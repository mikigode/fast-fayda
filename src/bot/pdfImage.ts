import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFiumLibrary } from "@hyzyla/pdfium";

/**
 * The card artwork inside the provider's PDF.
 *
 * The PDF verify endpoint returns the card as a document and nothing else — no
 * identity fields — and the vendor's guide forbids calling the JSON endpoint for
 * the same code (each verify costs a point). The document is not just a sheet,
 * though: the provider places the card's front and back on it as their own
 * images. This module takes those two images out and composes them side by side,
 * which is the picture a customer can print or forward.
 *
 * It deliberately never renders the page. A page render is a picture of a sheet
 * of paper — an A4 form with headings and a QR block — not of a card, and that
 * is exactly the picture nobody asked for.
 *
 * PDFium — the renderer inside Chrome — is used through its WebAssembly build,
 * so this needs no native binary and no host fonts: a PDF that embeds its fonts
 * (the provider's does) draws the same on every host, unlike the Skia text in
 * `cardImage.ts`, which needs the bundled Noto faces.
 *
 * Two properties matter more than fidelity here:
 *
 *   - It never runs for a document that was not already delivered. The caller
 *     sends the PDF first and then calls this, so a renderer that fails costs
 *     the customer a picture, not their card.
 *   - It is bounded. The sides are drawn at a fixed height and the result is
 *     kept well inside what Telegram accepts as a photo, so a mislabelled
 *     document cannot turn into a rejected upload.
 */

/**
 * Where the PDFium binary might be, tried in order.
 *
 * The package loads it from its own directory with a path built at runtime,
 * which Vercel's file tracer cannot see, so the file is located and read here
 * instead and handed to PDFium as bytes. Every candidate is spelled out rather
 * than assembled from parts for the same reason the card assets are (see
 * `cardImage.ts`): a path assembled at runtime is invisible to that tracer.
 *
 * The three shapes cover the ways this file is loaded:
 *   `dist/bot`        the compiled long-running server, two levels below the repo;
 *   `api/`            a serverless bundle flattened next to `node_modules`;
 *   `process.cwd()`   a repository root, or `/var/task` on Vercel.
 */
const WASM_CANDIDATES = [
  typeof __dirname === "string"
    ? join(__dirname, "..", "..", "node_modules", "@hyzyla", "pdfium", "dist", "pdfium.wasm")
    : null,
  typeof __dirname === "string"
    ? join(__dirname, "..", "node_modules", "@hyzyla", "pdfium", "dist", "pdfium.wasm")
    : null,
  join(process.cwd(), "node_modules", "@hyzyla", "pdfium", "dist", "pdfium.wasm"),
].filter((path): path is string => path !== null);

function readWasm(): Buffer | null {
  for (const path of WASM_CANDIDATES) {
    try {
      return readFileSync(path);
    } catch {
      // Not at this location; try the next.
    }
  }
  return null;
}

/**
 * Initialised once per process. PDFium's wasm compile is the expensive part of
 * a render (a few hundred milliseconds), and a warm function handles many
 * requests, so the instance is shared; the promise itself is cached so two
 * requests arriving together compile it once.
 */
let libraryOnce: Promise<PDFiumLibrary> | null = null;

function library(): Promise<PDFiumLibrary> {
  if (!libraryOnce) {
    const wasm = readWasm();
    if (!wasm) {
      // Let PDFium look for its own binary. This works wherever the package
      // directory survived intact, and fails loudly (into the caller's catch)
      // where it did not.
      console.error("pdf image: bundled PDFium wasm not found at any known path");
    }
    libraryOnce = PDFiumLibrary.init(wasm ? { wasmBinary: wasm } : undefined).catch((error) => {
      // A failed compile must not poison every later request.
      libraryOnce = null;
      throw error;
    });
  }
  return libraryOnce;
}

/** A rendered image: the bytes and the size they decode to. */
type Rendered = { data: Uint8Array; width: number; height: number };

/**
 * PDFium hands back raw RGBA; Skia turns it into the PNG Telegram wants. The
 * callback is per page and synchronous inside the renderer, so it is written as
 * a plain function rather than closing over page state.
 */
async function renderPng(options: { width: number; height: number; data: Uint8Array }): Promise<Uint8Array> {
  const canvas = createCanvas(options.width, options.height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(options.width, options.height);
  image.data.set(options.data);
  context.putImageData(image, 0, 0);
  return new Uint8Array(await canvas.encode("png"));
}

/**
 * The card artwork the provider embeds in its document: front on the left, back
 * on the right. Below these sizes an image is the portrait photo or the QR
 * code, not a side of the card.
 */
const SIDE_MIN_WIDTH = 1000;
const SIDE_MIN_HEIGHT = 1500;
/** The height each side is drawn at. Two portrait sides come out about 1500 px wide. */
const SIDE_HEIGHT = 1200;
/** A white gutter between the two sides, as the designed card has. */
const SIDE_GAP = 24;

/**
 * The provider's card front and back as one PNG, taken from the images embedded
 * in its PDF.
 *
 * The A4 document is a sheet, not a card: rendering it gives a picture of paper.
 * The artwork itself is in there, though, as the front and back images the
 * provider placed on that sheet, so this draws those side by side instead — the
 * same picture the designed card gives, just in the provider's own design and
 * portrait proportions rather than this bot's.
 *
 * Null on any failure. The PDF has already been delivered when this runs, so a
 * document whose images cannot be read costs a picture at most, and the caller
 * simply sends no picture rather than an A4 raster nobody asked for.
 */
export async function cardSidesFromPdf(pdf: Buffer): Promise<Buffer | null> {
  try {
    const pdfium = await library();
    const document = await pdfium.loadDocument(pdf);
    try {
      const sides: Rendered[] = [];
      for (const page of document.pages()) {
        try {
          for (const object of page.objects()) {
            // Only the card sides are this large; the photo and QR are not.
            if (object.type !== "image") continue;
            const image = await object.render({ render: renderPng });
            if (image.width < SIDE_MIN_WIDTH || image.height < SIDE_MIN_HEIGHT) continue;
            sides.push(image);
          }
        } finally {
          page.close();
        }
      }
      if (sides.length === 0) return null;
      // Document order puts the front before the back; a document with extra
      // large images keeps the first two it placed.
      return await composeSides(sides.slice(0, 2));
    } finally {
      document.destroy();
    }
  } catch (error) {
    console.error("card sides: could not read the document:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** One PNG: the card sides in order, on white, at a printable size. */
async function composeSides(rendered: Rendered[]): Promise<Buffer> {
  const images = await Promise.all(rendered.map((side) => loadImage(Buffer.from(side.data))));

  const tallest = Math.max(...images.map((image) => image.height));
  const scale = Math.min(1, SIDE_HEIGHT / tallest);
  const widths = images.map((image) => Math.round(image.width * scale));
  const height = Math.round(tallest * scale);
  const width = widths.reduce((sum, part) => sum + part, 0) + SIDE_GAP * (images.length - 1);

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  let x = 0;
  for (const [index, image] of images.entries()) {
    context.drawImage(image, x, 0, widths[index]!, height);
    x += widths[index]! + SIDE_GAP;
  }
  return canvas.encode("png");
}
