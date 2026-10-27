import { escapeHtml } from "../bot/api";

/**
 * Server-rendered HTML, plain — no framework, no build step, no client-side
 * JavaScript beyond the one script tag Telegram's own widget requires. The
 * portal is a handful of admins deciding a handful of things; a page that
 * reloads on every action is not a cost worth a framework to avoid.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 780px;
         margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid currentColor;
       padding-bottom: 0.25rem; opacity: 0.85; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #8883; }
  form.inline { display: inline; }
  input, textarea, button { font: inherit; padding: 0.35rem 0.5rem; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; }
  button { cursor: pointer; }
  .row { display: flex; gap: 0.5rem; align-items: center; margin: 0.4rem 0; }
  .muted { opacity: 0.65; font-size: 0.9em; }
  .error { color: #c33; }
  .settings-form label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.9em; }
  .settings-form input { width: 100%; box-sizing: border-box; }
  a.button { display: inline-block; text-decoration: none; border: 1px solid currentColor;
             border-radius: 4px; padding: 0.3rem 0.6rem; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body>${body}</body></html>`;
}

export function loginPage(botUsername: string, error?: string): string {
  const widget = botUsername
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22"
         data-telegram-login="${escapeHtml(botUsername)}" data-size="large"
         data-auth-url="/admin/auth" data-request-access="write"></script>`
    : `<p class="error">TELEGRAM_BOT_TOKEN is not configured, so the login widget cannot be shown.</p>`;
  return page(
    "Sign in",
    `<h1>fast-fayda admin</h1>` +
      (error ? `<p class="error">${escapeHtml(error)}</p>` : "") +
      `<p>Sign in with the Telegram account listed in ADMIN_TELEGRAM_IDS, or one already granted access.</p>` +
      widget,
  );
}

export function forbiddenPage(): string {
  return page(
    "Not an admin",
    `<h1>Not authorised</h1><p>This Telegram account is not an admin of this bot.</p>` +
      `<p class="muted">Ask an existing admin to add you from the Settings page, or set ` +
      `ADMIN_TELEGRAM_IDS on the deployment.</p>`,
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export type PurchaseRowView = {
  id: string;
  who: string;
  provider: string;
  reference: string;
  rawInput: string;
  amountEtb: string | null;
  createdAt: string;
};

export type CardJobRowView = {
  id: string;
  who: string;
  source: string;
  pointsSpent: number;
  createdAt: string;
};

export function dashboardPage(input: {
  self: string;
  /** Upstream card-API account. Null means unconfigured or unreachable. */
  cardBalance: { points: number; status: string } | null;
  purchases: PurchaseRowView[];
  jobs: CardJobRowView[];
  settings: {
    pointPriceEtb: string;
    cbeAccountName: string;
    cbeAccountNumber: string;
    telebirrAccountName: string;
    telebirrAccountNumber: string;
    /** Whether a Card API key is stored in the portal. The key itself is never shown. */
    cardApiKeySet: boolean;
  };
  admins: { telegramId: number; addedBy: number | null; superAdmin: boolean }[];
  /** Whether the viewer is a super admin, and so may grant access. */
  canGrant: boolean;
  flash?: string;
}): string {
  const { self, cardBalance, purchases, jobs, settings, admins, canGrant, flash } = input;

  // At zero, every OTP retrieval fails for every customer — so this is the one
  // number on the page that needs to be noticed before it becomes a problem,
  // not after.
  const cardBalanceLine = cardBalance
    ? `<p class="${cardBalance.points <= 10 ? "error" : "muted"}">` +
      `Card API balance: <b>${cardBalance.points}</b> point${cardBalance.points === 1 ? "" : "s"} ` +
      `(${escapeHtml(cardBalance.status)})` +
      (cardBalance.points <= 10 ? " — recharge before retrievals start failing." : "") +
      `</p>`
    : `<p class="muted">Card API balance: unavailable (no key configured, or the provider could not be reached).</p>`;

  const purchaseRows = purchases.length
    ? purchases
        .map(
          (p) => `<tr>
            <td><code>${escapeHtml(p.who)}</code></td>
            <td>${escapeHtml(p.provider.toUpperCase())}</td>
            <td><code>${escapeHtml(p.reference)}</code></td>
            <td>${p.amountEtb ? escapeHtml(p.amountEtb) + " ETB" : "?"}</td>
            <td class="muted">${escapeHtml(p.createdAt)}</td>
            <td>
              <form class="inline" method="post" action="/admin/api/payments/${p.id}/approve">
                <input name="points" type="number" min="1" required placeholder="pts" style="width:4rem">
                <button type="submit">Approve</button>
              </form>
              <form class="inline" method="post" action="/admin/api/payments/${p.id}/reject">
                <button type="submit">Reject</button>
              </form>
            </td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">Nothing waiting.</td></tr>`;

  const jobRows = jobs.length
    ? jobs
        .map(
          (j) => `<tr>
            <td>${escapeHtml(j.who)}</td>
            <td>${escapeHtml(j.source)}</td>
            <td>${j.pointsSpent}</td>
            <td class="muted">${escapeHtml(j.createdAt)}</td>
            <td>
              <a class="button" href="/admin/api/jobs/${j.id}/image" target="_blank" rel="noopener">View</a>
              <form class="inline" method="post" action="/admin/api/jobs/${j.id}/deliver">
                <button type="submit">Mark done</button>
              </form>
            </td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">Nothing waiting.</td></tr>`;

  const adminRows = admins
    .map(
      (a) =>
        `<li><code>${a.telegramId}</code> <span class="muted">${
          a.superAdmin
            ? "super admin (ADMIN_TELEGRAM_IDS)"
            : a.addedBy
              ? `admin (added by ${a.addedBy})`
              : "admin"
        }</span></li>`,
    )
    .join("");

  return page(
    "Admin",
    `<div class="row"><h1 style="flex:1">fast-fayda admin</h1>` +
      `<span class="muted">${escapeHtml(self)}</span></div>` +
      (flash ? `<p>${escapeHtml(flash)}</p>` : "") +
      cardBalanceLine +
      `<h2>Payments needing review</h2>` +
      `<table><thead><tr><th>From</th><th>Via</th><th>Reference</th><th>Amount</th><th>When</th><th></th></tr></thead>` +
      `<tbody>${purchaseRows}</tbody></table>` +
      `<h2>Documents needing review</h2>` +
      `<table><thead><tr><th>From</th><th>Type</th><th>Points</th><th>When</th><th></th></tr></thead>` +
      `<tbody>${jobRows}</tbody></table>` +
      `<h2>Settings</h2>` +
      `<form class="settings-form" method="post" action="/admin/api/settings">` +
      `<label>Point price (ETB)</label><input name="pointPriceEtb" value="${escapeHtml(settings.pointPriceEtb)}">` +
      `<label>CBE account name</label><input name="cbeAccountName" value="${escapeHtml(settings.cbeAccountName)}">` +
      `<label>CBE account number</label><input name="cbeAccountNumber" value="${escapeHtml(settings.cbeAccountNumber)}">` +
      `<label>Telebirr account name</label><input name="telebirrAccountName" value="${escapeHtml(settings.telebirrAccountName)}">` +
      `<label>Telebirr account number</label><input name="telebirrAccountNumber" value="${escapeHtml(settings.telebirrAccountNumber)}">` +
      `<label>Card API key</label>` +
      `<input name="cardApiKey" type="password" autocomplete="new-password" ` +
      `placeholder="${settings.cardApiKeySet ? "••••••••  (saved — leave blank to keep, or type a new key)" : "not set (using CARD_API_KEY)"}">` +
      `<label style="font-weight:normal"><input type="checkbox" name="clearCardApiKey" value="1" style="width:auto; margin-right:0.4rem">Clear the saved key and fall back to CARD_API_KEY</label>` +
      `<p><button type="submit">Save settings</button></p>` +
      `</form>` +
      `<h2>Admins</h2><ul>${adminRows}</ul>` +
      (canGrant
        ? `<form method="post" action="/admin/api/admins">` +
          `<input name="telegramId" placeholder="Telegram id" required inputmode="numeric" pattern="[0-9]+">` +
          `<button type="submit">Grant access</button></form>`
        : `<p class="muted">Only a super admin can grant or revoke admin access.</p>`) +
      `<h2>Post to all users</h2>` +
      `<p class="muted">Sends one message to everyone who has started the bot. This cannot be undone.</p>` +
      `<form method="post" action="/admin/api/broadcast">` +
      `<textarea name="message" rows="4" maxlength="3900" required placeholder="Announcement…"></textarea>` +
      `<p><button type="submit">Send to all users</button></p>` +
      `</form>`,
  );
}
