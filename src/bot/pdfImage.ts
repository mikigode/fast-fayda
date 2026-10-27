import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFiumLibrary } from "@hyzyla/pdfium";

/**
 * The provider's PDF, drawn as a picture.
 *
 * The PDF verify endpoint returns the card as a document and nothing else — no
 * identity fields, so the card image `cardImage.ts` draws from JSON cannot be
 * made for it. What the document *is*, though, is a picture already: a PDF page
 * is a description of ink on paper. Rendering that page gives the same card as
 * an image, without a second verify (and so without spending a second point
 * upstream), and without altering the document that is delivered alongside it.
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
 *   - It is bounded. Pages are composed side by side at a fixed scale, and the
 *     result is scaled down if that would exceed what Telegram accepts as a
 *     photo, so a mislabelled multi-page document cannot turn into a rejected
 *     upload.
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

/** Two CSS pixels per PDF point: text is legible without a huge upload. */
const SCALE = 2;
/** A white gutter between pages, so a two-page card does not read as one. */
const PAGE_GAP = 24;
/**
 * Telegram rejects photos wider or taller than 10,000 px, and a very long strip
 * of pages would also be unreadable. Composing is capped at this width and the
 * pages are scaled down to fit.
 */
const MAX_WIDTH = 6000;

type Rendered = { data: Uint8Array; width: number; height: number };

/**
 * Renders a PDF's pages side by side as one PNG.
 *
 * Throw on any failure — an unreadable document, a missing renderer — because
 * the caller has already delivered the PDF and only loses the extra image.
 */
export async function toPdfImage(pdf: Buffer): Promise<Buffer> {
  const pdfium = await library();
  const document = await pdfium.loadDocument(pdf);
  try {
    const pages = [...document.pages()];
    if (pages.length === 0) throw new Error("the document has no pages");

    const rendered: Rendered[] = [];
    for (const page of pages) {
      try {
        rendered.push(await page.render({ scale: SCALE, colorSpace: "RGBA", render: renderPng }));
      } finally {
        // Pages stay loaded until closed or the document is destroyed; a warm
        // function renders many documents, so close each as soon as it is read.
        page.close();
      }
    }
    return await compose(rendered);
  } finally {
    document.destroy();
  }
}

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

/** One PNG: the pages in order, left to right, on white. */
async function compose(rendered: Rendered[]): Promise<Buffer> {
  const images = await Promise.all(rendered.map((page) => loadImage(Buffer.from(page.data))));

  const naturalWidth =
    images.reduce((sum, image) => sum + image.width, 0) + PAGE_GAP * (images.length - 1);
  const naturalHeight = Math.max(...images.map((image) => image.height));
  const scale = Math.min(1, MAX_WIDTH / naturalWidth);
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  // Explicitly white rather than transparent: a forwarded image with a
  // transparent margin shows up black in some clients.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  let x = 0;
  for (const image of images) {
    const drawnWidth = image.width * scale;
    context.drawImage(image, x, 0, drawnWidth, image.height * scale);
    x += drawnWidth + PAGE_GAP * scale;
  }
  return canvas.encode("png");
}
