import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The HTTP surface, over a real socket.
 *
 * Only the paths that end before the handler needs a database are exercised
 * here — which is every path that matters for keeping strangers out. An
 * unauthenticated webhook is the one mistake in this service that would be
 * silent: it would work perfectly, for anyone.
 */

const SECRET = "test-webhook-secret";

let server: Server;
let base: string;
let setReady: (value: boolean, reason?: string | null) => void;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused@127.0.0.1:5432/unused?sslmode=disable";
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST";
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  // Pinned so a local .env cannot remount the endpoint under another path, or
  // switch the mode to polling — both of which would turn /webhook into a 404.
  process.env.WEBHOOK_PATH = "/webhook";
  process.env.BOT_MODE = "webhook";
  const serverModule = await import("@/server");
  setReady = serverModule.setReady;
  server = serverModule.createBotServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("webhook endpoint", () => {
  it("reports health without a secret", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "fast-fayda",
      ready: true,
    });
  });

  /**
   * The server listens before it has migrated, so a slow database cannot cost
   * a deployment its health check. What keeps that safe is below: an update
   * arriving in the gap is refused with a status Telegram retries, rather than
   * acknowledged with a 200 and dropped.
   */
  describe("before the schema is ready", () => {
    beforeEach(() => setReady(false, "connect ECONNREFUSED"));
    afterEach(() => setReady(true, null));

    it("still answers the health check, and says why it is not ready", async () => {
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        ready: false,
        reason: "connect ECONNREFUSED",
      });
    });

    it("refuses an update with 503, which Telegram retries", async () => {
      const response = await post('{"update_id":1}', {
        "x-telegram-bot-api-secret-token": SECRET,
      });
      expect(response.status).toBe(503);
    });

    it("still answers a bad secret with 401, revealing nothing about its state", async () => {
      const response = await post('{"update_id":1}', {
        "x-telegram-bot-api-secret-token": "nope",
      });
      expect(response.status).toBe(401);
    });
  });

  it("refuses a request with no secret", async () => {
    expect((await post('{"update_id":1}')).status).toBe(401);
  });

  it("refuses a request with the wrong secret", async () => {
    const response = await post('{"update_id":1}', { "x-telegram-bot-api-secret-token": "nope" });
    expect(response.status).toBe(401);
  });

  it("refuses a secret that is a prefix of the real one", async () => {
    // The constant-time compare rejects a length mismatch before comparing, so
    // this is a check that it does not somehow pass a partial match.
    const response = await post('{"update_id":1}', {
      "x-telegram-bot-api-secret-token": SECRET.slice(0, -1),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a body that is not JSON, once authenticated", async () => {
    const response = await post("not json", { "x-telegram-bot-api-secret-token": SECRET });
    expect(response.status).toBe(400);
  });

  it("rejects JSON that is not an update", async () => {
    const response = await post('{"hello":"world"}', {
      "x-telegram-bot-api-secret-token": SECRET,
    });
    expect(response.status).toBe(400);
  });

  it("404s an unknown path and 405s the wrong method", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/webhook`)).status).toBe(405);
  });
});
