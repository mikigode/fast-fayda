import { env } from "../src/env";
import { isUpdate, processUpdate, secretMatches } from "../src/webhook";

/**
 * Vercel serverless entry point.
 *
 * Same authentication and same handler as the long-running server — both come
 * from src/webhook.ts, so the two front ends cannot disagree about who gets in.
 *
 * Two things differ from server.ts, and both follow from there being no process
 * that stays alive:
 *
 *   - No migrations. A function has no startup, so migrating here would mean
 *     doing it on every cold start, several at once during a burst, each
 *     contending on the same advisory lock while Telegram waits. Run
 *     `npm run migrate` once against the database instead — it is a deploy
 *     step here rather than a boot step.
 *   - No polling. Polling is a loop that has to keep running; a function that
 *     is billed by the second and killed after ten is the wrong shape for it.
 *     Serverless means webhook.
 *
 * Use Supabase's *transaction* pooler (port 6543) for DATABASE_URL here, not
 * the session pooler. Every warm function instance holds its own connections,
 * so the count grows with concurrency, and transaction pooling is what keeps
 * that from exhausting the database.
 */

/**
 * Long enough for a card verify, which the provider documents as taking up to
 * two minutes because it waits on an upstream validation of its own.
 *
 * Sixty seconds is the ceiling on Vercel's Hobby plan, and this matters more
 * than it looks: a verify cut off mid-flight may already have spent a point
 * upstream, leaving the customer with nothing to show for it. Keep
 * CARD_API_TIMEOUT_MS below this number so a slow call comes back as a message
 * rather than as a killed function — and if a plan's limit is lower, lower
 * both.
 */
export const config = { maxDuration: 60 };

type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status(code: number): VercelResponse;
  send(body: string): void;
  json(body: unknown): void;
};

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.status(405).send("Method not allowed");
    return;
  }

  // Before anything reads configuration. A function has no startup to check
  // this at, so an unset variable has to be reported here — as a 503 naming
  // what is missing, in a log line an operator can act on, rather than as a
  // crash that says only that something went wrong.
  if (!env.webhookConfigured) {
    console.error(
      "Not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the " +
        "deployment's environment, then redeploy so the function picks them up.",
    );
    response.status(503).send("Bot is not configured.");
    return;
  }

  if (!secretMatches(request.headers["x-telegram-bot-api-secret-token"])) {
    // Not from Telegram. 401 rather than 200: there is nothing to acknowledge.
    response.status(401).send("Unauthorized");
    return;
  }

  // Vercel parses a JSON body for us, but only when the content type says so —
  // and a raw string arrives when it does not.
  let update: unknown = request.body;
  if (typeof update === "string") {
    try {
      update = JSON.parse(update);
    } catch {
      response.status(400).send("Bad request");
      return;
    }
  }

  if (!isUpdate(update)) {
    response.status(400).send("Bad request");
    return;
  }

  await processUpdate(update);
  response.status(200).send("ok");
}
