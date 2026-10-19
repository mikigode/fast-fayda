import crypto from "node:crypto";
import { liveApi } from "./bot/api";
import { handleUpdate, liveDeps, type TgUpdate } from "./bot/router";
import { env } from "./env";

/**
 * The webhook's logic, independent of what is serving it.
 *
 * There are two front ends — the long-running node:http server in server.ts and
 * the serverless function in api/webhook.ts — and they must agree exactly on
 * who is allowed in and what happens to an update. Anything duplicated between
 * them is something that can be fixed in one and left broken in the other, and
 * the half that would be left broken is authentication.
 */

/** Telegram updates are small; anything larger is not one. */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Constant-time comparison of the secret Telegram echoes back.
 *
 * A fixed string checked on every request is exactly the shape a timing attack
 * wants, and an unauthenticated webhook is the one failure here that would be
 * silent — it would work perfectly, for anybody.
 */
export function secretMatches(header: string | string[] | undefined): boolean {
  const expected = env.webhookSecret;
  if (typeof header !== "string" || !expected) return false;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isUpdate(value: unknown): value is TgUpdate {
  return typeof (value as TgUpdate | null)?.update_id === "number";
}

/**
 * Handles an update and never throws.
 *
 * Telegram retries anything that is not a 2xx, so an error escaping here would
 * have it redeliver in a loop, and an update that reliably breaks the handler
 * would block everything queued behind it. The error is logged; the delivery is
 * acknowledged.
 */
export async function processUpdate(update: TgUpdate): Promise<void> {
  try {
    await handleUpdate(update, liveDeps(liveApi, env.supportChatId));
  } catch (error) {
    console.error(`Bot update ${update.update_id} failed:`, error);
  }
}
