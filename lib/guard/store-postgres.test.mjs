// Run from repo root: node --test lib/guard/store-postgres.test.mjs
//
// The behavioural tests here need a real Postgres and are skipped without one.
// Set DATABASE_URL (or POSTGRES_URL) to a throwaway database and they run:
//
//   DATABASE_URL=postgresql://... node --test lib/guard/store-postgres.test.mjs
//
// They are skipped rather than mocked on purpose. The whole value of this
// adapter is a guarantee the database makes — ON CONFLICT DO NOTHING deciding a
// race — and a mock would assert that the code calls the query it was written
// to call, which proves nothing about whether the guarantee holds.
import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresGuardStore } from "./store-postgres.ts";
import { storeSupportsConcurrentInstances, storeSurvivesColdStart } from "./store.ts";

const connectionString = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
const live = Boolean(connectionString);

test("the adapter refuses an empty connection string instead of degrading", () => {
  assert.throws(() => createPostgresGuardStore({ connectionString: "   " }), /connection string/i);
});

test("the adapter declares the only durability that satisfies a multi-instance deployment", () => {
  /* Constructing a pool performs no I/O, so this holds without a database.
     The declaration is what the write gate reads, so it is worth pinning. */
  const store = createPostgresGuardStore({ connectionString: "postgresql://user@localhost/none" });
  assert.equal(store.durability, "DURABLE_MULTI_WRITER");
  assert.equal(storeSurvivesColdStart(store), true);
  assert.equal(storeSupportsConcurrentInstances(store), true);
  return store.close?.();
});

test(
  "a live database round-trips every collection operation",
  { skip: live ? false : "set DATABASE_URL to run the live Postgres tests" },
  async () => {
    const store = createPostgresGuardStore({ connectionString });
    const tenant = `tenant_${Date.now().toString(36)}`;
    try {
      const intents = store.collection("intents");
      await intents.set(`${tenant}:int_1`, { id: "int_1", revision: 1 });

      assert.deepEqual(await intents.get(`${tenant}:int_1`), { id: "int_1", revision: 1 });
      assert.equal(await intents.has(`${tenant}:int_1`), true);
      assert.equal(await intents.has(`${tenant}:missing`), false);
      assert.equal(await intents.get(`${tenant}:missing`), undefined);

      // set is an upsert; the second write wins.
      await intents.set(`${tenant}:int_1`, { id: "int_1", revision: 2 });
      assert.deepEqual(await intents.get(`${tenant}:int_1`), { id: "int_1", revision: 2 });

      await intents.delete(`${tenant}:int_1`);
      assert.equal(await intents.has(`${tenant}:int_1`), false);
    } finally {
      await store.close?.();
    }
  },
);

test(
  "concurrent claims of one key resolve to exactly one winner",
  { skip: live ? false : "set DATABASE_URL to run the live Postgres tests" },
  async () => {
    /* This is the guarantee the adapter exists for. Twenty simultaneous claims
       of one transaction hash must produce one true and nineteen false, and the
       stored value must be the winner's — not the last writer's. Read-then-write
       would produce twenty trues here, which is how one authorized broadcast
       becomes twenty recorded executions. */
    const store = createPostgresGuardStore({ connectionString });
    const tenant = `tenant_${Date.now().toString(36)}_race`;
    const key = `${tenant}:eip155:5042002:0xabc`;
    try {
      const index = store.collection("transactionIndex");
      const claims = await Promise.all(
        Array.from({ length: 20 }, (_, i) => index.insertIfAbsent(key, `int_${i}`)),
      );
      assert.equal(claims.filter(Boolean).length, 1);

      const winnerIndex = claims.indexOf(true);
      assert.equal(await index.get(key), `int_${winnerIndex}`);
    } finally {
      await store.close?.();
    }
  },
);

test(
  "two independent store instances share state, which is what multi-writer means",
  { skip: live ? false : "set DATABASE_URL to run the live Postgres tests" },
  async () => {
    /* Two instances with no shared process memory — the same situation as two
       serverless functions serving consecutive requests from one caller. */
    const first = createPostgresGuardStore({ connectionString });
    const second = createPostgresGuardStore({ connectionString });
    const tenant = `tenant_${Date.now().toString(36)}_shared`;
    try {
      await first.collection("intents").set(`${tenant}:int_1`, { id: "int_1" });
      assert.deepEqual(await second.collection("intents").get(`${tenant}:int_1`), { id: "int_1" });

      // And a claim made on one instance is honoured on the other.
      assert.equal(
        await second.collection("intents").insertIfAbsent(`${tenant}:int_1`, { id: "other" }),
        false,
      );
    } finally {
      await first.close?.();
      await second.close?.();
    }
  },
);

test(
  "a prefix scan never crosses a tenant boundary, even with SQL wildcards in the id",
  { skip: live ? false : "set DATABASE_URL to run the live Postgres tests" },
  async () => {
    /* `%` and `_` are wildcards in LIKE. An unescaped tenant id containing one
       would silently widen the scan into other tenants' rows — a tenancy
       breach that reads as a working query. */
    const store = createPostgresGuardStore({ connectionString });
    const stamp = Date.now().toString(36);
    try {
      const intents = store.collection("intents");
      await intents.set(`t${stamp}a:int_1`, { id: "int_1" });
      await intents.set(`t${stamp}b:int_2`, { id: "int_2" });

      // `_` matches any single character, so this prefix would match both rows
      // if the adapter did not escape it.
      assert.deepEqual(await intents.valuesWithPrefix(`t${stamp}_:`), []);
      assert.deepEqual(await intents.valuesWithPrefix(`t${stamp}a:`), [{ id: "int_1" }]);
    } finally {
      await store.close?.();
    }
  },
);
