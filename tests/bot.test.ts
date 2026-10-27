import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { BotApi, InlineKeyboard } from "@/bot/api";
import { BotApiError } from "@/bot/api";
import {
  unconfiguredCardProvider,
  type CardIdentity,
  type CardProvider,
  type SendOtpResult,
  type VerifyOtpResult,
} from "@/bot/card";
import { hashId, last4, normalizeId, parseId, stubProvider } from "@/bot/fayda";
import { t } from "@/bot/i18n";
import { handleUpdate, type BotDeps, type TgUpdate } from "@/bot/router";
import {
  SpendError,
  type BotState,
  type BotStore,
  type BotUser,
  type LookupOutcome,
  type OutputSettings,
  type PurchaseInput,
  type PurchaseOutcome,
  type PurchaseRow,
} from "@/bot/store";

/**
 * The conversation, exercised against in-memory doubles.
 *
 * What is being protected here is that a person can always get somewhere: the
 * language chooser leads to a menu, a bad number leads to a correction rather
 * than a dead end, and a retried delivery does not act twice. Those are the
 * failures that would be invisible in review and obvious to a user.
 */

// hashId needs a key; without this it would derive one from DATABASE_URL.
process.env.ID_HASH_SECRET = "test-id-hash-secret-that-is-long-enough-32";

const CHAT = 555_111;

type Sent = {
  chatId: number;
  text: string;
  keyboard: InlineKeyboard | undefined;
  replyKeyboard?: string[][] | undefined;
};

class FakeStore implements BotStore {
  users = new Map<number, BotUser>();
  seenUpdates = new Set<number>();
  lookups: { kind: string; hash: string; last4: string; outcome: LookupOutcome }[] = [];
  support: { id: string; body: string; forwarded: boolean }[] = [];
  blocked: number[] = [];
  /** Overridable, so the rate limit can be tested without 5 round trips. */
  recentLookups = 0;

  async touchUser(input: {
    telegramId: number;
    chatId: number;
    firstName: string;
    username: string | null;
  }) {
    const existing = this.users.get(input.telegramId);
    const user: BotUser = existing ?? {
      telegramId: input.telegramId,
      chatId: input.chatId,
      firstName: input.firstName,
      username: input.username,
      language: null,
      state: "idle",
      stateData: {},
      points: 0,
      downloadType: "pdf_mirror",
      background: "bg2",
    };
    this.users.set(input.telegramId, user);
    return { ...user, created: !existing };
  }

  async setLanguage(telegramId: number, language: "am" | "en") {
    const user = this.users.get(telegramId);
    if (user) user.language = language;
  }

  async setState(telegramId: number, state: BotState, data: Record<string, unknown> = {}) {
    const user = this.users.get(telegramId);
    if (user) {
      user.state = state;
      user.stateData = data;
    }
  }

  async markBlocked(telegramId: number) {
    this.blocked.push(telegramId);
  }

  async claimUpdate(updateId: number) {
    if (this.seenUpdates.has(updateId)) return false;
    this.seenUpdates.add(updateId);
    return true;
  }

  async recordLookup(input: {
    telegramId: number;
    kind: "fin" | "fan";
    hash: string;
    last4: string;
    outcome: LookupOutcome;
  }) {
    this.lookups.push(input);
  }

  async countLookupsSince() {
    return this.recentLookups;
  }

  async saveSupportMessage(input: { telegramId: number; language: "am" | "en"; body: string }) {
    const id = `msg-${this.support.length + 1}`;
    this.support.push({ id, body: input.body, forwarded: false });
    return { id };
  }

  async markSupportForwarded(id: string) {
    const row = this.support.find((m) => m.id === id);
    if (row) row.forwarded = true;
  }

  // ---- points and purchases ----
  purchases: (PurchaseInput & { id: string })[] = [];
  decisions: { id: string; approve: boolean; points: number }[] = [];
  /** References already claimed, which is what makes a receipt single-use. */
  claimed = new Set<string>();

  async getBalance(telegramId: number) {
    return this.users.get(telegramId)?.points ?? 0;
  }

  async setOutput(telegramId: number, patch: Partial<OutputSettings>) {
    const user = this.users.get(telegramId);
    if (!user) return;
    if (patch.downloadType) user.downloadType = patch.downloadType;
    if (patch.background) user.background = patch.background;
  }

  async recordPurchase(input: PurchaseInput): Promise<PurchaseOutcome> {
    const key = `${input.provider}:${input.reference.toUpperCase()}`;
    if (this.claimed.has(key)) return { outcome: "duplicate" };
    this.claimed.add(key);

    const id = `pur-${this.purchases.length + 1}`;
    this.purchases.push({ ...input, id });

    const user = this.users.get(input.telegramId);
    if (input.status === "approved" && user) user.points += input.points;
    return { outcome: "created", id, balance: user?.points ?? 0 };
  }

  async decidePurchase({ id, approve, points }: { id: string; approve: boolean; adminId: number; points: number }) {
    if (this.decisions.some((d) => d.id === id)) return null;
    const purchase = this.purchases.find((p) => p.id === id);
    if (!purchase) return null;
    this.decisions.push({ id, approve, points });

    const user = this.users.get(purchase.telegramId);
    if (approve && user) user.points += points;
    return {
      applied: true,
      telegramId: purchase.telegramId,
      points: approve ? points : 0,
      balance: user?.points ?? 0,
    };
  }

  async pendingPurchases() {
    return this.pending;
  }

  /** Overridable, so the /admin review list can be exercised. */
  pending: PurchaseRow[] = [];

  // ---- card jobs -------------------------------------------------------
  cardJobs: {
    id: string;
    telegramId: number;
    source: "otp" | "upload_image" | "upload_pdf";
    pointsSpent: number;
    status: string;
    telegramFileId: string | null;
  }[] = [];

  async spendOnCardJob({
    telegramId,
    source,
    telegramFileId,
    telegramFileUniqueId,
    points,
    status = "pending",
  }: Parameters<BotStore["spendOnCardJob"]>[0]) {
    void telegramFileUniqueId;
    const user = this.users.get(telegramId);
    if (!user || user.points < points) throw new SpendError("Not enough points.");
    user.points -= points;
    const id = `job-${this.cardJobs.length + 1}`;
    this.cardJobs.push({ id, telegramId, source, pointsSpent: points, status, telegramFileId });
    return { id, balance: user.points };
  }

  /** Serials handed out, starting where production does. */
  cardSerials: number[] = [];
  /** Set to make allocation fail, which must not cost the customer their card. */
  failNextCardSerial = false;

  async nextCardSerial() {
    if (this.failNextCardSerial) throw new Error("card_serial_seq unavailable");
    const serial = 58100 + this.cardSerials.length;
    this.cardSerials.push(serial);
    return serial;
  }

  async pendingCardJobs() {
    return [];
  }

  async getCardJob(id: string) {
    const job = this.cardJobs.find((j) => j.id === id);
    return job ? ({ id: job.id, telegram_id: String(job.telegramId) } as never) : null;
  }

  async markCardJobDelivered(id: string) {
    const job = this.cardJobs.find((j) => j.id === id && j.status === "pending");
    if (!job) return false;
    job.status = "delivered";
    return true;
  }

  // ---- OTP sessions ------------------------------------------------------
  otpSessions: {
    id: string;
    telegramId: number;
    slot: number;
    fanSecret: string | null;
    providerRef: string | null;
    attempts: number;
    status: string;
  }[] = [];

  async openOtpSession({
    telegramId,
    slot,
    fanSecret,
    providerRef,
  }: Parameters<BotStore["openOtpSession"]>[0]) {
    const id = `otp-${this.otpSessions.length + 1}`;
    this.otpSessions.push({
      id,
      telegramId,
      slot,
      fanSecret,
      providerRef,
      attempts: 0,
      status: "awaiting_code",
    });
    return { id };
  }

  async openOtpSessionFor(telegramId: number) {
    const found = [...this.otpSessions]
      .reverse()
      .find((s) => s.telegramId === telegramId && s.status === "awaiting_code");
    return found
      ? {
          id: found.id,
          slot: found.slot,
          fanSecret: found.fanSecret,
          providerRef: found.providerRef,
          attempts: found.attempts,
        }
      : null;
  }

  async closeOtpSession(id: string, status: "verified" | "failed" | "expired") {
    const found = this.otpSessions.find((s) => s.id === id);
    if (!found) return;
    found.status = status;
    // Mirrors the SQL: the secrets go with the status change, so a test that
    // asserts nothing is left behind is testing the real guarantee.
    found.fanSecret = null;
    found.providerRef = null;
  }

  async countOtpAttempt(id: string) {
    const found = this.otpSessions.find((s) => s.id === id);
    if (!found) return 0;
    found.attempts += 1;
    return found.attempts;
  }

  // ---- settings ----------------------------------------------------------
  settings: Partial<Record<string, unknown>> = {};

  async getSettings() {
    return {
      pointPriceEtb: null,
      cbeAccountName: null,
      cbeAccountNumber: null,
      telebirrAccountName: null,
      telebirrAccountNumber: null,
      cardApiKey: null,
      ...this.settings,
    } as never;
  }

  async updateSettings(patch: Record<string, unknown>) {
    Object.assign(this.settings, patch);
  }

  // ---- portal admins -------------------------------------------------
  grantedAdmins: number[] = [];

  async isAdmin(telegramId: number, envAdminIds: number[]) {
    return envAdminIds.includes(telegramId) || this.grantedAdmins.includes(telegramId);
  }

  async listGrantedAdmins() {
    return this.grantedAdmins.map((telegramId) => ({ telegramId, addedBy: null, createdAt: "" }));
  }

  async grantAdmin(telegramId: number, _addedBy: number) {
    if (!this.grantedAdmins.includes(telegramId)) this.grantedAdmins.push(telegramId);
  }

  async hasUser(telegramId: number) {
    return this.users.has(telegramId);
  }

  async revokeAdmin(telegramId: number) {
    const at = this.grantedAdmins.indexOf(telegramId);
    if (at === -1) return false;
    this.grantedAdmins.splice(at, 1);
    return true;
  }

  // ---- broadcast -----------------------------------------------------
  async broadcastRecipients() {
    return [...this.users.values()].map((user) => ({
      telegramId: user.telegramId,
      chatId: user.chatId,
    }));
  }

  // ---- user stats ----------------------------------------------------
  async userSummary() {
    const users = [...this.users.values()];
    return {
      users: users.length,
      points: users.reduce((sum, user) => sum + user.points, 0),
    };
  }

  async listUserPoints(limit = 20) {
    return [...this.users.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, limit)
      .map((user) => ({
        telegramId: user.telegramId,
        firstName: user.firstName,
        username: user.username,
        points: user.points,
      }));
  }
}

class FakeApi implements BotApi {
  /**
   * Everything put on screen, in order, whether it was a new message or an
   * edit of an existing one. The bot uses both — a button replaces the screen
   * it was tapped on, a typed message gets a new one — so assertions about
   * "what the person is looking at now" have to read one chronological list.
   */
  screens: Sent[] = [];
  /** Only the newly sent ones, which is where a forward to the support chat lands. */
  sent: Sent[] = [];
  answered: string[] = [];
  /** Set to make sends fail as a blocked chat would. */
  failWith: BotApiError | null = null;
  /**
   * Limits failWith to one chat. Without it every send fails, including the
   * one to the support chat — which is not how a blocked customer behaves,
   * and would hide whether an admin actually gets told.
   */
  failChatId: number | null = null;

  private failFor(chatId: number) {
    if (!this.failWith) return null;
    if (this.failChatId !== null && this.failChatId !== chatId) return null;
    return this.failWith;
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: { keyboard?: InlineKeyboard; replyKeyboard?: string[][] } = {},
  ) {
    const failure = this.failFor(chatId);
    if (failure) throw failure;
    const entry = { chatId, text, keyboard: options.keyboard, replyKeyboard: options.replyKeyboard };
    this.screens.push(entry);
    this.sent.push(entry);
    return { message_id: this.screens.length, chat: { id: chatId } };
  }

  async editMessage(
    chatId: number,
    _messageId: number,
    text: string,
    options: { keyboard?: InlineKeyboard } = {},
  ) {
    const failure = this.failFor(chatId);
    if (failure) throw failure;
    this.screens.push({ chatId, text, keyboard: options.keyboard });
  }

  async answerCallback(callbackId: string) {
    this.answered.push(callbackId);
  }

  async sendChatAction() {}

  /** Files sent, so a test can assert the bytes and the name that carried them. */
  documents: { chatId: number; filename: string; bytes: Buffer; caption?: string }[] = [];

  async sendDocument(
    chatId: number,
    file: { bytes: Buffer; filename: string },
    options: { caption?: string; replyKeyboard?: string[][] } = {},
  ) {
    const failure = this.failFor(chatId);
    if (failure) throw failure;
    this.documents.push({ chatId, filename: file.filename, bytes: file.bytes, caption: options.caption });
    // A document is also a screen: it is what the person is now looking at.
    const entry = {
      chatId,
      text: options.caption ?? "",
      keyboard: undefined,
      replyKeyboard: options.replyKeyboard,
    };
    this.screens.push(entry);
    this.sent.push(entry);
    return { message_id: this.screens.length, chat: { id: chatId } };
  }

  /** Images sent, kept apart from documents so a test can tell the two hands-off apart. */
  photos: { chatId: number; filename: string; bytes: Buffer; caption?: string }[] = [];

  async sendPhoto(
    chatId: number,
    file: { bytes: Buffer; filename: string },
    options: { caption?: string; replyKeyboard?: string[][] } = {},
  ) {
    const failure = this.failFor(chatId);
    if (failure) throw failure;
    this.photos.push({ chatId, filename: file.filename, bytes: file.bytes, caption: options.caption });
    const entry = {
      chatId,
      text: options.caption ?? "",
      keyboard: undefined,
      replyKeyboard: options.replyKeyboard,
    };
    this.screens.push(entry);
    this.sent.push(entry);
    return { message_id: this.screens.length, chat: { id: chatId } };
  }

  /** The last thing put on screen, however it got there. */
  get lastScreen(): Sent {
    const last = this.screens[this.screens.length - 1];
    if (!last) throw new Error("nothing was sent");
    return last;
  }

  buttons(): string[] {
    return (this.lastScreen.keyboard ?? []).flat().map((b) => b.callback_data ?? b.text);
  }

  /** The persistent keyboard drawn under the last message, flattened. */
  mainButtons(): string[] {
    return (this.lastScreen.replyKeyboard ?? []).flat();
  }
}

/**
 * The identity a FAN verify returns. A FAN is the only login this bot accepts,
 * and the vendor's FAN flow verifies through `/verify-otp-json` — so this is
 * what the provider really hands back, not a PDF.
 */
const IDENTITY: CardIdentity = {
  fanNumber: "1234567890123456",
  fin: "1234567890",
  name: { amharic: "አበበ ቀበደ", english: "Abebe Kebede" },
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
};

/**
 * Stands in for the card API. Scripted rather than stateful: each test says
 * what the provider does, and the assertions are about what the bot does with
 * that — which is the half that can be wrong.
 */
class FakeCards implements CardProvider {
  name = "http";
  sendOtpResult: SendOtpResult = { outcome: "sent", session: "sess-1", phone: "******7890" };
  verifyResult: VerifyOtpResult = {
    outcome: "verified",
    format: "json",
    identity: IDENTITY,
    remainingPoints: 497,
  };
  /** Every call made, so a test can prove a point was not spent twice. */
  calls: { method: string; fan?: string; otp?: string; session?: string; format?: "pdf" | "json" }[] = [];

  async sendOtp(fan: string) {
    this.calls.push({ method: "sendOtp", fan });
    return this.sendOtpResult;
  }

  async verifyOtp({ fan, otp, session, format }: { fan: string; otp: string; session: string; format: "pdf" | "json" }) {
    this.calls.push({ method: "verifyOtp", fan, otp, session, format });
    return this.verifyResult;
  }

  async balance() {
    return { points: 497, status: "active" };
  }
}

let store: FakeStore;
let api: FakeApi;
let cards: FakeCards;
let deps: BotDeps;
let updateId = 0;
/** What the fake bank page returns; individual tests override it. */
let receiptPage: string | null = null;

const ADMIN = 42_000;

beforeEach(() => {
  store = new FakeStore();
  // Buy Points needs somewhere to say "send it here" before it will start a
  // receipt conversation; most tests care about what happens after that, not
  // about the account-configured state itself, so fixture accounts are on by
  // default here.
  store.settings = {
    cbeAccountName: "Fast Fayda",
    cbeAccountNumber: "1000123456789",
    telebirrAccountName: "Fast Fayda",
    telebirrAccountNumber: "0912345678",
  };
  api = new FakeApi();
  cards = new FakeCards();
  deps = {
    store,
    api,
    cards,
    provider: stubProvider,
    supportChatId: -100_200,
    newUserGroupId: -100_300,
    pricePerPoint: 15,
    fetchReceipt: async () => receiptPage,
    adminIds: [ADMIN],
    adminContact: "@fayda_id_administrator",
  };
  receiptPage = "<td>Amount</td><td>ETB 150.00</td>";
  updateId = 0;
});

function message(text: string, overrides: Partial<TgUpdate> = {}): TgUpdate {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: { id: CHAT, type: "private" },
      from: { id: CHAT, first_name: "Hanna", username: "hanna" },
      text,
    },
    ...overrides,
  };
}

function tap(data: string): TgUpdate {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: CHAT, first_name: "Hanna", username: "hanna" },
      message: { message_id: 1, chat: { id: CHAT, type: "private" } },
      data,
    },
  };
}

/** Gets a user past the chooser and into the menu, in the given language. */
async function startIn(lang: "am" | "en") {
  await handleUpdate(message("/start"), deps);
  await handleUpdate(tap(`lang:${lang}`), deps);
  api.screens = [];
  api.sent = [];
}

describe("first contact", () => {
  it("announces a brand-new user to the new-user group, once", async () => {
    await handleUpdate(message("/start"), deps);

    const note = api.sent.find((entry) => entry.chatId === deps.newUserGroupId);
    expect(note).toBeDefined();
    expect(note?.text).toContain("Hanna");
    expect(note?.text).toContain("@hanna");

    // A returning user is not announced again.
    api.sent = [];
    await handleUpdate(message("hello again"), deps);
    expect(api.sent.some((entry) => entry.chatId === deps.newUserGroupId)).toBe(false);
  });

  it("answers /start with the language chooser, in both languages", async () => {
    await handleUpdate(message("/start"), deps);

    expect(api.lastScreen.text).toContain("Please choose your language");
    expect(api.lastScreen.text).toContain("እባክዎ ቋንቋ ይምረጡ");
    expect(api.buttons()).toEqual(["lang:am", "lang:en"]);
  });

  it("asks for a language before answering anything else", async () => {
    await handleUpdate(message("hello"), deps);
    expect(api.buttons()).toEqual(["lang:am", "lang:en"]);
  });

  it("stores the choice and opens the menu addressed to the person", async () => {
    await handleUpdate(message("/start"), deps);
    await handleUpdate(tap("lang:am"), deps);

    expect(store.users.get(CHAT)?.language).toBe("am");
    // Two messages: the welcome, then the message that draws the keyboard the
    // bot is actually driven from. An edit cannot carry a reply keyboard.
    expect(api.screens.some((s) => s.text.includes("ሰላም Hanna"))).toBe(true);
    expect(api.mainButtons()).toContain("💳 ነጥብ ይግዙ");
  });

  it("greets a returning user by name on /start", async () => {
    await startIn("en");
    await handleUpdate(message("/start"), deps);
    expect(api.sent.at(-1)?.text).toContain("Hello Hanna!");
    expect(api.sent.at(-1)?.text).toContain("Please choose your language.");
    expect(api.sent.at(-1)?.text).toContain("እባክዎ ቋንቋ ይምረጡ።");
    // The prompt has to come with the choices, or it is a dead end.
    expect(api.buttons()).toEqual(["lang:am", "lang:en"]);
  });

  it("falls back to the @username when there is no first name", async () => {
    const other = CHAT + 1;
    store.users.set(other, {
      telegramId: other,
      chatId: other,
      firstName: "",
      username: "hanna",
      language: "en",
      state: "idle",
      stateData: {},
      points: 2,
      downloadType: "pdf_mirror",
      background: "bg2",
    });
    await handleUpdate(
      {
        update_id: ++updateId,
        message: {
          message_id: updateId,
          chat: { id: other, type: "private" },
          from: { id: other, username: "hanna" },
          text: "/start",
        },
      },
      deps,
    );
    expect(api.sent.at(-1)?.text).toContain("Hello @hanna!");
  });

  it("answers the callback so the button stops spinning", async () => {
    await handleUpdate(message("/start"), deps);
    await handleUpdate(tap("lang:en"), deps);
    expect(api.answered).toHaveLength(1);
  });
});

describe("delivery retries", () => {
  it("ignores an update_id it has already handled", async () => {
    const update = message("/start");
    await handleUpdate(update, deps);
    await handleUpdate(update, deps);

    // The redelivered update must not run the conversation a second time,
    // including the new-user announcement to the group.
    const toUser = api.sent.filter((entry) => entry.chatId === CHAT);
    expect(toUser).toHaveLength(1);
  });

  it("does not send a support message twice when the delivery is retried", async () => {
    await startIn("en");
    await handleUpdate(tap("support"), deps);

    const submission = message("My FAN is not working");
    await handleUpdate(submission, deps);
    await handleUpdate(submission, deps);

    expect(store.support).toHaveLength(1);
  });
});

describe("status lookup", () => {
  it("asks for a number and remembers that it is waiting for one", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);

    expect(api.lastScreen.text).toContain("FIN");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_id");
  });

  it("reports the status for a valid FIN and returns to idle", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    // stubProvider maps the last digit onto a status; 3 is "printed".
    expect(api.lastScreen.text).toContain("Printed");
    expect(api.lastScreen.text).toContain("9123");
    expect(store.users.get(CHAT)?.state).toBe("idle");
  });

  it("answers in the chosen language", async () => {
    await startIn("am");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    expect(api.lastScreen.text).toContain(t("am").statusLabels.printed);
  });

  it("accepts a number typed with spaces", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("1234 5678 9123"), deps);

    expect(store.lookups[0]?.outcome).toBe("found");
  });

  it("logs a hash and the last four digits, never the number", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    const logged = store.lookups[0];
    expect(logged?.last4).toBe("9123");
    expect(logged?.hash).toBe(hashId("123456789123"));
    expect(logged?.hash).not.toContain("123456789123");
  });

  it("explains a number of the wrong length and keeps waiting", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("12345"), deps);

    expect(api.lastScreen.text).toContain("does not look like");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_id");
    expect(store.lookups[0]?.outcome).toBe("invalid");
  });

  it("reports a number with no application behind it", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    // The stub treats a trailing zero as not found.
    await handleUpdate(message("123456789120"), deps);

    expect(api.lastScreen.text).toContain("No application was found");
  });

  it("stops looking things up once the budget is spent", async () => {
    await startIn("en");
    store.recentLookups = 5;
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    expect(api.lastScreen.text).toContain("several checks in a short time");
    // Nothing was looked up, so nothing was recorded.
    expect(store.lookups).toHaveLength(0);
  });

  it("says so plainly when no provider is configured", async () => {
    deps.provider = { name: "unconfigured", async lookup() { return { outcome: "unavailable" }; } };
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    expect(api.lastScreen.text).toContain("unavailable");
    expect(store.lookups[0]?.outcome).toBe("unavailable");
  });

  it("survives a provider that throws", async () => {
    deps.provider = {
      name: "broken",
      async lookup() {
        throw new Error("upstream on fire");
      },
    };
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("123456789123"), deps);

    expect(api.lastScreen.text).toContain("Something went wrong");
    expect(store.lookups[0]?.outcome).toBe("error");
  });
});

describe("faq", () => {
  it("lists the questions and opens one", async () => {
    await startIn("en");
    await handleUpdate(tap("faq"), deps);
    expect(api.buttons()).toContain("faq:fin-fan");

    await handleUpdate(tap("faq:fin-fan"), deps);
    expect(api.lastScreen.text).toContain("FIN and FAN");
    // Back goes to the list it was opened from, not the main menu.
    expect(api.buttons()).toEqual(["faq"]);
  });

  it("falls back to the menu for a question that does not exist", async () => {
    await startIn("en");
    await handleUpdate(tap("faq:nonsense"), deps);
    expect(api.buttons()).toEqual(["status", "faq", "appt", "support", "lang"]);
  });
});

describe("support handoff", () => {
  it("saves the message and forwards it to the support chat", async () => {
    await startIn("en");
    await handleUpdate(tap("support"), deps);
    await handleUpdate(message("I registered in June and heard nothing"), deps);

    expect(store.support[0]?.body).toBe("I registered in June and heard nothing");
    expect(store.support[0]?.forwarded).toBe(true);

    const forwarded = api.sent.find((m) => m.chatId === -100_200);
    expect(forwarded?.text).toContain("I registered in June");
    expect(forwarded?.text).toContain("@hanna");
    expect(api.lastScreen.text).toContain("passed to the support team");
  });

  it("keeps the message when there is nowhere to forward it, and says so", async () => {
    deps.supportChatId = null;
    await startIn("en");
    await handleUpdate(tap("support"), deps);
    await handleUpdate(message("hello?"), deps);

    expect(store.support[0]?.forwarded).toBe(false);
    expect(api.lastScreen.text).toContain("could not be delivered");
  });

  it("rejects an over-long message without losing the state", async () => {
    await startIn("en");
    await handleUpdate(tap("support"), deps);
    await handleUpdate(message("x".repeat(1001)), deps);

    expect(store.support).toHaveLength(0);
    expect(store.users.get(CHAT)?.state).toBe("awaiting_support");
  });
});

describe("odds and ends", () => {
  it("offers the menu back for text it cannot interpret", async () => {
    await startIn("en");
    await handleUpdate(message("thanks!"), deps);

    expect(api.lastScreen.text).toContain("did not understand");
    // The persistent keyboard is redrawn, so there is always a way forward.
    expect(api.mainButtons()).toContain("💳 Buy Points");
  });

  it("treats an unknown command as unknown input", async () => {
    await startIn("en");
    await handleUpdate(message("/teleport"), deps);
    expect(api.lastScreen.text).toContain("did not understand");
    expect(api.mainButtons()).toContain("📊 My Points");
  });

  it("cancels a pending question", async () => {
    await startIn("en");
    await handleUpdate(tap("status"), deps);
    await handleUpdate(message("/cancel"), deps);

    expect(store.users.get(CHAT)?.state).toBe("idle");
    expect(api.lastScreen.text).toBe(t("en").cancelled);
  });

  it("ignores group chats, where an ID number would be public", async () => {
    const update = message("123456789123");
    update.message!.chat = { id: -900, type: "supergroup" };
    await handleUpdate(update, deps);

    expect(api.sent).toHaveLength(0);
  });

  it("ignores other bots", async () => {
    const update = message("/start");
    update.message!.from = { id: 9, first_name: "Spam", is_bot: true };
    await handleUpdate(update, deps);

    expect(api.sent).toHaveLength(0);
  });

  it("marks a chat blocked instead of failing the update", async () => {
    api.failWith = new BotApiError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    await expect(handleUpdate(message("/start"), deps)).resolves.toBeUndefined();
    expect(store.blocked).toEqual([CHAT]);
  });

  /**
   * Found by running the thing: an egress proxy in front of the deployment
   * refused the call to Telegram with a bare 403, and every user it touched was
   * marked as having blocked the bot. Infrastructure failing is not a person
   * leaving.
   */
  it("does not mark a chat blocked when an intermediary returns 403", async () => {
    api.failWith = new BotApiError("sendMessage", 403, "Access to api.telegram.org is blocked");
    await expect(handleUpdate(message("/start"), deps)).rejects.toThrow();
    expect(store.blocked).toEqual([]);
  });

  it("does not mark a chat blocked when the network fails", async () => {
    api.failWith = new BotApiError("sendMessage", 504, "Request to Telegram timed out.");
    await expect(handleUpdate(message("/start"), deps)).rejects.toThrow();
    expect(store.blocked).toEqual([]);
  });
});

describe("number parsing", () => {
  it("recognises a 12-digit FIN and a 16-digit FAN", () => {
    expect(parseId("123456789012")).toEqual({ kind: "fin", digits: "123456789012" });
    expect(parseId("1234567890123456")).toEqual({ kind: "fan", digits: "1234567890123456" });
  });

  it("rejects the wrong length, and anything that is not digits", () => {
    expect(parseId("1234567890")).toBeNull();
    expect(parseId("12345678901234")).toBeNull();
    expect(parseId("12345678901a")).toBeNull();
    expect(parseId("")).toBeNull();
  });

  it("strips the separators people type into long numbers", () => {
    expect(normalizeId(" 1234-5678 9012 ")).toBe("123456789012");
    expect(parseId("1234/5678/9012")?.digits).toBe("123456789012");
  });

  it("accepts Arabic-Indic digits, which some keyboards produce", () => {
    expect(normalizeId("١٢٣٤٥٦٧٨٩٠١٢")).toBe("123456789012");
    expect(parseId("۱۲۳۴۵۶۷۸۹۰۱۲")?.kind).toBe("fin");
  });

  it("takes the last four digits for display", () => {
    expect(last4("123456789012")).toBe("9012");
  });
});

describe("points and payments", () => {
  it("shows the balance and the price", async () => {
    await startIn("en");
    await handleUpdate(message("📊 My Points"), deps);

    expect(api.lastScreen.text).toContain("Your points: 0");
    expect(api.lastScreen.text).toContain("Print price (ETB/point): 15");
  });

  it("lists every accepted receipt format when buying", async () => {
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);

    const text = api.lastScreen.text;
    expect(text).toContain("apps.cbe.com.et");
    expect(text).toContain("mbreciept.cbe.com.et");
    expect(text).toContain("transactioninfo.ethiotelecom.et");
    expect(text).toContain("@fayda_id_administrator");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_receipt");
  });

  it("credits points for a receipt it can confirm", async () => {
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);

    expect(api.lastScreen.text).toContain("Points added: 10");
    expect(await store.getBalance(CHAT)).toBe(10);
    expect(store.users.get(CHAT)?.state).toBe("idle");
  });

  it("refuses a receipt that has already been used", async () => {
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);
    const balance = await store.getBalance(CHAT);

    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);

    expect(api.lastScreen.text).toContain("already been used");
    expect(await store.getBalance(CHAT)).toBe(balance);
  });

  it("keeps waiting when the message holds no reference", async () => {
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("i paid yesterday please check"), deps);

    expect(api.lastScreen.text).toContain("could not find a payment reference");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_receipt");
    expect(store.purchases).toHaveLength(0);
  });

  /**
   * The bank's page being unreadable is our problem, not the customer's. It
   * must never read as "you did not pay", and the reference must not be spent
   * on a row that says nothing.
   */
  it("queues for a human when the bank page cannot be read, and tells the admin chat", async () => {
    receiptPage = null;
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);

    expect(api.lastScreen.text).toContain("being checked");
    expect(await store.getBalance(CHAT)).toBe(0);

    const forwarded = api.sent.find((m) => m.chatId === -100_200);
    expect(forwarded?.text).toContain("Payment needs review");
    expect(forwarded?.text).toContain("FT25391XM4KP");
    expect((forwarded?.keyboard ?? []).flat().map((b) => b.callback_data)).toEqual([
      expect.stringMatching(/^adm:ok:/),
      expect.stringMatching(/^adm:no:/),
    ]);
  });

  it("rejects a payment too small to buy a point, without spending the reference", async () => {
    receiptPage = "<td>ETB 10.00</td>";
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);

    expect(api.lastScreen.text).toContain("less than the price of one point");
    expect(store.purchases).toHaveLength(0);
  });

  /**
   * The real Telebirr mistake: "This request is not correct" is what its receipt
   * host returns for an id that does not exist — almost always because a capital
   * letter O was typed as a zero (DJB5O07MCF vs DJB5007MCF). The page loads, so
   * it is not "unreachable", but there is no amount on it. The customer has to
   * be told to check the reference, not left waiting on a review that cannot
   * confirm anything. It is still queued so a real redesign is not lost.
   */
  it("tells the customer to check the reference when the page loads without an amount", async () => {
    receiptPage = "<html><body>This request is not correct</body></html>";
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("DJB5007MCF"), deps);

    expect(api.lastScreen.text).toContain("could not read an amount");
    expect(api.lastScreen.text).toContain("letter O and the digit 0");
    expect(await store.getBalance(CHAT)).toBe(0);
    expect(api.sent.some((m) => m.chatId === -100_200 && m.text.includes("Payment needs review"))).toBe(
      true,
    );
  });

  it("answers in Amharic when that is the chosen language", async () => {
    await startIn("am");
    await handleUpdate(message("📊 የእኔ ነጥብ"), deps);
    expect(api.lastScreen.text).toContain("የእርስዎ ነጥብ፡ 0");
  });

  /**
   * The keyboard on screen is a picture, and it lags a language change by one
   * message. A tap on the stale one still has to work.
   */
  it("routes a button from the other language", async () => {
    await startIn("am");
    await handleUpdate(message("📊 My Points"), deps);
    expect(api.lastScreen.text).toContain("የእርስዎ ነጥብ፡");
  });

  it("treats a button press as a change of mind, not an answer", async () => {
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("📊 My Points"), deps);

    expect(api.lastScreen.text).toContain("Your points:");
    expect(store.purchases).toHaveLength(0);
  });
});

describe("admin review", () => {
  const adminTap = (data: string): TgUpdate => ({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: ADMIN, first_name: "Admin" },
      message: { message_id: 1, chat: { id: ADMIN, type: "private" } },
      data,
    },
  });

  async function queueOne(): Promise<string> {
    receiptPage = null;
    await startIn("en");
    await handleUpdate(message("💳 Buy Points"), deps);
    await handleUpdate(message("FT25391XM4KP"), deps);
    const id = store.purchases[0]?.id;
    if (!id) throw new Error("nothing was queued");
    return id;
  }

  it("credits the customer when an admin approves and names an amount", async () => {
    const id = await queueOne();

    await handleUpdate(adminTap(`adm:ok:${id}`), deps);
    expect(api.lastScreen.text).toContain("How many points?");

    await handleUpdate(
      {
        update_id: ++updateId,
        message: {
          message_id: 99,
          chat: { id: ADMIN, type: "private" },
          from: { id: ADMIN, first_name: "Admin" },
          text: "10",
        },
      },
      deps,
    );

    expect(await store.getBalance(CHAT)).toBe(10);
    // The customer has heard nothing since "being checked", so they are told.
    expect(api.sent.some((m) => m.chatId === CHAT && m.text.includes("Points added: 10"))).toBe(
      true,
    );
  });

  it("credits nothing when an admin rejects", async () => {
    const id = await queueOne();
    await handleUpdate(adminTap(`adm:no:${id}`), deps);

    expect(api.lastScreen.text).toContain("Rejected");
    expect(await store.getBalance(CHAT)).toBe(0);
  });

  /**
   * callback_data is attacker-controlled. Anyone can send adm:ok:<id> to the
   * bot; only the allow-list decides whether it means anything.
   */
  it("ignores an approval from someone who is not an admin", async () => {
    const id = await queueOne();
    await handleUpdate(tap(`adm:ok:${id}`), deps);

    expect(api.lastScreen.text).not.toContain("How many points?");
    expect(store.decisions).toHaveLength(0);
  });

  it("ignores a second decision on the same payment", async () => {
    const id = await queueOne();
    await handleUpdate(adminTap(`adm:no:${id}`), deps);
    await handleUpdate(adminTap(`adm:no:${id}`), deps);

    expect(api.lastScreen.text).toContain("already been decided");
    expect(store.decisions).toHaveLength(1);
  });
});

describe("admin panel", () => {
  const adminMessage = (text: string): TgUpdate => ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      chat: { id: ADMIN, type: "private" },
      from: { id: ADMIN, first_name: "Admin" },
      text,
    },
  });

  const adminTap = (data: string): TgUpdate => ({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: ADMIN, first_name: "Admin" },
      message: { message_id: 1, chat: { id: ADMIN, type: "private" } },
      data,
    },
  });

  /** The admin's own /start, so /admin is past the language gate. */
  async function adminStartIn() {
    await handleUpdate(adminMessage("/start"), deps);
    await handleUpdate(adminTap("lang:en"), deps);
    api.screens = [];
    api.sent = [];
  }

  const paymentRow = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
    id: "pur-1",
    telegram_id: String(CHAT),
    provider: "telebirr",
    reference: "DJB5O07MCF",
    raw_input: "DJB5O07MCF",
    amount_etb: "15.00",
    points: 1,
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("opens a panel for an admin, with a way to post", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);

    expect(api.lastScreen.text).toContain("Admin panel");
    expect(api.lastScreen.text).toContain("Pending payments");
    expect(api.buttons()).toContain("ap:post");
    expect(api.buttons()).toContain("menu");
  });

  it("tells a non-admin that /admin is not for them", async () => {
    await startIn("en");
    await handleUpdate(message("/admin"), deps);

    expect(api.lastScreen.text).toContain("for administrators");
    expect(api.buttons()).not.toContain("ap:post");
  });

  it("opens the panel before a language has been chosen", async () => {
    // The admin's very first message is /admin — no language set yet.
    await handleUpdate(adminMessage("/admin"), deps);

    expect(api.lastScreen.text).toContain("Admin panel");
    expect(api.buttons()).toContain("ap:post");
  });

  it("lists pending payments with the same approve and reject buttons", async () => {
    await adminStartIn();
    store.pending = [paymentRow()];

    await handleUpdate(adminMessage("/admin"), deps);
    expect(api.buttons()).toContain("ap:pays");

    await handleUpdate(adminTap("ap:pays"), deps);
    expect(api.lastScreen.text).toContain("DJB5O07MCF");
    expect(api.buttons()).toContain("adm:ok:pur-1");
    expect(api.buttons()).toContain("adm:no:pur-1");
  });

  it("ignores the panel's post button from someone who is not an admin", async () => {
    await startIn("en");
    await handleUpdate(tap("ap:post"), deps);

    expect(store.users.get(CHAT)?.state).not.toBe("awaiting_post");
  });

  it("shows the user count, their total points, and the card API points", async () => {
    await adminStartIn();
    store.users.get(ADMIN)!.points = 5;

    await handleUpdate(adminMessage("/admin"), deps);

    expect(api.lastScreen.text).toContain("Users: <b>1</b>");
    expect(api.lastScreen.text).toContain("Total user points: <b>5</b>");
    expect(api.lastScreen.text).toContain("My points (card API): <b>497</b>");
    expect(api.buttons()).toContain("ap:users");
  });

  it("lists each user with their balance and the total", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 7;
    await adminStartIn();
    store.users.get(ADMIN)!.points = 3;

    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:users"), deps);

    expect(api.lastScreen.text).toContain("Total: <b>2</b>");
    expect(api.lastScreen.text).toContain("Points held: <b>10</b>");
    expect(api.lastScreen.text).toContain("Hanna");
    expect(api.lastScreen.text).toContain("<b>7</b>");
    expect(api.buttons()).toContain("ap:panel");
  });

  it("ignores the users button from someone who is not an admin", async () => {
    await startIn("en");
    await handleUpdate(tap("ap:users"), deps);

    expect(api.screens).toHaveLength(0);
  });

  it("posts an admin's message to every user and reports the count", async () => {
    await startIn("en"); // a plain user, who should receive it
    await adminStartIn();

    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:post"), deps);
    expect(store.users.get(ADMIN)?.state).toBe("awaiting_post");

    api.sent = [];
    await handleUpdate(adminMessage("Maintenance at 6pm"), deps);

    const delivered = api.sent.filter((m) => m.text.includes("Maintenance at 6pm"));
    expect(delivered.map((m) => m.chatId).sort()).toEqual([CHAT, ADMIN].sort());
    expect(api.lastScreen.text).toContain("Posted to 2 of 2 users");
    expect(store.users.get(ADMIN)?.state).toBe("idle");
  });

  it("keeps asking when the announcement is too long", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:post"), deps);

    await handleUpdate(adminMessage("x".repeat(5000)), deps);

    expect(api.lastScreen.text).toContain("too long");
    expect(store.users.get(ADMIN)?.state).toBe("awaiting_post");
  });

  /**
   * A DB-granted admin has never been in ADMIN_TELEGRAM_IDS, so an admin check
   * that only reads the environment would leave them unable to use the panel
   * they were granted. These tests exercise a second operator — one granted
   * through the portal — alongside the super admin from the environment.
   */
  const REGULAR = 55_000;

  const asMessage = (id: number, text: string): TgUpdate => ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      chat: { id, type: "private" },
      from: { id, first_name: "Operator", username: "operator" },
      text,
    },
  });

  const asTap = (id: number, data: string): TgUpdate => ({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id, first_name: "Operator" },
      message: { message_id: 1, chat: { id, type: "private" } },
      data,
    },
  });

  /** Starts the bot as someone else, so their user row exists. */
  async function startAs(id: number) {
    await handleUpdate(asMessage(id, "/start"), deps);
    await handleUpdate(asTap(id, "lang:en"), deps);
    api.screens = [];
    api.sent = [];
  }

  it("draws the Admin button only for admins", async () => {
    await startIn("en");
    await handleUpdate(message("📊 My Points"), deps);
    expect(api.mainButtons()).not.toContain("🛠 Admin");

    await adminStartIn();
    await handleUpdate(adminMessage("📊 My Points"), deps);
    expect(api.mainButtons()).toContain("🛠 Admin");
  });

  it("treats a database-granted admin as an admin, with the button and the panel", async () => {
    store.grantedAdmins = [REGULAR];
    await startAs(REGULAR);

    await handleUpdate(asMessage(REGULAR, "📊 My Points"), deps);
    expect(api.mainButtons()).toContain("🛠 Admin");

    await handleUpdate(asMessage(REGULAR, "/admin"), deps);
    expect(api.lastScreen.text).toContain("Role: <b>admin</b>");
    expect(api.buttons()).toContain("ap:post");
    // Only a super admin may grow the operator list.
    expect(api.buttons()).not.toContain("ap:add");
    expect(api.buttons()).not.toContain("ap:admins");
  });

  it("offers admin management to a super admin", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);

    expect(api.lastScreen.text).toContain("Role: <b>super admin</b>");
    expect(api.buttons()).toContain("ap:add");
    expect(api.buttons()).toContain("ap:admins");
  });

  it("refuses admin management from a granted admin", async () => {
    store.grantedAdmins = [REGULAR];
    await startAs(REGULAR);

    await handleUpdate(asTap(REGULAR, "ap:add"), deps);
    expect(api.lastScreen.text).toContain("Only a super admin");
    expect(store.users.get(REGULAR)?.state).not.toBe("awaiting_admin");

    await handleUpdate(asTap(REGULAR, "ap:admins"), deps);
    expect(api.lastScreen.text).toContain("Only a super admin");
  });

  it("grants access to someone who has started the bot, and tells them", async () => {
    await startAs(REGULAR);
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:add"), deps);
    expect(store.users.get(ADMIN)?.state).toBe("awaiting_admin");

    await handleUpdate(adminMessage(String(REGULAR)), deps);

    expect(store.grantedAdmins).toContain(REGULAR);
    expect(store.users.get(ADMIN)?.state).toBe("idle");
    expect(api.lastScreen.text).toContain(`Granted admin access to ${REGULAR}`);
    // The keyboard is static: the new admin has to redraw it themselves.
    expect(
      api.sent.some(
        (m) => m.chatId === REGULAR && m.text.includes("You are now an admin"),
      ),
    ).toBe(true);
  });

  it("refuses a grant for an id that has never started the bot", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:add"), deps);

    await handleUpdate(adminMessage("999999999"), deps);

    expect(store.grantedAdmins).toHaveLength(0);
    expect(api.lastScreen.text).toContain("has not started this bot");
    // Still waiting, so a corrected id can be sent without starting over.
    expect(store.users.get(ADMIN)?.state).toBe("awaiting_admin");
  });

  it("asks for a numeric id when the grant text is not one", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:add"), deps);

    await handleUpdate(adminMessage("not-a-number"), deps);

    expect(store.grantedAdmins).toHaveLength(0);
    expect(api.lastScreen.text).toContain("not a Telegram ID");
    expect(store.users.get(ADMIN)?.state).toBe("awaiting_admin");
  });

  it("says so when the id is already a super admin", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:add"), deps);

    await handleUpdate(adminMessage(String(ADMIN)), deps);

    expect(store.grantedAdmins).toHaveLength(0);
    expect(api.lastScreen.text).toContain("already a super admin");
    expect(store.users.get(ADMIN)?.state).toBe("idle");
  });

  it("lists every admin and revokes a granted one", async () => {
    store.grantedAdmins = [REGULAR];
    await startAs(REGULAR);
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);
    await handleUpdate(adminTap("ap:admins"), deps);

    expect(api.lastScreen.text).toContain(`<code>${ADMIN}</code> — super admin`);
    expect(api.lastScreen.text).toContain(`<code>${REGULAR}</code> — admin`);
    expect(api.buttons()).toContain(`ap:rm:${REGULAR}`);

    await handleUpdate(adminTap(`ap:rm:${REGULAR}`), deps);

    expect(store.grantedAdmins).not.toContain(REGULAR);
    expect(api.lastScreen.text).toContain(`Removed admin access from ${REGULAR}`);
    expect(api.buttons()).not.toContain(`ap:rm:${REGULAR}`);
  });

  it("does not remove a super admin from the chat", async () => {
    await adminStartIn();
    await handleUpdate(adminMessage("/admin"), deps);

    await handleUpdate(adminTap(`ap:rm:${ADMIN}`), deps);

    expect(store.grantedAdmins).toHaveLength(0);
    expect(api.lastScreen.text).toContain("cannot be removed here");
  });
});

describe("settings", () => {
  it("offers the five download types and remembers the choice", async () => {
    await startIn("en");
    await handleUpdate(message("⚙️ Settings"), deps);

    // The Settings button opens a menu, not the format list directly.
    expect(api.lastScreen.text).toContain("Choose what to change.");
    expect(api.buttons()).toEqual(["setlang", "dl_menu", "my_points", "menu"]);

    await handleUpdate(tap("dl_menu"), deps);
    expect(api.lastScreen.text).toContain("Current download type: Download PDF Mirror");
    expect(api.buttons()).toEqual([
      "dl:png_mirror",
      "dl:pdf_mirror",
      "dl:duo_png",
      "dl:zip",
      "dl:printable",
      "back_settings",
    ]);

    await handleUpdate(tap("dl:zip"), deps);
    expect(store.users.get(CHAT)?.downloadType).toBe("zip");
    expect(api.lastScreen.text).toContain("Current download type: Download ZIP");
    expect(api.buttons()).toEqual([
      "dl:png_mirror",
      "dl:pdf_mirror",
      "dl:duo_png",
      "dl:zip",
      "dl:printable",
      "back_settings",
    ]);

    await handleUpdate(tap("dl:printable"), deps);
    expect(store.users.get(CHAT)?.downloadType).toBe("printable");
    expect(api.lastScreen.text).toContain("Current download type: Printable Card");
  });

  it("changes the language from Settings and stays in Settings", async () => {
    await startIn("en");
    await handleUpdate(message("⚙️ Settings"), deps);

    await handleUpdate(tap("setlang"), deps);
    await handleUpdate(tap("setlang:am"), deps);

    expect(store.users.get(CHAT)?.language).toBe("am");
    // Back on the Settings menu, now in Amharic.
    expect(api.lastScreen.text).toContain("ምን መቀየር እንደሚፈልጉ ይምረጡ");
    expect(api.buttons()).toEqual(["setlang", "dl_menu", "my_points", "menu"]);
  });
});

describe("card retrieval", () => {
  it("says plainly that retrieval is not connected when there is no provider", async () => {
    deps.cards = unconfiguredCardProvider;
    await startIn("en");
    await handleUpdate(message("📱 OTP 2"), deps);

    expect(api.lastScreen.text).toContain("not connected");
    expect(store.users.get(CHAT)?.state).toBe("idle");
  });

  /**
   * The cost is named before the number is asked for. Sending somebody's FAN
   * upstream and only then saying they cannot afford the result would have
   * spent their privacy for nothing.
   */
  it("refuses before asking for a FAN when the balance will not cover it", async () => {
    await startIn("en");
    await handleUpdate(message("📱 OTP 2"), deps);

    expect(api.lastScreen.text).toContain("Buy more points first");
    expect(store.users.get(CHAT)?.state).toBe("idle");
    expect(cards.calls).toHaveLength(0);
  });

  it("does not store the FAN in plain text anywhere", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);

    // The session has to survive until the code arrives, so it holds the FAN —
    // encrypted. Neither the user row nor the session may show the digits.
    const stored = JSON.stringify([...store.users.values(), ...store.otpSessions]);
    expect(stored).not.toContain("1234567890123456");
    expect(store.otpSessions[0]?.fanSecret).toMatch(/^v1\./);
  });

  it("rejects a FIN, which is the wrong number for this flow", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("123456789012"), deps);

    expect(api.lastScreen.text).toContain("does not look like");
    expect(cards.calls).toHaveLength(0);
  });

  it("sends the code, then delivers the provider's original PDF and charges for it", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "pdf",
      pdf: await PDFDocument.create().then((doc) => {
        doc.addPage([242.645, 153.071]);
        return doc.save().then((bytes) => Buffer.from(bytes));
      }),
      filename: "Fayda-1234567890123456.pdf",
      remainingPoints: 496,
    };

    await startIn("en");
    store.users.get(CHAT)!.points = 3;

    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    expect(api.lastScreen.text).toContain("16-digit");

    await handleUpdate(message("1234567890123456"), deps);
    expect(api.lastScreen.text).toContain("******7890");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_otp");

    await handleUpdate(message("123456"), deps);

    // The default format is "PDF mirror", so the PDF verify endpoint is used —
    // the provider's own document goes out unchanged, not an A4 sheet rendered
    // here. Requesting the JSON endpoint too would spend a second point.
    expect(cards.calls.find((c) => c.method === "verifyOtp")?.format).toBe("pdf");

    // The document itself, under the provider's own filename.
    expect(api.documents).toHaveLength(1);
    expect(api.documents[0]?.filename).toBe("Fayda-1234567890123456.pdf");
    expect(api.documents[0]?.bytes.toString()).toContain("%PDF");
    expect(api.documents[0]?.caption).toContain("Points used: 1");
    // The provider's document is passed through untouched: no serial of ours
    // is allocated or printed on it.
    expect(store.cardSerials).toHaveLength(0);
    expect(api.documents[0]?.caption).not.toContain("SN:");
    // The document is also sent as a picture. It carries no identity fields to
    // draw the designed card from, so its own pages are rendered instead — one
    // verify, one point, both outputs.
    expect(api.photos).toHaveLength(1);
    expect(api.photos[0]?.filename).toBe("fayda-card.png");
    expect(api.photos[0]?.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(api.photos[0]?.caption).toContain("image");

    expect(await store.getBalance(CHAT)).toBe(2);
    expect(store.users.get(CHAT)?.state).toBe("idle");
    expect(store.cardJobs[0]).toMatchObject({ source: "otp", status: "delivered", telegramFileId: null });

    // The session is closed and emptied, not merely marked done.
    expect(store.otpSessions[0]?.status).toBe("verified");
    expect(store.otpSessions[0]?.fanSecret).toBeNull();
    expect(store.otpSessions[0]?.providerRef).toBeNull();
  });

  /**
   * The printable format gets the card twice: the A4 sheet for paper, and the
   * same card as a picture — front and back — that is easy to forward. The
   * image comes second, so a card already delivered as a document is never
   * withheld because the picture failed. Only the printable format has
   * identity fields to draw; the original PDF is delivered as-is.
   */
  it("follows the printable PDF with the card as a front-and-back image", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "json",
      remainingPoints: 496,
      identity: IDENTITY,
    };

    await startIn("en");
    store.users.get(CHAT)!.downloadType = "printable";
    store.users.get(CHAT)!.points = 3;

    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("123456"), deps);

    expect(api.documents).toHaveLength(1);
    expect(api.photos).toHaveLength(1);
    expect(api.photos[0]?.filename).toBe("fayda-card.png");
    expect(api.photos[0]?.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Two CR80-proportioned panels side by side.
    expect(api.photos[0]?.bytes.readUInt32BE(16)).toBe(2600);
    expect(api.photos[0]?.bytes.readUInt32BE(20)).toBe(800);
    expect(api.photos[0]?.caption).toContain("Front & back");
    // The first printable card is numbered 58100, and the number is repeated
    // in the delivery caption so it can be matched to the paper card.
    expect(store.cardSerials).toEqual([58100]);
    expect(api.documents[0]?.caption).toContain("SN: 58100");
  });

  it("renders a printable sheet when the download type is printable", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "json",
      remainingPoints: 496,
      identity: IDENTITY,
    };

    await startIn("en");
    store.users.get(CHAT)!.downloadType = "printable";
    store.users.get(CHAT)!.points = 3;

    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("123456"), deps);

    // The layout is built by pdf-lib from the JSON identity: the delivered
    // document is a fresh PDF with two A4 sheets (front and back), named for a
    // print sheet instead of an upstream file.
    expect(api.documents).toHaveLength(1);
    expect(api.documents[0]?.filename).toBe("fayda-printable.pdf");
    const delivered = await PDFDocument.load(api.documents[0]!.bytes);
    expect(delivered.getPageCount()).toBe(2);
    for (const page of delivered.getPages()) {
      expect(page.getWidth()).toBeGreaterThan(500); // A4 sheets, not an upstream page
    }
    // The JSON endpoint was asked for, so the same code is never sent twice.
    expect(cards.calls.find((c) => c.method === "verifyOtp")?.format).toBe("json");
    // The caption recaps the identity the JSON verify returned — the guide's
    // summary, alongside the card — including the provider's remaining points.
    const caption = api.documents[0]?.caption ?? "";
    expect(caption).toContain("Abebe Kebede");
    expect(caption).toContain("1234567890");
    expect(caption).toContain("1988-05-09");
    expect(caption).toContain("0912345678");
    expect(caption).toContain("Remaining points: 496");
  });

  /**
   * A serial identifies a produced card, so it is allocated once per printable
   * delivery and never repeats. The sequence starts at 58100; these two runs
   * prove the router asks for the next one rather than rebuilding the same.
   */
  it("numbers each printable card in sequence", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "json",
      remainingPoints: 496,
      identity: IDENTITY,
    };

    await startIn("en");
    store.users.get(CHAT)!.downloadType = "printable";
    store.users.get(CHAT)!.points = 5;

    const deliver = async () => {
      await handleUpdate(message("📱 OTP 1 ⭐"), deps);
      await handleUpdate(message("1234567890123456"), deps);
      await handleUpdate(message("123456"), deps);
    };

    await deliver();
    await deliver();

    expect(store.cardSerials).toEqual([58100, 58101]);
    expect(api.documents).toHaveLength(2);
    expect(api.documents[0]?.caption).toContain("SN: 58100");
    expect(api.documents[1]?.caption).toContain("SN: 58101");
  });

  /**
   * The serial is a label, not a precondition. If the sequence cannot be read,
   * the card has still been paid for twice over and must go out unnumbered.
   */
  it("still delivers a printable card when no serial can be allocated", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "json",
      remainingPoints: 496,
      identity: IDENTITY,
    };
    store.failNextCardSerial = true;

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await startIn("en");
      store.users.get(CHAT)!.downloadType = "printable";
      store.users.get(CHAT)!.points = 3;

      await handleUpdate(message("📱 OTP 1 ⭐"), deps);
      await handleUpdate(message("1234567890123456"), deps);
      await handleUpdate(message("123456"), deps);

      expect(api.documents).toHaveLength(1);
      expect(api.photos).toHaveLength(1);
      expect(api.documents[0]?.caption).not.toContain("SN:");
      expect(errors.mock.calls.flat().join(" ")).toContain("card serial allocation failed");
    } finally {
      errors.mockRestore();
    }
  });

  it("hands the provider back the session exactly as it was given", async () => {
    cards.sendOtpResult = { outcome: "sent", session: "  odd/session+value==  ", phone: "***" };
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234 5678 9012 3456"), deps);
    await handleUpdate(message("123456"), deps);

    const verify = cards.calls.find((c) => c.method === "verifyOtp");
    expect(verify?.session).toBe("  odd/session+value==  ");
    // Spaces are stripped from the FAN, which is what the provider expects.
    expect(verify?.fan).toBe("1234567890123456");
  });

  it("keeps the session open for a mistyped code, and charges nothing", async () => {
    cards.verifyResult = { outcome: "rejected", message: "Invalid OTP." };
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("000000"), deps);

    expect(api.lastScreen.text).toContain("Invalid OTP.");
    expect(await store.getBalance(CHAT)).toBe(3);
    expect(store.users.get(CHAT)?.state).toBe("awaiting_otp");
    expect(store.otpSessions[0]?.status).toBe("awaiting_code");
  });

  it("closes the session after three wrong codes", async () => {
    cards.verifyResult = { outcome: "rejected", message: "Invalid OTP." };
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);

    for (const code of ["000000", "111111", "222222"]) {
      await handleUpdate(message(code), deps);
    }

    expect(api.lastScreen.text).toContain("Too many wrong codes");
    expect(store.otpSessions[0]?.status).toBe("failed");
    expect(store.users.get(CHAT)?.state).toBe("idle");
  });

  /**
   * A verify that does not come back may still have succeeded upstream, and a
   * point may already be gone. Retrying would risk spending a second one, so
   * the session closes and a human is told instead.
   */
  it("closes the session and warns the admin chat when a verify does not complete", async () => {
    cards.verifyResult = { outcome: "unavailable" };
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("123456"), deps);

    expect(await store.getBalance(CHAT)).toBe(3);
    expect(store.otpSessions[0]?.status).toBe("failed");
    expect(store.users.get(CHAT)?.state).toBe("idle");
    const warned = api.sent.find((m) => m.chatId === -100_200);
    expect(warned?.text).toContain("check whether a point was spent");
  });

  it("warns the admin chat when the upstream balance is running out", async () => {
    cards.verifyResult = {
      outcome: "verified",
      format: "json",
      identity: IDENTITY,
      remainingPoints: 4,
    };
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("123456"), deps);

    const warned = api.sent.find((m) => m.chatId === -100_200 && m.text.includes("balance is low"));
    expect(warned?.text).toContain("4 points left");
  });

  /**
   * The customer has been charged and the PDF is not retained, so a failed
   * hand-off cannot be retried — it can only be refunded, and that needs a
   * human to hear about it.
   */
  it("tells the admin chat when a produced card cannot be delivered", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);

    api.failWith = new BotApiError("sendDocument", 403, "Forbidden: bot was blocked by the user");
    api.failChatId = CHAT;
    await expect(handleUpdate(message("123456"), deps)).resolves.toBeUndefined();

    // Recorded more than once: the "checking your code" message fails the same
    // way a moment earlier. Marking a chat blocked is idempotent, so that is
    // harmless — but it is why this is a containment check, not an equality one.
    expect(store.blocked).toContain(CHAT);
    const warned = api.sent.find((m) => m.chatId === -100_200 && m.text.includes("could not be delivered"));
    expect(warned?.text).toContain("needs a refund");
  });

  it("asks again for anything that is not a six-digit code", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 3;
    await handleUpdate(message("📱 OTP 1 ⭐"), deps);
    await handleUpdate(message("1234567890123456"), deps);
    await handleUpdate(message("not a code"), deps);

    expect(api.lastScreen.text).toContain("6-digit code");
    expect(cards.calls.filter((c) => c.method === "verifyOtp")).toHaveLength(0);
    expect(store.users.get(CHAT)?.state).toBe("awaiting_otp");
  });

  it("asks to buy points first when there are not enough to cover a print", async () => {
    await startIn("en");
    await handleUpdate(message("📄 Upload PDF"), deps);
    expect(api.lastScreen.text).toContain("Buy more points first");
    expect(store.users.get(CHAT)?.state).toBe("idle");
  });

  it("takes an uploaded PDF, spends points, and creates a card job", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 3;

    await handleUpdate(message("📄 Upload PDF"), deps);
    expect(api.lastScreen.text).toContain("Send your Fayda screenshot or PDF now");
    expect(store.users.get(CHAT)?.state).toBe("awaiting_upload");

    await handleUpdate(
      message("", {
        message: {
          message_id: ++updateId,
          chat: { id: CHAT, type: "private" },
          from: { id: CHAT, first_name: "Hanna", username: "hanna" },
          document: { file_id: "file-1", file_unique_id: "unique-1", mime_type: "application/pdf" },
        },
      }),
      deps,
    );

    expect(api.sent.some((m) => m.chatId === CHAT && m.text.includes("Points used: 1"))).toBe(true);
    expect(await store.getBalance(CHAT)).toBe(2);
    expect(store.users.get(CHAT)?.state).toBe("idle");
    expect(store.cardJobs).toHaveLength(1);
    expect(store.cardJobs[0]).toMatchObject({
      telegramId: CHAT,
      source: "upload_pdf",
      pointsSpent: 1,
      telegramFileId: "file-1",
    });

    const forwarded = api.sent.find((m) => m.chatId === -100_200);
    expect(forwarded?.text).toContain("New card job");
  });

  it("takes an uploaded screenshot as a photo", async () => {
    await startIn("en");
    store.users.get(CHAT)!.points = 1;

    await handleUpdate(message("🪪 Fayda Screenshot"), deps);
    await handleUpdate(
      message("", {
        message: {
          message_id: ++updateId,
          chat: { id: CHAT, type: "private" },
          from: { id: CHAT, first_name: "Hanna", username: "hanna" },
          photo: [
            { file_id: "small", file_unique_id: "small-u", width: 90, height: 90 },
            { file_id: "large", file_unique_id: "large-u", width: 800, height: 800 },
          ],
        },
      }),
      deps,
    );

    expect(await store.getBalance(CHAT)).toBe(0);
    expect(store.cardJobs[0]).toMatchObject({ source: "upload_image", telegramFileId: "large" });
  });
});
