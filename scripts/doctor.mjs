#!/usr/bin/env node
/**
 * `npm run doctor` — checks what is configured and prints a report that is safe
 * to paste to somebody who is helping.
 *
 * Passwords and tokens are never printed: a connection string is shown as its
 * parts, with the password replaced. What is printed is the part that matters
 * for diagnosis — which host, which user, whether DNS resolved, whether the
 * server answered, and the exact error if it did not.
 *
 * This exists because "it asks me again" is all a failing loop tells you from
 * the outside, and the error scrolls past. One command, one block of output,
 * no secrets.
 */

import { readFileSync, existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import pg from "pg";

const lines = [];
const out = (s = "") => {
  lines.push(s);
  console.log(s);
};

/**
 * pg discards its `ssl` option whenever sslmode appears in the connection
 * string — it resolves its own ssl to {} in that case, full verification,
 * no matter what was passed. So sslmode is read here and then stripped
 * before the string reaches pg; sslFor()'s answer is the only one honoured.
 */
function stripSslMode(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** libpq's sslmode, as src/db.ts implements it. */
function sslFor(url) {
  const mode = /[?&]sslmode=([a-z-]+)/.exec(url)?.[1];
  if (mode === "disable") return false;
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };
  if (mode === "require" || mode === "prefer" || mode === "allow") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

function readEnv() {
  if (!existsSync(".env")) return {};
  const env = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Splits a Postgres URL into parts, dropping the password. */
function describeUrl(raw) {
  try {
    const u = new URL(raw);
    return {
      ok: true,
      host: u.hostname,
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      database: u.pathname.replace(/^\//, "") || "(none)",
      hasPassword: Boolean(u.password),
    };
  } catch {
    return { ok: false };
  }
}

async function main() {
  const env = { ...readEnv(), ...process.env };

  out("---------- fast-fayda doctor ----------");
  out(`node        ${process.version}`);
  out(`.env        ${existsSync(".env") ? "present" : "MISSING"}`);
  out("");

  // -- database ------------------------------------------------------------
  out("DATABASE");
  const url = env.DATABASE_URL;
  if (!url) {
    out("  DATABASE_URL is not set.");
  } else {
    const parts = describeUrl(url);
    if (!parts.ok) {
      out("  DATABASE_URL is not a valid URL. It should start with postgresql://");
    } else {
      out(`  host      ${parts.host}`);
      out(`  port      ${parts.port}`);
      out(`  user      ${parts.user}`);
      out(`  database  ${parts.database}`);
      out(`  password  ${parts.hasPassword ? "present (not shown)" : "MISSING"}`);

      // Which kind of endpoint, since it decides whether IPv6 is required.
      if (/^db\..*\.supabase\.co$/.test(parts.host)) {
        out("  endpoint  Supabase DIRECT — IPv6 only, will not work without IPv6");
      } else if (/pooler\.supabase\.com$/.test(parts.host)) {
        out("  endpoint  Supabase pooler — correct for most machines");
        if (!parts.user.includes(".")) {
          out("  PROBLEM   through the pooler the user must be postgres.<project-ref>");
        }
      }

      // DNS first: it separates "name does not exist" from "server refused".
      try {
        const address = await lookup(parts.host, { all: true });
        out(`  dns       ${address.map((a) => `${a.address} (IPv${a.family})`).join(", ")}`);
      } catch (error) {
        out(`  dns       FAILED — ${error.code ?? error.message}`);
        out("            The hostname does not resolve. Either it is wrong, or the");
        out("            Supabase project is paused (free projects pause when idle).");
      }

      const client = new pg.Client({
        connectionString: stripSslMode(url),
        // Same rule as src/db.ts; duplicated because these scripts run before a
        // build exists to import it from.
        ssl: sslFor(url),
        connectionTimeoutMillis: 10_000,
      });
      try {
        await client.connect();
        const { rows } = await client.query("select current_user, version()");
        out(`  connect   OK as ${rows[0].current_user}`);
        const tables = await client.query(
          "select count(*)::int as n from information_schema.tables where table_name like 'bot_%'",
        );
        out(`  schema    ${tables.rows[0].n} bot tables (0 means migrations have not run)`);
        await client.end();
      } catch (error) {
        await client.end().catch(() => {});
        out(`  connect   FAILED — ${error.message}`);
      }
    }
  }
  out("");

  // -- telegram ------------------------------------------------------------
  out("TELEGRAM");
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    out("  TELEGRAM_BOT_TOKEN is not set.");
  } else {
    out(`  token     present, id ${token.split(":")[0] ?? "?"} (secret not shown)`);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      out(body.ok ? `  getMe     OK — @${body.result.username}` : `  getMe     REJECTED — ${body.description}`);

      const info = await (
        await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
          signal: AbortSignal.timeout(15_000),
        })
      ).json();
      if (info.ok) {
        out(`  webhook   ${info.result.url || "(none — polling mode is fine)"}`);
        if (info.result.pending_update_count) {
          out(`  pending   ${info.result.pending_update_count} undelivered updates`);
        }
        if (info.result.last_error_message) {
          out(`  last error ${info.result.last_error_message}`);
        }
      }
    } catch (error) {
      out(`  getMe     FAILED — ${error.message}`);
      out("            This machine could not reach api.telegram.org.");
    }
  }

  out("");
  out(`mode        ${env.BOT_MODE === "polling" ? "polling (local)" : "webhook"}`);
  out("---------------------------------------");
  out("Safe to paste: no passwords or tokens appear above.");
}

main().catch((error) => {
  console.error("doctor failed:", error.message);
  process.exit(1);
});
