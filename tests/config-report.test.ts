import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configReport } from "@/env";

/**
 * The startup diagnostic, which exists to be pasted into a chat window.
 *
 * That is the whole reason for the test below about values: this function is
 * called at the exact moment somebody is stuck, and what a stuck person does
 * with a diagnostic is send it to someone else. A report that helpfully
 * printed DATABASE_URL would publish the database password every time it did
 * its job.
 */

// Every name configReport can count, so a local .env cannot quietly add
// entries to the report (WEBHOOK_PATH and friends) and change the headline.
const TOUCHED = [
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "BOT_MODE",
  "WEBHOOK_PATH",
  "PORT",
  "NODE_ENV",
  "ADMIN_TELEGRAM_IDS",
  "ADMIN_CONTACT",
  "BOT_SUPPORT_CHAT_ID",
  "CARD_API_KEY",
  "CARD_API_URL",
  "POINT_PRICE_ETB",
  "POINTS_PER_PRINT",
  "FAYDA_PROVIDER",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("configReport", () => {
  it("never prints the value of a secret, only that it is set", () => {
    process.env.DATABASE_URL = "postgresql://user:hunter2@db.example.com:5432/postgres";
    process.env.TELEGRAM_BOT_TOKEN = "1111111111:FAKE-TOKEN-FOR-TESTS-NOT-A-REAL-ONE";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret-webhook-value";
    process.env.CARD_API_KEY = "live-card-api-key";

    const report = configReport();

    for (const secret of [
      "hunter2",
      "FAKE-TOKEN-FOR-TESTS-NOT-A-REAL-ONE",
      "s3cret-webhook-value",
      "live-card-api-key",
    ]) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain("DATABASE_URL");
    expect(report).toMatch(/DATABASE_URL\s+set$/m);
  });

  it("prints the value of a setting that is not a secret, since that is the useful part", () => {
    process.env.BOT_MODE = "polling";
    expect(configReport()).toMatch(/BOT_MODE\s+set — polling/);
  });

  it("names what is missing", () => {
    expect(configReport()).toMatch(/DATABASE_URL\s+missing/);
  });

  /**
   * The case that cost three deploy cycles: not one variable wrong, but the
   * platform injecting nothing at all. That is a different problem with a
   * different fix, so the report says so rather than leaving it to be inferred
   * from a list of fifteen "missing" lines.
   */
  it("calls out the case where nothing is set at all", () => {
    const report = configReport();
    expect(report).toContain("Nothing at all is set");
    expect(report).toContain("staging");
    expect(report).toContain("build-only");
  });

  /**
   * Found by writing the test above: NODE_ENV is set by nixpacks, by npm, and
   * by vitest — so counting it would have suppressed that message on very
   * nearly every host, which is to say in every case it was written for.
   */
  it("does not count variables the platform sets by itself", () => {
    process.env.NODE_ENV = "production";
    process.env.PORT = "8080";
    const report = configReport();
    expect(report).toContain("Nothing at all is set");
    // Still shown — the values are useful — just not counted as ours.
    expect(report).toMatch(/NODE_ENV\s+set — production/);
    expect(report).toMatch(/PORT\s+set — 8080/);
  });

  it("says nothing about that when something is set", () => {
    process.env.DATABASE_URL = "postgres://x@y/z";
    expect(configReport()).not.toContain("Nothing at all is set");
  });

  it("counts what it found, so the headline answers the question on its own", () => {
    process.env.DATABASE_URL = "postgres://x@y/z";
    process.env.BOT_MODE = "polling";
    expect(configReport()).toMatch(/^Configuration visible to this process \(2 of \d+ set\):/);
  });
});
