import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The store and the migration runner, against a real Postgres.
 *
 * tests/bot.test.ts proves the conversation is right by replacing the store
 * with a double, which means none of its SQL runs there. These are the
 * statements that double stands in for: an upsert that has to survive a second
 * contact, a claim that has to lose exactly once under a duplicate delivery,
 * and an interval expression that only fails when Postgres parses it.
 *
 * Skipped unless TEST_DATABASE_URL points at a scratch database:
 *   createdb fast_fayda_test
 *   TEST_DATABASE_URL=postgres://…/fast_fayda_test npm test
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

const TG = 90_210;

suite("store", () => {
  let db: typeof import("@/db");
  let store: typeof import("@/bot/store").dbStore;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.ID_HASH_SECRET = "test-id-hash-secret-that-is-long-enough-32";
    db = await import("@/db");
    store = (await import("@/bot/store")).dbStore;
    await db.migrate();
    await db.withDb((q) => q.run("delete from bot_users"));
  });

  afterAll(async () => {
    await db.withDb((q) => q.run("delete from bot_users where telegram_id = $1", [String(TG)]));
    await db.getPool().end();
  });

  it("applies migrations, and applying them again does nothing", async () => {
    // The first call ran in beforeAll; a second must be a no-op rather than an
    // error, because every restart of the service runs it.
    expect(await db.migrate()).toEqual([]);
  });

  /**
   * Two instances rolling at once — which is exactly what a Render deploy does,
   * starting the new container before retiring the old one. The advisory lock
   * has to make one of them wait and then find nothing to do, rather than both
   * running the same CREATE and one of them crashing the boot.
   */
  it("survives two instances migrating at the same moment", async () => {
    const [a, b] = await Promise.all([db.migrate(), db.migrate()]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it("creates a user on first contact and updates them on the next", async () => {
    const first = await store.touchUser({
      telegramId: TG,
      chatId: TG,
      firstName: "Selam",
      username: null,
    });
    expect(first.language).toBeNull();
    expect(first.state).toBe("idle");

    await store.setLanguage(TG, "am");
    await store.setState(TG, "awaiting_id");

    const second = await store.touchUser({
      telegramId: TG,
      chatId: TG,
      firstName: "Selam T",
      username: "selam",
    });
    expect(second.firstName).toBe("Selam T");
    // A new message must not throw away where the conversation had got to.
    expect(second.language).toBe("am");
    expect(second.state).toBe("awaiting_id");
  });

  it("clears the blocked flag when the person comes back", async () => {
    await store.markBlocked(TG);
    await store.touchUser({ telegramId: TG, chatId: TG, firstName: "Selam", username: null });
    const blocked = await db.withDb((q) =>
      q.value<boolean>("select is_blocked from bot_users where telegram_id = $1", [String(TG)]),
    );
    expect(blocked).toBe(false);
  });

  it("claims an update exactly once", async () => {
    const updateId = Date.now();
    expect(await store.claimUpdate(updateId)).toBe(true);
    expect(await store.claimUpdate(updateId)).toBe(false);
  });

  it("counts lookups inside the rate-limit window and not outside it", async () => {
    await store.recordLookup({
      telegramId: TG,
      kind: "fin",
      hash: "deadbeef",
      last4: "9012",
      outcome: "found",
    });
    expect(await store.countLookupsSince(TG, 15)).toBe(1);

    await db.withDb((q) =>
      q.run("update bot_lookups set created_at = now() - interval '1 hour' where telegram_id = $1", [
        String(TG),
      ]),
    );
    expect(await store.countLookupsSince(TG, 15)).toBe(0);
  });

  it("saves a support message and marks it forwarded", async () => {
    const { id } = await store.saveSupportMessage({
      telegramId: TG,
      language: "en",
      body: "still waiting",
    });
    await store.markSupportForwarded(id);
    const forwarded = await db.withDb((q) =>
      q.value<boolean>("select forwarded from bot_support_messages where id = $1", [id]),
    );
    expect(forwarded).toBe(true);
  });

  /**
   * The money path. Everything above it — six input formats, a scraper, a
   * review queue — is machinery around the guarantee tested here: one receipt
   * is worth points exactly once, no matter who sends it or how often.
   */
  describe("purchases", () => {
    const OTHER = 90_211;
    const purchase = (reference: string, telegramId = TG, points = 10) => ({
      telegramId,
      provider: "cbe" as const,
      reference,
      rawInput: reference,
      amountEtb: 150,
      points,
      status: "approved" as const,
      decidedBy: "auto" as const,
    });

    beforeAll(async () => {
      await store.touchUser({ telegramId: OTHER, chatId: OTHER, firstName: "Abel", username: null });
    });

    it("credits points and writes a ledger entry explaining the balance", async () => {
      const before = await store.getBalance(TG);
      const result = await store.recordPurchase(purchase("FT00000001AA"));

      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") throw new Error("unreachable");
      expect(result.balance).toBe(before + 10);
      expect(await store.getBalance(TG)).toBe(before + 10);

      const ledger = await db.withDb((q) =>
        q.one<{ delta: number; reason: string; balance_after: number }>(
          `select delta, reason, balance_after from point_ledger
            where telegram_id = $1 order by created_at desc limit 1`,
          [String(TG)],
        ),
      );
      expect(ledger).toMatchObject({ delta: 10, reason: "purchase", balance_after: before + 10 });
    });

    it("refuses the same reference a second time", async () => {
      await store.recordPurchase(purchase("FT00000002BB"));
      const before = await store.getBalance(TG);

      const again = await store.recordPurchase(purchase("FT00000002BB"));
      expect(again.outcome).toBe("duplicate");
      expect(await store.getBalance(TG)).toBe(before);
    });

    it("refuses a reference another person has already claimed", async () => {
      await store.recordPurchase(purchase("FT00000003CC", TG));
      const stolen = await store.recordPurchase(purchase("FT00000003CC", OTHER));
      expect(stolen.outcome).toBe("duplicate");
      expect(await store.getBalance(OTHER)).toBe(0);
    });

    it("treats a reference as the same payment whatever case it arrives in", async () => {
      await store.recordPurchase(purchase("FT00000004DD"));
      const lower = await store.recordPurchase({
        ...purchase("ft00000004dd"),
        reference: "ft00000004dd",
      });
      expect(lower.outcome).toBe("duplicate");
    });

    /**
     * Two deliveries of the same receipt racing each other. Exactly one may
     * win — which is a property of the unique index, not of any ordering the
     * application arranges.
     */
    it("credits once when the same receipt is sent twice at the same moment", async () => {
      const before = await store.getBalance(TG);
      const results = await Promise.all([
        store.recordPurchase(purchase("FT00000005EE")),
        store.recordPurchase(purchase("FT00000005EE")),
      ]);

      const created = results.filter((r) => r.outcome === "created");
      expect(created).toHaveLength(1);
      expect(await store.getBalance(TG)).toBe(before + 10);
    });

    it("queues a pending purchase without crediting anything", async () => {
      const before = await store.getBalance(TG);
      const result = await store.recordPurchase({
        ...purchase("FT00000006FF"),
        status: "pending",
        decidedBy: "none",
        points: 0,
      });

      expect(result.outcome).toBe("created");
      expect(await store.getBalance(TG)).toBe(before);
      expect((await store.pendingPurchases()).some((row) => row.reference === "FT00000006FF")).toBe(
        true,
      );
    });

    it("credits a queued purchase when an admin approves it", async () => {
      const queued = await store.recordPurchase({
        ...purchase("FT00000007GG"),
        status: "pending",
        decidedBy: "none",
        points: 0,
      });
      if (queued.outcome !== "created") throw new Error("unreachable");
      const before = await store.getBalance(TG);

      const decision = await store.decidePurchase({
        id: queued.id,
        approve: true,
        adminId: 1,
        points: 10,
      });
      expect(decision).toMatchObject({ applied: true, telegramId: TG, balance: before + 10 });
    });

    /**
     * The forwarded admin message has approve and reject buttons and does not
     * disappear when tapped, so two admins — or one impatient one — can decide
     * the same purchase twice.
     */
    it("ignores a second decision on the same purchase", async () => {
      const queued = await store.recordPurchase({
        ...purchase("FT00000008HH"),
        status: "pending",
        decidedBy: "none",
        points: 0,
      });
      if (queued.outcome !== "created") throw new Error("unreachable");

      await store.decidePurchase({ id: queued.id, approve: true, adminId: 1, points: 10 });
      const balanceAfterFirst = await store.getBalance(TG);

      const second = await store.decidePurchase({
        id: queued.id,
        approve: true,
        adminId: 2,
        points: 10,
      });
      expect(second).toBeNull();
      expect(await store.getBalance(TG)).toBe(balanceAfterFirst);
    });

    it("credits nothing when an admin rejects", async () => {
      const queued = await store.recordPurchase({
        ...purchase("FT00000009II"),
        status: "pending",
        decidedBy: "none",
        points: 0,
      });
      if (queued.outcome !== "created") throw new Error("unreachable");
      const before = await store.getBalance(TG);

      const decision = await store.decidePurchase({
        id: queued.id,
        approve: false,
        adminId: 1,
        points: 10,
      });
      expect(decision).toMatchObject({ applied: true, points: 0, balance: before });
    });

    it("stores output preferences", async () => {
      await store.setOutput(TG, { downloadType: "zip", background: "bg5" });
      const row = await db.withDb((q) =>
        q.one<{ download_type: string; background: string }>(
          `select download_type, background from bot_users where telegram_id = $1`,
          [String(TG)],
        ),
      );
      expect(row).toMatchObject({ download_type: "zip", background: "bg5" });
    });

    /**
     * `printable` is offered in the download menu, but the original check
     * constraint never listed it — saving it failed against the database.
     */
    it("stores the printable download type the menu offers", async () => {
      await store.setOutput(TG, { downloadType: "printable" });
      const row = await db.withDb((q) =>
        q.one<{ download_type: string }>(
          `select download_type from bot_users where telegram_id = $1`,
          [String(TG)],
        ),
      );
      expect(row?.download_type).toBe("printable");
    });

    it("will not let a balance go negative", async () => {
      await expect(
        db.withDb((q) =>
          q.run(`update bot_users set points = -1 where telegram_id = $1`, [String(TG)]),
        ),
      ).rejects.toThrow(/points_non_negative/i);
    });
  });

  it("rolls back a transaction that throws", async () => {
    await expect(
      db.withDb(async (q) => {
        await q.run("update bot_users set first_name = 'rolled back' where telegram_id = $1", [
          String(TG),
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const name = await db.withDb((q) =>
      q.value<string>("select first_name from bot_users where telegram_id = $1", [String(TG)]),
    );
    expect(name).not.toBe("rolled back");
  });

  /**
   * The panel's two reads. Placed last on purpose: this block clears the table,
   * so anything that expects a user to already exist must run before it.
   */
  describe("user stats", () => {
    const A = 90_220;
    const B = 90_221;
    const C = 90_222;

    beforeAll(async () => {
      await db.withDb((q) => q.run("delete from bot_users"));
      await db.withDb((q) =>
        q.run(
          `insert into bot_users (telegram_id, chat_id, first_name, username, points) values
             ($1, $1, 'Selam', 'selam', 4),
             ($2, $2, 'Dawit', null, 9),
             ($3, $3, 'Hanna', 'hanna', 0)`,
          [String(A), String(B), String(C)],
        ),
      );
    });

    it("counts users and totals their points", async () => {
      expect(await store.userSummary()).toEqual({ users: 3, points: 13 });
    });

    it("lists users highest balance first, honouring the limit", async () => {
      const rows = await store.listUserPoints(2);
      expect(rows.map((row) => [row.firstName, row.points])).toEqual([
        ["Dawit", 9],
        ["Selam", 4],
      ]);
      expect(rows[1]?.username).toBe("selam");
    });

    it("reports an empty table as zero, not null", async () => {
      await db.withDb((q) =>
        q.run("delete from bot_users where telegram_id in ($1, $2, $3)", [
          String(A),
          String(B),
          String(C),
        ]),
      );
      expect(await store.userSummary()).toEqual({ users: 0, points: 0 });
    });
  });
});
