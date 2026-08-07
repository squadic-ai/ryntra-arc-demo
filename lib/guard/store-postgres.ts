import { Pool, type PoolConfig } from "pg";

import {
  GUARD_COLLECTIONS,
  type GuardCollection,
  type GuardCollectionName,
  type GuardStore,
} from "./store.ts";

/**
 * Postgres adapter — the first store that is safe for concurrent writers.
 *
 * It is deliberately provider-neutral. Any Postgres reachable over
 * `DATABASE_URL` works: a managed database from a platform marketplace, Neon,
 * Supabase, or one you run yourself. Nothing here names a vendor, because
 * binding the settlement-evidence store to one hosting company would be a
 * strange thing for a provider-neutral evidence layer to do.
 *
 * One table, keyed by (collection, key), holding the same JSON objects the
 * other adapters hold. At prototype volume a relational schema per object type
 * would buy nothing and would fix the shape of contracts that are still
 * PROVISIONAL; a key-value table keeps the kernel the single authority on what
 * an object means.
 *
 * The reason this adapter exists at all is `insertIfAbsent`. Read-then-write
 * cannot claim an idempotency key or a transaction hash across two instances —
 * both readers see the key free. `INSERT … ON CONFLICT DO NOTHING` decides that
 * race inside the database, once, for every writer.
 */

const TABLE = "guard_objects";

export type PostgresGuardStoreOptions = {
  connectionString: string;
  /** Overrides for tests or an operator with unusual pool requirements. */
  poolConfig?: Omit<PoolConfig, "connectionString">;
};

function isLocalConnection(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function createPostgresGuardStore(options: PostgresGuardStoreOptions): GuardStore {
  const { connectionString } = options;
  if (!connectionString.trim()) {
    throw new Error("A Postgres Guard store requires a non-empty connection string.");
  }

  const pool = new Pool({
    /* TLS is verified against the system trust store, which every managed
       Postgres provider's certificate chains to. Turning verification off is
       the usual shortcut here and it is the wrong one: this connection carries
       the authorization and settlement record, so an unverified peer would let
       an attacker on the path read and rewrite the evidence this whole system
       exists to preserve. A local database speaks plaintext and gets no TLS
       config at all — demanding it there breaks development for no gain. */
    ssl: isLocalConnection(connectionString) ? undefined : true,
    connectionString,
    /* `ssl: true` above is set explicitly rather than left to the connection
       string. Managed providers append `sslmode=require`, which pg 8 currently
       treats as full verification — but pg 9 will change that alias to libpq
       semantics, where `require` encrypts without verifying the peer. Passing
       the flag here keeps verification on through that change instead of
       silently weakening the connection that carries the authorization and
       settlement record. */
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...options.poolConfig,
  });

  /* One migration, run once per process and awaited by every caller that races
     it. A store that silently served reads before its table existed would fail
     as "no rows" — indistinguishable from a genuinely absent lifecycle, which
     is the one error this system must never fake. */
  let ready: Promise<void> | null = null;
  function ensureReady(): Promise<void> {
    ready ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
           collection text NOT NULL,
           key        text NOT NULL,
           value      jsonb NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (collection, key)
         )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        /* Clear the memo so a transient failure at startup does not poison the
           process for its whole life. */
        ready = null;
        throw error;
      });
    return ready;
  }

  function collection<T>(name: GuardCollectionName): GuardCollection<T> {
    return {
      async get(key) {
        await ensureReady();
        const result = await pool.query<{ value: T }>(
          `SELECT value FROM ${TABLE} WHERE collection = $1 AND key = $2`,
          [name, key],
        );
        return result.rows[0]?.value;
      },

      async set(key, value) {
        await ensureReady();
        await pool.query(
          `INSERT INTO ${TABLE} (collection, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (collection, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [name, key, JSON.stringify(value)],
        );
      },

      async insertIfAbsent(key, value) {
        await ensureReady();
        const result = await pool.query(
          `INSERT INTO ${TABLE} (collection, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (collection, key) DO NOTHING`,
          [name, key, JSON.stringify(value)],
        );
        return (result.rowCount ?? 0) === 1;
      },

      async delete(key) {
        await ensureReady();
        await pool.query(`DELETE FROM ${TABLE} WHERE collection = $1 AND key = $2`, [name, key]);
      },

      async has(key) {
        await ensureReady();
        const result = await pool.query(
          `SELECT 1 FROM ${TABLE} WHERE collection = $1 AND key = $2`,
          [name, key],
        );
        return (result.rowCount ?? 0) > 0;
      },

      async valuesWithPrefix(keyPrefix) {
        await ensureReady();
        /* `like_escape` keeps a tenant id containing % or _ from widening the
           scan into another tenant's rows. Ordering by insertion keeps
           "latest wins" readers deterministic across instances. */
        const result = await pool.query<{ value: T }>(
          `SELECT value FROM ${TABLE}
           WHERE collection = $1 AND key LIKE $2 ESCAPE '\\'
           ORDER BY created_at, key`,
          [name, `${keyPrefix.replace(/[\\%_]/g, "\\$&")}%`],
        );
        return result.rows.map((row) => row.value);
      },
    };
  }

  return {
    durability: "DURABLE_MULTI_WRITER",
    description: "Postgres (shared table, safe for concurrent instances)",
    collection,
    async close() {
      await pool.end();
    },
  };
}

/** Every collection name, exported so a migration or an audit can enumerate them. */
export const POSTGRES_GUARD_COLLECTIONS = GUARD_COLLECTIONS;
