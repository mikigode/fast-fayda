#!/usr/bin/env node
/**
 * One command that gets the bot running: `npm run setup`.
 *
 * It asks for what it needs, checks each answer as it arrives, applies the
 * schema, and then either starts the bot locally or points Telegram at a
 * deployment. Everything it learns is saved to .env, so running it again is
 * cheap and answers can be reused by pressing enter.
 *
 * The reason this exists is that the steps are individually simple and
 * collectively easy to get wrong in ways that look like something else: a
 * database URL that cannot be reached from a given host reads as a credentials
 * problem, a webhook registered against the wrong URL reads as a broken bot,
 * and a schema that was never applied reads as a bot that ignores you. Each
 * check below turns one of those into a sentence naming what to do.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const rl = createInterface({ input: stdin, output: stdout });

const say = (s = "") => console.log(s);
const ok = (s) => console.log(`  [32m✓[0m ${s}`);
const bad = (s) => console.log(`  [31m✗[0m ${s}`);
const step = (n, s) => console.log(`\n[1m${n}. ${s}[0m`);

// ---------------------------------------------------------------------------
// .env, read and written in place
// ---------------------------------------------------------------------------

function readEnv() {
  if (!existsSync(".env")) return {};
  const out = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function writeEnv(values) {
  const body = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(".env", body + "\n", "utf8");
}

/**
 * Prompts, showing any existing value as the default.
 *
 * End-of-input is treated as "the person is gone" rather than as an error: it
 * happens when the script is piped rather than typed into, and the retry loops
 * above would otherwise spin against a closed stream and end in a stack trace
 * that says nothing about what to do.
 */
async function ask(question, existing, { secret = false } = {}) {
  const shown = existing ? (secret ? `${existing.slice(0, 8)}…` : existing) : "";
  const suffix = existing ? ` [${shown}]` : "";
  let answer;
  try {
    answer = await rl.question(`${question}${suffix}\n> `);
  } catch {
    say("\n\nInput ended. Run `npm run setup` again in a terminal you can type into.");
    say("Anything already answered has been saved to .env.");
    process.exit(1);
  }
  return answer.trim() || existing || "";
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

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

async function checkDatabase(url) {
  const client = new pg.Client({
    connectionString: stripSslMode(url),
    // Same rule as src/db.ts; duplicated because these scripts run before a
    // build exists to import it from.
    ssl: sslFor(url),
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    return { ok: true };
  } catch (error) {
    await client.end().catch(() => {});
    return { ok: false, message: error.message };
  }
}

/** Turns a connection failure into the thing that is actually wrong. */
function explainDatabase(url, message) {
  const direct = /(?:postgres(?:ql)?:\/\/)?([^:]+):([^@]*)@db\.([a-z0-9]+)\.supabase\.co/.exec(url);

  // ENOTFOUND belongs here as much as ENETUNREACH does. Supabase's direct
  // endpoint publishes only an AAAA record now, so a machine without IPv6
  // finds no usable address and the resolver reports the name as missing
  // rather than the route as unreachable — which reads as a typo in the
  // hostname, and is not one.
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH/.test(message) && direct) {
    const [, , password, ref] = direct;
    return [
      "That is Supabase's direct endpoint, which is IPv6-only. This machine has",
      "no route to it, so the name does not resolve.",
      "",
      "Use the pooler instead. Yours is:",
      "",
      `  postgresql://postgres.${ref}:${password}@aws-0-<region>.pooler.supabase.com:5432/postgres`,
      "",
      "Replace <region> with your project's — Supabase → Connect shows the whole",
      "string. Note the username carries the project ref and the host changes.",
      "",
      "If the pooler fails the same way, the project may be paused: a free",
      "Supabase project pauses after a week idle and stops resolving until it is",
      "restored from the dashboard.",
    ].join("\n     ");
  }

  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return [
      `That hostname does not resolve: ${message}`,
      "",
      "Check it against Supabase → Connect. If it looks right, the project may be",
      "paused — a free project pauses after a week idle and has to be restored.",
    ].join("\n     ");
  }
  if (/password authentication failed|SASL/i.test(message)) {
    return "The password is wrong. If you reset it in Supabase, copy the new string from Connect.";
  }
  if (/Tenant or user not found/i.test(message)) {
    return [
      "The pooler did not recognise that user.",
      "Through the pooler the username must carry the project ref —",
      "  postgres.<ref>, not postgres.",
    ].join("\n     ");
  }
  if (/self-signed|certificate|unable to verify/i.test(message)) {
    return [
      "The server's TLS certificate is not one this machine already trusts.",
      "",
      "Add ?sslmode=require to the end of the connection string:",
      "",
      `  ${url.split("?")[0]}?sslmode=require`,
      "",
      "That encrypts the connection without verifying the certificate, which is",
      "what every other Postgres client does with that setting. To verify as",
      "well, download the provider's CA certificate and put its contents in",
      "DATABASE_CA_CERT instead.",
    ].join("\n     ");
  }
  if (/does not exist/i.test(message)) {
    return "That database name does not exist on the server.";
  }
  return message;
}

/**
 * Runs a command, working around a Windows-only failure mode.
 *
 * `npm` and `npx` are `.cmd` files there, not executables, and `spawnSync`
 * cannot run one directly without going through a shell — it was silently
 * failing to launch at all. `stdout` and `stderr` came back `undefined`, and
 * printing `build.stdout + build.stderr` produced the literal string "NaN",
 * which explained nothing about what had actually gone wrong. `node` is a real
 * executable everywhere and needs none of this.
 */
function run(command, args, options = {}) {
  const needsShell = process.platform === "win32" && (command === "npm" || command === "npx");
  return spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    shell: needsShell,
    ...options,
  });
}

/** Turns a failed spawnSync result into something worth printing. */
function describeSpawnFailure(result) {
  const parts = [];
  if (result.error) parts.push(`could not start: ${result.error.message}`);
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  return parts.join("\n") || `exited with status ${result.status}, no output was captured.`;
}

async function callTelegram(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  say("\n[1mfast-fayda setup[0m");
  say("Press enter to keep an existing answer. Nothing is sent anywhere but your");
  say("own database and Telegram.");

  const env = readEnv();

  // -- database ------------------------------------------------------------
  step(1, "Database");
  let databaseUrl = env.DATABASE_URL ?? "";
  for (;;) {
    databaseUrl = await ask("Postgres connection string:", databaseUrl);
    if (!databaseUrl) {
      bad("A database is required.");
      continue;
    }
    process.stdout.write("  checking… ");
    const result = await checkDatabase(databaseUrl);
    if (result.ok) {
      say("");
      ok("connected");
      break;
    }
    say("");
    bad("could not connect:");
    say(`     ${explainDatabase(databaseUrl, result.message)}`);
    say("");
  }
  env.DATABASE_URL = databaseUrl;
  writeEnv(env);

  // -- token ---------------------------------------------------------------
  step(2, "Telegram bot");
  let token = env.TELEGRAM_BOT_TOKEN ?? "";
  let username = "";
  for (;;) {
    token = await ask("Bot token from @BotFather:", token, { secret: true });
    if (!token) {
      bad("A token is required.");
      continue;
    }
    process.stdout.write("  checking… ");
    let me;
    try {
      me = await callTelegram(token, "getMe");
    } catch (error) {
      say("");
      bad(`could not reach Telegram: ${error.message}`);
      say("     Check this machine's internet connection and try again.");
      continue;
    }
    say("");
    if (!me.ok) {
      bad(`Telegram rejected it: ${me.description ?? "unknown error"}`);
      say("     If you revoked this token, use the new one @BotFather gave you.");
      continue;
    }
    username = me.result.username;
    ok(`@${username}`);
    break;
  }
  env.TELEGRAM_BOT_TOKEN = token;
  writeEnv(env);

  // -- schema --------------------------------------------------------------
  step(3, "Schema");
  const build = run("npm", ["run", "build"]);
  if (build.status !== 0) {
    bad("build failed:");
    say(describeSpawnFailure(build));
    process.exit(1);
  }
  const migrate = spawnSync("node", ["dist/migrate-cli.js"], {
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (migrate.status !== 0) {
    bad("migrations failed:");
    say(describeSpawnFailure(migrate));
    process.exit(1);
  }
  ok((migrate.stdout ?? "").trim() || "applied");

  // -- how to run ----------------------------------------------------------
  step(4, "How should the bot receive messages?");
  say("  1) Run it here, now — no hosting, no URL, no webhook. Best for testing.");
  say("  2) Point Telegram at a deployed URL (Vercel, Render, anywhere).");
  const choice = (await rl.question("\n> ")).trim();

  if (choice === "2") {
    let url = env.PUBLIC_URL ?? "";
    for (;;) {
      url = await ask("Public HTTPS URL of the deployment:", url);
      if (/^https:\/\/.+/.test(url)) break;
      bad("Needs to start with https://");
    }
    url = url.replace(/\/$/, "");

    // A path, because a Vercel deployment serves /api/webhook while a plain
    // server serves /webhook, and getting it wrong is silent.
    const path = env.WEBHOOK_PATH || (url.includes("vercel.app") ? "/api/webhook" : "/webhook");
    const secret = env.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString("base64url");

    process.stdout.write("  registering… ");
    const set = await callTelegram(token, "setWebhook", {
      url: `${url}${path}`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    say("");
    if (!set.ok) {
      bad(`Telegram refused: ${set.description}`);
      process.exit(1);
    }
    ok(`Telegram will deliver to ${url}${path}`);

    const info = await callTelegram(token, "getWebhookInfo");
    if (info.ok && info.result.last_error_message) {
      bad(`Telegram's last delivery failed: ${info.result.last_error_message}`);
    }

    env.PUBLIC_URL = url;
    env.WEBHOOK_PATH = path;
    env.TELEGRAM_WEBHOOK_SECRET = secret;
    env.BOT_MODE = "webhook";
    writeEnv(env);

    say("\n[1mOne thing left, and the bot will not work without it:[0m");
    say("set these on the deployment (Vercel/Render dashboard), then redeploy:");
    say("");
    say(`  TELEGRAM_BOT_TOKEN       = (the token you just entered)`);
    say(`  TELEGRAM_WEBHOOK_SECRET  = ${secret}`);
    say(`  DATABASE_URL             = (the connection string you just entered)`);
    say("");
    say("The secret must match exactly — Telegram sends it with every delivery,");
    say("and the bot refuses anything that does not carry it.");
    say(`\nThen message @${username} and say /start.`);
  } else {
    env.BOT_MODE = "polling";
    delete env.TELEGRAM_WEBHOOK_SECRET;
    writeEnv(env);
    say("");
    ok("configured to run locally");
    say(`\nStarting the bot. Message [1m@${username}[0m and say /start.`);
    say("It answers for as long as this stays open. Ctrl-C to stop.\n");
    rl.close();
    run("npx", ["tsx", "src/server.ts"], { stdio: "inherit", env: { ...process.env, ...env } });
    return;
  }

  rl.close();
}

main().catch((error) => {
  console.error("\nSetup failed:", error.message);
  process.exit(1);
});
