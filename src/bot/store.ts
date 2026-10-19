import { withDb, type Querier } from "../db";
import { DOWNLOAD_TYPES, type DownloadType, type Lang } from "./i18n";

/**
 * Everything the bot keeps between messages.
 *
 * Defined as an interface first, with the Postgres implementation below it, so
 * the conversation handler can be exercised against an in-memory double. The
 * handler is where the bugs live — a flow that answers the wrong thing in one
 * language, a state that never clears — and testing that against a real
 * database would mean nobody runs the tests.
 */

export type BotState =
  | "idle"
  | "awaiting_id"
  | "awaiting_support"
  /** Sent "Buy Points"; the next message should be a receipt. */
  | "awaiting_receipt"
  /** Tapped an OTP button; the next message should be a FAN. */
  | "awaiting_fan"
  /** A code is on its way to the holder's phone; the next message should be it. */
  | "awaiting_otp"
  /** An admin tapped Approve; the next message should be a number of points. */
  | "awaiting_grant"
  /** An admin chose "Post to all users"; the next message is the announcement. */
  | "awaiting_post"
  /** Tapped Screenshot/Upload PDF; the next message should be the file itself. */
  | "awaiting_upload";

export type BotUser = {
  /**
   * Telegram IDs are int64 in the API but stay well inside 2^53 in practice,
   * and every Bot API call takes them as JSON numbers. Stored as bigint,
   * carried as number.
   */
  telegramId: number;
  chatId: number;
  firstName: string;
  username: string | null;
  /** Null until they have chosen — which is what triggers the chooser. */
  language: Lang | null;
  state: BotState;
  stateData: Record<string, unknown>;
  points: number;
  downloadType: DownloadType;
  background: string;
};

export type LookupOutcome = "found" | "not_found" | "invalid" | "unavailable" | "error";

export type BotStore = {
  /** Creates the row on first contact, refreshes it on every message after. */
  touchUser(input: {
    telegramId: number;
    chatId: number;
    firstName: string;
    username: string | null;
  }): Promise<BotUser & { created: boolean }>;
  setLanguage(telegramId: number, language: Lang): Promise<void>;
  setState(telegramId: number, state: BotState, data?: Record<string, unknown>): Promise<void>;
  markBlocked(telegramId: number): Promise<void>;
  /** False when this update_id has been handled before — the caller must stop. */
  claimUpdate(updateId: number): Promise<boolean>;
  recordLookup(input: {
    telegramId: number;
    kind: "fin" | "fan";
    hash: string;
    last4: string;
    outcome: LookupOutcome;
  }): Promise<void>;
  countLookupsSince(telegramId: number, minutes: number): Promise<number>;
  saveSupportMessage(input: {
    telegramId: number;
    language: Lang;
    body: string;
  }): Promise<{ id: string }>;
  markSupportForwarded(id: string): Promise<void>;

  // ---- points and purchases ----------------------------------------------
  getBalance(telegramId: number): Promise<number>;
  setOutput(telegramId: number, patch: Partial<OutputSettings>): Promise<void>;
  /**
   * Records a claimed payment, and credits it in the same transaction when it
   * arrives already approved.
   *
   * The two halves are inseparable on purpose: crediting in a second call means
   * a crash between them either pays twice or not at all, and the reference is
   * spent either way.
   */
  recordPurchase(input: PurchaseInput): Promise<PurchaseOutcome>;
  /** Approves or rejects a queued purchase. Idempotent — a second decision is ignored. */
  decidePurchase(input: {
    id: string;
    approve: boolean;
    adminId: number;
    points: number;
    note?: string;
  }): Promise<{ applied: boolean; telegramId: number; points: number; balance: number } | null>;
  pendingPurchases(limit?: number): Promise<PurchaseRow[]>;

  // ---- card jobs (uploaded documents) --------------------------------------
  /**
   * Spends points and creates the job in one transaction, so a job can never
   * exist without having been paid for, and points can never be taken without
   * a job to show for it.
   *
   * Throws SpendError when the balance will not cover it — the check
   * constraint on bot_users.points is what actually enforces this; the error
   * exists to give the caller a message to show rather than a raw SQLSTATE.
   */
  spendOnCardJob(input: {
    telegramId: number;
    source: "otp" | "upload_image" | "upload_pdf";
    downloadType: DownloadType;
    background: string;
    /** Null for an OTP job: nothing was uploaded, and the PDF is not retained. */
    telegramFileId: string | null;
    telegramFileUniqueId: string | null;
    points: number;
    /** OTP jobs arrive already fulfilled, so they are never 'pending'. */
    status?: "pending" | "delivered";
  }): Promise<{ id: string; balance: number }>;
  pendingCardJobs(limit?: number): Promise<CardJobRow[]>;
  getCardJob(id: string): Promise<CardJobRow | null>;
  /** Marks a job handled. Idempotent — a second call on an already-delivered job does nothing. */
  markCardJobDelivered(id: string): Promise<boolean>;

  // ---- OTP sessions ------------------------------------------------------
  /**
   * Opens a session for a code that is on its way to the holder's phone.
   *
   * The FAN goes in encrypted (see src/crypto.ts) because the verify call
   * needs it back; the hash and last four are what the audit trail keeps.
   */
  openOtpSession(input: {
    telegramId: number;
    slot: number;
    fanHash: string;
    fanLast4: string;
    fanSecret: string;
    providerRef: string;
  }): Promise<{ id: string }>;
  /** The newest session still awaiting a code, if it has not expired. */
  openOtpSessionFor(
    telegramId: number,
  ): Promise<{ id: string; slot: number; fanSecret: string | null; providerRef: string | null; attempts: number } | null>;
  /**
   * Closes a session, clearing the FAN and the provider handle with it — a
   * finished session should hold nothing worth stealing.
   */
  closeOtpSession(id: string, status: "verified" | "failed" | "expired"): Promise<void>;
  /** Records a wrong code. Returns the new count, so the caller can stop at a limit. */
  countOtpAttempt(id: string): Promise<number>;

  // ---- settings --------------------------------------------------------
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>, updatedBy: number): Promise<void>;

  // ---- portal admins -----------------------------------------------------
  /** True if telegramId is in the environment allow-list OR the grantable table. */
  isAdmin(telegramId: number, envAdminIds: number[]): Promise<boolean>;
  listGrantedAdmins(): Promise<{ telegramId: number; addedBy: number | null; createdAt: string }[]>;
  grantAdmin(telegramId: number, addedBy: number): Promise<void>;

  // ---- broadcast ---------------------------------------------------------
  /**
   * Every chat the bot can still reach: one row per user who has started it,
   * minus anyone Telegram has already told us is gone. Read once per broadcast
   * and then sent to in turn, so the sender can count what actually happened.
   */
  broadcastRecipients(): Promise<{ telegramId: number; chatId: number }[]>;

  // ---- user stats --------------------------------------------------------
  /** How many people have started the bot, and the points they hold between them. */
  userSummary(): Promise<{ users: number; points: number }>;
  /** Users and their balances, highest first, for the admin panel's list. */
  listUserPoints(limit?: number): Promise<UserPointRow[]>;
};

export class SpendError extends Error {}

export type CardJobRow = {
  id: string;
  telegram_id: string;
  first_name: string;
  username: string | null;
  source: string;
  download_type: string;
  background: string;
  status: string;
  points_spent: number;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  created_at: string;
  delivered_at: string | null;
};

export type Settings = {
  pointPriceEtb: number | null;
  cbeAccountName: string | null;
  cbeAccountNumber: string | null;
  telebirrAccountName: string | null;
  telebirrAccountNumber: string | null;
  /** Card API key set from the portal; null means fall back to CARD_API_KEY. */
  cardApiKey: string | null;
};

export type OutputSettings = {
  downloadType: DownloadType;
  background: string;
};

export type PurchaseInput = {
  telegramId: number;
  provider: "cbe" | "telebirr";
  reference: string;
  rawInput: string;
  amountEtb: number | null;
  points: number;
  /** 'approved' credits immediately; 'pending' queues it for a human. */
  status: "approved" | "pending";
  decidedBy: "auto" | "none";
  note?: string;
};

export type PurchaseOutcome =
  /** Credited or queued. `balance` is the balance after, unchanged when queued. */
  | { outcome: "created"; id: string; balance: number }
  /** This reference has been claimed before — by this person or anyone else. */
  | { outcome: "duplicate" };

export type PurchaseRow = {
  id: string;
  telegram_id: string;
  provider: string;
  reference: string;
  raw_input: string;
  amount_etb: string | null;
  points: number;
  status: string;
  created_at: string;
};

/** A user's balance, as the admin panel lists it. */
export type UserPointRow = {
  telegramId: number;
  firstName: string;
  username: string | null;
  points: number;
};

type UserRow = {
  telegram_id: string;
  chat_id: string;
  first_name: string;
  username: string | null;
  language: string | null;
  state: string;
  state_data: Record<string, unknown>;
  points: number;
  download_type: string;
  background: string;
  /** True only on the insert, when this was the very first contact. */
  created: boolean;
};

const STATES: BotState[] = [
  "idle",
  "awaiting_id",
  "awaiting_support",
  "awaiting_receipt",
  "awaiting_fan",
  "awaiting_otp",
  "awaiting_grant",
  "awaiting_post",
  "awaiting_upload",
];

function toUser(row: UserRow): BotUser {
  return {
    telegramId: Number(row.telegram_id),
    chatId: Number(row.chat_id),
    firstName: row.first_name,
    username: row.username,
    language: row.language === "am" || row.language === "en" ? row.language : null,
    state: STATES.includes(row.state as BotState) ? (row.state as BotState) : "idle",
    stateData: row.state_data ?? {},
    points: Number(row.points ?? 0),
    downloadType: DOWNLOAD_TYPES.includes(row.download_type as DownloadType)
      ? (row.download_type as DownloadType)
      : "pdf_mirror",
    background: row.background ?? "bg2",
  };
}

export const dbStore: BotStore = {
  async touchUser({ telegramId, chatId, firstName, username }) {
    return withDb(async (q) => {
      const row = await q.need<UserRow>(
        `insert into bot_users (telegram_id, chat_id, first_name, username)
         values ($1, $2, $3, $4)
         on conflict (telegram_id) do update
            set chat_id      = excluded.chat_id,
                first_name   = excluded.first_name,
                username     = excluded.username,
                -- They messaged us, so whatever made them unreachable is over.
                is_blocked   = false,
                last_seen_at = now()
         returning telegram_id, chat_id, first_name, username, language, state, state_data,
                   points, download_type, background, (xmax = 0) as created`,
        [String(telegramId), String(chatId), firstName, username],
      );
      return { ...toUser(row), created: row.created };
    });
  },

  async setLanguage(telegramId, language) {
    await withDb((q) =>
      q.run(`update bot_users set language = $2 where telegram_id = $1`, [
        String(telegramId),
        language,
      ]),
    );
  },

  async setState(telegramId, state, data = {}) {
    await withDb((q) =>
      q.run(`update bot_users set state = $2, state_data = $3 where telegram_id = $1`, [
        String(telegramId),
        state,
        JSON.stringify(data),
      ]),
    );
  },

  async markBlocked(telegramId) {
    await withDb((q) =>
      q.run(`update bot_users set is_blocked = true where telegram_id = $1`, [String(telegramId)]),
    );
  },

  async claimUpdate(updateId) {
    return withDb(async (q) => {
      // The insert is the lock: two concurrent deliveries of the same update
      // race here, and exactly one of them writes a row.
      const inserted = await q.run(
        `insert into bot_updates (update_id) values ($1) on conflict do nothing`,
        [String(updateId)],
      );
      return inserted > 0;
    });
  },

  async recordLookup({ telegramId, kind, hash, last4, outcome }) {
    await withDb((q) =>
      q.run(
        `insert into bot_lookups (telegram_id, id_kind, id_hash, id_last4, outcome)
         values ($1, $2, $3, $4, $5)`,
        [String(telegramId), kind, hash, last4, outcome],
      ),
    );
  },

  async countLookupsSince(telegramId, minutes) {
    return withDb(async (q) => {
      const count = await q.value<string>(
        `select count(*) from bot_lookups
          where telegram_id = $1
            and created_at > now() - make_interval(mins => $2)`,
        [String(telegramId), minutes],
      );
      return Number(count ?? 0);
    });
  },

  async saveSupportMessage({ telegramId, language, body }) {
    return withDb((q) =>
      q.need<{ id: string }>(
        `insert into bot_support_messages (telegram_id, language, body)
         values ($1, $2, $3) returning id`,
        [String(telegramId), language, body],
      ),
    );
  },

  async markSupportForwarded(id) {
    await withDb((q) =>
      q.run(`update bot_support_messages set forwarded = true where id = $1`, [id]),
    );
  },

  // ---- points and purchases ------------------------------------------------

  async getBalance(telegramId) {
    return withDb(async (q) => {
      const points = await q.value<number>(
        `select points from bot_users where telegram_id = $1`,
        [String(telegramId)],
      );
      return Number(points ?? 0);
    });
  },

  async setOutput(telegramId, patch) {
    const sets: string[] = [];
    const params: unknown[] = [String(telegramId)];
    if (patch.downloadType !== undefined) {
      params.push(patch.downloadType);
      sets.push(`download_type = $${params.length}`);
    }
    if (patch.background !== undefined) {
      params.push(patch.background);
      sets.push(`background = $${params.length}`);
    }
    if (sets.length === 0) return;
    await withDb((q) =>
      q.run(`update bot_users set ${sets.join(", ")} where telegram_id = $1`, params),
    );
  },

  async recordPurchase(input) {
    return withDb(async (q) => {
      // `on conflict do nothing` against the unique (provider, upper(reference))
      // index is the whole double-spend defence: two people sending the same
      // receipt at the same moment both reach here, and Postgres decides which
      // one wrote it. No read-then-write, so there is no window between them.
      const row = await q.one<{ id: string }>(
        `insert into point_purchases
           (telegram_id, provider, reference, raw_input, amount_etb, points, status, decided_by,
            note, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 case when $7 = 'approved' then now() else null end)
         on conflict do nothing
         returning id`,
        [
          String(input.telegramId),
          input.provider,
          input.reference,
          input.rawInput,
          input.amountEtb,
          input.points,
          input.status,
          input.decidedBy,
          input.note ?? null,
        ],
      );
      if (!row) return { outcome: "duplicate" as const };

      if (input.status !== "approved" || input.points <= 0) {
        const balance = await q.value<number>(
          `select points from bot_users where telegram_id = $1`,
          [String(input.telegramId)],
        );
        return { outcome: "created" as const, id: row.id, balance: Number(balance ?? 0) };
      }

      const balance = await creditPoints(q, {
        telegramId: input.telegramId,
        delta: input.points,
        reason: "purchase",
        refId: row.id,
      });
      return { outcome: "created" as const, id: row.id, balance };
    });
  },

  async decidePurchase({ id, approve, adminId, points, note }) {
    return withDb(async (q) => {
      // Only a purchase still pending can be decided. Two admins tapping
      // approve on the same forwarded message would otherwise credit twice.
      const row = await q.one<{ telegram_id: string }>(
        `update point_purchases
            set status     = $2,
                points     = $3,
                decided_by = 'admin',
                admin_id   = $4,
                note       = coalesce($5, note),
                decided_at = now()
          where id = $1 and status = 'pending'
          returning telegram_id`,
        [id, approve ? "approved" : "rejected", approve ? points : 0, String(adminId), note ?? null],
      );
      if (!row) return null;

      const telegramId = Number(row.telegram_id);
      if (!approve || points <= 0) {
        const balance = await q.value<number>(
          `select points from bot_users where telegram_id = $1`,
          [row.telegram_id],
        );
        return { applied: true, telegramId, points: 0, balance: Number(balance ?? 0) };
      }

      const balance = await creditPoints(q, {
        telegramId,
        delta: points,
        reason: "purchase",
        refId: id,
      });
      return { applied: true, telegramId, points, balance };
    });
  },

  async pendingPurchases(limit = 20) {
    return withDb((q) =>
      q.all<PurchaseRow>(
        `select id, telegram_id, provider, reference, raw_input, amount_etb, points, status,
                created_at
           from point_purchases
          where status = 'pending'
          order by created_at desc
          limit $1`,
        [limit],
      ),
    );
  },

  // ---- card jobs -----------------------------------------------------------

  async spendOnCardJob({
    telegramId,
    source,
    downloadType,
    background,
    telegramFileId,
    telegramFileUniqueId,
    points,
    status = "pending",
  }) {
    return withDb(async (q) => {
      // Created before the spend, so the debit's ledger entry can reference it
      // directly — no row is ever left pointing at a job that does not exist,
      // and no job is ever left without a ledger entry explaining its cost.
      const job = await q.need<{ id: string }>(
        `insert into card_jobs
           (telegram_id, source, download_type, background, telegram_file_id,
            telegram_file_unique_id, points_spent, status, delivered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 case when $8 = 'delivered' then now() else null end)
         returning id`,
        [
          String(telegramId),
          source,
          downloadType,
          background,
          telegramFileId,
          telegramFileUniqueId,
          points,
          status,
        ],
      );

      let balance: number;
      try {
        balance = await creditPoints(q, { telegramId, delta: -points, reason: "print", refId: job.id });
      } catch (error) {
        // 23514 is the check constraint on bot_users.points >= 0 — the only
        // way this insert can fail, so it is unambiguous. The job insert above
        // rolls back with it; nothing is left half-done.
        if (error && typeof error === "object" && "code" in error && error.code === "23514") {
          throw new SpendError("Not enough points.");
        }
        throw error;
      }
      return { id: job.id, balance };
    });
  },

  // ---- OTP sessions --------------------------------------------------------

  async openOtpSession({ telegramId, slot, fanHash, fanLast4, fanSecret, providerRef }) {
    return withDb((q) =>
      q.need<{ id: string }>(
        `insert into otp_sessions
           (telegram_id, slot, fan_hash, fan_last4, fan_secret, provider_ref)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [String(telegramId), slot, fanHash, fanLast4, fanSecret, providerRef],
      ),
    );
  },

  async openOtpSessionFor(telegramId) {
    const row = await withDb((q) =>
      q.one<{
        id: string;
        slot: number;
        fan_secret: string | null;
        provider_ref: string | null;
        attempts: number;
      }>(
        `select id, slot, fan_secret, provider_ref, attempts
           from otp_sessions
          where telegram_id = $1
            and status = 'awaiting_code'
            and expires_at > now()
          order by created_at desc
          limit 1`,
        [String(telegramId)],
      ),
    );
    return row
      ? {
          id: row.id,
          slot: row.slot,
          fanSecret: row.fan_secret,
          providerRef: row.provider_ref,
          attempts: row.attempts,
        }
      : null;
  },

  async closeOtpSession(id, status) {
    await withDb((q) =>
      q.run(
        // The secrets go with the status change, in the same statement: a
        // finished session that still holds a FAN is the thing this is for.
        `update otp_sessions
            set status = $2, fan_secret = null, provider_ref = null
          where id = $1`,
        [id, status],
      ),
    );
  },

  async countOtpAttempt(id) {
    const row = await withDb((q) =>
      q.one<{ attempts: number }>(
        `update otp_sessions set attempts = attempts + 1 where id = $1 returning attempts`,
        [id],
      ),
    );
    return row?.attempts ?? 0;
  },

  async pendingCardJobs(limit = 20) {
    return withDb((q) =>
      q.all<CardJobRow>(
        `select j.id, j.telegram_id, u.first_name, u.username, j.source, j.download_type,
                j.background, j.status, j.points_spent, j.telegram_file_id,
                j.telegram_file_unique_id, j.created_at, j.delivered_at
           from card_jobs j
           join bot_users u on u.telegram_id = j.telegram_id
          where j.status = 'pending'
          order by j.created_at desc
          limit $1`,
        [limit],
      ),
    );
  },

  async getCardJob(id) {
    return withDb((q) =>
      q.one<CardJobRow>(
        `select j.id, j.telegram_id, u.first_name, u.username, j.source, j.download_type,
                j.background, j.status, j.points_spent, j.telegram_file_id,
                j.telegram_file_unique_id, j.created_at, j.delivered_at
           from card_jobs j
           join bot_users u on u.telegram_id = j.telegram_id
          where j.id = $1`,
        [id],
      ),
    );
  },

  async markCardJobDelivered(id) {
    return withDb(async (q) => {
      const updated = await q.run(
        `update card_jobs set status = 'delivered', delivered_at = now()
          where id = $1 and status = 'pending'`,
        [id],
      );
      return updated > 0;
    });
  },

  // ---- settings --------------------------------------------------------

  async getSettings() {
    return withDb(async (q) => {
      const row = await q.need<{
        point_price_etb: string | null;
        cbe_account_name: string | null;
        cbe_account_number: string | null;
        telebirr_account_name: string | null;
        telebirr_account_number: string | null;
        card_api_key: string | null;
      }>(
        `select point_price_etb, cbe_account_name, cbe_account_number,
                telebirr_account_name, telebirr_account_number, card_api_key
           from app_settings where id = true`,
      );
      return {
        pointPriceEtb: row.point_price_etb === null ? null : Number(row.point_price_etb),
        cbeAccountName: row.cbe_account_name,
        cbeAccountNumber: row.cbe_account_number,
        telebirrAccountName: row.telebirr_account_name,
        telebirrAccountNumber: row.telebirr_account_number,
        cardApiKey: row.card_api_key,
      };
    });
  },

  async updateSettings(patch, updatedBy) {
    const columns: Record<string, string> = {
      pointPriceEtb: "point_price_etb",
      cbeAccountName: "cbe_account_name",
      cbeAccountNumber: "cbe_account_number",
      telebirrAccountName: "telebirr_account_name",
      telebirrAccountNumber: "telebirr_account_number",
      cardApiKey: "card_api_key",
    };
    const set = buildUpdate(
      Object.fromEntries(
        Object.entries(patch)
          .filter(([key]) => key in columns)
          .map(([key, value]) => [columns[key as keyof typeof columns], value]),
      ),
      2,
    );
    if (!set) return;
    await withDb((q) =>
      q.run(
        `update app_settings set ${set.clause}, updated_at = now(), updated_by = $1 where id = true`,
        [String(updatedBy), ...set.params],
      ),
    );
  },

  // ---- portal admins ---------------------------------------------------

  async isAdmin(telegramId, envAdminIds) {
    if (envAdminIds.includes(telegramId)) return true;
    return withDb(async (q) => {
      const found = await q.one(`select 1 from bot_admins where telegram_id = $1`, [
        String(telegramId),
      ]);
      return found !== null;
    });
  },

  async listGrantedAdmins() {
    return withDb(async (q) => {
      const rows = await q.all<{ telegram_id: string; added_by: string | null; created_at: string }>(
        `select telegram_id, added_by, created_at from bot_admins order by created_at desc`,
      );
      return rows.map((row) => ({
        telegramId: Number(row.telegram_id),
        addedBy: row.added_by === null ? null : Number(row.added_by),
        createdAt: row.created_at,
      }));
    });
  },

  async grantAdmin(telegramId, addedBy) {
    await withDb((q) =>
      q.run(
        `insert into bot_admins (telegram_id, added_by) values ($1, $2)
         on conflict (telegram_id) do nothing`,
        [String(telegramId), String(addedBy)],
      ),
    );
  },

  // ---- broadcast -------------------------------------------------------

  async broadcastRecipients() {
    return withDb(async (q) => {
      const rows = await q.all<{ telegram_id: string; chat_id: string }>(
        `select telegram_id, chat_id from bot_users where is_blocked = false`,
      );
      return rows.map((row) => ({
        telegramId: Number(row.telegram_id),
        chatId: Number(row.chat_id),
      }));
    });
  },

  // ---- user stats ------------------------------------------------------

  async userSummary() {
    return withDb(async (q) => {
      // count and sum both come back as strings: Postgres widens them to
      // bigint, and the driver will not narrow that to a JS number for us.
      const row = await q.one<{ users: string; points: string | null }>(
        `select count(*)::text as users, coalesce(sum(points), 0)::text as points
           from bot_users`,
      );
      return {
        users: Number(row?.users ?? 0),
        points: Number(row?.points ?? 0),
      };
    });
  },

  async listUserPoints(limit = 20) {
    return withDb(async (q) => {
      const rows = await q.all<{
        telegram_id: string;
        first_name: string;
        username: string | null;
        points: number;
      }>(
        `select telegram_id, first_name, username, points
           from bot_users
          order by points desc, created_at asc
          limit $1`,
        [limit],
      );
      return rows.map((row) => ({
        telegramId: Number(row.telegram_id),
        firstName: row.first_name,
        username: row.username,
        points: row.points,
      }));
    });
  },
};

/**
 * `buildUpdate` builds `set a = $2, b = $3` from a patch object, skipping
 * undefined keys, starting parameter numbering at `startIndex`. Small enough
 * to keep local rather than pull in a query builder for one call site.
 */
function buildUpdate(
  patch: Record<string, unknown>,
  startIndex: number,
): { clause: string; params: unknown[] } | null {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  const clause = entries.map(([column], i) => `${column} = $${startIndex + i}`).join(", ");
  return { clause, params: entries.map(([, value]) => value) };
}

/**
 * Moves points and writes the ledger entry that explains the move, returning
 * the new balance.
 *
 * Runs inside the caller's transaction — never on its own — so the balance and
 * its explanation are written together or not at all.
 */
async function creditPoints(
  q: Querier,
  input: { telegramId: number; delta: number; reason: string; refId: string | null },
): Promise<number> {
  const balance = await q.need<{ points: number }>(
    `update bot_users set points = points + $2 where telegram_id = $1 returning points`,
    [String(input.telegramId), input.delta],
  );
  await q.run(
    `insert into point_ledger (telegram_id, delta, reason, ref_id, balance_after)
     values ($1, $2, $3, $4, $5)`,
    [String(input.telegramId), input.delta, input.reason, input.refId, balance.points],
  );
  return balance.points;
}
