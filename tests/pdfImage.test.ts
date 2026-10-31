import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { cardSidesFromPdf } from "@/bot/pdfImage";

/**
 * The picture that follows the provider's original PDF.
 *
 * It is the card artwork the provider embedded in its own document — front and
 * back — not a rendering of the A4 sheet. These tests pin what the caller
 * depends on: the two sides come back as one PNG in the right order, small
 * images (the portrait photo, the QR code) are not mistaken for a side, and a
 * document with no artwork yields null so the caller sends no picture rather
 * than a picture of paper.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function solid(width: number, height: number, colour: string): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = colour;
  context.fillRect(0, 0, width, height);
  return canvas.encode("png");
}

/** A document with the given images placed on one A4 page, in that order. */
async function documentWith(
  images: { width: number; height: number; colour: string }[],
): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  let x = 40;
  for (const spec of images) {
    const embedded = await document.embedPng(await solid(spec.width, spec.height, spec.colour));
    page.drawImage(embedded, {
      x,
      y: 300,
      width: spec.width / 4,
      height: spec.height / 4,
    });
    x += 180;
  }
  return Buffer.from(await document.save());
}

/** PNG IHDR: width and height are the first two big-endian words of the chunk. */
function size(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The colour at one point of a PNG. */
async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(x, y, 1, 1);
  return [data[0]!, data[1]!, data[2]!];
}

describe("cardSidesFromPdf", () => {
  it("composes the two card sides side by side and ignores smaller images", async () => {
    const pdf = await documentWith([
      { width: 400, height: 500, colour: "#ff0000" },
      { width: 1200, height: 1800, colour: "#235d71" },
      { width: 300, height: 300, colour: "#00ff00" },
      { width: 1200, height: 1800, colour: "#d8d2c4" },
    ]);

    const png = await cardSidesFromPdf(pdf);
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    // Two 1200x1800 sides at 2/3 scale, plus the 24px gutter. The photo and
    // the QR are too small to be sides and must not widen this.
    expect(size(png!)).toEqual({ width: 1624, height: 1200 });
  });

  it("keeps the provider's order: front on the left, back on the right", async () => {
    const pdf = await documentWith([
      { width: 1200, height: 1800, colour: "#235d71" },
      { width: 1200, height: 1800, colour: "#d8d2c4" },
    ]);

    const png = (await cardSidesFromPdf(pdf))!;
    const [lr, lg, lb] = await pixel(png, 400, 600);
    const [rr, rg, rb] = await pixel(png, 1200, 600);

    // The teal front is left of the gutter, the pale back to its right.
    expect(lb).toBeGreaterThan(lr);
    expect(lg).toBeGreaterThan(lr);
    expect(rr).toBeGreaterThan(rb);
  });

  it("returns null when the document holds no card-sized images", async () => {
    const pdf = await documentWith([
      { width: 400, height: 500, colour: "#ff0000" },
      { width: 620, height: 620, colour: "#000000" },
    ]);

    expect(await cardSidesFromPdf(pdf)).toBeNull();
  });

  it("returns null for bytes that are not a document, so the caller can carry on", async () => {
    expect(await cardSidesFromPdf(Buffer.from("this is not a PDF"))).toBeNull();
  });
});
