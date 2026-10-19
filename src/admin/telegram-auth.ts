import crypto from "node:crypto";

/**
 * Verifies the payload Telegram's Login Widget redirects back with.
 *
 * https://core.telegram.org/widgets/login#checking-authorization
 *
 * The widget signs every field except `hash` itself with a key derived from
 * the bot token, so anyone who can read this code but not the token cannot
 * forge a login — the same trust boundary the bot API itself rests on.
 */

export type TelegramLoginPayload = {
  id: number;
  first_name: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
};

export class TelegramLoginError extends Error {}

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

/** Every field the widget can send, in the order they arrive from a query string. */
const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"] as const;

export function verifyTelegramLogin(
  params: URLSearchParams,
  botToken: string,
): TelegramLoginPayload {
  const hash = params.get("hash");
  if (!hash) throw new TelegramLoginError("Missing hash.");

  const dataCheckString = FIELDS.filter((field) => params.has(field))
    .map((field) => `${field}=${params.get(field)}`)
    .sort()
    .join("\n");

  const secret = crypto.createHash("sha256").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  if (!timingSafeEqualHex(hash, expected)) {
    throw new TelegramLoginError("Signature does not match.");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) throw new TelegramLoginError("Missing auth_date.");
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > MAX_AUTH_AGE_SECONDS) throw new TelegramLoginError("Login has expired. Try again.");
  if (age < -300) throw new TelegramLoginError("Login has an invalid timestamp.");

  const id = Number(params.get("id"));
  if (!Number.isSafeInteger(id)) throw new TelegramLoginError("Missing id.");

  return {
    id,
    first_name: params.get("first_name") ?? "",
    username: params.get("username") ?? undefined,
    photo_url: params.get("photo_url") ?? undefined,
    auth_date: authDate,
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/**
 * A stateless signed cookie: telegram_id and an expiry, HMAC'd. No session
 * table — nothing to clean up, and revoking access (removing an admin) takes
 * effect on the next request because admin membership is re-checked every
 * time, not baked into the cookie.
 */

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function signSession(telegramId: number, secret: string): string {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `${telegramId}.${expires}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function verifySession(cookie: string | undefined, secret: string): number | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [idPart, expiresPart, signature] = parts;
  const payload = `${idPart}.${expiresPart}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (!signature || !timingSafeEqualHex(signature, expected)) return null;

  const expires = Number(expiresPart);
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return null;

  const telegramId = Number(idPart);
  return Number.isSafeInteger(telegramId) ? telegramId : null;
}
