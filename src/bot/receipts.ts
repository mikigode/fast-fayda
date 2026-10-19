/**
 * Turning whatever someone pastes into a payment reference.
 *
 * People send six different things, all of them meaning "here is my payment":
 *
 *   1. https://apps.cbe.com.et:100/?id=FT25391XM4KP07823491
 *   2. https://mbreciept.cbe.com.et/FT26257QHWN-41985602
 *   3. FT25391XM4KP                        (CBE reference on its own)
 *   4. https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ
 *   5. CKM8P4YJNQ                          (Telebirr id on its own)
 *   6. the whole SMS or email, pasted, with one of the above buried in it
 *
 * All six reduce to a provider and a reference. Case 6 is why this scans rather
 * than matches: the text around a reference is unbounded, so the parser looks
 * for the reference *inside* whatever arrived instead of trying to recognise
 * the shape of the whole message.
 *
 * Nothing here decides whether a payment is real — see payments.ts. This only
 * answers "which payment is being claimed", which is what makes it a pure
 * function and worth testing exhaustively.
 */

export type Provider = "cbe" | "telebirr";

export type ParsedReceipt = {
  provider: Provider;
  /** Normalised: upper case, no separators. The identity of the payment. */
  reference: string;
  /** Where the receipt can be read back, for verification. */
  verifyUrl: string;
};

/**
 * A CBE reference is FT followed by a run of alphanumerics — FT25391XM4KP,
 * FT26257QHWN.
 *
 * The length is deliberately a range rather than a constant: real references
 * come in at eleven and twelve characters both, so pinning it to one length
 * silently rejects half of them. The bound exists only to stop the pattern
 * running away into surrounding text.
 *
 * Both link forms carry more than the reference. The apps.cbe URL appends the
 * last eight digits of the account (FT25391XM4KP07823491) and mbreciept
 * separates them with a dash (FT26257QHWN-41985602). That suffix is not part of
 * the payment's identity, and keeping it would let one transaction be redeemed
 * twice by sending the other link form — so normaliseCbe cuts it, and every
 * path runs through there.
 */
const CBE_REFERENCE = /\bFT[A-Z0-9]{8,18}\b/i;

/** Strips the account suffix both CBE link forms append to the reference. */
function normaliseCbe(raw: string): string {
  const upper = raw.toUpperCase().split("-")[0] ?? "";
  // The apps.cbe form runs the account's last eight digits straight on to the
  // end of the reference, with nothing to separate them. Lengths vary, so this
  // peels off exactly the eight-digit tail and keeps whatever preceded it.
  const withSuffix = /^(FT[A-Z0-9]{8,14}?)(\d{8})$/.exec(upper);
  return withSuffix?.[1] ?? upper;
}

/**
 * Telebirr ids are ten upper-case alphanumerics — CKM8P4YJNQ.
 *
 * That pattern is loose enough to match ordinary words in a pasted SMS, so a
 * bare id is only accepted when the message is essentially just the id. Inside
 * a longer text it has to come from the receipt URL, where there is no
 * ambiguity about what it is.
 */
const TELEBIRR_ID = /^[A-Z0-9]{10}$/i;
const TELEBIRR_URL = /transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]{10})/i;
const CBE_APPS_URL = /apps\.cbe\.com\.et(?::\d+)?\/\?id=([A-Z0-9]+)/i;
const CBE_MB_URL = /mbreciept\.cbe\.com\.et\/([A-Z0-9-]+)/i;

export function cbeVerifyUrl(reference: string): string {
  return `https://apps.cbe.com.et:100/?id=${reference}`;
}

export function telebirrVerifyUrl(reference: string): string {
  return `https://transactioninfo.ethiotelecom.et/receipt/${reference}`;
}

function cbe(reference: string): ParsedReceipt {
  const normalised = normaliseCbe(reference);
  return { provider: "cbe", reference: normalised, verifyUrl: cbeVerifyUrl(normalised) };
}

function telebirr(reference: string): ParsedReceipt {
  const normalised = reference.toUpperCase();
  return {
    provider: "telebirr",
    reference: normalised,
    verifyUrl: telebirrVerifyUrl(normalised),
  };
}

/**
 * Returns null when nothing in the input looks like a payment reference.
 *
 * Order matters: the URL forms are checked first because they are unambiguous,
 * and the bare-id case is checked last and only against the whole trimmed
 * input, so a stray ten-character word in a pasted SMS cannot be mistaken for a
 * Telebirr id.
 */
export function parseReceipt(input: string): ParsedReceipt | null {
  const text = input.trim();
  if (!text) return null;

  const telebirrUrl = TELEBIRR_URL.exec(text);
  if (telebirrUrl?.[1]) return telebirr(telebirrUrl[1]);

  // Both CBE link forms carry the reference plus an account suffix, which
  // normaliseCbe trims — so the URL match only has to confirm which host it
  // came from and hand over the path or query it found.
  const cbeUrl = CBE_APPS_URL.exec(text) ?? CBE_MB_URL.exec(text);
  if (cbeUrl?.[1]) {
    const reference = normaliseCbe(cbeUrl[1]);
    if (CBE_REFERENCE.test(reference)) return cbe(reference);
  }

  const bareCbe = CBE_REFERENCE.exec(text);
  if (bareCbe) return cbe(bareCbe[0]);

  // Last, and only when the message is the id and nothing else.
  if (TELEBIRR_ID.test(text)) return telebirr(text);

  return null;
}

// ---------------------------------------------------------------------------
// Reading an amount back off a receipt page
// ---------------------------------------------------------------------------

/**
 * Pulls the birr amount out of a fetched receipt.
 *
 * Both providers render HTML meant for a person, not an API response, so this
 * is a scrape and it will break when they redesign. That is survivable by
 * design: a receipt whose amount cannot be read is not rejected, it goes to a
 * human (see payments.ts). The failure mode of a layout change is therefore a
 * queue that needs attention, not customers losing money.
 *
 * Matches the largest plausible figure rather than the first: these pages carry
 * service charges and VAT alongside the transferred amount, and the first
 * number on the page is as often a fee as the total.
 */
export function extractAmount(html: string): number | null {
  // Strip tags so a number split across markup still reads as one string.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ");

  const amounts: number[] = [];
  // "1,250.00 ETB", "ETB 1,250.00", "Birr 1250"
  const pattern = /(?:ETB|BIRR)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:ETB|BIRR)/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) amounts.push(value);
  }

  if (amounts.length === 0) return null;
  return Math.max(...amounts);
}

/** Points bought by an amount, at the configured price. Never negative. */
export function pointsFor(amountEtb: number, pricePerPoint: number): number {
  if (!Number.isFinite(amountEtb) || amountEtb <= 0) return 0;
  if (!Number.isFinite(pricePerPoint) || pricePerPoint <= 0) return 0;
  return Math.floor(amountEtb / pricePerPoint);
}
