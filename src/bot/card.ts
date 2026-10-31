import { env } from "../env";
import { resolveSettings } from "./settings";
import type { BotStore } from "./store";

/**
 * The card provider: FAN in, OTP to the holder's phone, PDF or identity data out.
 *
 * Two things about this API shape drive the code below, and both are the kind
 * that fail confusingly rather than loudly if ignored.
 *
 * **A verify needs a 12-digit `finNumber`, which the bot does not collect.** The
 * provider's published docs describe a `{ otp, fanNumber, session }` body, but
 * the live API refuses it with "finNumber is required" on both `/verify-otp` and
 * `/verify-otp-json` (checked against the live endpoint). The bot only ever
 * holds the 16-digit FAN, so `finNumberFromFan` derives the FIN the provider
 * accepts: the FAN's last 12 digits. A live verify for FAN 5274670831630236
 * succeeds with finNumber 670831630236, and the response echoes the same `fin`.
 * If the provider ever changes that contract, verifying breaks loudly here.
 *
 * **The JSON verify is the primary one.** `/verify-otp-json` returns the
 * identity fields the designed card picture is drawn from, and that picture is
 * delivered for every completed verification. `/verify-otp` returns the
 * provider's rendered PDF, which formats other than "Printable Card" also want;
 * it is fetched by a second verify after the image has been delivered. Each
 * successful verify costs a point, so the customer's one point buys the card
 * and the service absorbs the extra upstream call. The PDF branch below is a
 * faithful client of the provider's API either way.
 *
 * **A successful JSON verify is not a PDF, and a PDF verify is not JSON.** The
 * two endpoints invert each other, so the response is always read as bytes
 * first and the format decided from what came back, never by assuming. Reading
 * a PDF as JSON gets "unexpected token %" from `%PDF-1.4`, which reads as a
 * broken client rather than a successful verification.
 *
 * **A verify costs a point upstream, on success.** The first (JSON) verify is
 * made exactly once per code: no retries, because a retry would either spend a
 * second point or fail on an already-used code. The optional PDF verify after
 * it is the router's deliberate second call, and its failure costs only the
 * PDF.
 *
 * The session token is opaque and must go back exactly as it arrived —
 * untrimmed, unparsed, unmodified.
 */

/**
 * The 12-digit FIN the provider demands at verify, derived from the 16-digit
 * FAN the user typed. The provider accepts the FAN's last 12 digits (see the
 * file comment); digits are stripped first so a spaced FAN still yields 12.
 */
function finNumberFromFan(fan: string): string {
  return fan.replace(/\D/g, "").slice(-12);
}


export type SendOtpResult =
  /** The code is on its way to `phone`, which is masked by the provider. */
  | { outcome: "sent"; session: string; phone: string }
  /** The provider refused, and said why in words meant for a person. */
  | { outcome: "rejected"; message: string }
  /** Not configured, unreachable, or broken. Never the customer's fault. */
  | { outcome: "unavailable" };

export type VerifyOtpResult =
  | { outcome: "verified"; format: "pdf"; pdf: Buffer; filename: string; remainingPoints: number | null }
  | { outcome: "verified"; format: "json"; identity: CardIdentity; remainingPoints: number | null }
  | { outcome: "rejected"; message: string }
  | { outcome: "unavailable" };

/**
 * The structured identity the JSON verify endpoint returns, per the vendor's
 * integration guide. Every pair field carries both scripts; `photo` and
 * `qrCode` are base64 images (or data URIs) for the designed card.
 */
export type CardIdentity = {
  fanNumber: string;
  fin: string;
  name: { amharic: string; english: string };
  dateOfBirth: { ethiopian: string; gregorian: string };
  gender: { amharic: string; english: string };
  nationality: { amharic: string; english: string };
  phone: string;
  address: {
    city: { amharic: string; english: string };
    subCity: { amharic: string; english: string };
    woreda: { amharic: string; english: string };
  };
  issueDate: { ethiopian: string; gregorian: string };
  expiryDate: { ethiopian: string; gregorian: string };
  photo: string | null;
  qrCode: string | null;
};

export type CardProvider = {
  name: string;
  sendOtp(fan: string): Promise<SendOtpResult>;
  verifyOtp(input: {
    fan: string;
    otp: string;
    session: string;
    /** Which endpoint: the rendered PDF, or the structured JSON. */
    format: "pdf" | "json";
    /**
     * Overrides the provider's default wait for this one call, for a caller
     * that has less time than the platform's usual budget.
     */
    timeoutMs?: number;
  }): Promise<VerifyOtpResult>;
  /** Upstream account balance, for monitoring. Null when it cannot be read. */
  balance(): Promise<{ points: number; status: string } | null>;
};

/**
 * What an unconfigured deployment does: says so, rather than inventing a card.
 *
 * Same reasoning as the status provider in fayda.ts — the conversation, the
 * points, the audit trail all work without credentials, so a deployment
 * without them is honest about it instead of half-broken.
 */
export const unconfiguredCardProvider: CardProvider = {
  name: "unconfigured",
  async sendOtp() {
    return { outcome: "unavailable" };
  },
  async verifyOtp() {
    return { outcome: "unavailable" };
  },
  async balance() {
    return null;
  },
};

/** The provider's own wording from a JSON error body, or null when it gave none. */
function errorMessage(bytes: Buffer): string | null {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Not JSON, so there is no message to read.
  }
  return null;
}

/** The provider's wording if it gave one, else a status-based line. */
function messageFrom(bytes: Buffer, status: number): string {
  return errorMessage(bytes) ?? `Verification failed (HTTP ${status}).`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function localizedPair(value: unknown): { amharic: string; english: string } {
  const pair = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { amharic: text(pair.amharic), english: text(pair.english) };
}

function calendarPair(value: unknown): { ethiopian: string; gregorian: string } {
  const pair = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { ethiopian: text(pair.ethiopian), gregorian: text(pair.gregorian) };
}

/** Reads the JSON verify shape defensively: any field may be missing. */
export function identityFromJson(parsed: any): CardIdentity {
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const data = typeof body.data === "object" && body.data !== null ? (body.data as Record<string, unknown>) : {};
  const address = typeof data.address === "object" && data.address !== null ? (data.address as Record<string, unknown>) : {};

  const photo = text(data.photo);
  const qrCode = text(data.qrCode);

  return {
    fanNumber: text(data.fanNumber),
    fin: text(data.fin),
    name: localizedPair(data.name),
    dateOfBirth: calendarPair(data.dateOfBirth),
    gender: localizedPair(data.gender),
    nationality: localizedPair(data.nationality),
    phone: text(data.phone),
    address: {
      city: localizedPair(address.city),
      subCity: localizedPair(address.subCity),
      woreda: localizedPair(address.woreda),
    },
    issueDate: calendarPair(data.issueDate),
    expiryDate: calendarPair(data.expiryDate),
    photo: photo || null,
    qrCode: qrCode || null,
  };
}

function filenameFrom(header: string | null, fallback: string): string {
  const match = /filename="?([^";]+)"?/.exec(header ?? "");
  const name = match?.[1]?.trim();
  // A provider-supplied filename ends up as a Telegram attachment name; strip
  // any path in it rather than trusting where it points.
  return name ? name.replace(/[/\\]/g, "_") : fallback;
}

/**
 * Points as a number, from either source the provider uses: the
 * `X-Remaining-Points` header (a string) or `remainingPoints` in the JSON body
 * (a number). Both are optional; either may be absent or junk.
 */
function toPoints(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const points = Number(value);
  return Number.isFinite(points) ? points : null;
}

/**
 * A configuration value that may be resolved on each call. The Card API key
 * especially: an admin can rotate it from the portal while the process keeps
 * running, so it is read per request rather than captured at construction. A
 * plain string still works, which is what tests and the env-only path pass.
 */
type Resolvable = string | (() => string | Promise<string>);

async function resolveValue(value: Resolvable): Promise<string> {
  return typeof value === "function" ? await value() : value;
}

export function httpCardProvider(
  baseUrl: Resolvable = env.cardApiUrl,
  apiKey: Resolvable = env.cardApiKey,
  timeoutMs = env.cardApiTimeoutMs,
): CardProvider {
  /**
   * The base URL and key for one call, or null when no key is configured at
   * all. Null means "unavailable", never "rejected": a deployment with no key
   * has not told the customer anything about their card.
   */
  async function requestContext(): Promise<{ root: string; key: string } | null> {
    const key = await resolveValue(apiKey);
    if (!key) return null;
    const url = await resolveValue(baseUrl);
    return { root: url.replace(/\/+$/, ""), key };
  }

  return {
    name: "http",

    async sendOtp(fan) {
      const context = await requestContext();
      if (!context) return { outcome: "unavailable" };
      let response: Response;
      try {
        response = await fetch(`${context.root}/send-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": context.key },
          body: JSON.stringify({ fanNumber: fan }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Deliberately does not include the request body: it holds a FAN.
        console.error("card send-otp failed:", error instanceof Error ? error.message : error);
        return { outcome: "unavailable" };
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) return { outcome: "rejected", message: messageFrom(bytes, response.status) };

      const contentType = response.headers.get("content-type") ?? "no content type";
      try {
        const body = JSON.parse(bytes.toString("utf8")) as {
          session?: unknown;
          phone?: unknown;
          message?: unknown;
        };
        if (typeof body.session === "string" && body.session) {
          return {
            outcome: "sent",
            session: body.session,
            phone: typeof body.phone === "string" ? body.phone : "",
          };
        }
        // A 200 with no session is the provider declining in its documented
        // error shape — an unknown FAN, most often. This used to be reported as
        // "not connected", which told the customer the deployment was broken
        // when the number they typed was. The body is never logged: it can name
        // the FAN.
        const message =
          typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;
        if (message) return { outcome: "rejected", message };
        console.error(`card send-otp: 200 without a session or a message (${contentType})`);
        return { outcome: "unavailable" };
      } catch {
        console.error(`card send-otp: expected JSON, got ${contentType}`);
        return { outcome: "unavailable" };
      }
    },

    async verifyOtp({ fan, otp, session, format, timeoutMs: callTimeoutMs }) {
      const context = await requestContext();
      if (!context) return { outcome: "unavailable" };
      const endpoint = format === "json" ? "/verify-otp-json" : "/verify-otp";
      let response: Response;
      try {
        response = await fetch(`${context.root}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": context.key },
          // The session goes back exactly as it arrived. Trimming or
          // re-encoding it is the documented way to get "session is invalid".
          // `finNumber` is not in the docs but is required live; it is derived
          // from the FAN (see the file comment).
          body: JSON.stringify({ otp, fanNumber: fan, finNumber: finNumberFromFan(fan), session }),
          signal: AbortSignal.timeout(callTimeoutMs ?? timeoutMs),
        });
      } catch (error) {
        console.error("card verify-otp failed:", error instanceof Error ? error.message : error);
        return { outcome: "unavailable" };
      }

      // Read as bytes first, always. On PDF success this is a PDF, and asking
      // for text or JSON before knowing that corrupts it.
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      const remainingPoints = toPoints(response.headers.get("x-remaining-points"));

      if (format === "json") {
        // Success is JSON on this endpoint; the guide is explicit that
        // response.json() is correct here, and that an error is JSON too.
        if (response.ok) {
          let parsed: { success?: unknown; data?: unknown; remainingPoints?: unknown };
          try {
            parsed = JSON.parse(bytes.toString("utf8")) as {
              success?: unknown;
              data?: unknown;
              remainingPoints?: unknown;
            };
          } catch {
            console.error(`card verify-otp-json: expected JSON, got ${contentType || "no content type"}`);
            return { outcome: "unavailable" };
          }
          if (parsed.success === true) {
            return {
              outcome: "verified",
              format: "json",
              identity: identityFromJson(parsed),
              // The header carries it too, but the guide lists it in the body
              // as well — so a provider that sends only one is still read.
              remainingPoints: remainingPoints ?? toPoints(parsed.remainingPoints),
            };
          }
          // The guide's own bot treats `success !== true` as the error to show,
          // whatever the status code. Relay the provider's wording when it gave
          // one; with none, the contract moved and nobody is at fault.
          const message = errorMessage(bytes);
          if (message) return { outcome: "rejected", message };
          console.error("card verify-otp-json: success was not true in a 200 body");
          return { outcome: "unavailable" };
        }
        return { outcome: "rejected", message: messageFrom(bytes, response.status) };
      }

      if (response.ok && contentType.includes("application/pdf")) {
        return {
          outcome: "verified",
          format: "pdf",
          pdf: bytes,
          filename: filenameFrom(response.headers.get("content-disposition"), "fayda.pdf"),
          remainingPoints,
        };
      }

      if (!response.ok) {
        // Documented error shape: JSON with a message, on a 4xx or 5xx.
        return { outcome: "rejected", message: messageFrom(bytes, response.status) };
      }

      // A 200 that is not a PDF. The guide's rule is to read a JSON body and
      // show its message; when there is none, the contract has changed under us
      // and nobody is at fault, so it is unavailable rather than a rejection.
      const message = errorMessage(bytes);
      if (message) return { outcome: "rejected", message };
      console.error(`card verify-otp: expected a PDF, got ${contentType || "no content type"}`);
      return { outcome: "unavailable" };
    },

    async balance() {
      const context = await requestContext();
      if (!context) return null;
      try {
        const response = await fetch(`${context.root}/balance`, {
          headers: { "x-api-key": context.key },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { points?: unknown; status?: unknown };
        if (typeof body.points !== "number") return null;
        return {
          points: body.points,
          status: typeof body.status === "string" ? body.status : "unknown",
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The provider this deployment is configured for.
 *
 * Given a store, the key is read from the portal's settings on every call
 * (falling back to CARD_API_KEY), so an admin can set or rotate it without a
 * redeploy. Without a store — tests, and the env-only path — the key is the
 * environment variable, and a deployment with none gets the honest
 * "unconfigured" provider rather than requests that cannot authenticate.
 */
export function liveCardProvider(store?: BotStore): CardProvider {
  if (store) {
    return httpCardProvider(
      env.cardApiUrl,
      async () => (await resolveSettings(store)).cardApiKey,
      env.cardApiTimeoutMs,
    );
  }
  return env.cardProvider === "http" ? httpCardProvider() : unconfiguredCardProvider;
}
