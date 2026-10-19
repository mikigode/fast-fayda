import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "@/bot/card";
import { embeddableImageBytes, toPrintable } from "@/bot/printable";
import { SAMPLE_JPEG_BASE64 } from "./fixtures/sample-jpeg";

/**
 * The printable sheet embeds the holder's photo and QR code with pdf-lib.
 *
 * Its JPEG embedder reads `imageData.buffer` and ignores `byteOffset`/`byteLength`
 * (`new DataView(imageData.buffer)`, with `imageData.buffer.byteLength` as the
 * scan bound). A Node `Buffer` from `Buffer.from(base64)` is usually a view into
 * the shared pool, so pdf-lib parsed the pool instead of the image and threw
 * "SOI not found in JPEG" — silently dropping the photo from every delivered
 * card and drawing a placeholder frame instead. These tests pin the copy that
 * fixes it, using a real JPEG rather than a fixture whose bytes only happen to
 * sit at offset zero.
 */

function jpegBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(SAMPLE_JPEG_BASE64, "base64"));
}

/**
 * Places `bytes` inside a larger buffer so they sit at a non-zero byteOffset —
 * the exact shape `Buffer.from(base64)` hands the renderer in production.
 */
function atPoolOffset(bytes: Uint8Array, offset = 16): Uint8Array {
  const pool = new Uint8Array(offset + bytes.length + 16);
  pool.set(bytes, offset);
  return pool.subarray(offset, offset + bytes.length);
}

const IDENTITY: CardIdentity = {
  fanNumber: "1234567890123456",
  fin: "345678901234",
  name: { amharic: "\u12a0\u1260\u1260 \u12a8\u1260\u12f0", english: "Abebe Kebede" },
  dateOfBirth: { ethiopian: "1980-08-01", gregorian: "1988-05-09" },
  gender: { amharic: "\u12c8\u1295\u12f5", english: "Male" },
  nationality: { amharic: "\u12a2\u1275\u12ee\u1335\u12eb", english: "Ethiopian" },
  phone: "0912345678",
  address: {
    city: { amharic: "\u12a0\u12f2\u1235", english: "Addis Ababa" },
    subCity: { amharic: "\u1261\u122e", english: "Bole" },
    woreda: { amharic: "\u1309\u1309", english: "03" },
  },
  issueDate: { ethiopian: "2015-01-01", gregorian: "2022-09-11" },
  expiryDate: { ethiopian: "2025-01-01", gregorian: "2032-09-11" },
  photo: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64}`,
  qrCode: null,
};

describe("embeddableImageBytes", () => {
  it("starts the ArrayBuffer at the image, whatever offset the input had", () => {
    const view = atPoolOffset(jpegBytes());
    expect(view.byteOffset).toBe(16);

    const bytes = embeddableImageBytes(view);

    expect(bytes.byteOffset).toBe(0);
    // pdf-lib scans to `buffer.byteLength`, so the buffer must not carry the
    // pool's slack past the image either.
    expect(bytes.buffer.byteLength).toBe(view.length);
    // The exact read pdf-lib performs internally, which used to return the
    // pool's first bytes and throw "SOI not found in JPEG".
    expect(new DataView(bytes.buffer).getUint16(0)).toBe(0xffd8);
    expect(Buffer.from(bytes).equals(Buffer.from(view))).toBe(true);
  });

  it("is what makes pdf-lib embed a JPEG that sits at a pool offset", async () => {
    const shifted = atPoolOffset(jpegBytes());

    // Without the copy, this is the failure the customer's card hit.
    await expect((await PDFDocument.create()).embedJpg(shifted)).rejects.toThrow(/SOI not found/);

    const image = await (await PDFDocument.create()).embedJpg(embeddableImageBytes(shifted));
    expect(image.width).toBe(8);
    expect(image.height).toBe(8);
  });
});

describe("toPrintable", () => {
  it("embeds the holder's JPEG photo instead of falling back to a frame", async () => {
    // Prime the buffer pool so the photo's own Buffer.from(base64) is a view,
    // as it is in the running bot after any earlier allocation.
    Buffer.from(Buffer.alloc(300, 1).toString("base64"), "base64");

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pdf = await toPrintable(IDENTITY);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("card image embed failed");
      const delivered = await PDFDocument.load(pdf);
      expect(delivered.getPageCount()).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });
});
