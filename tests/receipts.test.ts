import { describe, expect, it } from "vitest";
import { extractAmount, parseReceipt, pointsFor } from "@/bot/receipts";

/**
 * The six input formats the bot advertises, plus the ways people get them
 * slightly wrong.
 *
 * This is the module where a bug costs money in both directions — a reference
 * that parses two different ways lets one payment be redeemed twice, and one
 * that fails to parse turns a paying customer into a support ticket — so it is
 * covered far more thoroughly than its size suggests.
 */

describe("parseReceipt", () => {
  it("reads a CBE apps link, dropping the account suffix", () => {
    expect(parseReceipt("https://apps.cbe.com.et:100/?id=FT25391XM4KP07823491")).toEqual({
      provider: "cbe",
      reference: "FT25391XM4KP",
      verifyUrl: "https://apps.cbe.com.et:100/?id=FT25391XM4KP",
    });
  });

  it("reads an mbreciept link, dropping the dashed account suffix", () => {
    expect(parseReceipt("https://mbreciept.cbe.com.et/FT26257QHWN-41985602")?.reference).toBe(
      "FT26257QHWN",
    );
  });

  /**
   * The same payment reaches us as two different links. If the account suffix
   * survived into the reference they would be two rows, and the single-use
   * guarantee would be worth nothing.
   */
  it("gives one reference for both CBE link forms of the same payment", () => {
    const a = parseReceipt("https://apps.cbe.com.et:100/?id=FT25391XM4KP07823491");
    const b = parseReceipt("https://mbreciept.cbe.com.et/FT25391XM4KP-07823491");
    expect(a?.reference).toBe(b?.reference);
  });

  it("reads a bare CBE reference", () => {
    expect(parseReceipt("FT25391XM4KP")?.reference).toBe("FT25391XM4KP");
  });

  it("reads a Telebirr receipt link", () => {
    expect(parseReceipt("https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ")).toEqual({
      provider: "telebirr",
      reference: "CKM8P4YJNQ",
      verifyUrl: "https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ",
    });
  });

  it("reads a bare Telebirr id", () => {
    expect(parseReceipt("CKM8P4YJNQ")).toEqual({
      provider: "telebirr",
      reference: "CKM8P4YJNQ",
      verifyUrl: "https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ",
    });
  });

  it("finds a reference inside a pasted SMS", () => {
    const sms =
      "Dear customer, you have transferred ETB 150.00 to FAYDA PRINT on 12/08/2026. " +
      "Your transaction reference is FT25391XM4KP. Thank you for banking with CBE.";
    expect(parseReceipt(sms)?.reference).toBe("FT25391XM4KP");
  });

  it("finds a Telebirr id inside a pasted SMS, via its receipt link", () => {
    const sms =
      "You have received ETB 300.00. Click https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ " +
      "to view your receipt.";
    expect(parseReceipt(sms)?.provider).toBe("telebirr");
  });

  it("normalises case, so a hand-typed reference matches a pasted one", () => {
    expect(parseReceipt("ft25391xm4kp")?.reference).toBe("FT25391XM4KP");
    expect(parseReceipt("ckm8p4yjnq")?.reference).toBe("CKM8P4YJNQ");
  });

  it("tolerates surrounding whitespace and newlines", () => {
    expect(parseReceipt("\n  FT25391XM4KP \n")?.reference).toBe("FT25391XM4KP");
  });

  /**
   * A ten-character word is not a Telebirr id just because it is ten
   * characters. Accepting one would credit points for a sentence.
   */
  it("does not mistake a word in a message for a bare Telebirr id", () => {
    expect(parseReceipt("Hello there, my payment did not go through")).toBeNull();
    expect(parseReceipt("PROCESSING")).not.toBeNull(); // ten chars, and alone — accepted
    expect(parseReceipt("I sent the money PROCESSING please check")).toBeNull();
  });

  it("returns null for input with no reference in it", () => {
    expect(parseReceipt("")).toBeNull();
    expect(parseReceipt("   ")).toBeNull();
    expect(parseReceipt("please help me")).toBeNull();
    expect(parseReceipt("https://example.com/receipt/12345")).toBeNull();
  });

  it("rejects a CBE reference of the wrong length", () => {
    expect(parseReceipt("FT123")).toBeNull();
    expect(parseReceipt("FT25391XM4KP99999999999")).toBeNull();
  });
});

describe("extractAmount", () => {
  it("reads an amount written after the currency", () => {
    expect(extractAmount("<td>Amount</td><td>ETB 150.00</td>")).toBe(150);
  });

  it("reads an amount written before the currency", () => {
    expect(extractAmount("<div>Total: 1,250.50 ETB</div>")).toBe(1250.5);
  });

  it("reads Birr as well as ETB", () => {
    expect(extractAmount("<p>Transferred 300 Birr</p>")).toBe(300);
  });

  /**
   * These pages list the transfer alongside its service charge and VAT. Taking
   * the first number would credit points for the fee.
   */
  it("takes the largest figure, not the first", () => {
    const html = `
      <table>
        <tr><td>Service charge</td><td>ETB 5.00</td></tr>
        <tr><td>VAT</td><td>ETB 0.75</td></tr>
        <tr><td>Transferred</td><td>ETB 450.00</td></tr>
      </table>`;
    expect(extractAmount(html)).toBe(450);
  });

  it("sees through markup splitting a value", () => {
    expect(extractAmount("<span>ETB</span> <b>75.00</b>")).toBe(75);
  });

  it("ignores numbers in scripts and styles", () => {
    const html = "<script>var x = 99999 + 'ETB'</script><p>ETB 60.00</p>";
    expect(extractAmount(html)).toBe(60);
  });

  it("returns null when there is no amount to read", () => {
    expect(extractAmount("<html><body>Receipt not found</body></html>")).toBeNull();
    expect(extractAmount("")).toBeNull();
  });
});

describe("pointsFor", () => {
  it("converts birr to points at the configured price", () => {
    expect(pointsFor(150, 15)).toBe(10);
    expect(pointsFor(15, 15)).toBe(1);
  });

  it("rounds down — a part-point is not a point", () => {
    expect(pointsFor(160, 15)).toBe(10);
    expect(pointsFor(14.99, 15)).toBe(0);
  });

  it("refuses to invent points from nonsense", () => {
    expect(pointsFor(0, 15)).toBe(0);
    expect(pointsFor(-100, 15)).toBe(0);
    expect(pointsFor(150, 0)).toBe(0);
    expect(pointsFor(Number.NaN, 15)).toBe(0);
  });
});
