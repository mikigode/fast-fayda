import { describe, expect, it } from "vitest";
import { verifyPayment } from "@/bot/payments";
import { parseReceipt } from "@/bot/receipts";

/**
 * What a claimed payment is worth, and — more importantly — who bears the cost
 * when the bank's page cannot be read.
 */

const RECEIPT = parseReceipt("FT25391XM4KP")!;
const page = (amount: string) => `<table><tr><td>Amount</td><td>${amount}</td></tr></table>`;

const opts = (fetchReceipt: (url: string) => Promise<string | null>) => ({
  fetchReceipt,
  pricePerPoint: 15,
});

describe("verifyPayment", () => {
  it("credits points when the page reads cleanly", async () => {
    const result = await verifyPayment(RECEIPT, opts(async () => page("ETB 150.00")));
    expect(result).toEqual({ decision: "credit", amountEtb: 150, points: 10 });
  });

  it("fetches the receipt's own verify URL", async () => {
    let asked = "";
    await verifyPayment(
      RECEIPT,
      opts(async (url) => {
        asked = url;
        return page("ETB 15.00");
      }),
    );
    expect(asked).toBe("https://apps.cbe.com.et:100/?id=FT25391XM4KP");
  });

  it("rounds down to whole points", async () => {
    const result = await verifyPayment(RECEIPT, opts(async () => page("ETB 160.00")));
    expect(result).toMatchObject({ decision: "credit", points: 10 });
  });

  /**
   * The three ways this can go wrong on our side all have to land in the same
   * place: a queue, not a refusal. A customer who paid must never be told they
   * did not because a web page moved.
   */
  it("queues for review when the page cannot be fetched", async () => {
    const result = await verifyPayment(RECEIPT, opts(async () => null));
    expect(result).toEqual({ decision: "review", reason: "unreachable", amountEtb: null });
  });

  it("queues for review when the fetch throws", async () => {
    const result = await verifyPayment(
      RECEIPT,
      opts(async () => {
        throw new Error("certificate expired");
      }),
    );
    expect(result).toMatchObject({ decision: "review", reason: "unreachable" });
  });

  it("queues for review when the page has no amount on it", async () => {
    const result = await verifyPayment(
      RECEIPT,
      opts(async () => "<html><body>Transaction not found</body></html>"),
    );
    expect(result).toEqual({ decision: "review", reason: "no_amount", amountEtb: null });
  });

  it("rejects only when it read the page and the amount is too small", async () => {
    const result = await verifyPayment(RECEIPT, opts(async () => page("ETB 10.00")));
    expect(result).toEqual({ decision: "reject", reason: "below_minimum", amountEtb: 10 });
  });

  it("honours a different price per point", async () => {
    const result = await verifyPayment(RECEIPT, {
      fetchReceipt: async () => page("ETB 100.00"),
      pricePerPoint: 25,
    });
    expect(result).toMatchObject({ decision: "credit", points: 4 });
  });
});
