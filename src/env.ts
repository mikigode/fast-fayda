import { hkdfSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Environment access. Reads are lazy so a missing variable surfaces as a clear
 * error where it is needed, rather than as a crash at import time that names
 * nothing useful.
 */

/**
 * Loads .env, if there is one, before anything reads configuration.
 *
 * Done here rather than with a dependency because it is fifteen lines and this
 * project otherwise needs exactly one package. Real environment variables
 * always win: a value exported in the shell, or set by a hosting platform, is
 * more specific than a file checked into a working directory, and silently
 * overriding it would be the kind of surprise that costs an afternoon.
 *
 * Without this, `npm run setup` would write a .env that `npm run dev` then
 * ignored, and the bot would report the variables missing immediately after
 * being told what they were.
 */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = (rawValue ?? "").trim().replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const env = {
  /** Postgres connection string. The bot owns this database; nothing else uses it. */
  get databaseUrl() {
    return required("DATABASE_URL");
  },

  /** From @BotFather. */
  get telegramBotToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  /**
   * Same value, but reading it must not throw: the admin portal needs
   * somewhere to say "not configured" rather than crash the request that was
   * asking.
   */
  get telegramBotTokenOrEmpty() {
    return process.env.TELEGRAM_BOT_TOKEN ?? "";
  },

  /**
   * Shared secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token.
   *
   * Not derived from anything, because the value also lives on Telegram's side
   * — set by setWebhook — so it is external state that has to be chosen once
   * and used in both places. Without it the webhook is an unauthenticated
   * endpoint that anyone who guesses the path can post forged updates to, so
   * the server refuses to start rather than run open.
   */
  get webhookSecret() {
    // Deliberately not required(): reading this must not throw.
    //
    // It is the first thing the webhook touches, and on a serverless platform
    // there is no startup where a missing variable could have been caught — so
    // throwing here crashed the function outright, which reads to the caller as
    // "the code is broken" rather than "a variable is not set". Empty means
    // unconfigured, which secretMatches() already treats as "let nobody in".
    return process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  },

  /** Whether this deployment can serve a webhook at all. */
  get webhookConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);
  },

  /**
   * How updates arrive.
   *
   * `polling` needs no public URL and no hosting, which is what makes it the
   * mode to develop and demonstrate in. `webhook` is the one that scales, and
   * the one to run in production: exactly one process may poll a bot at a time,
   * so polling cannot be scaled past a single instance.
   */
  get botMode(): "webhook" | "polling" {
    return process.env.BOT_MODE === "polling" ? "polling" : "webhook";
  },

  /** Where the webhook is mounted. Changing it changes the URL given to setWebhook. */
  get webhookPath() {
    const path = process.env.WEBHOOK_PATH ?? "/webhook";
    return path.startsWith("/") ? path : `/${path}`;
  },

  get port() {
    return Number(process.env.PORT ?? 8080);
  },

  /**
   * Chat that support messages are forwarded to — a group with the bot in it,
   * or an operator's own chat. Group IDs are negative.
   */
  get supportChatId(): number | null {
    const raw = process.env.BOT_SUPPORT_CHAT_ID;
    if (!raw) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  },

  /**
   * Chat told about every new user who starts the bot. Defaults to the
   * support chat; set NEW_USER_GROUP_ID to send it somewhere else.
   */
  get newUserGroupId(): number | null {
    const raw = process.env.NEW_USER_GROUP_ID ?? process.env.BOT_SUPPORT_CHAT_ID;
    if (!raw) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  },

  /** What one print costs, in birr. A payment buys floor(amount / price) points. */
  get pointPriceEtb() {
    const value = Number(process.env.POINT_PRICE_ETB ?? 15);
    return Number.isFinite(value) && value > 0 ? value : 15;
  },

  /**
   * Telegram IDs allowed to approve or reject a queued payment.
   *
   * An allow-list rather than a role in the database: the people who can create
   * points out of nothing should be named in the deployment's configuration,
   * where changing the list is a deliberate act with an audit trail, not a row
   * anyone with database access can add themselves to.
   */
  get adminTelegramIds(): number[] {
    return (process.env.ADMIN_TELEGRAM_IDS ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isSafeInteger(value) && value !== 0);
  },

  /** Who the bot tells people to contact. Appears in several messages. */
  get adminContact() {
    return process.env.ADMIN_CONTACT ?? "the administrator";
  },

  /** Points a print costs. Charged when the customer's document is received. */
  get pointsPerPrint() {
    const value = Number(process.env.POINTS_PER_PRINT ?? 1);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
  },

  /**
   * Fallback receiving accounts, shown in Buy Points until the portal sets
   * real ones in app_settings — which take priority once present. Blank means
   * the bot says accounts are not configured rather than showing nothing and
   * leaving a customer to guess where to send money.
   */
  get cbeAccountName() {
    return process.env.CBE_ACCOUNT_NAME ?? "";
  },
  get cbeAccountNumber() {
    return process.env.CBE_ACCOUNT_NUMBER ?? "";
  },
  get telebirrAccountName() {
    return process.env.TELEBIRR_ACCOUNT_NAME ?? "";
  },
  get telebirrAccountNumber() {
    return process.env.TELEBIRR_ACCOUNT_NUMBER ?? "";
  },

  // ---- admin portal -------------------------------------------------------
  /**
   * Signs the portal's session cookie.
   *
   * Derived from idHashSecret (itself derived from DATABASE_URL when unset) so
   * a working portal needs no variable beyond what the bot already requires —
   * consistent with the rest of this file. A distinct HKDF info string keeps
   * it unrelated to the ID-hashing key even though both trace back to the same
   * root. Set ADMIN_SESSION_SECRET to decouple it — doing so invalidates every
   * signed-in session, which is also how to force everyone out at once.
   */
  get adminSessionSecret() {
    const explicit = process.env.ADMIN_SESSION_SECRET;
    if (explicit && explicit.length >= 32) return explicit;
    if (explicit) {
      throw new Error(
        `ADMIN_SESSION_SECRET is set but only ${explicit.length} characters; it needs at least 32.`,
      );
    }
    return deriveFrom(this.idHashSecret, "fast-fayda/admin-session/v1");
  },

  // ---- card retrieval -----------------------------------------------------
  /**
   * Where the FAN → OTP → PDF flow is served from.
   *
   * Inferred from the key rather than set separately: a deployment that has a
   * card API key wants the card API, and a second variable to agree with the
   * first is only a way for the two to disagree.
   */
  get cardProvider(): "unconfigured" | "http" {
    return this.cardApiKey ? "http" : "unconfigured";
  },
  get cardApiUrl() {
    return process.env.CARD_API_URL ?? "https://otp.affiliate.pro.et/api/v1";
  },
  /** Server-side only. It must never be handed to a mini-app or any client. */
  get cardApiKey() {
    return process.env.CARD_API_KEY ?? "";
  },
  /**
   * How long to wait on a verify. The provider documents 60–120 seconds,
   * because it is waiting on an upstream validation of its own.
   *
   * The default sits just under Telegram's webhook window, so a slow verify
   * comes back as a message saying so rather than as a delivery Telegram
   * retries — and a retried update would re-run the flow and spend a second
   * point on a code that has already been used. On a platform with a shorter
   * function limit than this, lower it to fit; see the README.
   */
  get cardApiTimeoutMs() {
    const value = Number(process.env.CARD_API_TIMEOUT_MS ?? 55_000);
    return Number.isFinite(value) && value >= 1_000 ? value : 55_000;
  },
  /**
   * Encrypts the FAN while an OTP is outstanding — see src/crypto.ts for what
   * that does and does not protect. Derived like every other key here, so a
   * deployment needs no extra variable; rotating it only invalidates OTP
   * sessions in flight, which expire in ten minutes anyway.
   */
  get otpSecretKey(): Buffer {
    return Buffer.from(deriveFrom(this.idHashSecret, "fast-fayda/otp-session/v1"), "base64url").subarray(
      0,
      32,
    );
  },

  /**
   * Which backend answers a status check. Unset means none: the bot says the
   * check is unavailable, which is true, rather than inventing an answer.
   */
  get faydaProvider(): "unconfigured" | "stub" | "http" {
    const value = process.env.FAYDA_PROVIDER;
    if (value === "stub" || value === "http") return value;
    return "unconfigured";
  },
  get faydaApiUrl() {
    return process.env.FAYDA_API_URL ?? "";
  },
  get faydaApiKey() {
    return process.env.FAYDA_API_KEY ?? "";
  },

  /**
   * Keys the HMAC that stands in for a submitted ID number in the audit log.
   *
   * When it is not set, one is derived from DATABASE_URL. That keeps the number
   * of variables a deployment must get right small, and the derived key has the
   * properties this needs: stable across restarts and instances (so a hash
   * written last week still matches one written today), secret (DATABASE_URL
   * holds the database password and never leaves the server), and separated by
   * HKDF's info string so it cannot be run backwards into the password.
   *
   * The trade-off is that rotating the database password makes existing hashes
   * unmatchable. Nothing depends on matching them across a rotation today —
   * they are written and counted, never looked up by value — but set
   * ID_HASH_SECRET explicitly to decouple the two.
   */
  get idHashSecret() {
    const explicit = process.env.ID_HASH_SECRET;
    if (explicit && explicit.length >= 32) return explicit;
    if (explicit) {
      throw new Error(
        `ID_HASH_SECRET is set but only ${explicit.length} characters; it needs at least 32. ` +
          "Generate one with: openssl rand -base64 48 — or remove it and one is derived from DATABASE_URL.",
      );
    }
    return deriveKey(this.databaseUrl);
  },
};

export function deriveKey(databaseUrl: string): string {
  const key = hkdfSync(
    "sha256",
    Buffer.from(databaseUrl, "utf8"),
    Buffer.from("fast-fayda/id-hash/v1", "utf8"),
    Buffer.from("HMAC key for hashed application numbers", "utf8"),
    48,
  );
  return Buffer.from(key).toString("base64url");
}

/**
 * HKDF-SHA256 off some other secret this file already derived, rather than off
 * DATABASE_URL directly — kept distinct from `deriveKey` so that function's
 * output for existing deployments never changes. `info` gives each derived key
 * its own identity from the same root.
 */
function deriveFrom(root: string, info: string): string {
  const key = hkdfSync(
    "sha256",
    Buffer.from(root, "utf8"),
    Buffer.from(info, "utf8"),
    Buffer.from("fast-fayda derived key", "utf8"),
    48,
  );
  return Buffer.from(key).toString("base64url");
}

/**
 * Which variables this process can actually see, by name.
 *
 * Written for one question that costs a deploy cycle every time it is guessed
 * at: is the platform injecting anything at all? A host that shows every name
 * as missing is not configured — wrong service, wrong environment, or
 * build-time variables that never reach the runtime container. A host that
 * shows some set and one missing is a typo in that one name.
 *
 * Values are printed only for the handful that are settings rather than
 * secrets. Everything else reports set/missing and nothing more: a log is a
 * place secrets leak from, and this function exists to be called precisely
 * when someone is about to paste the output to somebody else.
 */
const SAFE_TO_PRINT = new Set([
  "BOT_MODE",
  "WEBHOOK_PATH",
  "PORT",
  "FAYDA_PROVIDER",
  "POINT_PRICE_ETB",
  "POINTS_PER_PRINT",
  "CARD_API_URL",
  "NODE_ENV",
]);

const KNOWN_VARS = [
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "BOT_MODE",
  "WEBHOOK_PATH",
  "PORT",
  "NODE_ENV",
  "ADMIN_TELEGRAM_IDS",
  "ADMIN_CONTACT",
  "BOT_SUPPORT_CHAT_ID",
  "CARD_API_KEY",
  "CARD_API_URL",
  "POINT_PRICE_ETB",
  "POINTS_PER_PRINT",
  "FAYDA_PROVIDER",
];

/**
 * Set by the platform, not by an operator — so they are shown but do not count
 * as evidence that anyone's configuration arrived.
 *
 * Without this exclusion the count would be at least one on nearly every host
 * (nixpacks and npm both set NODE_ENV), which would suppress the "nothing at
 * all is set" message in exactly the situation it is written for.
 */
const PLATFORM_INJECTED = new Set(["NODE_ENV", "PORT"]);

export function configReport(): string {
  const lines = KNOWN_VARS.map((name) => {
    const raw = process.env[name];
    const state = !raw ? "missing" : SAFE_TO_PRINT.has(name) ? `set — ${raw}` : "set";
    return `  ${name.padEnd(24)} ${state}`;
  });
  const ours = KNOWN_VARS.filter((name) => !PLATFORM_INJECTED.has(name));
  const seen = ours.filter((name) => process.env[name]).length;
  return (
    `Configuration visible to this process (${seen} of ${ours.length} set):\n` +
    lines.join("\n") +
    (seen === 0
      ? "\n\nNothing at all is set. The variables are not reaching this container:\n" +
        "  - check they are set on the service and environment actually running\n" +
        "    (a blue/green deploy starts a *staging* container, which may have its own set)\n" +
        "  - check they are runtime variables, not build-only ones\n"
      : "")
  );
}

/**
 * Checked once at startup, so a deployment missing a variable fails on boot
 * with the name of it rather than on the first person who says hello.
 */
export function assertConfigured(): void {
  void env.databaseUrl;
  void env.telegramBotToken;
  // Polling has no inbound requests to authenticate, so it needs no secret.
  // Requiring one anyway would be a variable to invent for no purpose.
  if (env.botMode === "webhook" && !env.webhookSecret) {
    throw new Error(
      "Missing environment variable TELEGRAM_WEBHOOK_SECRET. Generate one with: " +
        "npm run webhook secret — or set BOT_MODE=polling, which needs no secret.",
    );
  }
  if (env.faydaProvider === "http" && !env.faydaApiUrl) {
    throw new Error("FAYDA_PROVIDER=http needs FAYDA_API_URL.");
  }
}
