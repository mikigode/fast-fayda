import { callBot } from "./bot/api";
import { handleUpdate, type BotDeps, type TgUpdate } from "./bot/router";

/**
 * Long polling: the other way to receive updates.
 *
 * A webhook needs a public HTTPS URL, which needs somewhere to host it. Polling
 * needs neither — the bot asks Telegram for updates over an outbound
 * connection, so it runs on a laptop, behind NAT, or inside a container with no
 * inbound routing. That makes it the right mode for developing, for
 * demonstrating, and for running a bot before deciding what to pay for.
 *
 * The trade-off is that exactly one process may poll a given bot at a time.
 * Telegram enforces it — a second getUpdates for the same token evicts the
 * first with a 409 — so this is for a single instance, never a scaled
 * deployment. The webhook is the mode that scales.
 *
 * Updates arrive through the same handleUpdate as the webhook, so the two modes
 * cannot drift apart in behaviour.
 */

/**
 * How long Telegram holds an empty poll open before answering. Long enough that
 * an idle bot makes a few requests a minute rather than hundreds; short enough
 * that shutting down is not spent waiting on a hanging socket.
 */
const POLL_TIMEOUT_SECONDS = 25;

/** Backoff after a failed poll, so an outage is not hammered. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * The three calls polling makes, behind an interface so tests can drive the
 * loop without a network.
 */
export type PollTransport = {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>;
  deleteWebhook(): Promise<void>;
  getMe(): Promise<{ username: string }>;
};

export const liveTransport: PollTransport = {
  getUpdates: (offset, timeout) =>
    callBot<TgUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      },
      undefined,
      // A long-poll holds for `timeout` seconds, so the client abort must give
      // it headroom over that rather than cut it off early. `callBot`'s default
      // of 10s would abort every idle poll before Telegram answered, surfacing
      // as a 504 loop.
      (timeout + 15) * 1000,
    ),
  deleteWebhook: async () => {
    await callBot("deleteWebhook", {});
  },
  getMe: () => callBot<{ username: string }>("getMe"),
};

export type Poller = {
  start(): Promise<void>;
  stop(): void;
};

export function createPoller(
  deps: BotDeps,
  transport: PollTransport = liveTransport,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Poller {
  let running = false;
  /**
   * The update_id to ask from next.
   *
   * Telegram treats sending an offset as confirming everything before it, so
   * this only advances past an update after handling has returned. A crash
   * mid-handle leaves the update unconfirmed and it arrives again — which is
   * safe because claimUpdate has already made handling idempotent, the same
   * property the webhook depends on.
   */
  let offset = 0;
  let backoff = MIN_BACKOFF_MS;

  async function pollOnce(): Promise<void> {
    const updates = await transport.getUpdates(offset, POLL_TIMEOUT_SECONDS);
    for (const update of updates) {
      try {
        await handleUpdate(update, deps);
      } catch (error) {
        // One update failing must not stop the loop, or a single bad message
        // wedges the bot for everyone queued behind it.
        console.error(`Update ${update.update_id} failed:`, error);
      }
      offset = update.update_id + 1;
    }
  }

  return {
    async start() {
      running = true;

      // Telegram refuses getUpdates while a webhook is registered, and says so
      // only as "can't use getUpdates method while webhook is active".
      // Clearing it here makes switching modes a restart rather than a puzzle.
      await transport.deleteWebhook().catch(() => undefined);

      // Best effort, and deliberately not allowed to be fatal. This call only
      // supplies a name for the log line, but it is the first thing the process
      // does over the network — so a blip at boot, or a slow start on the
      // platform's side, would otherwise take the whole service down before it
      // had polled once. A host that restarts on exit turns that into a crash
      // loop. The poll loop below has its own backoff and is where a real
      // outage should be handled.
      try {
        const me = await transport.getMe();
        console.log(`Polling as @${me.username}. One instance only.`);
      } catch (error) {
        console.warn(
          `Could not confirm the bot's identity at startup: ${
            error instanceof Error ? error.message : String(error)
          }. Polling anyway.`,
        );
      }

      while (running) {
        try {
          await pollOnce();
          backoff = MIN_BACKOFF_MS;
        } catch (error) {
          if (!running) break;
          const message = error instanceof Error ? error.message : String(error);
          // A 409 means something else is polling this bot — another terminal,
          // or a deployment someone forgot about. Backing off quietly would
          // leave the two fighting invisibly.
          if (/terminated by other getUpdates|\(409\)/.test(message)) {
            console.error("Another process is polling this bot. Stop one of them.");
          } else {
            console.error(`Poll failed, retrying in ${backoff}ms:`, message);
          }
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    },

    stop() {
      running = false;
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { POLL_TIMEOUT_SECONDS };
