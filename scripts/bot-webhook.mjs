#!/usr/bin/env node
/**
 * Points the Telegram bot at this deployment, and reports on what it did.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
 *   npm run webhook set https://your-host.example.com
 *
 *   npm run webhook info      # what Telegram thinks it should call
 *   npm run webhook delete    # stop delivery (for local polling)
 *   npm run webhook secret    # print a usable random secret
 *
 * The path appended to the base URL is WEBHOOK_PATH, defaulting to /webhook —
 * it has to match what the server is listening on, so set the same value here
 * as the service has.
 *
 * A webhook is registered once per bot, on Telegram's side — not per deploy —
 * so this is a setup step, not part of the build. Re-run it when the
 * deployment URL changes, and note that `info` is the first place to look when
 * the bot has gone quiet: last_error_message says why delivery is failing.
 */

import crypto from "node:crypto";

const [, , command = "info", ...rest] = process.argv;

if (command === "secret") {
  console.log(crypto.randomBytes(32).toString("base64url"));
  process.exit(0);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN (from @BotFather).");
  process.exit(1);
}

async function call(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!body.ok) {
    console.error(`${method} failed: ${body.description ?? response.status}`);
    process.exit(1);
  }
  return body.result;
}

/** Must stay in step with src/lib/bot/i18n.ts — same commands, same wording. */
const COMMANDS = {
  en: [
    ["start", "Open the menu"],
    ["status", "Check an application"],
    ["faq", "Frequently asked questions"],
    ["support", "Message the support team"],
    ["language", "Change language"],
    ["cancel", "Stop what you are doing"],
  ],
  am: [
    ["start", "ምናሌውን ክፈት"],
    ["status", "የማመልከቻ ሁኔታ አረጋግጥ"],
    ["faq", "በተደጋጋሚ የሚጠየቁ ጥያቄዎች"],
    ["support", "ለድጋፍ ቡድኑ መልእክት ላክ"],
    ["language", "ቋንቋ ቀይር"],
    ["cancel", "የያዙትን አቁም"],
  ],
};

async function setCommands() {
  for (const [languageCode, entries] of Object.entries(COMMANDS)) {
    const commands = entries.map(([command, description]) => ({ command, description }));
    // English doubles as the default list, for clients set to anything else.
    await call("setMyCommands", languageCode === "en" ? { commands } : { commands, language_code: languageCode });
  }
  console.log("Command menu set for en and am.");
}

const me = await call("getMe");

switch (command) {
  case "set": {
    const base = rest[0];
    if (!base) {
      console.error("Usage: npm run webhook set https://your-host.example.com");
      process.exit(1);
    }
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      console.error(
        "Set TELEGRAM_WEBHOOK_SECRET to the same value the deployment has.\n" +
          "Generate one with: node scripts/bot-webhook.mjs secret",
      );
      process.exit(1);
    }
    const rawPath = process.env.WEBHOOK_PATH ?? "/webhook";
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const url = `${base.replace(/\/$/, "")}${path}`;
    await call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await setCommands();
    console.log(`@${me.username} now delivers updates to ${url}`);
    break;
  }

  case "delete":
    await call("deleteWebhook", { drop_pending_updates: true });
    console.log(`@${me.username} will no longer receive webhook updates.`);
    break;

  case "commands":
    await setCommands();
    break;

  case "info": {
    const info = await call("getWebhookInfo");
    console.log(`bot:      @${me.username} (${me.id})`);
    console.log(`url:      ${info.url || "(none set)"}`);
    console.log(`pending:  ${info.pending_update_count}`);
    if (info.last_error_message) {
      const when = new Date((info.last_error_date ?? 0) * 1000).toISOString();
      console.log(`last error (${when}): ${info.last_error_message}`);
    }
    break;
  }

  default:
    console.error(`Unknown command "${command}". Use: set | delete | info | commands | secret`);
    process.exit(1);
}
