import { callBot, type BotApi } from "../bot/api";
import { broadcastToUsers } from "../bot/broadcast";
import type { CardProvider } from "../bot/card";
import type { BotStore } from "../bot/store";
import { forbiddenPage, loginPage, page, dashboardPage } from "./html";
import { signSession, verifySession, verifyTelegramLogin, TelegramLoginError } from "./telegram-auth";

/**
 * The admin portal, as one handler both runtimes call into.
 *
 * Framework-agnostic on purpose — this bot already runs two ways (a
 * long-running Node server and Vercel functions), and the webhook learned that
 * lesson already: duplicate the routing and the two will drift, and the half
 * that drifts is whichever nobody is looking at. `AdminRequest`/`AdminResponse`
 * are the seam; src/server.ts and api/admin.ts each adapt their native
 * request/response into it and otherwise know nothing about what is inside.
 */

export type AdminRequest = {
  method: string;
  path: string;
  cookie: string | undefined;
  /** Parsed `application/x-www-form-urlencoded` body, for POSTs. */
  form: URLSearchParams;
  query: URLSearchParams;
  /** True when the connection this request arrived on was HTTPS. */
  secure: boolean;
};

export type AdminResponse = {
  redirect(location: string, cookie?: string): void;
  html(status: number, body: string, cookie?: string): void;
  file(status: number, body: Buffer, contentType: string): void;
  text(status: number, body: string): void;
};

export type AdminDeps = {
  store: BotStore;
  botToken: string;
  adminIds: number[];
  sessionSecret: string;
  api: BotApi;
  /** Only its balance is read here; retrieval itself happens in the bot. */
  cards: CardProvider;
};

const COOKIE_NAME = "admin_session";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function setCookieHeader(value: string, secure: boolean, maxAgeSeconds: number): string {
  const attrs = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push("Secure");
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; ${attrs.join("; ")}`;
}

const clearCookie = (secure: boolean) => setCookieHeader("", secure, 0);

/** Cached across warm invocations; refetched on a cold start. */
let cachedBotUsername: { token: string; username: string } | null = null;
async function botUsername(token: string): Promise<string> {
  if (cachedBotUsername?.token === token) return cachedBotUsername.username;
  try {
    const me = await callBot<{ username: string }>("getMe", {}, token);
    cachedBotUsername = { token, username: me.username };
    return me.username;
  } catch {
    return "";
  }
}

async function currentAdmin(req: AdminRequest, deps: AdminDeps): Promise<number | null> {
  const cookies = parseCookies(req.cookie);
  const telegramId = verifySession(cookies[COOKIE_NAME], deps.sessionSecret);
  if (telegramId === null) return null;
  const ok = await deps.store.isAdmin(telegramId, deps.adminIds);
  return ok ? telegramId : null;
}

export async function handleAdmin(req: AdminRequest, res: AdminResponse, deps: AdminDeps): Promise<void> {
  // --- auth --------------------------------------------------------------
  if (req.path === "/admin/auth" && req.method === "GET") {
    let payload;
    try {
      payload = verifyTelegramLogin(req.query, deps.botToken);
    } catch (error) {
      const message = error instanceof TelegramLoginError ? error.message : "Login failed.";
      return res.html(401, loginPage(await botUsername(deps.botToken), message));
    }
    const ok = await deps.store.isAdmin(payload.id, deps.adminIds);
    if (!ok) return res.html(403, forbiddenPage());
    const cookie = setCookieHeader(signSession(payload.id, deps.sessionSecret), req.secure, 30 * 86_400);
    return res.redirect("/admin", cookie);
  }

  if (req.path === "/admin/logout") {
    return res.redirect("/admin", clearCookie(req.secure));
  }

  const adminId = await currentAdmin(req, deps);

  if (req.path === "/admin" && req.method === "GET") {
    if (adminId === null) return res.html(200, loginPage(await botUsername(deps.botToken)));
    return res.html(200, await renderDashboard(adminId, deps, req.query.get("flash") ?? undefined));
  }

  // Everything past here needs a logged-in admin.
  if (adminId === null) return res.html(401, page("Sign in required", `<p><a href="/admin">Sign in</a></p>`));

  // --- payments ------------------------------------------------------------
  const approveMatch = /^\/admin\/api\/payments\/([^/]+)\/approve$/.exec(req.path);
  if (approveMatch && req.method === "POST") {
    const id = approveMatch[1]!;
    const points = Number(req.form.get("points"));
    if (!Number.isSafeInteger(points) || points <= 0) {
      return res.redirect("/admin");
    }
    const decision = await deps.store.decidePurchase({ id, approve: true, adminId, points });
    if (decision) await notify(deps.api, decision.telegramId, `Payment confirmed.\nPoints added: ${points}\nYour points: ${decision.balance}`);
    return res.redirect("/admin");
  }

  const rejectMatch = /^\/admin\/api\/payments\/([^/]+)\/reject$/.exec(req.path);
  if (rejectMatch && req.method === "POST") {
    const id = rejectMatch[1]!;
    const decision = await deps.store.decidePurchase({ id, approve: false, adminId, points: 0 });
    if (decision) await notify(deps.api, decision.telegramId, "Your recent payment could not be confirmed. Contact support if you believe this is wrong.");
    return res.redirect("/admin");
  }

  // --- card jobs -------------------------------------------------------
  const deliverMatch = /^\/admin\/api\/jobs\/([^/]+)\/deliver$/.exec(req.path);
  if (deliverMatch && req.method === "POST") {
    const id = deliverMatch[1]!;
    const job = await deps.store.getCardJob(id);
    const done = await deps.store.markCardJobDelivered(id);
    if (done && job) await notify(deps.api, Number(job.telegram_id), "Your document has been processed. Contact support for next steps.");
    return res.redirect("/admin");
  }

  const imageMatch = /^\/admin\/api\/jobs\/([^/]+)\/image$/.exec(req.path);
  if (imageMatch && req.method === "GET") {
    return serveJobImage(imageMatch[1]!, res, deps);
  }

  // --- settings --------------------------------------------------------
  if (req.path === "/admin/api/settings" && req.method === "POST") {
    const price = req.form.get("pointPriceEtb");
    // The Card API key is shown masked, so a blank field means "leave it as it
    // is" rather than "erase it" — an admin clears it with the checkbox, which
    // hands the deployment back to CARD_API_KEY from the environment.
    const cardApiKey = blankToNull(req.form.get("cardApiKey"));
    const clearCardApiKey = req.form.get("clearCardApiKey") === "1";
    await deps.store.updateSettings(
      {
        pointPriceEtb: price ? Number(price) : null,
        cbeAccountName: blankToNull(req.form.get("cbeAccountName")),
        cbeAccountNumber: blankToNull(req.form.get("cbeAccountNumber")),
        telebirrAccountName: blankToNull(req.form.get("telebirrAccountName")),
        telebirrAccountNumber: blankToNull(req.form.get("telebirrAccountNumber")),
        ...(clearCardApiKey
          ? { cardApiKey: null }
          : cardApiKey
            ? { cardApiKey }
            : {}),
      },
      adminId,
    );
    return res.redirect("/admin");
  }

  if (req.path === "/admin/api/admins" && req.method === "POST") {
    const telegramId = Number(req.form.get("telegramId"));
    if (Number.isSafeInteger(telegramId) && telegramId !== 0) {
      await deps.store.grantAdmin(telegramId, adminId);
    }
    return res.redirect("/admin");
  }

  // --- broadcast -------------------------------------------------------
  if (req.path === "/admin/api/broadcast" && req.method === "POST") {
    const result = await broadcastToUsers(deps.store, deps.api, req.form.get("message") ?? "");
    if (!result.ok) {
      const flash =
        result.error === "empty"
          ? "Nothing to post — the message was empty."
          : "That message is too long for Telegram. Shorten it and try again.";
      return res.redirect(`/admin?flash=${encodeURIComponent(flash)}`);
    }
    const { sent, failed } = result;
    const total = sent + failed;
    const flash =
      `Posted to ${sent} of ${total} user${total === 1 ? "" : "s"}` +
      (failed ? ` (${failed} could not be reached).` : ".");
    return res.redirect(`/admin?flash=${encodeURIComponent(flash)}`);
  }

  return res.text(404, "Not found");
}

function blankToNull(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null;
}

async function notify(api: BotApi, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (error) {
    console.error("admin notification failed:", error);
  }
}

async function renderDashboard(adminId: number, deps: AdminDeps, flash?: string): Promise<string> {
  const [purchases, jobs, settings, granted, cardBalance] = await Promise.all([
    deps.store.pendingPurchases(),
    deps.store.pendingCardJobs(),
    deps.store.getSettings(),
    deps.store.listGrantedAdmins(),
    // Null when unconfigured or unreachable — the page says so rather than
    // showing a zero, which would read as "recharge now" when it means
    // "nobody asked".
    deps.cards.balance(),
  ]);

  const admins = [
    ...deps.adminIds.map((id) => ({ telegramId: id, addedBy: null })),
    ...granted.filter((g) => !deps.adminIds.includes(g.telegramId)),
  ];

  return dashboardPage({
    self: `Signed in as ${adminId}`,
    cardBalance,
    purchases: purchases.map((p) => ({
      id: p.id,
      who: p.telegram_id,
      provider: p.provider,
      reference: p.reference,
      rawInput: p.raw_input,
      amountEtb: p.amount_etb,
      createdAt: p.created_at,
    })),
    jobs: jobs.map((j) => ({
      id: j.id,
      who: j.username ? `@${j.username}` : j.first_name,
      source: j.source,
      pointsSpent: j.points_spent,
      createdAt: j.created_at,
    })),
    settings: {
      pointPriceEtb: settings.pointPriceEtb === null ? "" : String(settings.pointPriceEtb),
      cbeAccountName: settings.cbeAccountName ?? "",
      cbeAccountNumber: settings.cbeAccountNumber ?? "",
      telebirrAccountName: settings.telebirrAccountName ?? "",
      telebirrAccountNumber: settings.telebirrAccountNumber ?? "",
      // Never echo the key itself: the page only says whether one is set, and
      // the form replaces it.
      cardApiKeySet: settings.cardApiKey !== null,
    },
    admins,
    flash,
  });
}

/**
 * Streams a customer's document through this server rather than redirecting
 * the browser to Telegram's file URL. That URL carries the bot token in
 * plain text; keeping it out of a browser's address bar and history is worth
 * the extra round trip, for a document that is somebody's national ID.
 */
async function serveJobImage(id: string, res: AdminResponse, deps: AdminDeps): Promise<void> {
  const job = await deps.store.getCardJob(id);
  if (!job?.telegram_file_id) return res.text(404, "Not found");

  let filePath: string;
  try {
    const file = await callBot<{ file_path: string }>(
      "getFile",
      { file_id: job.telegram_file_id },
      deps.botToken,
    );
    filePath = file.file_path;
  } catch (error) {
    console.error("getFile failed:", error);
    return res.text(502, "Could not reach Telegram.");
  }

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${deps.botToken}/${filePath}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return res.text(502, "Could not download the file.");
  }
  if (!response.ok) return res.text(502, "Telegram refused the file.");

  const contentType = filePath.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
  const body = Buffer.from(await response.arrayBuffer());
  res.file(200, body, contentType);
}
