import crypto from "node:crypto";
import { env } from "../env";
import type { ApplicationStatus } from "./i18n";

/**
 * Application-number handling: what counts as a number, how it is hashed for
 * the audit log, and where a status actually comes from.
 *
 * The lookup itself is behind a provider interface because there is no public
 * API for it — reaching the real registry needs credentials from whoever runs
 * it. Rather than pretend otherwise, an unconfigured deployment answers
 * "unavailable" and says so to the user. Everything around the lookup (input
 * validation, rate limiting, auditing, the conversation) works regardless, so
 * dropping in the real backend is one module, not a rewrite.
 */

export type IdKind = "fin" | "fan";

/** Digit counts, by kind. Confirm against the real bot before launch. */
const LENGTHS: Record<IdKind, number> = { fin: 12, fan: 16 };

/**
 * Arabic-Indic and Extended Arabic-Indic digits map to ASCII.
 *
 * Some Ethiopian Android keyboards produce them, and a number typed on one of
 * those looks like ordinary digits to the person who sent it. Rejecting it as
 * "not a number" would be baffling and unfixable from their side.
 */
function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Strips the spaces, dashes and separators people type into long numbers. */
export function normalizeId(input: string): string {
  return toAsciiDigits(input.trim()).replace(/[\s\-_/.]/g, "");
}

export type ParsedId = { kind: IdKind; digits: string };

/**
 * Returns null for anything that is not a plausible FIN or FAN. Length alone
 * separates them, so a number of the wrong length is rejected here rather than
 * being sent to the registry to be rejected there.
 */
export function parseId(input: string): ParsedId | null {
  const digits = normalizeId(input);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === LENGTHS.fin) return { kind: "fin", digits };
  if (digits.length === LENGTHS.fan) return { kind: "fan", digits };
  return null;
}

/** Last four digits, for showing a person which attempt is being reported on. */
export function last4(digits: string): string {
  return digits.slice(-4);
}

/**
 * Keyed hash of a submitted number, for the audit log.
 *
 * HMAC rather than a plain digest: a 12-digit space is ~10^12, which is an
 * afternoon of brute force against an unkeyed hash, so SHA-256 alone would
 * store the number in all but name. See env.idHashSecret for where the key
 * comes from and what rotating it costs.
 */
export function hashId(digits: string): string {
  const key = crypto.hkdfSync(
    "sha256",
    Buffer.from(env.idHashSecret, "utf8"),
    Buffer.from("fast-fayda/id-hash-hmac/v1", "utf8"),
    Buffer.from("HMAC key for hashed application numbers", "utf8"),
    32,
  );
  return crypto.createHmac("sha256", Buffer.from(key)).update(digits).digest("hex");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type LookupResult =
  | { outcome: "found"; status: ApplicationStatus; updatedAt: string | null }
  | { outcome: "not_found" }
  | { outcome: "unavailable" }
  | { outcome: "error" };

export type FaydaProvider = {
  name: string;
  lookup(id: ParsedId): Promise<LookupResult>;
};

/** The default. Honest about having no registry to ask. */
export const unconfiguredProvider: FaydaProvider = {
  name: "unconfigured",
  async lookup() {
    return { outcome: "unavailable" };
  },
};

const STATUS_CYCLE: ApplicationStatus[] = [
  "submitted",
  "processing",
  "approved",
  "printed",
  "ready",
  "collected",
];

/**
 * Development stand-in, so the whole conversation can be walked end to end
 * without credentials.
 *
 * Its answers are derived from the number itself, which makes them stable —
 * the same number gives the same status every time, so a demo does not change
 * its story halfway through. Numbers ending in 0 report "not found" so that
 * path is reachable too.
 *
 * Refuses to run in production: a fabricated status about someone's national ID
 * is worse than an outage, because it looks like an answer.
 */
export const stubProvider: FaydaProvider = {
  name: "stub",
  async lookup(id) {
    if (process.env.NODE_ENV === "production") return { outcome: "unavailable" };
    if (id.digits.endsWith("0")) return { outcome: "not_found" };
    const index = Number(id.digits.slice(-1)) % STATUS_CYCLE.length;
    return {
      outcome: "found",
      status: STATUS_CYCLE[index] as ApplicationStatus,
      updatedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
    };
  },
};

const KNOWN_STATUSES = new Set<string>([...STATUS_CYCLE, "rejected"]);

/**
 * Talks to whatever HTTP service actually holds the statuses.
 *
 * The shape assumed is the simplest one that could work — `{ status,
 * updated_at }`, 404 for a number that is not there — and is where to adjust
 * when the real endpoint is known. An unrecognised status string is reported as
 * "not found" rather than shown raw: passing an untranslated internal code
 * through to a person tells them nothing and looks broken.
 */
export function httpProvider(baseUrl: string, apiKey: string): FaydaProvider {
  return {
    name: "http",
    async lookup(id) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl.replace(/\/$/, "")}/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ kind: id.kind, number: id.digits }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        return { outcome: "unavailable" };
      }

      if (response.status === 404) return { outcome: "not_found" };
      if (!response.ok) return { outcome: "unavailable" };

      let body: { status?: string; updated_at?: string };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        return { outcome: "error" };
      }

      const status = body.status?.toLowerCase() ?? "";
      if (!KNOWN_STATUSES.has(status)) return { outcome: "not_found" };
      return {
        outcome: "found",
        status: status as ApplicationStatus,
        updatedAt: body.updated_at ?? null,
      };
    },
  };
}

/** Chosen by environment, resolved per call so a redeploy is not needed. */
export function currentProvider(): FaydaProvider {
  switch (env.faydaProvider) {
    case "stub":
      return stubProvider;
    case "http":
      return httpProvider(env.faydaApiUrl, env.faydaApiKey);
    default:
      return unconfiguredProvider;
  }
}
