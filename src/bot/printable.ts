import { PDFDocument, PDFFont, PDFPage, PDFImage, StandardFonts, rgb } from "pdf-lib";
import type { CardIdentity } from "./card";

/**
 * Renders a card document for printing, from the structured identity the JSON
 * verify endpoint returns.
 *
 * The provider's PDF endpoint draws the card itself, but a printable sheet
 * needs the pieces — photo, QR code, names in both scripts — laid out at
 * physical CR80 size (85.6mm × 54mm) on a labelled A4 sheet, so what lands on
 * paper is the card at card size. This flow uses `/verify-otp-json` and builds
 * the sheet here, rather than re-paginating the provider's document.
 *
 * Pure function of its input: the same identity always produces the same
 * sheet, which keeps a retry and a first attempt identical. Rendering never
 * throws for missing or corrupt images — a card the customer is owed should
 * reach them even when a photo or QR code is unusable.
 */

/** A4 portrait, in PDF points (1/72 inch). */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** CR80 (credit card) size in points: 85.6mm × 54mm. */
const CARD_WIDTH = 242.645;
const CARD_HEIGHT = 153.071;

const DARK = rgb(0.08, 0.08, 0.08);
const GREY = rgb(0.45, 0.45, 0.45);
const GUIDE = rgb(0.75, 0.75, 0.75);

type DecodedImage = { data: Buffer; kind: "png" | "jpg" | "unknown" };

/** Decodes a base64 payload or a `data:` URI, sniffing PNG vs JPEG. */
function decodeImage(value: string | null): DecodedImage | null {
  if (!value) return null;
  const comma = value.indexOf(",");
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  let raw: Buffer;
  try {
    raw = Buffer.from(payload.replace(/\s/g, ""), "base64");
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47 && raw[4] === 0x0d) {
    return { data: raw, kind: "png" };
  }
  if (raw[0] === 0xff && raw[1] === 0xd8) return { data: raw, kind: "jpg" };
  // The provider may switch formats without notice; pdf-lib is the final
  // arbiter, so carry the bytes onward and let the embed decide.
  return { data: raw, kind: "unknown" };
}

/** Shrinks the font until the line fits, falling back to an ellipsis. */
function fitText(font: PDFFont, text: string, size: number, maxWidth: number): { text: string; size: number } {
  let fitted = text;
  let fittedSize = size;
  while (fittedSize > 5 && font.widthOfTextAtSize(fitted, fittedSize) > maxWidth) {
    fittedSize -= 0.5;
  }
  if (fittedSize <= 5) {
    const ellipsis = "…";
    while (fitted.length > 1 && font.widthOfTextAtSize(fitted + ellipsis, 5) > maxWidth) {
      fitted = fitted.slice(0, -1);
    }
    fitted += ellipsis;
    fittedSize = 5;
  }
  return { text: fitted, size: fittedSize };
}

type SheetAssets = { helv: PDFFont; helvBold: PDFFont };

/** A card-sized box, centred on the A4 sheet. */
function cardBox(page: PDFPage): { x: number; y: number } {
  return { x: (page.getWidth() - CARD_WIDTH) / 2, y: (A4_HEIGHT - CARD_HEIGHT) / 2 };
}

/** The grey cut line one card wider on every side. */
function drawCutGuide(page: PDFPage): void {
  const { x, y } = cardBox(page);
  const margin = 6;
  page.drawRectangle({
    x: x - margin,
    y: y - margin,
    width: CARD_WIDTH + margin * 2,
    height: CARD_HEIGHT + margin * 2,
    borderColor: GUIDE,
    borderWidth: 0.75,
  });
}

function drawCaption(page: PDFPage, font: PDFFont, side: "FRONT" | "BACK"): void {
  page.drawText(`FAYDA CARD - PRINT READY (A4, CR80)  |  ${side}`, {
    x: 36,
    y: A4_HEIGHT - 36,
    size: 9,
    font,
    color: GREY,
  });
  page.drawText(`${side}  |  CR80 85.6mm x 54mm  |  cut along the grey guide`, {
    x: 36,
    y: 36,
    size: 9,
    font,
    color: GREY,
  });
}

/**
 * Copies image bytes into a standalone `Uint8Array` for pdf-lib.
 *
 * pdf-lib's embedders read `imageData.buffer` and ignore its byteOffset, and a
 * Node `Buffer` from `Buffer.from(base64)` is usually a view into the shared
 * 8 KB pool: its `.buffer` is the pool and byte 0 is somebody else's data, so
 * the embedder parses the wrong bytes and throws "SOI not found in JPEG". A
 * copy whose ArrayBuffer starts exactly at the image is what it expects.
 */
export function embeddableImageBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

/** Draws an image letterboxed into a box; a missing or corrupt one gets a frame instead. */
async function drawImageFitted(
  sheet: PDFDocument,
  page: PDFPage,
  image: DecodedImage | null,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
): Promise<void> {
  if (!image) {
    page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, borderColor: GUIDE, borderWidth: 0.75 });
    return;
  }
  const bytes = embeddableImageBytes(image.data);
  const embed = async (): Promise<PDFImage> => {
    if (image.kind === "png") {
      try {
        return await sheet.embedPng(bytes);
      } catch {
        return await sheet.embedJpg(bytes);
      }
    }
    if (image.kind === "jpg") return await sheet.embedJpg(bytes);
    // Unknown magic bytes: let pdf-lib try both decoders before giving up.
    try {
      return await sheet.embedPng(bytes);
    } catch {
      return await sheet.embedJpg(bytes);
    }
  };
  try {
    const embedded = await embed();
    const scale = Math.min(boxW / embedded.width, boxH / embedded.height);
    const width = embedded.width * scale;
    const height = embedded.height * scale;
    page.drawImage(embedded, {
      x: boxX + (boxW - width) / 2,
      y: boxY + (boxH - height) / 2,
      width,
      height,
    });
  } catch (error) {
    // An unreadable photo must not cost the customer the card itself. The
    // details stay in the log so a new provider format is adaptable.
    console.error(
      `card image embed failed (${image.data.length} bytes, prefix ${image.data.subarray(0, 8).toString("hex")}):`,
      error instanceof Error ? error.message : error,
    );
    page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, borderColor: GUIDE, borderWidth: 0.75 });
  }
}

/** Draws one labelled field after another, top to bottom, skipping empty values. */
function drawFields(
  page: PDFPage,
  assets: SheetAssets,
  fields: { label: string; value: string }[],
  x: number,
  startTop: number,
  columnWidth: number,
): void {
  let top = startTop;
  for (const field of fields) {
    if (!field.value) continue;
    page.drawText(field.label.toUpperCase(), {
      x,
      y: top,
      size: 5,
      font: assets.helvBold,
      color: GREY,
    });
    const fitted = fitText(assets.helv, field.value, 7, columnWidth);
    page.drawText(fitted.text, { x, y: top - 8, size: fitted.size, font: assets.helv, color: DARK });
    top -= 19;
  }
}

export async function toPrintable(identity: CardIdentity): Promise<Buffer> {
  const sheet = await PDFDocument.create();
  sheet.setProducer("fast-fayda printable");
  const helv = await sheet.embedFont(StandardFonts.Helvetica);
  const helvBold = await sheet.embedFont(StandardFonts.HelveticaBold);
  const assets = { helv, helvBold };

  const front = sheet.addPage([A4_WIDTH, A4_HEIGHT]);
  drawCutGuide(front);
  drawCaption(front, helv, "FRONT");
  drawFront(sheet, front, assets, identity);

  const back = sheet.addPage([A4_WIDTH, A4_HEIGHT]);
  drawCutGuide(back);
  drawCaption(back, helv, "BACK");
  drawBack(sheet, back, assets, identity);

  return Buffer.from(await sheet.save());
}

/** A one-page text layout, as a last resort when the sheet renderer fails. */
export async function toIdentityPdf(identity: CardIdentity): Promise<Buffer> {
  const sheet = await PDFDocument.create();
  sheet.setProducer("fast-fayda printable");
  const helv = await sheet.embedFont(StandardFonts.Helvetica);
  const page = sheet.addPage([A4_WIDTH, A4_HEIGHT]);
  const lines = [
    "FAYDA CARD",
    "",
    `Name: ${identity.name.english}`,
    `FAN:  ${identity.fanNumber}`,
    `FIN:  ${identity.fin}`,
    `DOB:  ${identity.dateOfBirth.gregorian}`,
    `Gender: ${identity.gender.english}`,
    `Nationality: ${identity.nationality.english}`,
  ];
  let y = A4_HEIGHT - 72;
  for (const line of lines) {
    page.drawText(line, { x: 48, y, size: 11, font: helv, color: DARK });
    y -= 18;
  }
  return Buffer.from(await sheet.save());
}

async function drawFront(
  sheet: PDFDocument,
  page: PDFPage,
  assets: SheetAssets,
  identity: CardIdentity,
): Promise<void> {
  const { x: cardX, y: cardY } = cardBox(page);
  const innerX = cardX + 12;
  const innerTop = cardY + CARD_HEIGHT - 12;

  page.drawText(identity.name.english.toUpperCase(), {
    x: innerX,
    y: innerTop - 4,
    size: 9,
    font: assets.helvBold,
    color: DARK,
  });
  page.drawText(`FAN ${identity.fanNumber}`, {
    x: innerX,
    y: innerTop - 18,
    size: 7,
    font: assets.helv,
    color: GREY,
  });

  const imageX = innerX;
  const imageY = cardY + 18;
  const imageW = CARD_WIDTH * 0.38;
  const imageH = innerTop - 30 - imageY;
  await drawImageFitted(sheet, page, decodeImage(identity.photo), imageX, imageY, imageW, imageH);

  const textX = imageX + imageW + 12;
  const textColumnWidth = cardX + CARD_WIDTH - 12 - textX;
  drawFields(page, assets, [
    { label: "FIN", value: identity.fin },
    { label: "DOB", value: identity.dateOfBirth.gregorian },
    { label: "Gender", value: identity.gender.english },
    { label: "Nationality", value: identity.nationality.english },
  ], textX, imageY + imageH, textColumnWidth);
}

async function drawBack(
  sheet: PDFDocument,
  page: PDFPage,
  assets: SheetAssets,
  identity: CardIdentity,
): Promise<void> {
  const { x: cardX, y: cardY } = cardBox(page);
  const innerX = cardX + 12;
  const qrW = CARD_WIDTH * 0.34;
  const qrX = cardX + CARD_WIDTH - qrW - 12;
  const qrY = cardY + 18;
  await drawImageFitted(sheet, page, decodeImage(identity.qrCode), qrX, qrY, qrW, qrW);

  const address = [identity.address.city.english, identity.address.subCity.english, identity.address.woreda.english]
    .filter(Boolean)
    .join(", ");
  drawFields(page, assets, [
    { label: "Phone", value: identity.phone },
    { label: "Address", value: address },
    { label: "Issued", value: identity.issueDate.gregorian },
    { label: "Expires", value: identity.expiryDate.gregorian },
  ], innerX, cardY + CARD_HEIGHT - 12, qrX - innerX - 12);
}