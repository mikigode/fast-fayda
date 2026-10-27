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

/** Health is async: it asks the database which card API key is in force. */
const callHealth = async (request: Record<string, unknown> = {}): Promise<Captured> => {
  const { captured, res } = fakeResponse();
  await health(request as never, res);
  return captured;
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
    // Async because it reads the portal's settings: the card API key can come
    // from the database as well as the environment.
    await health({}, res);
    const body = captured.body as { configured: boolean; missing: string[] };

    expect(body.configured).toBe(false);
    expect(body.missing).toContain("TELEGRAM_WEBHOOK_SECRET");
    expect(JSON.stringify(body)).not.toContain(SECRET);

    process.env.TELEGRAM_WEBHOOK_SECRET = saved;
  });

  it("reports health without a secret", async () => {
    const { captured, res } = fakeResponse();
    await health({}, res);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, service: "fast-fayda" });
  });

  /**
   * "Card retrieval is not connected" is what a customer sees both when no key
   * is set and when the provider is unreachable, so the health check has to be
   * able to tell them apart — without calling out to anybody unless asked, and
   * without ever echoing the key.
   */
  it("probes the card provider only when asked, and never echoes the key", async () => {
    const saved = process.env.CARD_API_KEY;
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ points: 5 }), { status: 200 }),
    );
    const realFetch = globalThis.fetch;
    process.env.CARD_API_KEY = "card-key-from-the-environment";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const quiet = await callHealth();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(quiet.body).toMatchObject({ ok: true, cardKey: "env" });

      const probed = await callHealth({ query: { card: "1" } });
      expect(probed.body).toMatchObject({ card: { ok: true, outcome: "ok", status: 200 } });
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: { "x-api-key": "card-key-from-the-environment" },
      });
      expect(JSON.stringify(probed.body)).not.toContain("card-key-from-the-environment");
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.CARD_API_KEY;
      else process.env.CARD_API_KEY = saved;
    }
  });

  it("says the provider refused the key rather than blaming the deployment", async () => {
    const saved = process.env.CARD_API_KEY;
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const realFetch = globalThis.fetch;
    process.env.CARD_API_KEY = "rejected-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const probed = await callHealth({ query: { card: "1" } });
      expect(probed.body).toMatchObject({
        cardKey: "env",
        card: { ok: false, outcome: "refused", status: 401 },
      });
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.CARD_API_KEY;
      else process.env.CARD_API_KEY = saved;
    }
  });

  it("reports an unreachable provider as unreachable, by error name only", async () => {
    const saved = process.env.CARD_API_KEY;
    const timeout = new Error("the operation timed out");
    timeout.name = "TimeoutError";
    const fetchMock = vi.fn(async () => {
      throw timeout;
    });
    const realFetch = globalThis.fetch;
    process.env.CARD_API_KEY = "some-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const probed = await callHealth({ url: "/health?card=1" });
      expect(probed.body).toMatchObject({
        card: { ok: false, outcome: "unreachable", error: "TimeoutError" },
      });
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.CARD_API_KEY;
      else process.env.CARD_API_KEY = saved;
    }
  });
});
