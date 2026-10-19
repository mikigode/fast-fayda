import { handleAdmin, type AdminRequest, type AdminResponse } from "../src/admin/handler";
import { liveApi } from "../src/bot/api";
import { liveCardProvider } from "../src/bot/card";
import { dbStore } from "../src/bot/store";
import { env } from "../src/env";

/**
 * Vercel serverless entry point for the admin portal.
 *
 * One function handles every `/admin*` path — vercel.json rewrites them all
 * here — because the routing itself lives in src/admin/handler.ts and must
 * not be duplicated per file; see that module's header for why.
 */

type VercelRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): VercelResponse;
  end(body?: string | Buffer): void;
};

function header(request: VercelRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Vercel parses a urlencoded or JSON body into an object; a raw string arrives otherwise. */
function formBody(body: unknown): URLSearchParams {
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") {
    return new URLSearchParams(
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  return new URLSearchParams();
}

function adaptResponse(response: VercelResponse): AdminResponse {
  return {
    redirect(location, cookie) {
      if (cookie) response.setHeader("set-cookie", cookie);
      response.writeHead(303, { location }).end();
    },
    html(status, body, cookie) {
      if (cookie) response.setHeader("set-cookie", cookie);
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    },
    file(status, body, contentType) {
      response.writeHead(status, { "content-type": contentType }).end(body);
    },
    text(status, body) {
      response.writeHead(status, { "content-type": "text/plain" }).end(body);
    },
  };
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const url = new URL(request.url ?? "/admin", "http://localhost");
  const adminRequest: AdminRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    cookie: header(request, "cookie"),
    form: formBody(request.body),
    query: url.searchParams,
    secure: header(request, "x-forwarded-proto") === "https",
  };

  await handleAdmin(adminRequest, adaptResponse(response), {
    store: dbStore,
    botToken: env.telegramBotTokenOrEmpty,
    adminIds: env.adminTelegramIds,
    sessionSecret: env.adminSessionSecret,
    api: liveApi,
    cards: liveCardProvider(),
  });
}
