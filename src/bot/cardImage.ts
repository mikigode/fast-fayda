import { join } from "node:path";
import { GlobalFonts, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { CardIdentity } from "./card";

/**
 * Renders the card as one "duo" image — front and back side by side — in the
 * official design.
 *
 * The design itself is a real asset, `assets/card-background.png`, not something
 * this file draws: the vendor's card has a printed background (guilloché,
 * emblem, field labels in both scripts) that no amount of `fillRect` reproduces
 * faithfully. The division of labour is therefore the obvious one — the
 * background supplies everything static, and this file stamps the holder's
 * particulars into the boxes the design leaves for them:
 *
 *   front  the portrait, twice (a large one and a small one beside the FAN),
 *          both names, the date of birth and expiry in both calendars, sex,
 *          the issue date up the left edge, the FAN and its barcode;
 *   back   the phone number, the address (region, zone and woreda, each in
 *          both scripts), the FIN, and the QR code.
 *
 * The slots below were measured off a completed card (the front/back pair the
 * vendor's own tool produces): the rectangles are where its images sit, and the
 * baselines and sizes are where and how large its type sits.
 *
 * Pure function of its input, and never throws for a missing or unreadable
 * photo, QR code or background — a card the customer is owed has to arrive
 * either way.
 */

/** Two CR80-proportioned panels side by side, as the result image has them. */
const CARD_W = 1300;
const CARD_H = 800;
const IMAGE_W = CARD_W * 2;
const IMAGE_H = CARD_H;

/** Data is printed in near-black on the pale panels and white strips. */
const INK = "#111111";

type Ctx = SKRSContext2D;
type LoadedImage = Awaited<ReturnType<typeof loadImage>>;
type Box = { x: number; y: number; w: number; h: number };
/** A text slot: where the value starts, its baseline, and how wide it may run. */
type Line = { x: number; baseline: number; w: number };

/*
 * Where the holder's data goes, measured off a completed card.
 *
 * Images are rectangles; text is a baseline and a width, because the design
 * prints its values at a fixed size. Sizing a value to whatever box it happens
 * to sit in makes a short value (a woreda, a phone number) come out visibly
 * larger than a long one on the same card, which is exactly what the design
 * does not do — so the sizes below are the design's own, one per kind of field.
 * The ink height a Latin capital gives is about 0.72 of the size, Ethiopic
 * about 0.76, which is how they were read back off that card.
 */
const PHOTO: Box = { x: 99, y: 258, w: 351, h: 485 };
/** The small portrait beside the FAN, bottom right of the front. */
const PHOTO_THUMB: Box = { x: 1051, y: 585, w: 91, h: 143 };
const QR: Box = { x: 1912, y: 55, w: 620, h: 620 };

const NAME_AM: Line = { x: 499, baseline: 271, w: 430 };
const NAME_EN: Line = { x: 499, baseline: 324, w: 470 };

/*
 * Both dates the design prints sit on one line with a bar between them — the
 * Ethiopian calendar on the left, the Gregorian on the right — so each date
 * gets its own column rather than one wide slot. Each row sits directly under
 * its own label: the dates of birth under "የትውልድ ቀን | Date of Birth", the sex
 * under "ጾታ | Sex", the expiry under "የሚያበቃበት ቀን | Date of Expiry".
 */
const DOB_EC: Line = { x: 502, baseline: 414, w: 190 };
const DOB_GC: Line = { x: 706, baseline: 414, w: 205 };
const SEX: Line = { x: 502, baseline: 489, w: 400 };
const EXPIRY_EC: Line = { x: 502, baseline: 571, w: 190 };
const EXPIRY_GC: Line = { x: 706, baseline: 571, w: 205 };
/*
 * The FAN and its barcode share one white strip, the barcode starting a little
 * further left than the number so the bars line up with the strip rather than
 * with the digits above them. The number is left as the API gives it: the
 * design prints sixteen digits with no grouping, and the spacing is what makes
 * the width come out right.
 */
const FAN: Line = { x: 605, baseline: 673, w: 400 };
/**
 * The FAN's barcode, printed under the number on the same white strip.
 *
 * The box is sized so the bars — not the box — land where the design puts them:
 * `drawBarcode` leaves a ten-module quiet zone inside the box on each side, so
 * the drawn bars start about fifteen pixels in. 351 wide puts the bars at
 * x577–897, which is where the design's own barcode sits.
 */
const BARCODE: Box = { x: 562, y: 687, w: 351, h: 56 };

/*
 * The design prints a thin rule down the middle of a two-part value — between
 * the two dates on a row, and between the two scripts on the sex row. It stands
 * a little taller than the digits either side of it, which is how it was read
 * off the card: 23 above the baseline and 7 below.
 */
const BAR_X = 693;
const BAR_W = 5;
const BAR_ABOVE = 23;
const BAR_BELOW = 7;
/** Room left either side of the bar on the sex row, which sets it inline. */
const BAR_GAP_BEFORE = 24;
const BAR_GAP_AFTER = 16;

/*
 * The issue date runs up the front's left edge, turned a quarter turn so it
 * reads bottom to top with its first character at the bottom. The Ethiopian
 * date goes above the Amharic label and the Gregorian above the English one,
 * and both sit in the strips the design leaves blank for them: `x` is the
 * baseline, `bottom` where the first character starts, `length` the room left.
 */
type VLine = { x: number; bottom: number; length: number };
const ISSUE_GC: VLine = { x: 35, bottom: 289, length: 139 };
const ISSUE_EC: VLine = { x: 35, bottom: 599, length: 167 };

/*
 * The back prints each address level twice — once in Ethiopic, once in Latin —
 * so the six slots below run region, zone and woreda, each in both scripts.
 */
const PHONE: Line = { x: 1389, baseline: 129, w: 430 };
const ADDRESS_CITY_AM: Line = { x: 1388, baseline: 330, w: 420 };
const ADDRESS_CITY_EN: Line = { x: 1388, baseline: 367, w: 420 };
const ADDRESS_ZONE_AM: Line = { x: 1388, baseline: 406, w: 420 };
const ADDRESS_ZONE_EN: Line = { x: 1388, baseline: 446, w: 420 };
const ADDRESS_WOREDA_AM: Line = { x: 1388, baseline: 485, w: 420 };
const ADDRESS_WOREDA_EN: Line = { x: 1388, baseline: 523, w: 420 };
const FIN: Line = { x: 1538, baseline: 684, w: 340 };
/**
 * The serial number, in the blank strip directly under the QR code.
 *
 * This is the back's only free area: the QR ends at y675 and the return
 * message begins around y727, so the baseline sits between them. The serial is
 * printed here rather than in the page margin because the card is what is
 * forwarded and cut out — the number has to travel with it.
 */
const SERIAL: Line = { x: 1912, baseline: 716, w: 620 };

/** The design's own type sizes, shared by every field of the same kind. */
const SIZE_NAME = 37;
const SIZE_DATE = 33;
const SIZE_SEX = 33;
const SIZE_FAN = 28;
/** The issue date is set a shade smaller than the fields on the face. */
const SIZE_ISSUE = 23;
/** One size for the whole back, so its values all match. */
const SIZE_BACK = 32;
/** The serial is a small print, tucked under the QR rather than a card field. */
const SIZE_SERIAL = 28;

/**
 * The faces are bundled, not borrowed from the host.
 *
 * A serverless runtime can ship without any fonts at all: Vercel's Node image
 * has none, so Skia has nothing to shape glyphs with and `fillText` draws
 * nothing - quietly, while `fillRect` (the barcode and the separator bars)
 * still draws. The card that came back from production was exactly that: the
 * design, the photo, the QR, the bars and the barcode, and not one name, date,
 * number or label rendered from text.
 *
 * So Noto Sans and Noto Sans Ethiopic are kept under `assets/fonts` and
 * registered here, and they lead the candidate lists so a card looks the same
 * on every host. Both are SIL OFL 1.1; the licence is `assets/fonts/OFL.txt`.
 *
 * Every path is spelled out rather than assembled from a directory and a file
 * name: Vercel traces the files a function reads statically, and a path built
 * at runtime is invisible to that tracer, so the fonts would not be deployed.
 */
const BUNDLED_FONT_PATHS = [
  typeof __dirname === "string" ? join(__dirname, "..", "..", "assets", "fonts", "NotoSans-Regular.ttf") : null,
  typeof __dirname === "string" ? join(__dirname, "..", "assets", "fonts", "NotoSans-Regular.ttf") : null,
  join(process.cwd(), "assets", "fonts", "NotoSans-Regular.ttf"),
  typeof __dirname === "string" ? join(__dirname, "..", "..", "assets", "fonts", "NotoSans-Bold.ttf") : null,
  typeof __dirname === "string" ? join(__dirname, "..", "assets", "fonts", "NotoSans-Bold.ttf") : null,
  join(process.cwd(), "assets", "fonts", "NotoSans-Bold.ttf"),
  typeof __dirname === "string" ? join(__dirname, "..", "..", "assets", "fonts", "NotoSansEthiopic-Regular.ttf") : null,
  typeof __dirname === "string" ? join(__dirname, "..", "assets", "fonts", "NotoSansEthiopic-Regular.ttf") : null,
  join(process.cwd(), "assets", "fonts", "NotoSansEthiopic-Regular.ttf"),
  typeof __dirname === "string" ? join(__dirname, "..", "..", "assets", "fonts", "NotoSansEthiopic-Bold.ttf") : null,
  typeof __dirname === "string" ? join(__dirname, "..", "assets", "fonts", "NotoSansEthiopic-Bold.ttf") : null,
  join(process.cwd(), "assets", "fonts", "NotoSansEthiopic-Bold.ttf"),
].filter((path): path is string => path !== null);

for (const path of BUNDLED_FONT_PATHS) {
  try {
    // Returns null when the file is absent, which is why the host's fonts are
    // still fallbacks below: a card with text in the wrong face beats a blank.
    GlobalFonts.registerFromPath(path);
  } catch {
    // Unreadable or invalid; try the next candidate.
  }
}

if (GlobalFonts.families.length === 0) {
  // Not fatal - the photo, the QR and the barcode are not text - but every
  // name, date and number will be missing, which reads as a broken design
  // rather than a host without fonts. Make the cause obvious in the logs.
  console.error("card image: no fonts are available, so text will be missing from the card");
}

/**
 * Amharic and Latin do not share a face here: the Latin fonts have no Ethiopic
 * glyphs and would render the name as boxes. Pick the first family actually
 * available, falling back to the Latin choice so text still appears.
 */
function pickFamily(candidates: string[], fallback: string): string {
  const installed = new Set(GlobalFonts.families.map((font) => font.family));
  return candidates.find((name) => installed.has(name)) ?? fallback;
}

const LATIN = pickFamily(["Noto Sans", "Segoe UI", "Arial", "DejaVu Sans", "Liberation Sans"], "sans-serif");
const ETHIOPIC = pickFamily(
  ["Noto Sans Ethiopic", "Nyala", "Abyssinica SIL", "Ebrima"],
  LATIN,
);

function font(weight: number | string, size: number, family: string): string {
  return `${weight} ${size}px "${family}"`;
}

/** Strips a `data:` prefix and decodes base64, returning null for anything unusable. */
function bytesOf(value: string | null): Buffer | null {
  if (!value) return null;
  const comma = value.indexOf(",");
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  try {
    const raw = Buffer.from(payload.replace(/\s/g, ""), "base64");
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function loadOrNull(value: string | null): Promise<LoadedImage | null> {
  const bytes = bytesOf(value);
  if (!bytes) return null;
  try {
    return await loadImage(bytes);
  } catch {
    return null;
  }
}

/**
 * The static card design, loaded once.
 *
 * `__dirname` is where the CommonJS build and `tsx` both leave it; the `cwd`
 * form is for hosts that load this file as ESM (the test runner), where
 * `__dirname` does not exist. A missing file resolves to null rather than a
 * rejected promise, so a deployment that forgot to copy `assets/` degrades to a
 * plain card instead of failing every request.
 */
/**
 * Where the design is, tried in order, because the same file sits at a
 * different depth depending on who loaded it: `src/bot` under `tsx` and
 * `dist/bot` in the built server are both two levels below the repository
 * root, while a serverless bundler that flattens the entry point into
 * `/var/task/api` leaves it one level up. A deployment that ships none of
 * them gets the plain card rather than a failed request.
 */
const BACKGROUND_CANDIDATES = [
  typeof __dirname === "string" ? join(__dirname, "..", "..", "assets", "card-background.png") : null,
  typeof __dirname === "string" ? join(__dirname, "..", "assets", "card-background.png") : null,
  join(process.cwd(), "assets", "card-background.png"),
].filter((path): path is string => path !== null);

let backgroundOnce: Promise<LoadedImage | null> | null = null;
function loadBackground(): Promise<LoadedImage | null> {
  if (!backgroundOnce) {
    backgroundOnce = (async () => {
      for (const path of BACKGROUND_CANDIDATES) {
        try {
          return await loadImage(path);
        } catch {
          // Not at this location; try the next.
        }
      }
      return null;
    })();
  }
  return backgroundOnce;
}

/** Draws an image cropped to fill the box (like an ID photo). */
function drawCover(ctx: Ctx, image: LoadedImage, box: Box): void {
  const scale = Math.max(box.w / image.width, box.h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.drawImage(image, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
  ctx.restore();
}

/** Draws an image whole inside the box, on white; a missing one leaves the box. */
function drawContained(ctx: Ctx, image: LoadedImage | null, box: Box): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  if (!image) {
    ctx.restore();
    return;
  }
  const scale = Math.min(box.w / image.width, box.h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
  ctx.restore();
}

/**
 * Draws one value on its baseline, at the design's size, shrunk only if it
 * would run past the width the design leaves it.
 *
 * A value is a stranger's name or a 16-digit number, so it is measured rather
 * than assumed: the size is the design's, but oversized text still must not run
 * into the artwork beside it.
 */
function drawLine(ctx: Ctx, text: string, line: Line, family: string, size: number, weight = 600): void {
  if (!text) return;
  for (; size > 8; size--) {
    ctx.font = font(weight, size, family);
    if (ctx.measureText(text).width <= line.w) break;
  }
  ctx.font = font(weight, size, family);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, line.x, line.baseline);
}

/** Draws the design's separator rule on a row's baseline, at `x`. */
function drawBar(ctx: Ctx, baseline: number, x: number): void {
  ctx.fillStyle = INK;
  ctx.fillRect(x, baseline - BAR_ABOVE, BAR_W, BAR_ABOVE + BAR_BELOW);
}

/**
 * Draws one value up the front's left edge, turned a quarter turn so it reads
 * bottom to top — the way the design sets the issue date.
 *
 * The rotation is what makes the two anchoring arguments mean anything: after
 * the turn the text's baseline runs up the screen and its glyphs lean left, so
 * `slot.x` is the baseline and `slot.bottom` is where the first character sits.
 */
function drawVerticalLine(ctx: Ctx, text: string, slot: VLine, family: string, size: number, weight = 600): void {
  if (!text) return;
  for (; size > 8; size--) {
    ctx.font = font(weight, size, family);
    if (ctx.measureText(text).width <= slot.length) break;
  }
  ctx.save();
  ctx.translate(slot.x, slot.bottom);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * Draws a value the design prints in both scripts on one line — Amharic first,
 * a bar, then Latin — each run at its own face.
 *
 * Two runs rather than one string because neither face covers both scripts: an
 * Ethiopic family without Latin gives Latin as fallback shapes, and a Latin
 * family without Ethiopic gives boxes. The bar is placed where the Amharic
 * actually ends rather than at a fixed column, because "ወንድ" and "ሴት" are not
 * the same width.
 */
function drawBothScripts(ctx: Ctx, amharic: string, latin: string, line: Line, size: number): void {
  let x = line.x;
  if (amharic) {
    ctx.font = font(600, size, ETHIOPIC);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(amharic, x, line.baseline);
    x += ctx.measureText(amharic).width + BAR_GAP_BEFORE;
  }
  if (!latin) return;
  drawBar(ctx, line.baseline, x);
  const textX = x + BAR_W + BAR_GAP_AFTER;
  drawLine(ctx, latin, { x: textX, baseline: line.baseline, w: line.x + line.w - textX }, LATIN, size);
}

/** The address, as the design prints it: region, zone and woreda, in both scripts. */
function addressLevels(identity: CardIdentity): CardIdentity["address"][keyof CardIdentity["address"]][] {
  const { city, subCity, woreda } = identity.address;
  return [city, subCity, woreda];
}

/** `1234 5678 9012 3456` — a long number is easier to read in groups. */
export function groupFan(fan: string): string {
  return fan.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Code 128's 107 symbols, as module patterns (1 = bar, 0 = space).
 *
 * The table is the standard one from the code's specification: 103 data
 * symbols, three start symbols and the stop. Kept as data because the barcode
 * is only as good as the table — a scanner either reads the FAN or it does not.
 */
const CODE128 = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100, 10001001100, 10011001000,
  10011000100, 10001100100, 11001001000, 11001000100, 11000100100, 10110011100, 10011011100,
  10011001110, 10111001100, 10011101100, 10011100110, 11001110010, 11001011100, 11001001110,
  11011100100, 11001110100, 11101101110, 11101001100, 11100101100, 11100100110, 11101100100,
  11100110100, 11100110010, 11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000, 11000101000, 11000100010,
  10110111000, 10110001110, 10001101110, 10111011000, 10111000110, 10001110110, 11101110110,
  11010001110, 11000101110, 11011101000, 11011100010, 11011101110, 11101011000, 11101000110,
  11100010110, 11101101000, 11101100010, 11100011010, 11101111010, 11001000010, 11110001010,
  10100110000, 10100001100, 10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010, 11000010010, 11001010000,
  11110111010, 11000010100, 10001111010, 10100111100, 10010111100, 10010011110, 10111100100,
  10011110100, 10011110010, 11110100100, 11110010100, 11110010010, 11011011110, 11011110110,
  11110110110, 10101111000, 10100011110, 10001011110, 10111101000, 10111100010, 11110101000,
  11110100010, 10111011110, 10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

/**
 * Encodes ASCII text as Code 128-B modules — start, data, checksum, stop.
 *
 * B rather than A or C because a FAN is digits: C would be denser, but B keeps
 * the encoder to one table and every FAN still fits the strip. Characters
 * outside set B are dropped rather than encoded wrongly.
 */
export function code128B(text: string): string {
  const codes = [CODE128_START_B];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) continue;
    codes.push(code - 32);
  }
  let checksum = CODE128_START_B;
  for (let i = 1; i < codes.length; i++) checksum += (codes[i] ?? 0) * i;
  codes.push(checksum % 103, CODE128_STOP);
  return codes.map((code) => String(CODE128[code])).join("");
}

/**
 * Draws `text` as a barcode filling the box, on white so a scanner sees clean
 * bars. The quiet zones are part of the width rather than padding, so the bars
 * never run to the edge of the strip.
 */
function drawBarcode(ctx: Ctx, text: string, box: Box): void {
  if (!text) return;
  const modules = code128B(text);
  const quiet = 10;
  const unit = box.w / (modules.length + quiet * 2);
  if (!(unit > 0)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = INK;
  let run = 0;
  for (let i = 1; i <= modules.length; i++) {
    if (i < modules.length && modules[i] === modules[run]) continue;
    if (modules[run] === "1") {
      const x0 = box.x + Math.round((quiet + run) * unit);
      const x1 = box.x + Math.round((quiet + i) * unit);
      ctx.fillRect(x0, box.y, Math.max(1, x1 - x0), box.h);
    }
    run = i;
  }
  ctx.restore();
}

/**
 * The card as a single PNG, front and back side by side.
 *
 * The MIME type is fixed: Telegram needs it on the upload, and a caller that
 * guesses from the bytes would guess wrong about what a PNG is.
 */
export async function toCardImage(identity: CardIdentity, serial: number | null = null): Promise<Buffer> {
  const canvas = createCanvas(IMAGE_W, IMAGE_H);
  const ctx = canvas.getContext("2d");

  const [background, photo, qr] = await Promise.all([
    loadBackground(),
    loadOrNull(identity.photo),
    loadOrNull(identity.qrCode),
  ]);

  // The design, or a plain green field if the asset is missing — the card is
  // still worth sending with the data on it.
  if (background) {
    ctx.drawImage(background, 0, 0, IMAGE_W, IMAGE_H);
  } else {
    ctx.fillStyle = "#0d7a47";
    ctx.fillRect(0, 0, IMAGE_W, IMAGE_H);
  }

  // Front.
  if (photo) {
    drawCover(ctx, photo, PHOTO);
    drawCover(ctx, photo, PHOTO_THUMB);
  }
  drawLine(ctx, identity.name.amharic, NAME_AM, ETHIOPIC, SIZE_NAME, 700);
  drawLine(ctx, identity.name.english, NAME_EN, LATIN, SIZE_NAME, 700);
  drawLine(ctx, identity.dateOfBirth.ethiopian, DOB_EC, LATIN, SIZE_DATE);
  drawBar(ctx, DOB_EC.baseline, BAR_X);
  drawLine(ctx, identity.dateOfBirth.gregorian, DOB_GC, LATIN, SIZE_DATE);
  drawBothScripts(ctx, identity.gender.amharic, identity.gender.english, SEX, SIZE_SEX);
  drawLine(ctx, identity.expiryDate.ethiopian, EXPIRY_EC, LATIN, SIZE_DATE);
  drawBar(ctx, EXPIRY_EC.baseline, BAR_X);
  drawLine(ctx, identity.expiryDate.gregorian, EXPIRY_GC, LATIN, SIZE_DATE);
  // The issue date, up the left edge: the Gregorian above the English label,
  // the Ethiopian above the Amharic one.
  drawVerticalLine(ctx, identity.issueDate.gregorian, ISSUE_GC, LATIN, SIZE_ISSUE, 700);
  drawVerticalLine(ctx, identity.issueDate.ethiopian, ISSUE_EC, LATIN, SIZE_ISSUE, 700);
  drawLine(ctx, identity.fanNumber, FAN, LATIN, SIZE_FAN, 700);
  drawBarcode(ctx, identity.fanNumber, BARCODE);

  // Back. Nationality is deliberately left blank: it is the same on every card
  // this bot issues, so the design's label is enough without it spelled out.
  drawContained(ctx, qr, QR);
  drawLine(ctx, identity.phone, PHONE, LATIN, SIZE_BACK);
  const levels = addressLevels(identity);
  const slots: [Line, Line][] = [
    [ADDRESS_CITY_AM, ADDRESS_CITY_EN],
    [ADDRESS_ZONE_AM, ADDRESS_ZONE_EN],
    [ADDRESS_WOREDA_AM, ADDRESS_WOREDA_EN],
  ];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const slot = slots[i];
    if (!level || !slot) continue;
    drawLine(ctx, level.amharic, slot[0], ETHIOPIC, SIZE_BACK);
    drawLine(ctx, level.english, slot[1], LATIN, SIZE_BACK);
  }
  drawLine(ctx, identity.fin, FIN, LATIN, SIZE_BACK, 700);
  // Allocated per printable card; absent when numbering failed, which must not
  // stop the card itself from being drawn.
  if (serial !== null) drawLine(ctx, `SN ${serial}`, SERIAL, LATIN, SIZE_SERIAL, 700);

  return canvas.encodeSync("png");
}

export const CARD_IMAGE_FILENAME = "fayda-card.png";
