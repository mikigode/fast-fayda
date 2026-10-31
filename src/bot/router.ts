import { env } from "../env";
import {
  BotApiError,
  escapeHtml,
  type BotApi,
  type InlineKeyboard,
  type ReplyKeyboard,
} from "./api";
import { liveCardProvider, type CardIdentity, type CardProvider } from "./card";
import { broadcastToUsers } from "./broadcast";
import { CARD_IMAGE_FILENAME, toCardImage } from "./cardImage";
import { cardSidesFromPdf } from "./pdfImage";
import { toIdentityPdf, toPrintable } from "./printable";
import { open, seal } from "../crypto";
import { currentProvider, hashId, last4, parseId, type FaydaProvider } from "./fayda";
import {
  DOWNLOAD_TYPES,
  LANGS,
  commandsFor,
  guessLang,
  isLang,
  t,
  type DownloadType,
  type Lang,
} from "./i18n";
import { liveFetcher, verifyPayment, type ReceiptFetcher } from "./payments";
import { parseReceipt } from "./receipts";
import { hasAnyAccount, resolveSettings } from "./settings";
import { dbStore, SpendError, type BotStore, type BotUser, type UserPointRow } from "./store";

/**
 * The conversation itself.
 *
 * Written against the BotStore and BotApi interfaces rather than the database
 * and the network, so the whole flow is testable by passing doubles — see
 * tests/bot.test.ts. `handleUpdate` is the only entry point; the webhook route
 * does nothing but authenticate the request and call it.
 *
 * Two rules shape the code below:
 *
 *   - A person is never left without a way forward. Every screen ends in
 *     buttons, and any input the bot cannot make sense of gets the menu back
 *     rather than silence.
 *   - Nothing is remembered that does not have to be. The state machine holds
 *     which question was asked, never the answer.
 */

// ---------------------------------------------------------------------------
// The slice of Telegram's update shape this bot reads
// ---------------------------------------------------------------------------

export type TgUser = {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
  is_bot?: boolean;
};

export type TgPhotoSize = { file_id: string; file_unique_id: string; width: number; height: number };
export type TgDocument = { file_id: string; file_unique_id: string; mime_type?: string };

export type TgMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  /** Telegram sends every resolution it generated; the last is the largest. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type BotDeps = {
  store: BotStore;
  api: BotApi;
  provider: FaydaProvider;
  /** Turns a FAN plus an OTP into the holder's card. */
  cards: CardProvider;
  /** Chat receiving support messages and payments that need a human. */
  supportChatId: number | null;
  /** Chat (usually a group) that is told when someone starts the bot. */
  newUserGroupId: number | null;
  /** Birr per point. */
  pricePerPoint: number;
  /** Fetches a bank receipt page for verification. */
  fetchReceipt: ReceiptFetcher;
  /** Telegram IDs permitted to decide a queued payment. */
  adminIds: number[];
  /** Contact quoted in messages that send someone to a human. */
  adminContact: string;
};

/** Wires up the real database, network and provider. */
export function liveDeps(api: BotApi, supportChatId: number | null): BotDeps {
  return {
    store: dbStore,
    api,
    provider: currentProvider(),
    cards: liveCardProvider(dbStore),
    supportChatId,
    newUserGroupId: env.newUserGroupId,
    pricePerPoint: env.pointPriceEtb,
    fetchReceipt: liveFetcher,
    adminIds: env.adminTelegramIds,
    adminContact: env.adminContact,
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Lookup budget per person. Generous for someone checking their own
 * application and their family's, restrictive for anyone walking the number
 * space to see whose applications exist.
 */
const LOOKUP_LIMIT = 5;
const LOOKUP_WINDOW_MINUTES = 15;

/** Telegram messages cap at 4096 characters; a support message needs far less. */
const SUPPORT_MAX_CHARS = 1000;

// ---------------------------------------------------------------------------
// Callback data
// ---------------------------------------------------------------------------

/**
 * The bank-account fields an admin can edit from the chat panel.
 *
 * These are the same columns the admin portal's Settings form writes, so a
 * change made here is live for the very next "Buy Points" message — the
 * conversation resolves the accounts from the database every time rather than
 * reading them once at boot.
 */
const ACCOUNT_FIELDS = {
  cbeAccountName: "CBE account name",
  cbeAccountNumber: "CBE account number",
  telebirrAccountName: "Telebirr account name",
  telebirrAccountNumber: "Telebirr account number",
} as const;

type AccountField = keyof typeof ACCOUNT_FIELDS;

function isAccountField(value: string): value is AccountField {
  return value in ACCOUNT_FIELDS;
}

/**
 * Telegram allows 64 bytes of callback_data, which is why these are terse. They
 * are also attacker-controlled — anyone can send any callback_data to a bot —
 * so nothing here is trusted beyond selecting a screen.
 */
const CB = {
  lang: (lang: Lang) => `lang:${lang}`,
  menu: "menu",
  status: "status",
  faq: "faq",
  faqItem: (id: string) => `faq:${id}`,
  appointment: "appt",
  support: "support",
  language: "lang",
  cancel: "cancel",
  download: (type: DownloadType) => `dl:${type}`,
  /** Settings sub-menu: the download-format screen. */
  downloadMenu: "dl_menu",
  /** Settings shortcut: show the points balance. */
  myPoints: "my_points",
  /** Returns to the settings menu from Language or download-type screens. */
  backSettings: "back_settings",
  /** Opens the settings language chooser. */
  settingsLanguage: "setlang",
  /** The settings language chooser's option buttons. */
  settingsLangChoice: (lang: Lang) => `setlang:${lang}`,
  /** Admin decisions on a queued payment. Guarded by the allow-list, not by obscurity. */
  approve: (id: string) => `adm:ok:${id}`,
  reject: (id: string) => `adm:no:${id}`,
  /**
   * The /admin panel and its buttons. A distinct prefix from `adm:` on purpose
   * — decisions are dispatched on that prefix, and the panel is a different
   * thing that must not be mistaken for one.
   */
  adminPanel: "ap:panel",
  adminPayments: "ap:pays",
  adminUsers: "ap:users",
  adminPost: "ap:post",
  /** Super-admin only: grant access to one more person. */
  adminAdd: "ap:add",
  /** Super-admin only: list every admin, with a remove button per granted one. */
  adminList: "ap:admins",
  adminRemove: (telegramId: number) => `ap:rm:${telegramId}`,
  /** The CBE/Telebirr accounts customers pay into, editable in the chat. */
  adminAccounts: "ap:accounts",
  adminAccount: (field: AccountField) => `ap:acct:${field}`,
} as const;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function menuKeyboard(lang: Lang): InlineKeyboard {
  const c = t(lang);
  return [
    [{ text: c.btnCheckStatus, callback_data: CB.status }],
    [{ text: c.btnFaq, callback_data: CB.faq }],
    [{ text: c.btnAppointment, callback_data: CB.appointment }],
    [{ text: c.btnSupport, callback_data: CB.support }],
    [{ text: c.btnLanguage, callback_data: CB.language }],
  ];
}

function backKeyboard(lang: Lang): InlineKeyboard {
  return [[{ text: t(lang).btnBack, callback_data: CB.menu }]];
}

function cancelKeyboard(lang: Lang): InlineKeyboard {
  return [[{ text: t(lang).btnCancel, callback_data: CB.cancel }]];
}

function languageKeyboard(): InlineKeyboard {
  return [
    [
      { text: "አማርኛ", callback_data: CB.lang("am") },
      { text: "English", callback_data: CB.lang("en") },
    ],
  ];
}

function settingsKeyboard(lang: Lang): InlineKeyboard {
  const c = t(lang);
  return [
    [{ text: c.btnLanguage, callback_data: CB.settingsLanguage }],
    [{ text: c.btnDownloadType, callback_data: CB.downloadMenu }],
    [{ text: c.btnMyPoints, callback_data: CB.myPoints }],
    [{ text: c.btnBack, callback_data: CB.menu }],
  ];
}

/** Language chooser reachable from Settings; choosing returns to Settings. */
function settingsLanguageKeyboard(lang: Lang): InlineKeyboard {
  return [
    [
      { text: "አማርኛ", callback_data: CB.settingsLangChoice("am") },
      { text: "English", callback_data: CB.settingsLangChoice("en") },
    ],
    [{ text: t(lang).btnBackSettings, callback_data: CB.backSettings }],
  ];
}

function downloadMenuKeyboard(lang: Lang): InlineKeyboard {
  const labels = t(lang).downloadTypes;
  return [
    [
      { text: labels.png_mirror, callback_data: CB.download("png_mirror") },
      { text: labels.pdf_mirror, callback_data: CB.download("pdf_mirror") },
    ],
    [
      { text: labels.duo_png, callback_data: CB.download("duo_png") },
      { text: labels.zip, callback_data: CB.download("zip") },
    ],
    [{ text: labels.printable, callback_data: CB.download("printable") }],
    [{ text: t(lang).btnBackSettings, callback_data: CB.backSettings }],
  ];
}

// ---------------------------------------------------------------------------
// The main keyboard, and routing by what a button says
// ---------------------------------------------------------------------------

type Action =
  | "otp1"
  | "otp2"
  | "otp3"
  | "screenshot"
  | "upload_pdf"
  | "buy_points"
  | "my_points"
  | "settings"
  | "admin";

/**
 * The persistent keyboard. The admin row is appended only for an admin, so a
 * customer never sees an operator control — and a just-granted admin gets it
 * on the next message that redraws the keyboard.
 */
function mainKeyboard(lang: Lang, admin = false): ReplyKeyboard {
  const c = t(lang);
  const rows: ReplyKeyboard = [
    [c.btnOtp1, c.btnOtp2],
    [c.btnScreenshot, c.btnOtp3],
    [c.btnBuyPoints, c.btnMyPoints],
    [c.btnUploadPdf, c.btnSettings],
  ];
  if (admin) rows.push([c.btnAdmin]);
  return rows;
}

/**
 * Label to action, built from the copy tables of *every* language rather than
 * only the one the person is currently set to.
 *
 * A reply keyboard is a picture on the screen, not live state: someone who
 * switches language is still looking at the old buttons until the next message
 * redraws them, and tapping one then sends the old label. Routing both
 * languages' labels at all times means that tap still works instead of coming
 * back as "I did not understand that".
 */
const LABEL_ACTIONS: Map<string, Action> = (() => {
  const map = new Map<string, Action>();
  for (const lang of LANGS) {
    const c = t(lang);
    const pairs: [string, Action][] = [
      [c.btnOtp1, "otp1"],
      [c.btnOtp2, "otp2"],
      [c.btnOtp3, "otp3"],
      [c.btnScreenshot, "screenshot"],
      [c.btnUploadPdf, "upload_pdf"],
      [c.btnBuyPoints, "buy_points"],
      [c.btnMyPoints, "my_points"],
      [c.btnSettings, "settings"],
      [c.btnAdmin, "admin"],
    ];
    for (const [label, action] of pairs) map.set(label.trim(), action);
  }
  return map;
})();

function labelAction(text: string): Action | null {
  return LABEL_ACTIONS.get(text.trim()) ?? null;
}

function faqKeyboard(lang: Lang): InlineKeyboard {
  const c = t(lang);
  return [
    ...c.faq.map((entry) => [{ text: entry.question, callback_data: CB.faqItem(entry.id) }]),
    [{ text: c.btnBack, callback_data: CB.menu }],
  ];
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type Target = {
  chatId: number;
  /** Set when this came from a button, so the screen can be replaced in place. */
  messageId: number | null;
};

/**
 * Puts text on the screen: edits the message a button belongs to, or sends a
 * new one. Replacing the message in place is what makes a menu feel like a menu
 * rather than a growing wall of chat.
 *
 * A send that fails because the chat is gone is recorded and swallowed — there
 * is no one to apologise to, and throwing would make the webhook retry an
 * update that can never succeed.
 */
async function screen(
  deps: BotDeps,
  target: Target,
  telegramId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    if (target.messageId !== null) {
      await deps.api.editMessage(target.chatId, target.messageId, text, { keyboard });
    } else {
      await deps.api.sendMessage(target.chatId, text, { keyboard });
    }
  } catch (error) {
    if (error instanceof BotApiError && error.isUnreachableChat) {
      await deps.store.markBlocked(telegramId);
      return;
    }
    throw error;
  }
}

async function showMenu(deps: BotDeps, target: Target, user: BotUser, lang: Lang) {
  await deps.store.setState(user.telegramId, "idle");
  await screen(deps, target, user.telegramId, t(lang).menuPrompt, menuKeyboard(lang));
}

async function showLanguageChooser(deps: BotDeps, target: Target, telegramId: number) {
  await screen(deps, target, telegramId, t("en").chooseLanguage, languageKeyboard());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleUpdate(update: TgUpdate, deps: BotDeps): Promise<void> {
  // Idempotency first: everything past this point can write.
  if (!(await deps.store.claimUpdate(update.update_id))) return;

  if (update.callback_query) {
    await onCallback(update.callback_query, deps);
    return;
  }
  if (update.message) {
    await onMessage(update.message, deps);
  }
}

async function identify(
  deps: BotDeps,
  from: TgUser,
  chatId: number,
): Promise<BotUser & { created: boolean }> {
  return deps.store.touchUser({
    telegramId: from.id,
    chatId,
    firstName: from.first_name ?? "",
    username: from.username ?? null,
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * How the bot addresses someone: their first name, else their @username, else
 * nothing. A greeting with an empty name reads worse than one without, so the
 * copy is written to stand on its own when this returns "".
 */
function displayName(user: BotUser): string {
  if (user.firstName) return escapeHtml(user.firstName);
  if (user.username) return escapeHtml(`@${user.username}`);
  return "";
}

async function onMessage(message: TgMessage, deps: BotDeps): Promise<void> {
  const from = message.from;
  // A bot has no conversation to hold, and a group chat is not what this is
  // for — in a group every member would see the ID number being checked.
  if (!from || from.is_bot || message.chat.type !== "private") return;

  const user = await identify(deps, from, message.chat.id);
  if (user.created) await notifyNewUser(deps, user);
  const target: Target = { chatId: message.chat.id, messageId: null };
  const text = (message.text ?? "").trim();

  // A photo or document is handled here, ahead of everything below: it has no
  // text to carry it through the command and state-machine logic that follows,
  // and this is the one state in which a file means something rather than
  // being noise to wave back at the menu.
  if (user.state === "awaiting_upload" && (message.photo?.length || message.document)) {
    return onUploadSubmitted(deps, user, user.language ?? "en", message);
  }

  if (!text) {
    // A photo, sticker or contact. Nothing to read, so re-offer the menu.
    const lang = user.language ?? guessLang(from.language_code);
    if (!user.language) return showLanguageChooser(deps, target, user.telegramId);
    await screen(deps, target, user.telegramId, t(lang).unknownInput, menuKeyboard(lang));
    return;
  }

  const command = text.startsWith("/") ? text.slice(1).split(/[\s@]/)[0]?.toLowerCase() : null;

  // Also before the language gate, and for the same reason: this is the number
  // an operator was asked for, mid-decision.
  if (user.state === "awaiting_grant" && (await isAdmin(deps, user.telegramId))) {
    return onGrantSubmitted(deps, user, user.language ?? "en", text);
  }

  // /admin is answerable before a language is known, for the same reason the
  // decision callbacks are: an operator action should not be gated behind a
  // question about the customer's language. Non-admins get a refusal here too.
  if (command === "admin") return showAdminPanel(deps, target, user);

  // /start is answerable before a language is known; it *is* the language
  // chooser. Everything else waits until there is a language to answer in.
  if (!user.language) {
    await showLanguageChooser(deps, target, user.telegramId);
    return;
  }

  const lang = user.language;
  const c = t(lang);

  if (command === "start") {
    await deps.store.setState(user.telegramId, "idle");
    const points = await deps.store.getBalance(user.telegramId);
    // The greeting, then the bilingual prompt *with the choices attached*:
    // "please choose your language" over no buttons is a dead end. /start is
    // the one place that re-offers the choice to someone who already has a
    // language; picking one redraws the main menu from the callback.
    return screen(
      deps,
      target,
      user.telegramId,
      `${c.welcomeBot({ name: displayName(user), points })}\n\n${c.chooseLanguage}`,
      languageKeyboard(),
    );
  }

  // A tapped keyboard button arrives as its own label, so this comes before
  // the state machine: pressing "My Points" halfway through buying points is
  // a change of mind, not an answer to the question that was asked.
  const action = labelAction(text);
  if (action) return runAction(action, deps, target, user, lang);

  if (command) {
    switch (command) {
      case "language":
        return showLanguageChooser(deps, target, user.telegramId);
      case "status":
        await deps.store.setState(user.telegramId, "awaiting_id");
        return screen(deps, target, user.telegramId, c.askId, cancelKeyboard(lang));
      case "faq":
        return screen(deps, target, user.telegramId, c.faqPrompt, faqKeyboard(lang));
      case "support":
        await deps.store.setState(user.telegramId, "awaiting_support");
        return screen(deps, target, user.telegramId, c.supportAsk, cancelKeyboard(lang));
      case "cancel":
        await deps.store.setState(user.telegramId, "idle");
        return screen(deps, target, user.telegramId, c.cancelled, menuKeyboard(lang));
      case "help":
        return screen(deps, target, user.telegramId, c.help, menuKeyboard(lang));
      default:
        return home(deps, user, lang, c.unknownInput);
    }
  }

  switch (user.state) {
    case "awaiting_id":
      return onIdSubmitted(deps, target, user, lang, text);
    case "awaiting_support":
      return onSupportSubmitted(deps, target, user, lang, text);
    case "awaiting_receipt":
      return onReceiptSubmitted(deps, user, lang, text);
    case "awaiting_grant":
      return onGrantSubmitted(deps, user, lang, text);
    case "awaiting_fan":
      return onFanSubmitted(deps, user, lang, text);
    case "awaiting_otp":
      return onOtpSubmitted(deps, user, lang, text);
    case "awaiting_post":
      return onPostSubmitted(deps, user, lang, text);
    case "awaiting_admin":
      return onAdminAddSubmitted(deps, target, user, lang, text);
    case "awaiting_account":
      return onAccountSubmitted(deps, target, user, lang, text);
    case "awaiting_upload":
      // Reached with text, not a file — the file path above did not match.
      return home(deps, user, lang, c.uploadWrongType);
    default:
      return home(deps, user, lang, c.unknownInput);
  }
}

// ---------------------------------------------------------------------------
// The service: points, payments, cards
// ---------------------------------------------------------------------------

/** Sends a message and (re)draws the persistent keyboard under it. */
async function home(deps: BotDeps, user: BotUser, lang: Lang, text: string): Promise<void> {
  try {
    // Read per message rather than cached on BotUser: a grant made a moment
    // ago must draw the Admin button, and a revoked one must stop drawing it.
    const admin = await isAdmin(deps, user.telegramId);
    await deps.api.sendMessage(user.chatId, text, { replyKeyboard: mainKeyboard(lang, admin) });
  } catch (error) {
    if (error instanceof BotApiError && error.isUnreachableChat) {
      await deps.store.markBlocked(user.telegramId);
      return;
    }
    throw error;
  }
}

async function runAction(
  action: Action,
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
): Promise<void> {
  const c = t(lang);

  switch (action) {
    case "my_points": {
      const [points, settings] = await Promise.all([
        deps.store.getBalance(user.telegramId),
        resolveSettings(deps.store),
      ]);
      return home(deps, user, lang, c.myPoints({ points, price: settings.pricePerPoint }));
    }

    case "buy_points": {
      const settings = await resolveSettings(deps.store);
      if (!hasAnyAccount(settings)) {
        return home(deps, user, lang, c.buyPointsNoAccounts(deps.adminContact));
      }
      await deps.store.setState(user.telegramId, "awaiting_receipt");
      return home(
        deps,
        user,
        lang,
        `${c.buyPointsAccounts(settings)}\n\n${c.buyPointsHow(deps.adminContact)}`,
      );
    }

    case "otp1":
    case "otp2":
    case "otp3": {
      const slot = Number(action.slice(-1));
      if (deps.cards.name === "unconfigured") {
        return home(deps, user, lang, c.otpUnavailable(deps.adminContact));
      }
      // Checked before a FAN is asked for, not after: sending somebody's
      // number upstream and only then telling them they cannot afford the
      // result would spend their privacy for nothing.
      const balance = await deps.store.getBalance(user.telegramId);
      const need = env.pointsPerPrint;
      if (balance < need) {
        return home(deps, user, lang, c.uploadNeedMorePoints({ have: balance, need }));
      }
      await deps.store.setState(user.telegramId, "awaiting_fan", { slot });
      return home(deps, user, lang, c.otpAsk({ slot, points: need }));
    }

    // Rendering the finished card (compositing a template with the holder's
    // photo and fields) is not built — it needs the card background images and
    // a sample layout, which this deployment has not been given. Until then,
    // the intake still works: the document is received, points are spent, and
    // an admin follows up by hand. Silently accepting a file with nothing
    // downstream of it would be worse than saying what happens to it.
    case "screenshot":
    case "upload_pdf": {
      const kind = action === "screenshot" ? "upload_image" : "upload_pdf";
      const balance = await deps.store.getBalance(user.telegramId);
      const need = env.pointsPerPrint;
      if (balance < need) {
        return home(deps, user, lang, c.uploadNeedMorePoints({ have: balance, need }));
      }
      await deps.store.setState(user.telegramId, "awaiting_upload", { kind });
      return home(deps, user, lang, c.uploadAsk(need));
    }

    case "settings": {
      return screen(deps, target, user.telegramId, c.settingsPrompt, settingsKeyboard(lang));
    }

    case "admin": {
      return showAdminPanel(deps, target, user);
    }
  }
}

/**
 * A pasted receipt, on its way to becoming points.
 *
 * The order here is deliberate: verify first, record second. Recording is what
 * spends the reference, so it must not happen until there is a decision to
 * record — otherwise a page that times out burns the customer's receipt on a
 * row that says nothing.
 */
async function onReceiptSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const c = t(lang);
  const receipt = parseReceipt(text);

  // Left in awaiting_receipt: they are mid-task, and the next thing they send
  // is still meant to be a receipt.
  if (!receipt) return home(deps, user, lang, c.receiptUnreadable(deps.adminContact));

  await deps.api.sendChatAction(user.chatId).catch(() => undefined);
  const settings = await resolveSettings(deps.store);
  const verification = await verifyPayment(receipt, {
    fetchReceipt: deps.fetchReceipt,
    pricePerPoint: settings.pricePerPoint,
  });

  // A payment too small to buy anything is not recorded, so the reference is
  // not spent. If it was a genuine underpayment they will pay again, and the
  // top-up receipt is a different reference anyway.
  if (verification.decision === "reject") {
    await deps.store.setState(user.telegramId, "idle");
    return home(
      deps,
      user,
      lang,
      c.receiptTooSmall({ amount: verification.amountEtb, price: settings.pricePerPoint }),
    );
  }

  const credited = verification.decision === "credit";
  const record = await deps.store.recordPurchase({
    telegramId: user.telegramId,
    provider: receipt.provider,
    reference: receipt.reference,
    // Bounded: this is free text from a stranger, and the whole SMS is enough.
    rawInput: text.slice(0, 1000),
    amountEtb: verification.amountEtb,
    points: credited ? verification.points : 0,
    status: credited ? "approved" : "pending",
    decidedBy: credited ? "auto" : "none",
    note: credited ? undefined : verification.reason,
  });
  await deps.store.setState(user.telegramId, "idle");

  if (record.outcome === "duplicate") return home(deps, user, lang, c.receiptDuplicate);

  if (credited && verification.decision === "credit") {
    return home(
      deps,
      user,
      lang,
      c.receiptCredited({
        points: verification.points,
        balance: record.balance,
        amount: verification.amountEtb,
      }),
    );
  }

  await forwardForReview(deps, user, receipt.provider, receipt.reference, record.id, verification.reason);
  // "no_amount" means the page loaded but said nothing we could price — usually
  // a mistyped reference (letter O for zero), occasionally a redesign. Say so:
  // "being checked" alone leaves the customer waiting for a person to confirm a
  // payment that was mistyped and can never confirm. It is still queued.
  return home(
    deps,
    user,
    lang,
    verification.reason === "no_amount" ? c.receiptNoAmount(deps.adminContact) : c.receiptQueued,
  );
}

/** Puts a payment the bot could not confirm in front of a human. */
async function forwardForReview(
  deps: BotDeps,
  user: BotUser,
  provider: string,
  reference: string,
  purchaseId: string,
  reason: string,
): Promise<void> {
  if (deps.supportChatId === null) return;
  const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName);
  try {
    await deps.api.sendMessage(
      deps.supportChatId,
      `<b>Payment needs review</b>\n` +
        `From: ${who} — <code>${user.telegramId}</code>\n` +
        `${provider.toUpperCase()} <code>${escapeHtml(reference)}</code>\n` +
        `Could not confirm: ${reason}`,
      {
        keyboard: [
          [
            { text: "✅ Approve", callback_data: CB.approve(purchaseId) },
            { text: "❌ Reject", callback_data: CB.reject(purchaseId) },
          ],
        ],
      },
    );
  } catch (error) {
    console.error("review forward failed:", error);
  }
}

/**
 * The number an admin types after tapping Approve.
 *
 * Approving needs a point count and the bot does not have one — that is the
 * whole reason the payment is in front of a person. So the button records
 * which purchase is being decided and this reads the answer.
 */
async function onGrantSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const purchaseId = String(user.stateData.purchaseId ?? "");
  const points = Number(text.trim());

  if (!purchaseId || !Number.isSafeInteger(points) || points <= 0) {
    return home(deps, user, lang, "Send a whole number of points, or /cancel.");
  }

  await deps.store.setState(user.telegramId, "idle");
  const decision = await deps.store.decidePurchase({
    id: purchaseId,
    approve: true,
    adminId: user.telegramId,
    points,
  });

  if (!decision) return home(deps, user, lang, "That payment has already been decided.");

  await home(deps, user, lang, `Approved: ${points} points credited.`);
  // The person who paid is waiting on this, and has heard nothing since
  // "being checked".
  await notifyCredited(deps, decision.telegramId, points, decision.balance);
}

async function notifyCredited(
  deps: BotDeps,
  telegramId: number,
  points: number,
  balance: number,
): Promise<void> {
  try {
    await deps.api.sendMessage(
      telegramId,
      `Payment confirmed.\nPoints added: ${points}\nYour points: ${balance}`,
    );
  } catch (error) {
    if (error instanceof BotApiError && error.isUnreachableChat) {
      await deps.store.markBlocked(telegramId);
      return;
    }
    console.error("credit notification failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Uploaded documents
// ---------------------------------------------------------------------------

/**
 * A photo or PDF sent while a specific upload was asked for.
 *
 * The file itself is never fetched here — only its Telegram file_id is kept,
 * which is a handle the Bot API will resolve later, on demand, for whoever
 * reviews it. Downloading and storing a copy of somebody's national ID would
 * be exposure this service has no need to take on.
 */
async function onUploadSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  message: TgMessage,
): Promise<void> {
  const c = t(lang);
  const kind = String(user.stateData.kind ?? "upload_image");
  const source = kind === "upload_pdf" ? "upload_pdf" : "upload_image";

  const file = message.document
    ? { fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id }
    : message.photo?.length
      ? {
          // The array is every resolution Telegram generated; the last is the
          // largest, and the largest is what a print needs.
          fileId: message.photo[message.photo.length - 1]!.file_id,
          fileUniqueId: message.photo[message.photo.length - 1]!.file_unique_id,
        }
      : null;
  if (!file) return home(deps, user, lang, c.uploadWrongType);

  const points = env.pointsPerPrint;
  await deps.store.setState(user.telegramId, "idle");

  let result: Awaited<ReturnType<BotStore["spendOnCardJob"]>>;
  try {
    result = await deps.store.spendOnCardJob({
      telegramId: user.telegramId,
      source,
      downloadType: user.downloadType,
      background: user.background,
      telegramFileId: file.fileId,
      telegramFileUniqueId: file.fileUniqueId,
      points,
    });
  } catch (error) {
    // A race with something else spending the same balance between the check
    // in runAction and this message arriving. Rare, and the constraint that
    // catches it is the actual guarantee — this is just the human-readable
    // half of it.
    if (error instanceof SpendError) {
      const balance = await deps.store.getBalance(user.telegramId);
      return home(deps, user, lang, c.uploadNeedMorePoints({ have: balance, need: points }));
    }
    throw error;
  }

  await home(deps, user, lang, c.uploadReceived({ pointsSpent: points, balance: result.balance }));

  if (deps.supportChatId !== null) {
    const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName);
    try {
      await deps.api.sendMessage(
        deps.supportChatId,
        `<b>New card job</b> (${source})\n` +
          `From: ${who} — <code>${user.telegramId}</code>\n` +
          `Points spent: ${points}\n\n` +
          `Review it in the admin portal.`,
      );
    } catch (error) {
      console.error("card job notification failed:", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Card retrieval: FAN → OTP → PDF
// ---------------------------------------------------------------------------

/**
 * A FAN, typed after an OTP button.
 *
 * Asking the provider to send a code costs nothing upstream, so nothing is
 * charged here — the point is spent when a card actually comes back. What is
 * stored is a session: the FAN encrypted (the verify call needs it again), its
 * hash and last four for the audit trail, and the provider's opaque handle.
 */
async function onFanSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const c = t(lang);
  const parsed = parseId(text);
  // A FAN is the 16-digit one. A FIN will not work here, and saying so beats
  // sending it upstream to be refused.
  if (!parsed || parsed.kind !== "fan") {
    return home(deps, user, lang, c.idInvalid);
  }

  const slot = Number(user.stateData.slot ?? 1);
  await deps.api.sendChatAction(user.chatId, "typing");
  await home(deps, user, lang, c.otpSending);

  const result = await deps.cards.sendOtp(parsed.digits);
  if (result.outcome === "unavailable") {
    await deps.store.setState(user.telegramId, "idle");
    return home(deps, user, lang, c.otpNotAnswered(deps.adminContact));
  }
  if (result.outcome === "rejected") {
    await deps.store.setState(user.telegramId, "idle");
    return home(deps, user, lang, c.otpRejected(result.message));
  }

  await deps.store.openOtpSession({
    telegramId: user.telegramId,
    slot,
    fanHash: hashId(parsed.digits),
    fanLast4: last4(parsed.digits),
    fanSecret: seal(parsed.digits, env.otpSecretKey),
    providerRef: result.session,
  });
  await deps.store.setState(user.telegramId, "awaiting_otp");
  return home(deps, user, lang, c.otpSent(result.phone));
}

/** How many wrong codes before the session is closed. A 6-digit code is 10^6 wide; three tries keeps it that way. */
const OTP_ATTEMPT_LIMIT = 3;

/**
 * How long the picture's second verify may take.
 *
 * The PDF is already delivered when the picture is sent, but the function
 * running the whole flow is killed at 60 s on Vercel, and the second verify is
 * started as soon as the first succeeds so it can run while the document is
 * being uploaded. The cap is the request's remaining budget rather than a fixed
 * guess: the vendor's guide says to allow ~60–120 s for a verify, and the old
 * 15 s cap is what made production fall back to a picture of the A4 sheet.
 */
const UPDATE_BUDGET_MS = 55_000;
const SECOND_VERIFY_MIN_MS = 5_000;
const SECOND_VERIFY_MAX_MS = 45_000;
const DELIVERY_RESERVE_MS = 5_000;

/** What the second verify can still spend, given how much of the update already went. */
function secondVerifyBudget(startedAt: number): number {
  const remaining = UPDATE_BUDGET_MS - (Date.now() - startedAt) - DELIVERY_RESERVE_MS;
  return Math.max(SECOND_VERIFY_MIN_MS, Math.min(SECOND_VERIFY_MAX_MS, remaining));
}

/**
 * The code, and the calls in this service that cost money.
 *
 * A verify deducts a point from the upstream account on success, so it happens
 * exactly once per code — no retry on timeout, because a retry would either
 * spend a second point or fail on an already-used code, and neither is worth
 * the chance of the first attempt having quietly succeeded.
 *
 * The one exception is deliberate: a PDF delivery follows its verify with a
 * JSON one to get the fields for the designed card picture. That is a second
 * point upstream (the customer is still charged one), and it is made only after
 * the PDF verify has been accepted. If it fails, the picture is the card
 * artwork inside the delivered PDF — never a rendering of the A4 sheet.
 */
async function onOtpSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const startedAt = Date.now();
  const c = t(lang);
  const code = text.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) {
    return home(deps, user, lang, c.otpNotSixDigits);
  }

  const session = await deps.store.openOtpSessionFor(user.telegramId);
  const fan = session?.fanSecret ? open(session.fanSecret, env.otpSecretKey) : null;
  if (!session || !session.providerRef || !fan) {
    await deps.store.setState(user.telegramId, "idle");
    return home(deps, user, lang, c.otpNoSession);
  }

  await deps.api.sendChatAction(user.chatId, "upload_document");
  await home(deps, user, lang, c.otpVerifying);

  // Which verify endpoint this code uses is decided by the customer's chosen
  // download format: "Printable Card" builds the A4 sheet here from identity
  // fields (JSON); every other format delivers the provider's own PDF, which is
  // the document people actually want to keep. A PDF result has no identity
  // fields, so the designed card picture that follows it asks the JSON endpoint
  // for the same code once — a second, deliberate point upstream. That call is
  // started as soon as this verify is accepted and runs while the PDF is being
  // prepared and sent (see `cardFields`), so it costs time the request was
  // spending anyway and can cost a picture at most, never the card.
  const wantsPrintable = user.downloadType === "printable";
  const result = await deps.cards.verifyOtp({
    fan,
    otp: code,
    session: session.providerRef,
    // Both verify endpoints demand a 12-digit finNumber the docs omit; the
    // client derives it from the FAN (see card.ts).
    format: wantsPrintable ? "json" : "pdf",
  });

  if (result.outcome === "unavailable") {
    // Not the customer's fault and not necessarily a failed verification —
    // the call may have succeeded upstream and timed out on the way back. The
    // session is closed rather than left open for a retry that could be
    // charged twice, and the admin chat is told so a point can be reclaimed.
    await deps.store.closeOtpSession(session.id, "failed");
    await deps.store.setState(user.telegramId, "idle");
    await notifyAdmins(deps, `OTP verify did not complete for <code>${user.telegramId}</code> — check whether a point was spent upstream.`);
    return home(deps, user, lang, c.otpNotAnswered(deps.adminContact));
  }

  if (result.outcome === "rejected") {
    const attempts = await deps.store.countOtpAttempt(session.id);
    if (attempts >= OTP_ATTEMPT_LIMIT) {
      await deps.store.closeOtpSession(session.id, "failed");
      await deps.store.setState(user.telegramId, "idle");
      return home(deps, user, lang, c.otpTooManyAttempts);
    }
    // Session stays open: a mistyped code deserves another go at the same one.
    return home(deps, user, lang, c.otpRejected(result.message));
  }

  await deps.store.closeOtpSession(session.id, "verified");
  await deps.store.setState(user.telegramId, "idle");

  // The picture's fields are requested now, while the document is being
  // prepared and uploaded, instead of after it: the second verify gets the
  // request's remaining budget, and the upload costs it no time. It resolves
  // to null on any failure, so nothing here can delay or spoil the document.
  const cardFields =
    result.format === "json"
      ? null
      : identityFromSecondVerify(deps, {
          fan,
          otp: code,
          session: session.providerRef,
          timeoutMs: secondVerifyBudget(startedAt),
        });

  // Charged only now, against a card that exists. The job is recorded as
  // delivered with no file handle: the PDF is somebody's identity document and
  // is passed straight to them, never retained here.
  let spend: { id: string; balance: number };
  try {
    spend = await deps.store.spendOnCardJob({
      telegramId: user.telegramId,
      source: "otp",
      downloadType: user.downloadType,
      background: user.background,
      telegramFileId: null,
      telegramFileUniqueId: null,
      points: env.pointsPerPrint,
      status: "delivered",
    });
  } catch (error) {
    if (error instanceof SpendError) {
      // Their balance went to zero between the check and now. The card is
      // already paid for upstream, so withholding it would lose the point for
      // nothing — it is delivered, and the shortfall is an admin's to sort out.
      await notifyAdmins(deps, `Card delivered to <code>${user.telegramId}</code> with an unpayable balance — a point was spent upstream.`);
      spend = { id: "", balance: await deps.store.getBalance(user.telegramId) };
    } else {
      throw error;
    }
  }

  // The provider's original PDF is passed through untouched and keeps whatever
  // numbering the provider already printed in it. A printable card — and the
  // designed picture composed for a PDF delivery, once its fields arrive — is
  // one this bot drew, so it gets a serial. The artwork taken from the PDF as a
  // fallback is the provider's own and is not numbered.
  let serial: number | null = result.format === "json" ? await nextSerial(deps) : null;

  // The latest upstream balance seen, from either verify. The PDF call's header
  // is the first answer; a successful second verify is a fresher one.
  let latestPoints = result.remainingPoints;

  try {
    // A JSON verify delivers a structured identity, from which the print sheet
    // is rendered here; a PDF verify hands the provider's document through.
    const filename = result.format === "json" ? "fayda-printable.pdf" : result.filename;
    const bytes =
      result.format === "json"
        ? await toPrintable(result.identity, serial).catch((error) => {
            // A card that exists should always reach the customer; if the
            // print layout cannot be built, hand over the bare identity fields
            // rather than nothing.
            console.error("printable render failed:", error instanceof Error ? error.message : error);
            return toIdentityPdf(result.identity, serial);
          })
        : result.pdf;

    // A JSON verify also carries the identity fields, so the card goes out
    // with a short text recap the customer can read at a glance. A PDF verify
    // returns only the document, so it keeps the plain caption.
    const caption =
      result.format === "json"
        ? `${c.otpDelivered({ pointsSpent: env.pointsPerPrint, balance: spend.balance })}` +
          `${serial === null ? "" : `\nSN: ${serial}`}\n\n` +
          c.otpIdentitySummary({
            name: result.identity.name.english || result.identity.name.amharic,
            fan: result.identity.fanNumber,
            fin: result.identity.fin,
            dateOfBirth: result.identity.dateOfBirth.gregorian,
            phone: result.identity.phone,
            remainingPoints: result.remainingPoints,
          })
        : c.otpDelivered({ pointsSpent: env.pointsPerPrint, balance: spend.balance });

    const admin = await isAdmin(deps, user.telegramId);
    await deps.api.sendDocument(
      user.chatId,
      { bytes, filename },
      {
        caption,
        replyKeyboard: mainKeyboard(lang, admin),
      },
    );

    // The card also goes out as a picture, right after the document: the PDF is
    // what gets printed, the image is what gets forwarded. The printable sheet
    // is drawn from the identity fields it already has. For a PDF delivery the
    // fields were requested from the JSON endpoint with the same code while the
    // document was being sent (see `cardFields`); if they came back, the
    // picture is the designed front-and-back card. If they did not — a spent
    // code, a provider hiccup — the picture is the card artwork embedded in the
    // delivered PDF. It is never the A4 sheet rendered as an image. This block
    // carries its own guard for the same reason: the card has been delivered,
    // so an image that fails to render or upload must not read as a lost card
    // to the catch below.
    try {
      let image: Buffer;
      if (result.format === "json") {
        image = await toCardImage(result.identity, serial);
      } else {
        const extra = cardFields === null ? null : await cardFields;
        if (extra) {
          latestPoints = extra.remainingPoints ?? latestPoints;
          serial = await nextSerial(deps);
          image = await toCardImage(extra.identity, serial);
        } else {
          const sides = await cardSidesFromPdf(result.pdf);
          if (!sides) throw new Error("the provider's PDF has no card artwork");
          image = sides;
        }
      }
      await deps.api.sendPhoto(
        user.chatId,
        { bytes: image, filename: CARD_IMAGE_FILENAME },
        { caption: c.otpCardImage },
      );
    } catch (error) {
      console.error("card image delivery failed:", error instanceof Error ? error.message : error);
    }
  } catch (error) {
    // The card is paid for twice over by this point — a point upstream and a
    // point from the customer — so a failed hand-off is the one outcome that
    // must not pass silently. The PDF is not kept, so it cannot be resent;
    // what a human can do is refund, which needs them to know.
    if (error instanceof BotApiError && error.isUnreachableChat) {
      await deps.store.markBlocked(user.telegramId);
    }
    await notifyAdmins(
      deps,
      `Card was produced for <code>${user.telegramId}</code> but could not be delivered — ` +
        `${escapeHtml(error instanceof Error ? error.message : String(error))}. ` +
        `They were charged ${env.pointsPerPrint}; the document is not retained, so this needs a refund.`,
    );
    if (!(error instanceof BotApiError && error.isUnreachableChat)) throw error;
  }

  // An upstream balance at zero fails every customer after it, so the warning
  // has to reach a human before that happens rather than after.
  if (latestPoints !== null && latestPoints <= 10) {
    await notifyAdmins(deps, `Card API balance is low: ${latestPoints} points left. Recharge it before deliveries start failing.`);
  }
}

/**
 * Asks the JSON endpoint for the fields behind a code whose PDF was already
 * delivered, so the picture that follows can be the designed card rather than
 * the card artwork inside the document.
 *
 * This is a second verification and therefore a second point upstream; that is
 * a deliberate trade, made only after the PDF verify has been accepted. Any
 * failure returns null and the caller falls back to the artwork embedded in the
 * provider's document: an already-used code, a provider that is down, or a
 * changed response shape must cost a picture, never the card.
 *
 * `timeoutMs` is the request's remaining budget, measured from the start of the
 * update. The vendor's guide says a verify can take up to two minutes, so the
 * call gets as much of that budget as is safe rather than a fixed short cap.
 */
async function identityFromSecondVerify(
  deps: BotDeps,
  args: { fan: string; otp: string; session: string; timeoutMs: number },
): Promise<{ identity: CardIdentity; remainingPoints: number | null } | null> {
  try {
    const result = await deps.cards.verifyOtp({
      fan: args.fan,
      otp: args.otp,
      session: args.session,
      format: "json",
      timeoutMs: args.timeoutMs,
    });
    if (result.outcome === "verified" && result.format === "json") {
      return { identity: result.identity, remainingPoints: result.remainingPoints };
    }
    if (result.outcome === "rejected") {
      console.error(`card image: second verify was rejected: ${result.message}`);
    } else {
      console.error("card image: second verify did not complete");
    }
  } catch (error) {
    console.error("card image: second verify failed:", error instanceof Error ? error.message : error);
  }
  return null;
}

/**
 * The next serial for a card this bot drew, or null when numbering is down.
 *
 * The card is already paid for, upstream and here; a numbering failure must
 * cost it its SN, never the customer their delivery.
 */
async function nextSerial(deps: BotDeps): Promise<number | null> {
  try {
    return await deps.store.nextCardSerial();
  } catch (error) {
    console.error("card serial allocation failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Sends an operational note to the support chat, if there is one. Never throws. */
async function notifyAdmins(deps: BotDeps, html: string): Promise<void> {
  if (deps.supportChatId === null) return;
  try {
    await deps.api.sendMessage(deps.supportChatId, html);
  } catch (error) {
    console.error("admin notification failed:", error);
  }
}

/** Announces a brand-new user to the new-user group. Never throws. */
async function notifyNewUser(deps: BotDeps, user: BotUser): Promise<void> {
  if (deps.newUserGroupId === null) return;
  const name = escapeHtml(user.firstName || "Unknown");
  const username = user.username ? ` @${escapeHtml(user.username)}` : "";
  try {
    await deps.api.sendMessage(
      deps.newUserGroupId,
      `👤 <b>New user started the bot</b>\n${name}${username}\nID: ${user.telegramId}`,
    );
  } catch (error) {
    console.error("new-user notification failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Status lookup
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function onIdSubmitted(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const c = t(lang);
  const parsed = parseId(text);

  // A malformed number is not counted against the budget — someone fixing a
  // typo should not be rate limited for it — but it is recorded, because a
  // stream of invalid input is what probing looks like.
  if (!parsed) {
    await deps.store.recordLookup({
      telegramId: user.telegramId,
      kind: "fin",
      hash: "",
      last4: "",
      outcome: "invalid",
    });
    await screen(deps, target, user.telegramId, c.idInvalid, cancelKeyboard(lang));
    return;
  }

  const recent = await deps.store.countLookupsSince(user.telegramId, LOOKUP_WINDOW_MINUTES);
  if (recent >= LOOKUP_LIMIT) {
    await deps.store.setState(user.telegramId, "idle");
    await screen(
      deps,
      target,
      user.telegramId,
      c.idRateLimited(LOOKUP_WINDOW_MINUTES),
      menuKeyboard(lang),
    );
    return;
  }

  await deps.api.sendChatAction(user.chatId).catch(() => undefined);

  let result: Awaited<ReturnType<FaydaProvider["lookup"]>>;
  try {
    result = await deps.provider.lookup(parsed);
  } catch (error) {
    console.error("fayda lookup failed:", error);
    result = { outcome: "error" };
  }

  await deps.store.recordLookup({
    telegramId: user.telegramId,
    kind: parsed.kind,
    hash: hashId(parsed.digits),
    last4: last4(parsed.digits),
    outcome: result.outcome,
  });
  await deps.store.setState(user.telegramId, "idle");

  const after: InlineKeyboard = [
    [{ text: c.btnCheckAnother, callback_data: CB.status }],
    [{ text: c.btnBack, callback_data: CB.menu }],
  ];

  const body =
    result.outcome === "found"
      ? c.resultFound({
          status: c.statusLabels[result.status],
          last4: last4(parsed.digits),
          updated: formatDate(result.updatedAt),
        })
      : result.outcome === "not_found"
        ? c.resultNotFound
        : result.outcome === "unavailable"
          ? c.resultUnavailable
          : c.resultError;

  await screen(deps, target, user.telegramId, body, after);
}

// ---------------------------------------------------------------------------
// Support handoff
// ---------------------------------------------------------------------------

async function onSupportSubmitted(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  const c = t(lang);
  if (text.length > SUPPORT_MAX_CHARS) {
    await screen(deps, target, user.telegramId, c.supportTooLong, cancelKeyboard(lang));
    return;
  }

  // Saved before it is forwarded, so a support chat that is misconfigured or
  // unreachable loses the message from the operator's inbox, not from the
  // record. The person is told which of those happened.
  const saved = await deps.store.saveSupportMessage({
    telegramId: user.telegramId,
    language: lang,
    body: text,
  });
  await deps.store.setState(user.telegramId, "idle");

  let forwarded = false;
  if (deps.supportChatId !== null) {
    const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName);
    try {
      await deps.api.sendMessage(
        deps.supportChatId,
        `<b>Support request</b> (${lang})\n` +
          `From: ${who} — <code>${user.telegramId}</code>\n\n` +
          escapeHtml(text),
      );
      forwarded = true;
      await deps.store.markSupportForwarded(saved.id);
    } catch (error) {
      console.error("support forward failed:", error);
    }
  }

  await screen(
    deps,
    target,
    user.telegramId,
    forwarded ? c.supportSent : c.supportFailed,
    menuKeyboard(lang),
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

async function onCallback(query: TgCallbackQuery, deps: BotDeps): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const user = await identify(deps, query.from, chatId);
  // Telegram spins the button until the callback is answered, whatever else
  // happens next.
  await deps.api.answerCallback(query.id).catch(() => undefined);

  const target: Target = { chatId, messageId: query.message?.message_id ?? null };
  const data = query.data ?? "";

  // Before the language gate: deciding a payment is an operator action, and an
  // operator who has never held a conversation with the bot has no language
  // set. Making them pick one before they can approve anything would gate the
  // review queue behind an unrelated question.
  if (data.startsWith("adm:")) return onAdminDecision(data, deps, target, user);

  // The /admin panel's own buttons. Dispatched next to the decisions, and for
  // the same reason: they are operator actions, gated by the allow-list rather
  // than by a language the operator may never have chosen.
  if (data.startsWith("ap:")) return onAdminPanelAction(data, deps, target, user);

  if (data.startsWith("lang:")) {
    const choice = data.slice("lang:".length);
    if (!isLang(choice)) return;
    await deps.store.setLanguage(user.telegramId, choice);
    const c = t(choice);
    const name = escapeHtml(user.firstName || query.from.first_name || "");
    // Replace the chooser, then draw the keyboard the bot is driven from — an
    // edit cannot attach a reply keyboard, so it takes both messages.
    await screen(deps, target, user.telegramId, c.welcome(name), menuKeyboard(choice));
    const points = await deps.store.getBalance(user.telegramId);
    await home(deps, user, choice, c.welcomeBot({ name: displayName(user), points }));
    // Best effort: the command menu should be in the chosen language, but a
    // failure here must not cost the person their answer.
    setMenuCommands(deps, choice);
    return;
  }

  // Every other button needs a language. Someone can reach one by tapping an
  // old message from before they chose.
  const lang = user.language;
  if (!lang) return showLanguageChooser(deps, target, user.telegramId);
  const c = t(lang);

  if (data.startsWith("dl:")) {
    const choice = data.slice("dl:".length) as DownloadType;
    if (!DOWNLOAD_TYPES.includes(choice)) return;
    await deps.store.setOutput(user.telegramId, { downloadType: choice });
    return screen(
      deps,
      target,
      user.telegramId,
      c.downloadTypePrompt(c.downloadTypes[choice]),
      downloadMenuKeyboard(lang),
    );
  }

  if (data === CB.downloadMenu) {
    const current = c.downloadTypes[user.downloadType];
    return screen(deps, target, user.telegramId, c.downloadTypePrompt(current), downloadMenuKeyboard(lang));
  }

  if (data === CB.myPoints) {
    const [points, settings] = await Promise.all([
      deps.store.getBalance(user.telegramId),
      resolveSettings(deps.store),
    ]);
    return screen(deps, target, user.telegramId, c.myPoints({ points, price: settings.pricePerPoint }), settingsKeyboard(lang));
  }

  if (data === CB.backSettings) {
    return screen(deps, target, user.telegramId, c.settingsPrompt, settingsKeyboard(lang));
  }

  if (data.startsWith("setlang:")) {
    const choice = data.slice("setlang:".length);
    if (!isLang(choice)) return;
    await deps.store.setLanguage(user.telegramId, choice);
    const cc = t(choice);
    await screen(deps, target, user.telegramId, cc.settingsPrompt, settingsKeyboard(choice));
    setMenuCommands(deps, choice);
    return;
  }

  if (data.startsWith("faq:")) {
    const entry = c.faq.find((item) => item.id === data.slice("faq:".length));
    if (!entry) return showMenu(deps, target, user, lang);
    await screen(deps, target, user.telegramId, entry.answer, [
      [{ text: c.btnBack, callback_data: CB.faq }],
    ]);
    return;
  }

  switch (data) {
    case CB.status:
      await deps.store.setState(user.telegramId, "awaiting_id");
      return screen(deps, target, user.telegramId, c.askId, cancelKeyboard(lang));
    case CB.faq:
      return screen(deps, target, user.telegramId, c.faqPrompt, faqKeyboard(lang));
    case CB.appointment:
      return screen(deps, target, user.telegramId, c.appointment, backKeyboard(lang));
    case CB.support:
      await deps.store.setState(user.telegramId, "awaiting_support");
      return screen(deps, target, user.telegramId, c.supportAsk, cancelKeyboard(lang));
    case CB.language:
      return showLanguageChooser(deps, target, user.telegramId);
    case CB.settingsLanguage:
      return screen(deps, target, user.telegramId, c.chooseLanguage, settingsLanguageKeyboard(lang));
    case CB.backSettings:
      return screen(deps, target, user.telegramId, c.settingsPrompt, settingsKeyboard(lang));
    case CB.cancel:
      await deps.store.setState(user.telegramId, "idle");
      return screen(deps, target, user.telegramId, c.cancelled, menuKeyboard(lang));
    case CB.menu:
      return showMenu(deps, target, user, lang);
    default:
      return showMenu(deps, target, user, lang);
  }
}

/**
 * Approve or reject a queued payment.
 *
 * callback_data is attacker-controlled — anyone can send any string to a bot —
 * so the allow-list is checked here rather than relying on the buttons only
 * existing in the admin chat. Someone who guesses a purchase id and sends
 * `adm:ok:<id>` gets nothing.
 */
async function onAdminDecision(
  data: string,
  deps: BotDeps,
  target: Target,
  user: BotUser,
): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) return;

  const approve = data.startsWith("adm:ok:");
  const purchaseId = data.slice("adm:ok:".length);
  if (!purchaseId) return;

  if (approve) {
    // The bot has no amount to work from — that is why a human is looking at
    // it — so the number has to come from the person deciding.
    await deps.store.setState(user.telegramId, "awaiting_grant", { purchaseId });
    await screen(deps, target, user.telegramId, "How many points? Send the number, or /cancel.");
    return;
  }

  const decision = await deps.store.decidePurchase({
    id: purchaseId,
    approve: false,
    adminId: user.telegramId,
    points: 0,
  });
  await screen(
    deps,
    target,
    user.telegramId,
    decision ? "Rejected. Nothing was credited." : "That payment has already been decided.",
  );
}

/** Whether this Telegram id may review payments and post to everyone. */
function isAdmin(deps: BotDeps, telegramId: number): Promise<boolean> {
  return deps.store.isAdmin(telegramId, deps.adminIds);
}

/**
 * The bootstrap admins from `ADMIN_TELEGRAM_IDS`. Only these may grant or
 * revoke admin access: a granted admin can operate the bot but cannot grow the
 * operator list, which keeps a compromised or mistaken grant contained.
 */
function isSuperAdmin(deps: BotDeps, telegramId: number): boolean {
  return deps.adminIds.includes(telegramId);
}

/** Telegram truncates a button label silently, so long references are cut here. */
function buttonLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * `/admin` — the operator's entry point in the chat.
 *
 * Hardcoded English rather than i18n copy, the same choice the approve/reject
 * flow already makes: the audience is whoever runs the bot, not a customer, and
 * an operator who has never set a language must still be able to open it.
 */
async function showAdminPanel(deps: BotDeps, target: Target, user: BotUser): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) {
    return screen(deps, target, user.telegramId, "That command is for administrators.");
  }

  const [payments, jobs, balance, summary] = await Promise.all([
    deps.store.pendingPurchases(),
    deps.store.pendingCardJobs(),
    deps.cards.balance().catch(() => null),
    deps.store.userSummary(),
  ]);

  const superAdmin = isSuperAdmin(deps, user.telegramId);
  const lines = [
    "<b>Admin panel</b>",
    superAdmin ? "Role: <b>super admin</b>" : "Role: <b>admin</b>",
    "",
    `Users: <b>${summary.users}</b>`,
    `Total user points: <b>${summary.points}</b>`,
    `Pending payments: <b>${payments.length}</b>`,
    `Pending documents: <b>${jobs.length}</b>`,
    balance
      ? `My points (card API): <b>${balance.points}</b> (${escapeHtml(balance.status)})`
      : "My points (card API): unavailable",
  ];

  const keyboard: InlineKeyboard = [];
  if (summary.users) {
    keyboard.push([{ text: `👥 Users (${summary.users})`, callback_data: CB.adminUsers }]);
  }
  if (payments.length) {
    keyboard.push([
      { text: `📋 Review payments (${payments.length})`, callback_data: CB.adminPayments },
    ]);
  }
  keyboard.push([{ text: "🏦 Bank accounts", callback_data: CB.adminAccounts }]);
  keyboard.push([{ text: "📣 Post to all users", callback_data: CB.adminPost }]);
  if (superAdmin) {
    keyboard.push([{ text: "➕ Add admin", callback_data: CB.adminAdd }]);
    keyboard.push([{ text: "👑 Admins", callback_data: CB.adminList }]);
  }
  keyboard.push([{ text: "✖️ Close", callback_data: CB.menu }]);

  await screen(deps, target, user.telegramId, lines.join("\n"), keyboard);
}

/**
 * The accounts customers are told to pay into.
 *
 * The portal's Settings form edits the same columns, but an operator working
 * from the chat should not have to find a browser to answer "where do I send
 * the money?". The conversation resolves these values from the database on
 * every message, so a change here is visible to customers immediately.
 */
async function showAdminAccounts(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  note?: string,
): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) return;
  const settings = await resolveSettings(deps.store);

  const line = (name: string, number: string): string =>
    `<b>${escapeHtml(name || "not set")}</b>\n<code>${escapeHtml(number || "—")}</code>`;

  const keyboard: InlineKeyboard = [
    [{ text: "✏️ CBE name", callback_data: CB.adminAccount("cbeAccountName") }],
    [{ text: "✏️ CBE number", callback_data: CB.adminAccount("cbeAccountNumber") }],
    [{ text: "✏️ Telebirr name", callback_data: CB.adminAccount("telebirrAccountName") }],
    [{ text: "✏️ Telebirr number", callback_data: CB.adminAccount("telebirrAccountNumber") }],
    [{ text: "← Back", callback_data: CB.adminPanel }],
  ];

  await screen(
    deps,
    target,
    user.telegramId,
    "<b>Bank accounts</b>\n\n" +
      "These are the accounts customers are told to pay into when buying points. " +
      "Changes apply to the next message that shows them — no redeploy.\n\n" +
      `CBE\n${line(settings.cbeAccountName, settings.cbeAccountNumber)}\n\n` +
      `Telebirr\n${line(settings.telebirrAccountName, settings.telebirrAccountNumber)}` +
      (note ? `\n\n${note}` : ""),
    keyboard,
  );
}

/** Asks an admin for the new value of one bank field. */
async function startAccountEdit(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
  field: AccountField,
): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) return;
  await deps.store.setState(user.telegramId, "awaiting_account", { field });
  await screen(
    deps,
    target,
    user.telegramId,
    `Send the new ${ACCOUNT_FIELDS[field]}.\n\n` +
      "Send /cancel to stop, or a single - to clear it and fall back to the deployment's value.",
    cancelKeyboard(lang),
  );
}

/** The new value of a bank field, once the admin sends it. */
async function onAccountSubmitted(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  // The state could have been set before a change to the allow-list; re-check
  // rather than trust it.
  if (!(await isAdmin(deps, user.telegramId))) {
    await deps.store.setState(user.telegramId, "idle");
    return home(deps, user, lang, t(lang).unknownInput);
  }

  const field = String(user.stateData.field ?? "");
  if (!isAccountField(field)) {
    await deps.store.setState(user.telegramId, "idle");
    return showAdminAccounts(deps, target, user, "That edit expired. Open Bank accounts again.");
  }

  const raw = text.trim();
  if (raw.length > 100) {
    return screen(
      deps,
      target,
      user.telegramId,
      "That is too long for an account field (100 characters max). Send a shorter value, or /cancel.",
      cancelKeyboard(lang),
    );
  }
  const value = raw === "-" || raw === "" ? null : raw;
  await deps.store.updateSettings({ [field]: value }, user.telegramId);
  await deps.store.setState(user.telegramId, "idle");

  return showAdminAccounts(
    deps,
    target,
    user,
    `${ACCOUNT_FIELDS[field]} ${value === null ? "cleared." : "saved."}`,
  );
}

/**
 * The user list: who has started the bot and what each of them holds. Capped,
 * because a message has a length limit and a list of thousands is unreadable in
 * chat anyway — the total is the number that matters, the list is a sample.
 */
async function showUserPoints(deps: BotDeps, target: Target, user: BotUser): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) {
    return screen(deps, target, user.telegramId, "That command is for administrators.");
  }

  const back: InlineKeyboard = [[{ text: "← Back", callback_data: CB.adminPanel }]];
  const [summary, rows] = await Promise.all([
    deps.store.userSummary(),
    deps.store.listUserPoints(15),
  ]);

  if (!summary.users) {
    return screen(deps, target, user.telegramId, "No users yet.", back);
  }

  const lines = rows.map((row: UserPointRow) =>
    [
      `• ${escapeHtml(row.firstName || "—")}`,
      row.username ? ` @${escapeHtml(row.username)}` : "",
      ` <code>${row.telegramId}</code> — <b>${row.points}</b>`,
    ].join(""),
  );
  const tail = summary.users > rows.length ? `\n\nShowing the top ${rows.length}.` : "";

  await screen(
    deps,
    target,
    user.telegramId,
    `<b>Users</b>\n\nTotal: <b>${summary.users}</b>\nPoints held: <b>${summary.points}</b>\n\n` +
      `${lines.join("\n")}${tail}`,
    back,
  );
}

/**
 * The review queue, with the same Approve/Reject buttons the support-chat
 * forward carries. Reachable from `/admin` so an operator who is not in the
 * support chat can still decide a payment.
 */
async function showPendingPayments(deps: BotDeps, target: Target, user: BotUser): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) {
    return screen(deps, target, user.telegramId, "That command is for administrators.");
  }

  const back: InlineKeyboard = [[{ text: "← Back", callback_data: CB.adminPanel }]];
  const payments = await deps.store.pendingPurchases(10);
  if (!payments.length) {
    return screen(deps, target, user.telegramId, "No payments are waiting.", back);
  }

  const lines = payments.map(
    (p) =>
      `• ${escapeHtml(p.provider.toUpperCase())} <code>${escapeHtml(p.reference)}</code>` +
      ` — ${p.amount_etb ? `${escapeHtml(p.amount_etb)} ETB` : "amount unknown"}`,
  );
  const decisions: InlineKeyboard = payments.flatMap((p) => [
    [
      { text: `✅ ${buttonLabel(p.reference, 24)}`, callback_data: CB.approve(p.id) },
      { text: `❌ ${buttonLabel(p.reference, 24)}`, callback_data: CB.reject(p.id) },
    ],
  ]);

  await screen(
    deps,
    target,
    user.telegramId,
    `<b>Pending payments</b>\n\n${lines.join("\n")}`,
    [...decisions, ...back],
  );
}

/**
 * Every operator, super admins first, with a remove button for each granted
 * one. The environment admins get no remove button: they are a deployment
 * fact, not a row this bot can delete.
 */
async function showAdminList(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  note?: string,
): Promise<void> {
  if (!isSuperAdmin(deps, user.telegramId)) {
    return screen(deps, target, user.telegramId, "Only a super admin can manage admins.");
  }

  const granted = await deps.store.listGrantedAdmins();
  const removable = granted.filter((entry) => !deps.adminIds.includes(entry.telegramId));
  const lines = ["<b>Admins</b>", ""];
  if (note) lines.push(note, "");
  for (const id of deps.adminIds) lines.push(`👑 <code>${id}</code> — super admin`);
  for (const entry of removable) lines.push(`🛠 <code>${entry.telegramId}</code> — admin`);

  const remove: InlineKeyboard = removable.map((entry) => [
    { text: `❌ Remove ${entry.telegramId}`, callback_data: CB.adminRemove(entry.telegramId) },
  ]);
  await screen(deps, target, user.telegramId, lines.join("\n"), [
    ...remove,
    [{ text: "➕ Add admin", callback_data: CB.adminAdd }],
    [{ text: "← Back", callback_data: CB.adminPanel }],
  ]);
}

/** Asks a super admin for the id to grant, then hands off to `onAdminAddSubmitted`. */
async function startAdminAdd(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
): Promise<void> {
  if (!isSuperAdmin(deps, user.telegramId)) {
    return screen(deps, target, user.telegramId, "Only a super admin can add admins.");
  }
  await deps.store.setState(user.telegramId, "awaiting_admin");
  await screen(
    deps,
    target,
    user.telegramId,
    "Send the Telegram ID of the person to make an admin.\n\n" +
      "They must have started this bot at least once. Send /cancel to stop.",
    cancelKeyboard(lang),
  );
}

/** The id a super admin sent after tapping "Add admin". */
async function onAdminAddSubmitted(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  // The state could have been set before a change to the allow-list; re-check
  // rather than trust it.
  if (!isSuperAdmin(deps, user.telegramId)) {
    await deps.store.setState(user.telegramId, "idle");
    return screen(deps, target, user.telegramId, "Only a super admin can add admins.");
  }

  const telegramId = Number(text.trim());
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    return screen(
      deps,
      target,
      user.telegramId,
      "That is not a Telegram ID. Send the numeric id, or /cancel.",
      cancelKeyboard(lang),
    );
  }

  if (isSuperAdmin(deps, telegramId)) {
    await deps.store.setState(user.telegramId, "idle");
    return showAdminList(deps, target, user, `${telegramId} is already a super admin.`);
  }

  if (!(await deps.store.hasUser(telegramId))) {
    return screen(
      deps,
      target,
      user.telegramId,
      "That person has not started this bot yet, so there is no chat to grant.\n\n" +
        "Ask them to send /start first, then add them.",
      cancelKeyboard(lang),
    );
  }

  const already = (await deps.store.listGrantedAdmins()).some(
    (entry) => entry.telegramId === telegramId,
  );
  await deps.store.grantAdmin(telegramId, user.telegramId);
  await deps.store.setState(user.telegramId, "idle");

  if (already) {
    return showAdminList(deps, target, user, `${telegramId} is already an admin.`);
  }

  // The grant is a database row; the keyboard is a picture the new admin has
  // to redraw, so tell them in their own chat how to see the Admin button.
  try {
    await deps.api.sendMessage(
      telegramId,
      "You are now an admin of this bot.\n\n" +
        "Send /start to refresh your keyboard, then tap Admin (or send /admin).",
    );
  } catch (error) {
    console.error("admin grant notification failed:", error);
  }

  return showAdminList(deps, target, user, `Granted admin access to ${telegramId}.`);
}

/** Removes one granted admin. Environment (super) admins cannot be removed here. */
async function removeAdmin(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  telegramId: number,
): Promise<void> {
  if (!isSuperAdmin(deps, user.telegramId)) {
    return screen(deps, target, user.telegramId, "Only a super admin can manage admins.");
  }
  if (isSuperAdmin(deps, telegramId)) {
    return showAdminList(
      deps,
      target,
      user,
      `${telegramId} is a super admin from ADMIN_TELEGRAM_IDS and cannot be removed here.`,
    );
  }
  const removed = await deps.store.revokeAdmin(telegramId);
  return showAdminList(
    deps,
    target,
    user,
    removed ? `Removed admin access from ${telegramId}.` : `${telegramId} is not an admin.`,
  );
}

/** Asks for the announcement, then hands off to `onPostSubmitted`. */
async function startAdminPost(
  deps: BotDeps,
  target: Target,
  user: BotUser,
  lang: Lang,
): Promise<void> {
  await deps.store.setState(user.telegramId, "awaiting_post");
  await screen(
    deps,
    target,
    user.telegramId,
    "Send the message you want every user to receive.\n\nSend /cancel to stop.",
    cancelKeyboard(lang),
  );
}

/** The announcement itself, once the admin has sent it. */
async function onPostSubmitted(
  deps: BotDeps,
  user: BotUser,
  lang: Lang,
  text: string,
): Promise<void> {
  // The state could have been set before a change to the allow-list; re-check
  // rather than trust it.
  if (!(await isAdmin(deps, user.telegramId))) {
    await deps.store.setState(user.telegramId, "idle");
    return home(deps, user, lang, t(lang).unknownInput);
  }

  const result = await broadcastToUsers(deps.store, deps.api, text);
  if (!result.ok) {
    // Left in awaiting_post, so the same screen takes a corrected message.
    const why =
      result.error === "empty"
        ? "That message was empty."
        : "That message is too long for Telegram.";
    return home(deps, user, lang, `${why}\n\nSend it again, or /cancel.`);
  }

  await deps.store.setState(user.telegramId, "idle");
  const total = result.sent + result.failed;
  await home(
    deps,
    user,
    lang,
    `Posted to ${result.sent} of ${total} user${total === 1 ? "" : "s"}` +
      (result.failed ? ` (${result.failed} could not be reached).` : "."),
  );
}

/** The buttons drawn by `/admin`, dispatched before the language gate. */
async function onAdminPanelAction(
  data: string,
  deps: BotDeps,
  target: Target,
  user: BotUser,
): Promise<void> {
  if (!(await isAdmin(deps, user.telegramId))) return;

  // Removal is per-row: `ap:rm:<id>` is parsed before the exact-match switch.
  if (data.startsWith("ap:rm:")) {
    const telegramId = Number(data.slice("ap:rm:".length));
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return;
    return removeAdmin(deps, target, user, telegramId);
  }

  // Bank fields are per-row too: `ap:acct:<field>` names the column to edit.
  if (data.startsWith("ap:acct:")) {
    const field = data.slice("ap:acct:".length);
    if (!isAccountField(field)) return;
    return startAccountEdit(deps, target, user, user.language ?? "en", field);
  }

  switch (data) {
    case CB.adminPanel:
      return showAdminPanel(deps, target, user);
    case CB.adminAccounts:
      return showAdminAccounts(deps, target, user);
    case CB.adminPayments:
      return showPendingPayments(deps, target, user);
    case CB.adminUsers:
      return showUserPoints(deps, target, user);
    case CB.adminPost:
      return startAdminPost(deps, target, user, user.language ?? "en");
    case CB.adminAdd:
      return startAdminAdd(deps, target, user, user.language ?? "en");
    case CB.adminList:
      return showAdminList(deps, target, user);
  }
}

/**
 * Per-language command menus are set lazily, on first language choice, rather
 * than at deploy time — there is no startup hook in a serverless deployment to
 * hang it off.
 */
function setMenuCommands(deps: BotDeps, lang: Lang): void {
  void deps.api
    .setCommands?.(commandsFor(lang), lang === "am" ? "am" : "en")
    .catch(() => undefined);
}
