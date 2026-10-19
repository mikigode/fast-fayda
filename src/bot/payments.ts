import { extractAmount, pointsFor, type ParsedReceipt } from "./receipts";

/**
 * Deciding what a claimed payment is worth.
 *
 * The shape of this is set by one fact: the bank pages this reads were built
 * for people, not for us. They change without notice, they rate-limit, and they
 * are sometimes just down. A verifier that treats "I could not read the page"
 * as "you did not pay" would rob customers every time CBE redesigns.
 *
 * So there are three outcomes, not two:
 *
 *   credit  — the page was read and the amount is enough
 *   review  — something went wrong on our side; a human decides, customer waits
 *   reject  — the page was read and the amount is too small to buy a point
 *
 * Only the third is a "no", and it is the only one the bot says no to on its
 * own authority. Everything uncertain becomes somebody's job rather than
 * somebody's loss.
 */

export type ReceiptFetcher = (url: string) => Promise<string | null>;

export type Verification =
  | { decision: "credit"; amountEtb: number; points: number }
  | { decision: "review"; reason: "unreachable" | "no_amount"; amountEtb: null }
  | { decision: "reject"; reason: "below_minimum"; amountEtb: number };

export type VerifyOptions = {
  fetchReceipt: ReceiptFetcher;
  pricePerPoint: number;
};

export async function verifyPayment(
  receipt: ParsedReceipt,
  { fetchReceipt, pricePerPoint }: VerifyOptions,
): Promise<Verification> {
  let html: string | null;
  try {
    html = await fetchReceipt(receipt.verifyUrl);
  } catch {
    html = null;
  }
  if (!html) return { decision: "review", reason: "unreachable", amountEtb: null };

  const amountEtb = extractAmount(html);
  if (amountEtb === null) return { decision: "review", reason: "no_amount", amountEtb: null };

  const points = pointsFor(amountEtb, pricePerPoint);
  if (points <= 0) return { decision: "reject", reason: "below_minimum", amountEtb };

  return { decision: "credit", amountEtb, points };
}

/**
 * Fetches a receipt page over HTTPS.
 *
 * Short timeout and a browser-ish user agent: these hosts are slow, and a
 * webhook handler cannot wait on them for long without Telegram redelivering
 * the update underneath it. A timeout is a `review`, not a rejection — see
 * above.
 *
 * CBE's receipt host has served an expired or mismatched certificate at times,
 * which fetch rejects. That surfaces as `null` here, which is right: it lands
 * in the review queue rather than being waved through.
 */
export const liveFetcher: ReceiptFetcher = async (url) => {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; fast-fayda/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (!response || !response.ok) return null;
  return response.text().catch(() => null);
};
