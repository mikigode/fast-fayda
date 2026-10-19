import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TelegramLoginError,
  signSession,
  verifySession,
  verifyTelegramLogin,
} from "@/admin/telegram-auth";

const TOKEN = "123456:TEST-BOT-TOKEN-abcdefghijklmnop";

/** Builds a correctly signed Login Widget payload, the way Telegram does. */
function sign(fields: Record<string, string>, token = TOKEN): URLSearchParams {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = crypto.createHash("sha256").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash });
}

function now(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifyTelegramLogin", () => {
  it("accepts a correctly signed payload", () => {
    const params = sign({ id: "4242", first_name: "Amina", auth_date: now() });
    const result = verifyTelegramLogin(params, TOKEN);
    expect(result).toMatchObject({ id: 4242, first_name: "Amina" });
  });

  it("includes optional fields in the signature when present", () => {
    const params = sign({
      id: "4242",
      first_name: "Amina",
      username: "amina",
      photo_url: "https://t.me/photo.jpg",
      auth_date: now(),
    });
    expect(verifyTelegramLogin(params, TOKEN)).toMatchObject({ username: "amina" });
  });

  it("rejects a tampered field", () => {
    const params = sign({ id: "4242", first_name: "Amina", auth_date: now() });
    params.set("id", "9999"); // change the id after signing
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(TelegramLoginError);
  });

  it("rejects a payload signed with a different bot token", () => {
    const params = sign({ id: "4242", first_name: "Amina", auth_date: now() }, "999:OTHER-TOKEN");
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(TelegramLoginError);
  });

  it("rejects a missing hash", () => {
    const params = new URLSearchParams({ id: "4242", first_name: "Amina", auth_date: now() });
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(/hash/i);
  });

  it("rejects an expired login", () => {
    const oldDate = String(Math.floor(Date.now() / 1000) - 25 * 60 * 60);
    const params = sign({ id: "4242", first_name: "Amina", auth_date: oldDate });
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(/expired/i);
  });

  it("rejects a timestamp implausibly in the future", () => {
    const futureDate = String(Math.floor(Date.now() / 1000) + 3600);
    const params = sign({ id: "4242", first_name: "Amina", auth_date: futureDate });
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(/invalid timestamp/i);
  });

  it("rejects a hash of the wrong length rather than throwing on a Buffer mismatch", () => {
    const params = sign({ id: "4242", first_name: "Amina", auth_date: now() });
    params.set("hash", "ab");
    expect(() => verifyTelegramLogin(params, TOKEN)).toThrow(TelegramLoginError);
  });
});

describe("session cookie", () => {
  const SECRET = "a".repeat(32);

  it("round-trips: signed then verified gives back the same id", () => {
    const cookie = signSession(555, SECRET);
    expect(verifySession(cookie, SECRET)).toBe(555);
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = signSession(555, SECRET);
    expect(verifySession(cookie, "b".repeat(32))).toBeNull();
  });

  it("rejects a tampered telegram id", () => {
    const cookie = signSession(555, SECRET);
    const [, expires, signature] = cookie.split(".");
    expect(verifySession(`999.${expires}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects a malformed cookie", () => {
    expect(verifySession("not-a-real-cookie", SECRET)).toBeNull();
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
  });

  it("rejects an expired session", () => {
    // A cookie whose expiry is already in the past, signed correctly.
    const payload = "555.1000000000";
    const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
    expect(verifySession(`${payload}.${signature}`, SECRET)).toBeNull();
  });
});
