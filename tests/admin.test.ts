import { describe, expect, it } from "vitest";
import {
  handleAdmin,
  type AdminDeps,
  type AdminRequest,
  type AdminResponse,
} from "@/admin/handler";
import { signSession } from "@/admin/telegram-auth";
import { BotApiError, type BotApi } from "@/bot/api";
import { unconfiguredCardProvider } from "@/bot/card";
import type { BotStore, Settings } from "@/bot/store";

/**
 * The admin portal's posting half.
 *
 * What matters here is that a broadcast reaches the people it says it reached:
 * a message that silently stops at the first blocked chat, or that reports
 * "sent" for a chat Telegram refused, would be worse than no feature at all —
 * an announcement nobody received while the portal says it went out.
 */

const SECRET = "test-admin-session-secret-that-is-long-enough";
const ADMIN_ID = 42;

type Recipient = { telegramId: number; chatId: number };

class FakeApi implements BotApi {
  sent: { chatId: number; text: string }[] = [];
  /** Chats whose send throws as a blocked user's would. */
  failChatIds = new Set<number>();

  async sendMessage(chatId: number, text: string) {
    if (this.failChatIds.has(chatId)) {
      throw new BotApiError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    }
    this.sent.push({ chatId, text });
    return { message_id: this.sent.length, chat: { id: chatId } };
  }
  async editMessage() {}
  async answerCallback() {}
  async sendChatAction() {}
  async sendDocument() {
    return { message_id: 0, chat: { id: 0 } };
  }
  async sendPhoto() {
    return { message_id: 0, chat: { id: 0 } };
  }
}

function makeStore(
  recipients: Recipient[],
  admins: number[] = [ADMIN_ID],
  settings: Partial<Settings> = {},
) {
  const blocked: number[] = [];
  // Each POST records its patch, so a test can assert what the portal asked the
  // store to keep rather than only what the store ended up holding.
  const settingsUpdates: Partial<Settings>[] = [];
  const stored: Settings = {
    pointPriceEtb: null,
    cbeAccountName: null,
    cbeAccountNumber: null,
    telebirrAccountName: null,
    telebirrAccountNumber: null,
    cardApiKey: null,
    ...settings,
  };
  const store = {
    blocked,
    settingsUpdates,
    async isAdmin(id: number) {
      return admins.includes(id);
    },
    async broadcastRecipients() {
      return recipients;
    },
    async markBlocked(id: number) {
      blocked.push(id);
    },
    // Only the dashboard (GET /admin) reads these.
    async pendingPurchases() {
      return [];
    },
    async pendingCardJobs() {
      return [];
    },
    async listGrantedAdmins() {
      return [] as { telegramId: number; addedBy: number | null; createdAt: string }[];
    },
    async getSettings() {
      return stored;
    },
    async updateSettings(patch: Partial<Settings>, _updatedBy: number) {
      settingsUpdates.push(patch);
      Object.assign(stored, patch);
    },
  };
  return store;
}

function makeRes() {
  const out: { status: number; body?: string; location?: string } = { status: 0 };
  const res: AdminResponse = {
    redirect(location) {
      out.status = 303;
      out.location = location;
    },
    html(status, body) {
      out.status = status;
      out.body = body;
    },
    file() {},
    text(status, body) {
      out.status = status;
      out.body = body;
    },
  };
  return { out, res };
}

function adminCookie(id = ADMIN_ID) {
  return `admin_session=${encodeURIComponent(signSession(id, SECRET))}`;
}

function makeDeps(store: ReturnType<typeof makeStore>, api: FakeApi): AdminDeps {
  return {
    store: store as unknown as BotStore,
    botToken: "123456:TEST",
    adminIds: [ADMIN_ID],
    sessionSecret: SECRET,
    api,
    cards: unconfiguredCardProvider,
  };
}

function flashOf(location: string | undefined): string {
  const query = new URLSearchParams((location ?? "").split("?")[1] ?? "");
  return query.get("flash") ?? "";
}

describe("admin broadcast", () => {
  it("posts to every user who has started the bot", async () => {
    const store = makeStore([
      { telegramId: 1, chatId: 11 },
      { telegramId: 2, chatId: 22 },
    ]);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "Scheduled maintenance tonight." }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(out.status).toBe(303);
    expect(flashOf(out.location)).toBe("Posted to 2 of 2 users.");
    expect(api.sent.map((s) => s.chatId).sort()).toEqual([11, 22]);
    expect(api.sent.every((s) => s.text === "Scheduled maintenance tonight.")).toBe(true);
  });

  it("marks a chat that blocked the bot and counts it as unreachable", async () => {
    const store = makeStore([
      { telegramId: 1, chatId: 11 },
      { telegramId: 2, chatId: 22 },
      { telegramId: 3, chatId: 33 },
    ]);
    const api = new FakeApi();
    api.failChatIds.add(22);
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "Hello" }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(flashOf(out.location)).toBe("Posted to 2 of 3 users (1 could not be reached).");
    expect(store.blocked).toEqual([2]);
    expect(api.sent.map((s) => s.chatId).sort()).toEqual([11, 33]);
  });

  it("escapes HTML so an announcement with punctuation cannot break the message", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }]);
    const api = new FakeApi();
    const { res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "Tips & <tricks> for 5 > 3" }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(api.sent[0]?.text).toBe("Tips &amp; &lt;tricks&gt; for 5 &gt; 3");
  });

  it("refuses an empty message without sending anything", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }]);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "   " }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(flashOf(out.location)).toMatch(/empty/i);
    expect(api.sent).toHaveLength(0);
  });

  it("refuses a message too long for Telegram rather than failing every send", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }]);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "x".repeat(4097) }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(flashOf(out.location)).toMatch(/too long/i);
    expect(api.sent).toHaveLength(0);
  });

  it("requires a signed-in admin", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }]);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: undefined,
        form: new URLSearchParams({ message: "Hello" }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(out.status).toBe(401);
    expect(api.sent).toHaveLength(0);
  });

  it("rejects a signed cookie for someone who is not an admin", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }], []);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/broadcast",
        cookie: adminCookie(),
        form: new URLSearchParams({ message: "Hello" }),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(out.status).toBe(401);
    expect(api.sent).toHaveLength(0);
  });

  it("renders the post form and a flash message on the dashboard", async () => {
    const store = makeStore([{ telegramId: 1, chatId: 11 }]);
    const api = new FakeApi();
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "GET",
        path: "/admin",
        cookie: adminCookie(),
        form: new URLSearchParams(),
        query: new URLSearchParams({ flash: "Posted to 1 of 1 user." }),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, api),
    );

    expect(out.status).toBe(200);
    expect(out.body).toContain('action="/admin/api/broadcast"');
    expect(out.body).toContain('name="message"');
    expect(out.body).toContain("Posted to 1 of 1 user.");
  });
});

describe("admin settings", () => {
  async function postSettings(
    store: ReturnType<typeof makeStore>,
    form: Record<string, string>,
  ) {
    const { out, res } = makeRes();
    await handleAdmin(
      {
        method: "POST",
        path: "/admin/api/settings",
        cookie: adminCookie(),
        form: new URLSearchParams(form),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(store, new FakeApi()),
    );
    return out;
  }

  it("rotates the Card API key when the portal field is filled", async () => {
    const store = makeStore([], [ADMIN_ID], { cardApiKey: "old-key" });

    const out = await postSettings(store, { cardApiKey: "new-key" });

    expect(out.status).toBe(303);
    // The key is what the deployment verifies against, so it is written through
    // untouched — trimming or masking it here would break every request.
    expect(store.settingsUpdates[0]?.cardApiKey).toBe("new-key");
  });

  it("keeps the stored key when the masked field comes back blank", async () => {
    // The field is a password input with no value, so a normal save round-trip
    // submits it empty. That has to mean "unchanged", not "erase": otherwise the
    // key would be wiped the first time an admin edited the price.
    const store = makeStore([], [ADMIN_ID], { cardApiKey: "kept-key" });

    await postSettings(store, { cardApiKey: "", pointPriceEtb: "150" });

    expect(store.settingsUpdates[0]).not.toHaveProperty("cardApiKey");
    expect(store.settingsUpdates[0]?.pointPriceEtb).toBe(150);
  });

  it("clears the key when the checkbox is ticked, falling back to the environment", async () => {
    const store = makeStore([], [ADMIN_ID], { cardApiKey: "stored-key" });

    await postSettings(store, { clearCardApiKey: "1", cardApiKey: "typed-but-ignored" });

    expect(store.settingsUpdates[0]).toHaveProperty("cardApiKey", null);
  });

  it("tells the portal a key is saved without ever showing it", async () => {
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "GET",
        path: "/admin",
        cookie: adminCookie(),
        form: new URLSearchParams(),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(makeStore([], [ADMIN_ID], { cardApiKey: "super-secret-key" }), new FakeApi()),
    );

    expect(out.status).toBe(200);
    expect(out.body).toContain("saved — leave blank to keep");
    expect(out.body).not.toContain("super-secret-key");
  });

  it("says the key is unset when the deployment is falling back to the environment", async () => {
    const { out, res } = makeRes();

    await handleAdmin(
      {
        method: "GET",
        path: "/admin",
        cookie: adminCookie(),
        form: new URLSearchParams(),
        query: new URLSearchParams(),
        secure: false,
      } satisfies AdminRequest,
      res,
      makeDeps(makeStore([], [ADMIN_ID]), new FakeApi()),
    );

    expect(out.status).toBe(200);
    expect(out.body).toContain("not set (using CARD_API_KEY)");
  });
});
