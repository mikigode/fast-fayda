import { BotApiError, escapeHtml, type BotApi } from "./api";
import type { BotStore } from "./store";

/**
 * Sending one message to many people — shared by the two places that do it: the
 * web portal's Post form and the bot's own /admin command.
 *
 * One implementation because the failure modes are quiet. The text has to be
 * escaped, since every send parses HTML and one stray `&` would make Telegram
 * reject the message for everyone. A chat that has blocked the bot has to be
 * marked so the next broadcast skips it. And a message Telegram refuses has to
 * be counted as a failure rather than swallowed — a broadcast that reports
 * success while reaching nobody is worse than one that reports nothing.
 */

/** Telegram rejects a message longer than this; escaping only makes it longer. */
export const MAX_BROADCAST_CHARS = 4096;

export type BroadcastResult =
  | { ok: true; sent: number; failed: number }
  /** Caught before any send, so nothing was attempted. */
  | { ok: false; error: "empty" | "too_long" };

export async function broadcastToUsers(
  store: BotStore,
  api: BotApi,
  rawMessage: string,
): Promise<BroadcastResult> {
  const message = rawMessage.trim();
  if (!message) return { ok: false, error: "empty" };

  const text = escapeHtml(message);
  if (text.length > MAX_BROADCAST_CHARS) return { ok: false, error: "too_long" };

  const recipients = await store.broadcastRecipients();
  const queue = [...recipients];
  let sent = 0;
  let failed = 0;

  // A few at once so a long list does not outlast the request, but not many:
  // Telegram allows roughly 30 messages a second across different chats, and a
  // broadcast that trips that limit starts answering 429 for every message
  // after it. Delivery is best-effort — the rest are logged and counted, not
  // retried.
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    for (let recipient = queue.shift(); recipient; recipient = queue.shift()) {
      try {
        await api.sendMessage(recipient.chatId, text);
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error instanceof BotApiError && error.isUnreachableChat) {
          await store.markBlocked(recipient.telegramId);
        } else {
          console.error("broadcast failed for", recipient.telegramId, error);
        }
      }
    }
  });
  await Promise.all(workers);

  return { ok: true, sent, failed };
}
