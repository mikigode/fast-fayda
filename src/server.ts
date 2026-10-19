import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleAdmin, type AdminRequest, type AdminResponse } from "./admin/handler";
import { liveApi } from "./bot/api";
import { liveCardProvider } from "./bot/card";
import { liveDeps, type TgUpdate } from "./bot/router";
import { dbStore } from "./bot/store";
import { getPool, migrate } from "./db";
import { assertConfigured, configReport, env } from "./env";
import { createPoller } from "./poller";
import { MAX_BODY_BYTES, isUpdate, processUpdate, secretMatches } from "./webhook";

/**
 * The whole service: a webhook endpoint and a health check.
 *
 * Two decisions worth knowing about:
 *
 *   - It answers 200 even when handling fails. Telegram retries a non-2xx
 *     until it succeeds, so a bug that throws on one update would have
 *     Telegram redeliver it in a loop, and a message that consistently breaks
 *     the handler would block the queue behind it. The error is logged; the
 *     delivery is acknowledged.
 *   - The secret is compared in constant time. It is a fixed string checked on
 *     every request, which is exactly the shape a timing attack wants.
 *
 * https://core.telegram.org/bots/api#setwebhook
 */

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/plain") {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

/** Node's http.ServerResponse, wrapped to satisfy the admin handler's abstraction. */
function adminResponse(response: ServerResponse): AdminResponse {
  return {
    redirect(location, cookie) {
      if (cookie) response.setHeader("set-cookie", cookie);
      response.writeHead(303, { location }).end();
    },
    html(status, body, cookie) {
      if (cookie) response.setHeader("set-cookie", cookie);
      send(response, status, body, "text/html; charset=utf-8");
    },
    file(status, body, contentType) {
      response.writeHead(status, { "content-type": contentType }).end(body);
    },
    text(status, body) {
      send(response, status, body);
    },
  };
}

async function onAdminRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const rawBody = request.method === "POST" ? await readBody(request) : "";
  const adminRequest: AdminRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    cookie: request.headers.cookie,
    form: new URLSearchParams(rawBody),
    query: url.searchParams,
    secure: request.headers["x-forwarded-proto"] === "https",
  };
  await handleAdmin(adminRequest, adminResponse(response), {
    store: dbStore,
    botToken: env.telegramBotTokenOrEmpty,
    adminIds: env.adminTelegramIds,
    sessionSecret: env.adminSessionSecret,
    api: liveApi,
    cards: liveCardProvider(dbStore),
  });
}

/**
 * Whether the schema is in place. False for the first moments of a boot, and
 * after that only if migrating failed.
 *
 * Defaults to true so that importing this module in a test — which never calls
 * main() — behaves as it always did.
 */
let ready = true;
let notReadyBecause: string | null = null;

/** Exposed for tests; main() is the only other thing that writes it. */
export function setReady(value: boolean, reason: string | null = null): void {
  ready = value;
  notReadyBecause = reason;
}

async function onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    // 200 even when not ready: this answers "is the process alive", which is
    // what a platform health check is asking, and a rollback triggered by a
    // slow migration helps nobody. `ready` in the body is where the honest
    // answer lives, for a person looking at it.
    send(
      response,
      200,
      JSON.stringify({
        ok: true,
        service: "fast-fayda",
        provider: env.faydaProvider,
        ready,
        ...(notReadyBecause ? { reason: notReadyBecause } : {}),
      }),
      "application/json",
    );
    return;
  }

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return onAdminRequest(request, response, url);
  }

  if (url.pathname !== env.webhookPath) {
    send(response, 404, "Not found");
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, "Method not allowed");
    return;
  }

  // In polling mode nothing should be posting here, and there is no secret
  // configured to check against — so the endpoint is closed rather than open.
  if (env.botMode === "polling") {
    send(response, 404, "Not found");
    return;
  }

  if (!secretMatches(request.headers["x-telegram-bot-api-secret-token"])) {
    // Not from Telegram. 401 rather than 200: there is nothing to acknowledge.
    send(response, 401, "Unauthorized");
    return;
  }

  // 503, not 200, and after the secret check so an unauthenticated caller
  // learns nothing about our state. Telegram retries a non-2xx, so an update
  // arriving during a migration is delivered again a moment later rather than
  // acknowledged and lost — which is what returning 200 here would do.
  if (!ready) {
    send(response, 503, "Not ready");
    return;
  }

  let update: unknown;
  try {
    update = JSON.parse(await readBody(request)) as TgUpdate;
  } catch {
    send(response, 400, "Bad request");
    return;
  }

  if (!isUpdate(update)) {
    send(response, 400, "Bad request");
    return;
  }

  await processUpdate(update);
  send(response, 200, "ok");
}

export function createBotServer() {
  return createServer((request, response) => {
    onRequest(request, response).catch((error) => {
      console.error("Request failed:", error);
      if (!response.headersSent) send(response, 500, "Internal error");
    });
  });
}

async function main() {
  // A missing variable used to exit here, on the principle that failing on
  // boot beats failing on the first person who says hello. That principle is
  // right for a process someone is watching in a terminal and wrong for a
  // hosted one, where exiting means: the container restarts, exits again,
  // restarts, and the platform's health check finds nothing listening, calls
  // the deployment broken, rolls it back, and hands over a log in which the
  // one line that matters is buried under fifty repetitions of the crash.
  //
  // So a configuration error is now reported rather than fatal. The process
  // stays up, /health says `ready: false` and names the problem in a browser,
  // and nothing that would need the database is started.
  let configError: string | null = null;
  try {
    assertConfigured();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    console.error(`\n${configError}\n`);
    console.error(configReport());
  }

  // Listening comes before migrating, which is the opposite of the obvious
  // order, and it is deliberate.
  //
  // A container platform gives a new deployment a fixed window — commonly 30
  // seconds — to answer a health check before it decides the deployment is
  // broken and rolls back. Migrating first spends that window on a database
  // round trip: a cold pooler, a slow link or a schema change of any size and
  // the port is still closed when the check arrives, so a perfectly good build
  // is rejected for being slow to start.
  //
  // What makes this safe is that `ready` below gates the webhook rather than
  // the socket. Until migrations finish the endpoint answers 503, which
  // Telegram retries — so an update that arrives mid-migration is delayed, not
  // dropped. Answering 200 here would be the version that loses messages.
  const server = createBotServer();
  server.listen(env.port, () => {
    const where = env.botMode === "polling" ? "(health only)" : env.webhookPath;
    console.log(`fast-fayda listening on :${env.port} ${where}`);
    console.log(`Mode: ${env.botMode} — status provider: ${env.faydaProvider}`);
  });

  if (configError) {
    // Nothing below this point can work without configuration, and trying
    // would only replace a clear message with a confusing one.
    setReady(false, configError);
  } else {
    try {
      const applied = await migrate();
      console.log(
        applied.length ? `Applied migrations: ${applied.join(", ")}` : "Schema up to date.",
      );
      setReady(true);
    } catch (error) {
      // Staying up with `ready` false beats exiting, for the same reason as
      // above: the health endpoint reports the reason, and a crash-looped
      // container reports only that it crash-looped.
      setReady(false, error instanceof Error ? error.message : String(error));
      console.error("Migrations failed; the service is up but not ready:", error);
    }
  }

  // The HTTP server runs in both modes. Polling does not need it for updates,
  // but a host that expects something to answer a health check still gets one,
  // and it keeps one start path rather than two.
  const poller =
    env.botMode === "polling" && ready ? createPoller(liveDeps(liveApi, env.supportChatId)) : null;
  // start() runs until stop(); a rejection escaping it would be unhandled, and
  // an unhandled rejection ends the process in Node.
  if (poller) {
    void poller.start().catch((error) => {
      console.error("Polling stopped unexpectedly:", error);
    });
  }

  // Stop taking new requests, let the ones in flight finish, then close the
  // pool. Without this a redeploy kills a conversation mid-answer.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down.`);
    poller?.stop();

    const finish = () => {
      void getPool()
        .end()
        .then(() => process.exit(0));
    };
    server.close(finish);

    // close() alone waits for every socket, and Telegram holds its connections
    // open between deliveries — an idle keep-alive socket is healthy, just
    // unused, so it would keep the process alive until the deadline below on
    // every single redeploy. Closing the idle ones leaves close() waiting only
    // on requests actually being served.
    server.closeIdleConnections();

    setTimeout(() => {
      console.warn("Grace period expired; closing connections still in flight.");
      server.closeAllConnections();
      finish();
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only when run directly, so importing this in a test does not start a server.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
