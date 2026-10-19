import { describe, expect, it } from "vitest";
import type { CardIdentity } from "@/bot/card";
import { CARD_IMAGE_FILENAME, code128B, groupFan, toCardImage } from "@/bot/cardImage";
import { SAMPLE_JPEG_BASE64 } from "./fixtures/sample-jpeg";

/**
 * The card image is the front-and-back picture the bot sends after the
 * printable PDF. These tests pin the two things a caller depends on — that the
 * bytes are a PNG of the agreed size, and that an unusable photo or QR code
 * costs the customer a frame, never the whole image.
 */

const IDENTITY: CardIdentity = {
  fanNumber: "5274670831630236",
  fin: "670831630236",
  name: { amharic: "አበበ ከበደ", english: "Abebe Kebede" },
  dateOfBirth: { ethiopian: "1980-08-01", gregorian: "1988-05-09" },
  gender: { amharic: "ወንድ", english: "Male" },
  nationality: { amharic: "ኢትዮጵያ", english: "Ethiopian" },
  phone: "0912345678",
  address: {
    city: { amharic: "አዲስ አበባ", english: "Addis Ababa" },
    subCity: { amharic: "ቦሌ", english: "Bole" },
    woreda: { amharic: "03", english: "03" },
  },
  issueDate: { ethiopian: "2015-01-01", gregorian: "2022-09-11" },
  expiryDate: { ethiopian: "2025-01-01", gregorian: "2032-09-11" },
  photo: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64}`,
  qrCode: null,
};

describe("groupFan", () => {
  it("groups a long number in fours for reading off the card", () => {
    expect(groupFan("5274670831630236")).toBe("5274 6708 3163 0236");
  });

  it("leaves a short or unusual number alone rather than crashing", () => {
    expect(groupFan("123")).toBe("123");
    expect(groupFan("")).toBe("");
  });
});

describe("code128B", () => {
  it("frames the modules with the start-B and stop symbols", () => {
    const modules = code128B("0123456789");

    expect(modules.slice(0, 11)).toBe("11010010000");
    expect(modules.slice(-13)).toBe("1100011101011");
    expect(modules).toMatch(/^[01]+$/);
  });

  it("uses eleven modules per symbol, thirteen for the stop", () => {
    // Start, four data symbols and the checksum, then the wider stop.
    expect(code128B("1234")).toHaveLength(6 * 11 + 13);
  });

  it("encodes a value to its known module pattern", () => {
    // Start B, "0" (value 16), the checksum it implies (17), and the stop.
    expect(code128B("0")).toBe("1101001000010011101100100111001101100011101011");
  });

  it("drops characters the B set cannot represent rather than corrupting the code", () => {
    expect(code128B("1\u0000a")).toBe(code128B("1a"));
    expect(code128B("")).toBe(code128B(""));
  });
});

describe("toCardImage", () => {
  it("returns a two-card PNG at the agreed size", async () => {
    const png = await toCardImage(IDENTITY);

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // PNG IHDR: width and height are the first two big-endian words of the chunk.
    expect(png.readUInt32BE(16)).toBe(2600);
    expect(png.readUInt32BE(20)).toBe(800);
  });

  it("sends the filename Telegram is given, which the router passes through", () => {
    expect(CARD_IMAGE_FILENAME).toBe("fayda-card.png");
  });

  it("still renders when the photo and QR code are unusable", async () => {
    const broken: CardIdentity = {
      ...IDENTITY,
      photo: "this is not base64 !!",
      qrCode: "data:image/png;base64,=========",
    };

    const png = await toCardImage(broken);

    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.length).toBeGreaterThan(1000);
  });
});
