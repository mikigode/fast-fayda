import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

/**
 * Postgres access, and the migration runner.
 *
 * Much simpler than the multi-tenant original this was extracted from: there
 * are no tenants here, no row-level security and no role switching, because the
 * bot is the only thing that uses this database. One pool, one role, and every
 * query goes through `withDb`.
 */

/**
 * TLS for the database connection, following libpq's `sslmode`.
 *
 * The rules are Postgres's, not ours, because a connection string that works
 * with psql should work here:
 *
 *   disable                  no TLS at all
 *   require / prefer / allow encrypt, do not verify the certificate
 *   verify-ca / verify-full  encrypt and verify
 *   (unspecified)            encrypt and verify
 *
 * Verification is the default, and DATABASE_CA_CERT supplies a private CA where
 * one is needed — that is the setting to reach for, and it is strictly better
 * than the alternative.
 *
 * But `require` has to mean what it means everywhere else. Managed providers
 * routinely present certificates that Node's bundled roots do not chain to —
 * Supabase's pooler among them — and refusing to honour the standard setting
 * left `sslmode=require` failing here while working in every other client,
 * with no remedy short of downloading a certificate. Encrypted-without-verified
 * is weaker than verified: it stops eavesdropping but not an attacker who can
 * already redirect the connection. It is opted into by name, per connection.
 */
function sslConfig(url: string) {
  const mode = /[?&]sslmode=([a-z-]+)/.exec(url)?.[1];
  if (mode === "disable") return false;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  if (mode === "require" || mode === "prefer" || mode === "allow") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

/**
 * Removes sslmode before the string reaches `pg`.
 *
 * pg parses ssl-related query parameters out of the connection string itself,
 * and when it finds one it resolves its own `ssl` to `{}` — full verification
 * — discarding whatever was passed as the separate `ssl` option entirely, no
 * matter what it was. Two sources of truth for the same setting, and the
 * library's own parsing wins. That is why `sslConfig` above had no effect
 * while `sslmode` stayed in the string: the object it returned was computed
 * correctly and then silently thrown away.
 *
 * Confirmed by inspecting what pg resolves `connectionParameters.ssl` to, with
 * and without sslmode present, given the identical explicit `ssl` option in
 * both cases.
 */
function stripSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url;
  }
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      // sslConfig reads sslmode from the *original* URL; stripSslMode then
      // removes it so pg's own parsing cannot override that decision.
      connectionString: stripSslMode(env.databaseUrl),
      ssl: sslConfig(env.databaseUrl),
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (error) => {
      // An idle client erroring must not take the process down.
      console.error("pg pool error:", error.message);
    });
  }
  return pool;
}

export type Querier = {
  all: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<T | null>;
  need: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<T>;
  run: (sql: string, params?: unknown[]) => Promise<number>;
  value: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
};

function querier(client: PoolClient): Querier {
  return {
    async all(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      return result.rows as never;
    },
    async one(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      return (result.rows[0] ?? null) as never;
    },
    async need(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      if (result.rows.length === 0) throw new Error("Record not found.");
      return result.rows[0] as never;
    },
    async run(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      return result.rowCount ?? 0;
    },
    async value(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as Record<string, unknown>;
      return (Object.values(row)[0] ?? null) as never;
    },
  };
}

/** Runs `fn` inside a transaction; a thrown error rolls the whole thing back. */
export async function withDb<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(querier(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Applies any migration not already recorded, in filename order, each in its
 * own transaction.
 *
 * Run once at startup rather than as a deploy step: this is a single long-lived
 * process, so there is no fleet of instances to race, and a container that
 * starts is a container with the right schema.
 *
 * The advisory lock covers the case that does race — two containers rolling at
 * once. Whoever gets the lock migrates; the other waits and then finds nothing
 * to do.
 */
const LOCK_KEY = 0x5fada_01;

export async function migrate(dir = join(__dirname, "..", "migrations")): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query(
      `create table if not exists schema_migrations (
         name       text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    // The whole run is one transaction, and the lock is transaction-scoped.
    //
    // Both of those are for the benefit of connection poolers. Supabase's
    // Supavisor — and PgBouncer in transaction mode — hand a different backend
    // to each transaction, so a session-scoped `pg_advisory_lock` taken outside
    // one can be released against a connection that never held it, and the next
    // statement can land somewhere that has not got it at all. A transaction
    // lock is held exactly as long as the transaction that took it, wherever
    // that transaction is running, and is released by the commit.
    //
    // Making it one transaction also means a half-applied schema is not a state
    // this can end in: migration three failing takes one and two with it, and
    // the next boot starts from a database that matches its recorded version.
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);

    // Read *inside* the lock. Whoever waited gets the list as it is after the
    // other one finished, and finds nothing left to do.
    const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
    const done = new Set(rows.map((row) => row.name));

    try {
      for (const name of files) {
        if (done.has(name)) continue;
        const sql = readFileSync(join(dir, name), "utf8");
        try {
          await client.query(sql);
          await client.query("insert into schema_migrations (name) values ($1)", [name]);
          applied.push(name);
        } catch (error) {
          throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
  return applied;
}
