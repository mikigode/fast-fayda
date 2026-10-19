import { env } from "../env";

/**
 * Telegram Bot API client — the outbound half of the bot.
 *
 * Deliberately small: the bot sends text with inline keyboards, edits the
 * message a button was tapped on, and acknowledges callbacks. That is the whole
 * surface, so this is a typed wrapper over `POST /bot<token>/<method>` rather
 * than a framework.
 *
 * https://core.telegram.org/bots/api
 */

const BASE_URL = "https://api.telegram.org";

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    /** Seconds Telegram asked us to wait, when it answered 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(`${method} failed (${status}): ${description}`);
  }

  /**
   * The user blocked the bot, deleted the chat, or was deactivated. Not a fault
   * to retry or report — the chat is simply gone, and the caller should stop
   * sending to it.
   *
   * Matched on Telegram's description rather than on the 403 alone. A 403 is
   * not proof of anything by itself: a corporate proxy, a WAF or an egress
   * policy in front of the deployment will refuse a request with the same
   * status, and reading that as "this person blocked the bot" would mark live
   * users unreachable every time the network misbehaves. Telegram always sends
   * a description with the reason; an unexplained 403 is treated as an ordinary
   * failure, which is the recoverable reading.
   */
  get isUnreachableChat(): boolean {
    return (
      this.status === 403 &&
      /bot was blocked|user is deactivated|chat not found|bot can't initiate|bot was kicked|not enough rights/i.test(
        this.description,
      )
    );
  }
}

type ApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
};

export async function callBot<T>(
  method: string,
  payload: Record<string, unknown> = {},
  token = env.telegramBotToken,
  /**
   * Client-side timeout for the request. The default is right for webhook
   * handling — a slow outbound call would make Telegram retry the update — but
   * long polling passes a larger one, because a `getUpdates` is *supposed* to
   * hang for the length of its `timeout` argument, and aborting sooner than
   * that turns every idle poll into an immediate 504.
   */
  timeoutMs = 10_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Telegram gives a webhook handler a limited window to reply before it
      // retries the update. Hanging on an outbound call until the platform's
      // own timeout fires turns one slow request into a duplicate delivery.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new BotApiError(method, 504, `Request to Telegram ${reason}.`);
  }

  const payloadText = await response.text();
  let parsed: ApiResponse<T>;
  try {
    parsed = JSON.parse(payloadText) as ApiResponse<T>;
  } catch {
    throw new BotApiError(method, response.status, "Telegram returned an unreadable response.");
  }

  if (!response.ok || !parsed.ok) {
    throw new BotApiError(
      method,
      response.status,
      parsed.description ?? "Unknown error",
      parsed.parameters?.retry_after ?? null,
    );
  }
  return parsed.result as T;
}

/**
 * Same contract as callBot, for the one method that sends bytes.
 *
 * The Content-Type header is deliberately not set: fetch derives it from the
 * FormData, including the multipart boundary, and setting it by hand produces
 * a boundary-less header that Telegram cannot parse.
 *
 * The timeout is longer than callBot's because this one is an upload — a few
 * hundred kilobytes over a slow link is normal and not a hang.
 */
async function callBotMultipart<T>(
  method: string,
  form: FormData,
  token = env.telegramBotToken,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new BotApiError(method, 504, `Upload to Telegram ${reason}.`);
  }

  let parsed: ApiResponse<T>;
  try {
    parsed = JSON.parse(await response.text()) as ApiResponse<T>;
  } catch {
    throw new BotApiError(method, response.status, "Telegram returned an unreadable response.");
  }
  if (!response.ok || !parsed.ok) {
    throw new BotApiError(
      method,
      response.status,
      parsed.description ?? "Unknown error",
      parsed.parameters?.retry_after ?? null,
    );
  }
  return parsed.result as T;
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = InlineButton[][];

/**
 * The persistent keyboard under the message box, as rows of plain labels.
 *
 * It differs from an inline keyboard in the way that matters most here:
 * tapping a button sends its label as an ordinary message, so the router
 * recognises the *text*. That is why the labels in i18n.ts are routing keys and
 * not only display strings, and why changing one is a behavioural change.
 */
export type ReplyKeyboard = string[][];

/** `[[a, b], [c]]` — one array per row, which is how Telegram lays them out. */
export function keyboard(rows: InlineKeyboard) {
  return { inline_keyboard: rows };
}

function replyMarkup(rows: ReplyKeyboard) {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    // Without this the keyboard takes up half the screen on a phone.
    resize_keyboard: true,
    is_persistent: true,
  };
}

// ---------------------------------------------------------------------------
// The methods the bot actually uses
// ---------------------------------------------------------------------------

export type SentMessage = { message_id: number; chat: { id: number } };

export type BotApi = {
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      keyboard?: InlineKeyboard;
      /** Mutually exclusive with `keyboard` — Telegram takes one reply_markup. */
      replyKeyboard?: ReplyKeyboard;
      disablePreview?: boolean;
    },
  ): Promise<SentMessage>;
  editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options?: { keyboard?: InlineKeyboard },
  ): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action?: "typing" | "upload_document"): Promise<void>;
  /**
   * Uploads a file we hold in memory. Distinct from every other method here
   * because it is multipart rather than JSON — Telegram takes a URL or a
   * file_id as JSON, but bytes only as a form upload.
   */
  sendDocument(
    chatId: number,
    file: { bytes: Buffer; filename: string },
    options?: { caption?: string; replyKeyboard?: ReplyKeyboard },
  ): Promise<SentMessage>;
  /**
   * Uploads an image, shown inline rather than as an attachment. Same multipart
   * shape as `sendDocument`; only the form field and the MIME type differ.
   */
  sendPhoto(
    chatId: number,
    file: { bytes: Buffer; filename: string },
    options?: { caption?: string; replyKeyboard?: ReplyKeyboard },
  ): Promise<SentMessage>;
  /**
   * Optional: cosmetic, and a test double has no reason to implement it. The
   * router treats its absence as "nothing to do".
   */
  setCommands?(
    commands: { command: string; description: string }[],
    languageCode?: string,
  ): Promise<void>;
};

/**
 * Message text is HTML rather than Markdown throughout. Markdown's escaping
 * rules bite when interpolating anything a user typed — an unbalanced `_` or
 * `*` makes Telegram reject the whole message — whereas HTML needs exactly
 * three characters escaped, which `escapeHtml` below does.
 */
export const liveApi: BotApi = {
  async sendMessage(chatId, text, options = {}) {
    return callBot<SentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: options.disablePreview === false ? undefined : { is_disabled: true },
      reply_markup: options.keyboard
        ? keyboard(options.keyboard)
        : options.replyKeyboard
          ? replyMarkup(options.replyKeyboard)
          : undefined,
    });
  },

  async editMessage(chatId, messageId, text, options = {}) {
    try {
      await callBot("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: options.keyboard ? keyboard(options.keyboard) : undefined,
      });
    } catch (error) {
      // Tapping the same button twice re-sends identical content, which
      // Telegram rejects. The screen already shows what we wanted it to.
      if (error instanceof BotApiError && /message is not modified/i.test(error.description)) {
        return;
      }
      throw error;
    }
  },

  async answerCallback(callbackId, text) {
    try {
      await callBot("answerCallbackQuery", { callback_query_id: callbackId, text });
    } catch (error) {
      // A callback older than ~15 minutes cannot be answered. The button still
      // works; only the spinner in the client is left to time out on its own.
      if (error instanceof BotApiError && /query is too old|invalid/i.test(error.description)) {
        return;
      }
      throw error;
    }
  },

  async sendChatAction(chatId, action = "typing") {
    await callBot("sendChatAction", { chat_id: chatId, action });
  },

  async sendDocument(chatId, file, options = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    // Copied into a fresh Uint8Array: a Buffer can be a view onto a larger
    // pooled allocation, and Blob would take the whole underlying buffer.
    form.append(
      "document",
      new Blob([new Uint8Array(file.bytes)], { type: "application/pdf" }),
      file.filename,
    );
    if (options.caption) {
      form.append("caption", options.caption);
      form.append("parse_mode", "HTML");
    }
    if (options.replyKeyboard) {
      form.append("reply_markup", JSON.stringify(replyMarkup(options.replyKeyboard)));
    }
    return callBotMultipart<SentMessage>("sendDocument", form);
  },

  async sendPhoto(chatId, file, options = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    // Copied for the same reason as sendDocument: a Buffer can be a view onto a
    // larger pooled allocation, and Blob would take the whole underlying buffer.
    form.append("photo", new Blob([new Uint8Array(file.bytes)], { type: "image/png" }), file.filename);
    if (options.caption) {
      form.append("caption", options.caption);
      form.append("parse_mode", "HTML");
    }
    if (options.replyKeyboard) {
      form.append("reply_markup", JSON.stringify(replyMarkup(options.replyKeyboard)));
    }
    return callBotMultipart<SentMessage>("sendPhoto", form);
  },

  async setCommands(commands, languageCode) {
    await setMyCommands(commands, languageCode);
  },
};

/** The three characters Telegram's HTML parser treats as markup. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Setup helpers, used by scripts/bot-webhook.mjs and /api/telegram/webhook
// ---------------------------------------------------------------------------

export type BotIdentity = { id: number; username: string; first_name: string };

export function getMe(token?: string) {
  return callBot<BotIdentity>("getMe", {}, token);
}

export function setWebhook(url: string, secret: string, token?: string) {
  return callBot<boolean>(
    "setWebhook",
    {
      url,
      secret_token: secret,
      // Everything else — channel posts, edited messages, inline queries — is
      // noise this bot has no handler for, and Telegram will stop sending it.
      allowed_updates: ["message", "callback_query"],
      // A backlog from before the current deployment is stale by definition.
      drop_pending_updates: true,
    },
    token,
  );
}

export function deleteWebhook(token?: string) {
  return callBot<boolean>("deleteWebhook", { drop_pending_updates: true }, token);
}

export function getWebhookInfo(token?: string) {
  return callBot<{
    url: string;
    pending_update_count: number;
    last_error_message?: string;
    last_error_date?: number;
  }>("getWebhookInfo", {}, token);
}

/** The slash-command list Telegram shows in the chat's menu button. */
export function setMyCommands(
  commands: { command: string; description: string }[],
  languageCode?: string,
  token?: string,
) {
  return callBot<boolean>(
    "setMyCommands",
    { commands, ...(languageCode ? { language_code: languageCode } : {}) },
    token,
  );
}
