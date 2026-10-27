import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { toPdfImage } from "@/bot/pdfImage";

/**
 * The picture that follows the provider's original PDF.
 *
 * Its job is the same as the designed card image's — something to forward —
 * but it has no identity fields to draw from, so it is the provider's own pages
 * rasterised. These tests pin the two things a caller depends on: a real PNG of
 * the right shape comes back, and the composition stays inside what Telegram
 * accepts as a photo.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PDF of `pages` pages, each filled black so the render cannot be mistaken for blank. */
async function filled(pages: number, size: [number, number]): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = document.addPage(size);
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(0, 0, 0) });
  }
  return Buffer.from(await document.save());
}

/** PNG IHDR: width and height are the first two big-endian words of the chunk. */
function size(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("toPdfImage", () => {
  it("renders a one-page document as a PNG of the page", async () => {
    const png = await toPdfImage(await filled(1, [242.645, 153.071]));

    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const { width, height } = size(png);
    // The card size at two pixels per point, rounded by the renderer.
    expect(width).toBeGreaterThan(480);
    expect(width).toBeLessThan(490);
    expect(height).toBeGreaterThan(300);
    expect(height).toBeLessThan(310);
  });

  it("draws the page itself, not an empty canvas", async () => {
    const png = await toPdfImage(await filled(1, [242.645, 153.071]));
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);

    // The page was filled black, so most of the picture has to be ink.
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 60 && data[i + 1]! < 60 && data[i + 2]! < 60) dark++;
    }
    expect(dark / (image.width * image.height)).toBeGreaterThan(0.9);
  });

  it("puts a front-and-back document side by side, with a gutter", async () => {
    const one = size(await toPdfImage(await filled(1, [200, 120])));
    const two = size(await toPdfImage(await filled(2, [200, 120])));

    expect(two.height).toBe(one.height);
    // Two 400px pages at 2x, plus the 24px gutter between them.
    expect(two.width).toBe(one.width * 2 + 24);
  });

  it("scales a very wide strip down to what Telegram accepts", async () => {
    const { width } = size(await toPdfImage(await filled(2, [2500, 100])));

    // Two 5,000px pages would be 10,024px wide, past the 10,000px photo limit.
    expect(width).toBe(6000);
  });

  it("rejects bytes that are not a document, so the caller's guard can carry on", async () => {
    await expect(toPdfImage(Buffer.from("this is not a PDF"))).rejects.toThrow();
  });
});
