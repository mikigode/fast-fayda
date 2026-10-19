import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The serverless entry point.
 *
 * It is a second front door onto the same bot, and the thing that must not
 * differ from the first is who gets through it. These are the same
 * authentication cases as tests/server.test.ts, run against the Vercel handler,
 * so the two cannot drift apart unnoticed.
 */

const SECRET = "test-webhook-secret";

type Captured = { status: number; body: unknown };

function fakeResponse(): { captured: Captured; res: never } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    send(body: string) {
      captured.body = body;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  return { captured, res: res as never };
}

let handler: typeof import("../api/webhook").default;
let health: typeof import("../api/health").default;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused@127.0.0.1:5432/unused?sslmode=disable";
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST";
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  handler = (await import("../api/webhook")).default;
  health = (await import("../api/health")).default;
});

const call = (
  headers: Record<string, string>,
  body: unknown,
  method = "POST",
): Promise<Captured> => {
  const { captured, res } = fakeResponse();
  return Promise.resolve(handler({ method, headers, body }, res)).then(() => captured);
};

describe("vercel webhook function", () => {
  it("refuses a request with no secret", async () => {
    expect((await call({}, { update_id: 1 })).status).toBe(401);
  });

  it("refuses a request with the wrong secret", async () => {
    const result = await call({ "x-telegram-bot-api-secret-token": "nope" }, { update_id: 1 });
    expect(result.status).toBe(401);
  });

  it("refuses a secret that is a prefix of the real one", async () => {
    const result = await call(
      { "x-telegram-bot-api-secret-token": SECRET.slice(0, -1) },
      { update_id: 1 },
    );
    expect(result.status).toBe(401);
  });

  it("rejects anything that is not an update, once authenticated", async () => {
    const headers = { "x-telegram-bot-api-secret-token": SECRET };
    expect((await call(headers, { hello: "world" })).status).toBe(400);
    expect((await call(headers, "not json")).status).toBe(400);
    expect((await call(headers, undefined)).status).toBe(400);
  });

  /**
   * Vercel parses JSON for us only when the content type says so, and hands
   * over a raw string when it does not. Telegram sets the header correctly, but
   * a proxy in front of the deployment need not preserve it.
   */
  it("accepts a body that arrived as an unparsed string", async () => {
    const result = await call(
      { "x-telegram-bot-api-secret-token": SECRET },
      JSON.stringify({ update_id: 5 }),
    );
    expect(result.status).toBe(200);
  });

  it("rejects the wrong method before looking at anything else", async () => {
    expect((await call({}, undefined, "GET")).status).toBe(405);
  });

  /**
   * The crash this endpoint actually shipped with.
   *
   * secretMatches() is the first thing the handler runs, and it read the secret
   * through a getter that threw when the variable was unset. Nothing caught it,
   * so an unconfigured deployment answered every request with
   * FUNCTION_INVOCATION_FAILED — "This Serverless Function has crashed" — which
   * tells an operator that the code is broken rather than that a variable is
   * missing. The long-running server never hit it because assertConfigured()
   * runs at boot; a function has no boot.
   */
  it("answers 503 rather than crashing when the secret is not configured", async () => {
    const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call({ "x-telegram-bot-api-secret-token": "anything" }, { update_id: 1 });

    expect(result.status).toBe(503);
    // The log has to name the variable, or this is undiagnosable from outside.
    expect(errors.mock.calls.join(" ")).toContain("TELEGRAM_WEBHOOK_SECRET");

    errors.mockRestore();
    process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  });

  it("says which variables are missing, without revealing any values", async () => {
    const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;

    const { captured, res } = fakeResponse();
    health({}, res);
    const body = captured.body as { configured: boolean; missing: string[] };

    expect(body.configured).toBe(false);
    expect(body.missing).toContain("TELEGRAM_WEBHOOK_SECRET");
    expect(JSON.stringify(body)).not.toContain(SECRET);

    process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  });

  it("reports health without a secret", async () => {
    const { captured, res } = fakeResponse();
    health({}, res);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, service: "fast-fayda" });
  });
});
