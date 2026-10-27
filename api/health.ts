import { env } from "../src/env";
import { dbStore } from "../src/bot/store";
import { resolveSettings } from "../src/bot/settings";

type HealthRequest = {
  /** Vercel parses the query string into this. */
  query?: Record<string, string | string[] | undefined>;
  /** A plain node handler hands over the URL instead. */
  url?: string;
};

type HealthResponse = { status(code: number): { json(body: unknown): void } };

/**
 * The card API key actually in force, and which of its two sources it came
 * from. Never the value itself: this endpoint is public.
 */
async function cardState(): Promise<{
  key: string;
  source: "settings" | "env" | "missing";
}> {
  let stored: string | null = null;
  try {
    // The same merge the conversation uses, so the answer here is the answer a
    // customer would get — not a second opinion about which key is live.
    stored = (await resolveSettings(dbStore)).cardApiKey || null;
  } catch {
    // The settings table is unreachable. A health check reports; it does not
    // fail, and the environment's key is still the one the bot would use when
    // the portal cannot answer.
  }
  const key = stored ?? env.cardApiKey;
  return { key, source: stored ? "settings" : env.cardApiKey ? "env" : "missing" };
}

/**
 * One read-only call to the card provider.
 *
 * "Card retrieval is not connected" is also what a customer sees when the
 * provider times out, so knowing that the key exists does not settle it. This
 * separates the three real causes: no key, the provider refused the key, or the
 * provider could not be reached at all.
 */
async function probeCard(
  key: string,
): Promise<{ ok: boolean; outcome: "unconfigured" | "ok" | "refused" | "unreachable"; status?: number; error?: string }> {
  if (!key) return { ok: false, outcome: "unconfigured" };
  try {
    const response = await fetch(`${env.cardApiUrl.replace(/\/+$/, "")}/balance`, {
      headers: { "x-api-key": key },
      // Short on purpose: a health check that waits on somebody else's service
      // is a health check that breaks with them.
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok
      ? { ok: true, outcome: "ok", status: response.status }
      : { ok: false, outcome: "refused", status: response.status };
  } catch (error) {
    // The error name only ("TimeoutError", "TypeError"): a fetch error can
    // carry the request URL, and this answer is public.
    return {
      ok: false,
      outcome: "unreachable",
      error: error instanceof Error ? error.name : "Error",
    };
  }
}

/** Opt-in: `?card=1`. Absent means this endpoint makes no outbound calls. */
function wantsCardProbe(request: HealthRequest): boolean {
  const fromQuery = request.query?.card;
  if (Array.isArray(fromQuery) ? fromQuery[0] === "1" : fromQuery === "1") return true;
  if (!request.url) return false;
  try {
    return new URL(request.url, "http://localhost").searchParams.get("card") === "1";
  } catch {
    return false;
  }
}

/**
 * Liveness. Separate file because Vercel maps one file to one route, so a
 * second export from api/webhook.ts would never be reachable.
 */
export default async function handler(
  request: HealthRequest,
  response: HealthResponse,
): Promise<void> {
  const card = await cardState();

  // Reports *which* configuration is missing, never its value. Without this,
  // diagnosing an unconfigured deployment means reading function logs.
  const body: Record<string, unknown> = {
    ok: true,
    service: "fast-fayda",
    mode: "webhook",
    provider: env.faydaProvider,
    configured: env.webhookConfigured,
    cardKey: card.source,
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
  };
  if (wantsCardProbe(request)) body.card = await probeCard(card.key);

  response.status(200).json(body);
}
