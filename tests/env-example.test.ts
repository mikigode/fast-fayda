import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * .env.example is tracked by git. .env is not.
 *
 * That one-word difference has published live credentials from this repository
 * five times: a database password, a Supabase service-role key, and three bot
 * tokens, each of which then had to be rotated at the source because a commit
 * cannot be un-published. The file is a template, and a template with a value
 * in it is a leak waiting for the next `git push`.
 *
 * So the rule is mechanical rather than remembered: every assignment in
 * .env.example is empty, and this fails if one is not.
 */

const EXAMPLE = ".env.example";

/** `KEY=value` lines, ignoring comments and blanks. */
function assignments(): { line: number; key: string; value: string }[] {
  return readFileSync(EXAMPLE, "utf8")
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => /^[A-Z_][A-Z0-9_]*=/.test(text))
    .map(({ text, line }) => {
      const at = text.indexOf("=");
      return { line, key: text.slice(0, at), value: text.slice(at + 1).trim() };
    });
}

describe(".env.example", () => {
  it("has a key to fill in", () => {
    // Guards the guard: a rename or a move would otherwise make every
    // assertion below vacuously true.
    expect(assignments().length).toBeGreaterThan(0);
  });

  it("holds no values at all — it is a template, and it is committed", () => {
    const filled = assignments().filter((entry) => entry.value !== "");
    const report = filled.map((e) => `  ${EXAMPLE}:${e.line}  ${e.key}=…`).join("\n");

    expect(
      filled.length === 0,
      filled.length === 0
        ? ""
        : `${filled.length} value(s) set in a tracked file:\n${report}\n\n` +
            `Move them to .env (gitignored), or let \`npm run setup\` write it.\n` +
            `If any of these are real, rotate them: committing is publishing.`,
    ).toBe(true);
  });

  /**
   * Belt and braces, for values that arrive under a key this file does not
   * list yet — a leak does not have to land on a line we predicted.
   */
  it("contains nothing that looks like a live credential", () => {
    const body = readFileSync(EXAMPLE, "utf8");
    const patterns: [RegExp, string][] = [
      [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/, "a Telegram bot token"],
      [/\bsb_secret_[A-Za-z0-9_-]+/, "a Supabase secret key"],
      [/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/, "a database password"],
      [/\beyJ[A-Za-z0-9_-]{20,}\./, "a JWT"],
    ];

    for (const [pattern, what] of patterns) {
      expect(pattern.test(body), `${EXAMPLE} appears to contain ${what}`).toBe(false);
    }
  });
});
