import { afterEach, describe, expect, it, vi } from "vitest";
import { httpCardProvider, liveCardProvider, unconfiguredCardProvider } from "@/bot/card";
import type { BotStore } from "@/bot/store";
import { open, seal } from "@/crypto";

/**
 * The card provider, against a scripted fetch.
 *
 * The case worth the most here is the one the provider's own guide warns
 * about: a successful verify is a PDF, not JSON, and a client that parses
 * unconditionally gets a syntax error from `%PDF-1.4` and reports it as a
 * failed verification. That is a point spent and a customer told they got
 * their code wrong, so it is tested from both sides.
 */

const KEY = Buffer.alloc(32, 7);

function respond(
  body: Buffer | string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

function provider() {
  return httpCardProvider("https://cards.example/api/v1/", "test-key", 5_000);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("send-otp", () => {
  it("returns the session and the masked phone", async () => {
    const fetchMock = vi.fn(async () =>
      respond(JSON.stringify({ session: "opaque-1", phone: "******7890" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().sendOtp("1234567890123456");
    expect(result).toEqual({ outcome: "sent", session: "opaque-1", phone: "******7890" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash on the base URL must not become a double slash.
    expect(url).toBe("https://cards.example/api/v1/send-otp");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(init.body))).toEqual({ fanNumber: "1234567890123456" });
  });

  it("passes the provider's own wording through on a refusal", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "FAN not found." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().sendOtp("1234567890123456")).toEqual({
      outcome: "rejected",
      message: "FAN not found.",
    });
  });

  it("treats a 200 with a message and no session as a refusal, not an outage", async () => {
    // The provider answers some declines with 200 and its own wording. Calling
    // that "not connected" hid a wrong FAN behind a deployment problem.
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "Unknown FAN." }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().sendOtp("1234567890123456")).toEqual({
      outcome: "rejected",
      message: "Unknown FAN.",
    });
  });

  it("is unavailable, not rejected, when the network fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    expect(await provider().sendOtp("1234567890123456")).toEqual({ outcome: "unavailable" });
  });

  it("is unavailable when the body is not the shape it promised", async () => {
    vi.stubGlobal("fetch", async () => respond("not json"));
    expect(await provider().sendOtp("1234567890123456")).toEqual({ outcome: "unavailable" });
  });
});

describe("verify-otp", () => {
  const args = { fan: "1234567890123456", otp: "123456", session: "opaque-1", format: "pdf" as const };

  it("reads a PDF body as bytes rather than parsing it", async () => {
    const pdf = Buffer.from("%PDF-1.4\nbinary\x00bytes");
    vi.stubGlobal("fetch", async () =>
      respond(pdf, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="Fayda-1234.pdf"',
          "x-remaining-points": "497",
        },
      }),
    );

    const result = await provider().verifyOtp(args);
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified" || result.format !== "pdf") return;
    expect(result.pdf.equals(pdf)).toBe(true);
    expect(result.filename).toBe("Fayda-1234.pdf");
    expect(result.remainingPoints).toBe(497);
  });

  it("sends the session back byte for byte", async () => {
    const fetchMock = vi.fn(async () =>
      respond(Buffer.from("%PDF-1.4"), { headers: { "content-type": "application/pdf" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().verifyOtp({ ...args, session: "  spaced/session+value==  " });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).session).toBe("  spaced/session+value==  ");
  });

  it("falls back to a safe filename, and never one with a path in it", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(Buffer.from("%PDF-1.4"), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="../../etc/passwd"',
        },
      }),
    );
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "verified" && result.format === "pdf" && result.filename).toBe(".._.._etc_passwd");
  });

  it("uses a default filename when the header does not carry one", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(Buffer.from("%PDF-1.4"), { headers: { "content-type": "application/pdf" } }),
    );
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "verified" && result.format === "pdf" && result.filename).toBe("fayda.pdf");
  });

  it("reads the message out of a JSON error", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "Invalid OTP." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().verifyOtp(args)).toEqual({
      outcome: "rejected",
      message: "Invalid OTP.",
    });
  });

  it("shows the provider's message when JSON arrives instead of a PDF", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "late failure" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().verifyOtp(args)).toEqual({
      outcome: "rejected",
      message: "late failure",
    });
  });

  it("names the status when an error body carries no message", async () => {
    vi.stubGlobal("fetch", async () => respond("<html>gateway</html>", { status: 502 }));
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "rejected" && result.message).toContain("502");
  });

  /**
   * A 200 that is not a PDF means the contract moved. Calling that a rejection
   * would tell a customer they mistyped a code they got right.
   */
  it("is unavailable when a success is not a PDF", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().verifyOtp(args)).toEqual({ outcome: "unavailable" });
  });

  it("has no remaining-points figure when the header is absent or junk", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(Buffer.from("%PDF-1.4"), {
        headers: { "content-type": "application/pdf", "x-remaining-points": "lots" },
      }),
    );
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "verified" && result.remainingPoints).toBeNull();
  });
});

describe("verify-otp-json", () => {
  const args = { fan: "1234567890123456", otp: "123456", session: "opaque-1", format: "json" as const };

  it("returns the structured identity for a JSON 200", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(
        JSON.stringify({
          success: true,
          remainingPoints: 497,
          data: {
            fanNumber: "1234567890123456",
            fin: "1234567890",
            name: { amharic: "አበበ", english: "Abebe" },
            dateOfBirth: { ethiopian: "01/05/1988", gregorian: "1988-05-09" },
            gender: { amharic: "", english: "Male" },
            nationality: { amharic: "", english: "Ethiopian" },
            phone: "0912345678",
            address: {
              city: { amharic: "", english: "Addis Ababa" },
              subCity: { amharic: "", english: "Bole" },
              woreda: { amharic: "", english: "03" },
            },
            issueDate: { ethiopian: "", gregorian: "2019-01-01" },
            expiryDate: { ethiopian: "", gregorian: "2029-01-01" },
            photo: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            qrCode: null,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await provider().verifyOtp(args);
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified" || result.format !== "json") return;
    expect(result.identity.name.english).toBe("Abebe");
    expect(result.identity.fin).toBe("1234567890");
    expect(result.identity.photo).toContain("iVBORw0KGgo");
    expect(result.identity.qrCode).toBeNull();
  });

  /**
   * The live provider rejects a FAN-only body with "finNumber is required".
   * The bot does not collect a FIN, so the client derives it from the FAN's
   * last 12 digits — the value the live endpoint accepts.
   */
  it("derives the required finNumber from the FAN's last 12 digits", async () => {
    const fetchMock = vi.fn(async () =>
      respond(JSON.stringify({ success: true, remainingPoints: 1, data: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().verifyOtp({ fan: "1234567890123456", otp: "123456", session: "opaque-1", format: "json" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      otp: "123456",
      fanNumber: "1234567890123456",
      finNumber: "567890123456",
      session: "opaque-1",
    });
  });

  it("derives a clean 12-digit finNumber even from a spaced FAN", async () => {
    const fetchMock = vi.fn(async () =>
      respond(JSON.stringify({ success: true, remainingPoints: 1, data: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().verifyOtp({ fan: "1234 5678 9012 3456", otp: "123456", session: "opaque-1", format: "json" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).finNumber).toBe("567890123456");
  });

  it("reads the message out of a JSON rejection", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "OTP expired." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().verifyOtp(args)).toEqual({
      outcome: "rejected",
      message: "OTP expired.",
    });
  });

  it("shows the message when a JSON 200 still reports failure", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: false, message: "OTP expired." }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await provider().verifyOtp(args)).toEqual({
      outcome: "rejected",
      message: "OTP expired.",
    });
  });

  it("is unavailable when a JSON 200 body is not the shape it promised", async () => {
    vi.stubGlobal("fetch", async () =>
      respond("not json", { headers: { "content-type": "text/plain" } }),
    );
    expect(await provider().verifyOtp(args)).toEqual({ outcome: "unavailable" });
  });

  it("reads remainingPoints from the body when the header is absent", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: true, remainingPoints: 497, data: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "verified" && result.remainingPoints).toBe(497);
  });

  it("prefers the header when both carry a figure", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(JSON.stringify({ success: true, remainingPoints: 100, data: {} }), {
        headers: { "content-type": "application/json", "x-remaining-points": "42" },
      }),
    );
    const result = await provider().verifyOtp(args);
    expect(result.outcome === "verified" && result.remainingPoints).toBe(42);
  });
});

describe("the unconfigured provider", () => {
  it("is unavailable for everything, and never throws", async () => {
    expect(await unconfiguredCardProvider.sendOtp("1234567890123456")).toEqual({
      outcome: "unavailable",
    });
    expect(
      await unconfiguredCardProvider.verifyOtp({ fan: "x", otp: "1", session: "s", format: "json" }),
    ).toEqual({ outcome: "unavailable" });
    expect(await unconfiguredCardProvider.balance()).toBeNull();
  });
});

describe("sealing the FAN while a code is outstanding", () => {
  it("round-trips", () => {
    expect(open(seal("1234567890123456", KEY), KEY)).toBe("1234567890123456");
  });

  it("does not put the plaintext in the ciphertext", () => {
    expect(seal("1234567890123456", KEY)).not.toContain("1234567890123456");
  });

  it("produces a different ciphertext every time, so equal FANs do not look equal", () => {
    expect(seal("1234567890123456", KEY)).not.toBe(seal("1234567890123456", KEY));
  });

  it("refuses the wrong key rather than returning something", () => {
    expect(open(seal("1234567890123456", KEY), Buffer.alloc(32, 9))).toBeNull();
  });

  it("refuses a tampered ciphertext", () => {
    const sealed = seal("1234567890123456", KEY);
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[3] = body.toString("base64url");
    expect(open(parts.join("."), KEY)).toBeNull();
  });

  it("refuses anything malformed, without throwing", () => {
    for (const bad of ["", "v1", "v1.a.b", "v2.a.b.c", "not-sealed-at-all", "v1....."]) {
      expect(open(bad, KEY)).toBeNull();
    }
  });
});

describe("liveCardProvider picking its key", () => {
  /**
   * The Card API key can be rotated from the portal, so the provider has to
   * read it per request rather than capture it at construction. These tests pin
   * the three sources in priority order: the portal's setting, then
   * CARD_API_KEY, then nothing (which is "unavailable", never a request that
   * would come back unauthorised and be reported to the customer as a failure).
   */
  function storeHolding(cardApiKey: string | null): BotStore {
    return {
      async getSettings() {
        return {
          pointPriceEtb: null,
          cbeAccountName: null,
          cbeAccountNumber: null,
          telebirrAccountName: null,
          telebirrAccountNumber: null,
          cardApiKey,
        };
      },
    } as unknown as BotStore;
  }

  const jsonOk = () =>
    vi.fn(async () =>
      respond(JSON.stringify({ session: "opaque-1", phone: "******7890" }), {
        headers: { "content-type": "application/json" },
      }),
    );

  function sentKey(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return (init.headers as Record<string, string>)["x-api-key"];
  }

  it("uses the key the portal holds, so an admin can rotate it without a redeploy", async () => {
    const fetchMock = jsonOk();
    vi.stubGlobal("fetch", fetchMock);

    await liveCardProvider(storeHolding("portal-key")).sendOtp("1234567890123456");

    expect(sentKey(fetchMock)).toBe("portal-key");
  });

  it("falls back to CARD_API_KEY when the portal holds none", async () => {
    const saved = process.env.CARD_API_KEY;
    process.env.CARD_API_KEY = "env-key";
    try {
      const fetchMock = jsonOk();
      vi.stubGlobal("fetch", fetchMock);
      await liveCardProvider(storeHolding(null)).sendOtp("1234567890123456");
      expect(sentKey(fetchMock)).toBe("env-key");
    } finally {
      if (saved === undefined) delete process.env.CARD_API_KEY;
      else process.env.CARD_API_KEY = saved;
    }
  });

  it("is unavailable, and makes no request, when no key is configured anywhere", async () => {
    const saved = process.env.CARD_API_KEY;
    delete process.env.CARD_API_KEY;
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect(await liveCardProvider(storeHolding(null)).sendOtp("1234567890123456")).toEqual({
        outcome: "unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.CARD_API_KEY;
      else process.env.CARD_API_KEY = saved;
    }
  });
});
