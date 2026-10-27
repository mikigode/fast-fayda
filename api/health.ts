import { env } from "../src/env";
import { dbStore } from "../src/bot/store";

/**
 * Liveness. Separate file because Vercel maps one file to one route, so a
 * second export from api/webhook.ts would never be reachable.
 */
export default async function handler(
  _request: unknown,
  response: { status(code: number): { json(body: unknown): void } },
): Promise<void> {
  // The card API key has two sources — the portal's `app_settings` row, then
  // `CARD_API_KEY` — and "card retrieval is not connected" is the message a
  // customer gets when neither is set. Reporting *which* one is in force is the
  // difference between "set an environment variable" and "read the logs".
  let cardKey: "settings" | "env" | "missing" = env.cardApiKey ? "env" : "missing";
  try {
    const stored = await dbStore.getSettings();
    if (stored.cardApiKey) cardKey = "settings";
  } catch {
    // A health check reports; it does not fail. The rest of the answer, and the
    // environment's own key, are still worth having.
  }

  // Reports *which* configuration is missing, never its value. Without this,
  // diagnosing an unconfigured deployment means reading function logs.
  response.status(200).json({
    ok: true,
    service: "fast-fayda",
    mode: "webhook",
    provider: env.faydaProvider,
    configured: env.webhookConfigured,
    cardKey,
    // Which commit is actually live. Vercel sets this automatically, and
    // without it there is no way to tell a deployment of new code from a
    // redeploy of old code — a redeploy from the dashboard reuses the original
    // source, so a fix can look like it did not work when it was never shipped.
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown").slice(0, 7),
    missing: [
      process.env.TELEGRAM_BOT_TOKEN ? null : "TELEGRAM_BOT_TOKEN",
      process.env.TELEGRAM_WEBHOOK_SECRET ? null : "TELEGRAM_WEBHOOK_SECRET",
      process.env.DATABASE_URL ? null : "DATABASE_URL",
    ].filter(Boolean),
  });
}
