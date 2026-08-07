// Run from repo root: node --test lib/guard/store.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileGuardStore,
  createMemoryGuardStore,
  guardStoreLimitations,
  storeSupportsConcurrentInstances,
  storeSurvivesColdStart,
} from "./store.ts";
import {
  resolveGuardDeployment,
  resolveGuardStore,
  resolveGuardWriteGate,
} from "./runtime.ts";
import { createGuardService, GuardError } from "./service.ts";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "ryntra-guard-store-"));
}

test("each adapter declares its own durability and reports it verbatim", () => {
  const memory = createMemoryGuardStore();
  assert.equal(memory.durability, "EPHEMERAL_SINGLE_INSTANCE");
  assert.equal(storeSurvivesColdStart(memory), false);
  assert.equal(storeSupportsConcurrentInstances(memory), false);
  assert.deepEqual(guardStoreLimitations(memory), ["EPHEMERAL_SINGLE_INSTANCE_STORE"]);

  const directory = temporaryDirectory();
  try {
    const file = createFileGuardStore({ directory });
    assert.equal(file.durability, "DURABLE_SINGLE_WRITER");
    assert.equal(storeSurvivesColdStart(file), true);
    // The honest half: durable is not the same as safe behind several
    // instances, and this adapter must never claim the stronger property.
    assert.equal(storeSupportsConcurrentInstances(file), false);
    assert.deepEqual(guardStoreLimitations(file), ["DURABLE_SINGLE_WRITER_STORE"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the file adapter survives a cold start and keeps collections separate", async () => {
  const directory = temporaryDirectory();
  try {
    const first = createFileGuardStore({ directory });
    await first.collection("intents").set("tenant-a:int_1", { id: "int_1", revision: 1 });
    await first.collection("transactionIndex").set("tenant-a:chain:0xabc", "int_1");

    // A brand new adapter over the same directory is exactly what a cold start
    // looks like: no shared process memory, only what reached disk.
    const second = createFileGuardStore({ directory });
    assert.deepEqual(await second.collection("intents").get("tenant-a:int_1"), { id: "int_1", revision: 1 });
    assert.equal(await second.collection("transactionIndex").get("tenant-a:chain:0xabc"), "int_1");
    assert.equal(await second.collection("receipts").has("tenant-a:int_1"), false);
    assert.deepEqual(await second.collection("intents").valuesWithPrefix("tenant-a:"), [
      { id: "int_1", revision: 1 },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory adapter loses state across instances, which is why it is labelled ephemeral", async () => {
  const first = createMemoryGuardStore();
  await first.collection("intents").set("tenant-a:int_1", { id: "int_1" });
  const second = createMemoryGuardStore();
  assert.equal(await second.collection("intents").has("tenant-a:int_1"), false);
});

test("a prefix scan cannot read another tenant's rows", async () => {
  /* Every adapter shares one namespace per collection, so the key prefix is a
     tenancy boundary rather than a convenience. A tenant id containing SQL
     wildcards must not widen the scan — hence the escaping in the Postgres
     adapter and this test standing over the shape all adapters promise. */
  for (const store of [createMemoryGuardStore(), null]) {
    const directory = store ? null : temporaryDirectory();
    const subject = store ?? createFileGuardStore({ directory });
    try {
      const intents = subject.collection("intents");
      await intents.set("tenant-a:int_1", { id: "int_1" });
      await intents.set("tenant-b:int_2", { id: "int_2" });
      await intents.set("tenant-a%:int_3", { id: "int_3" });

      assert.deepEqual(await intents.valuesWithPrefix("tenant-b:"), [{ id: "int_2" }]);
      const tenantA = await intents.valuesWithPrefix("tenant-a:");
      assert.deepEqual(tenantA, [{ id: "int_1" }]);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("insertIfAbsent claims a key exactly once and never overwrites the winner", async () => {
  /* This is the one operation that cannot be composed from get and set.
     Read-then-write is a race: two callers both see the key free and both
     write, which is how one authorization becomes two recorded broadcasts. */
  const directory = temporaryDirectory();
  try {
    for (const subject of [createMemoryGuardStore(), createFileGuardStore({ directory })]) {
      const index = subject.collection("transactionIndex");
      assert.equal(await index.insertIfAbsent("tenant-a:chain:0xabc", "int_1"), true);
      assert.equal(await index.insertIfAbsent("tenant-a:chain:0xabc", "int_2"), false);
      // The loser's value was not written — the first claim still stands.
      assert.equal(await index.get("tenant-a:chain:0xabc"), "int_1");

      // Releasing a claim makes the key available again, which is what lets a
      // failed operation be retried instead of burning its key forever.
      await index.delete("tenant-a:chain:0xabc");
      assert.equal(await index.has("tenant-a:chain:0xabc"), false);
      assert.equal(await index.insertIfAbsent("tenant-a:chain:0xabc", "int_2"), true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store selection never falls back to memory when a durable store was requested", () => {
  assert.equal(resolveGuardStore({}).durability, "EPHEMERAL_SINGLE_INSTANCE");
  assert.equal(resolveGuardStore({ RYNTRA_GUARD_STORE: "memory" }).durability, "EPHEMERAL_SINGLE_INSTANCE");
  // A misconfigured durable store is an error, not a silent downgrade: that
  // downgrade is precisely the failure this packet must not ship.
  assert.throws(
    () => resolveGuardStore({ RYNTRA_GUARD_STORE: "file" }),
    /RYNTRA_GUARD_STORE_DIR/,
  );
  // The same rule for the multi-writer adapter: naming it without a connection
  // string is a startup error, never a quiet downgrade to something weaker.
  assert.throws(
    () => resolveGuardStore({ RYNTRA_GUARD_STORE: "postgres" }),
    /DATABASE_URL/,
  );

  const directory = temporaryDirectory();
  try {
    const store = resolveGuardStore({ RYNTRA_GUARD_STORE: "file", RYNTRA_GUARD_STORE_DIR: directory });
    assert.equal(store.durability, "DURABLE_SINGLE_WRITER");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment shape defaults to the safe assumption", () => {
  assert.equal(resolveGuardDeployment({}), "SINGLE_INSTANCE");
  assert.equal(resolveGuardDeployment({ VERCEL: "1" }), "MULTI_INSTANCE");
  assert.equal(resolveGuardDeployment({ RYNTRA_GUARD_DEPLOYMENT: "multi-instance" }), "MULTI_INSTANCE");
  assert.equal(
    resolveGuardDeployment({ VERCEL: "1", RYNTRA_GUARD_DEPLOYMENT: "single-instance" }),
    "SINGLE_INSTANCE",
  );
});

test("a multi-instance deployment refuses writes until a multi-writer store exists", () => {
  const memory = createMemoryGuardStore();
  assert.deepEqual(resolveGuardWriteGate(memory, "SINGLE_INSTANCE"), { allowed: true });

  const blockedMemory = resolveGuardWriteGate(memory, "MULTI_INSTANCE");
  assert.equal(blockedMemory.allowed, false);
  assert.match(blockedMemory.reason, /per-process memory/i);
  assert.equal(blockedMemory.requiredAction, "CONFIGURE_DURABLE_MULTI_WRITER_GUARD_STORE");

  const directory = temporaryDirectory();
  try {
    // Durable-for-one-writer is still refused behind several instances. Cold
    // start survival alone does not make concurrent writers correct.
    const blockedFile = resolveGuardWriteGate(createFileGuardStore({ directory }), "MULTI_INSTANCE");
    assert.equal(blockedFile.allowed, false);
    assert.match(blockedFile.reason, /single writer/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const multiWriter = { ...createMemoryGuardStore(), durability: "DURABLE_MULTI_WRITER" };
  assert.deepEqual(resolveGuardWriteGate(multiWriter, "MULTI_INSTANCE"), { allowed: true });
});

test("the whole lifecycle survives a cold start on the durable adapter", async () => {
  const directory = temporaryDirectory();
  const chainRef = "eip155:5042002";
  const assetRef = `${chainRef}/erc20:0x3600000000000000000000000000000000000000`;
  const intent = {
    schemaVersion: "1.0.0",
    id: "int_durable",
    tenantId: "tenant-a",
    createdAt: "2026-08-06T00:00:00.000Z",
    revision: 1,
    idempotencyKey: "durable-key-0001",
    operationType: "TRANSFER",
    chainRef,
    accountRef: "0x1111111111111111111111111111111111111111",
    recipientRef: "0x2222222222222222222222222222222222222222",
    assetRefIn: assetRef,
    amountIn: "1.00",
    policyRef: { id: "demo-stablecoin-policy", version: 1 },
    expiresAt: "2026-08-06T01:00:00.000Z",
  };

  try {
    const first = createGuardService({
      now: () => "2026-08-06T00:00:00.000Z",
      createId: (prefix) => `${prefix}_fixed`,
      store: createFileGuardStore({ directory }),
    });
    await first.createIntent({ tenantId: "tenant-a", intent, idempotencyKey: "durable-key-0001" });

    // A second service over the same directory has no shared memory with the
    // first: everything it can answer came off disk.
    const second = createGuardService({
      now: () => "2026-08-06T00:05:00.000Z",
      createId: (prefix) => `${prefix}_fixed2`,
      store: createFileGuardStore({ directory }),
    });
    assert.equal(
      (await second.getIntent({ tenantId: "tenant-a", intentId: "int_durable" })).id,
      "int_durable",
    );
    assert.equal(
      (await second.getStatus({ tenantId: "tenant-a", intentId: "int_durable" })).executionStatus,
      "NOT_STARTED",
    );

    // Tenant scoping is a property of the stored key, so it survives restart too.
    await assert.rejects(
      () => second.getIntent({ tenantId: "tenant-b", intentId: "int_durable" }),
      (error) => error instanceof GuardError && error.code === "TENANT_FORBIDDEN",
    );

    // Idempotency replay is answered from the persisted request hash, and a
    // changed payload under the same key still conflicts after restart.
    const replay = await second.createIntent({
      tenantId: "tenant-a",
      intent,
      idempotencyKey: "durable-key-0001",
    });
    assert.equal(replay.id, "int_durable");
    assert.equal(replay.idempotentReplay, true);
    await assert.rejects(
      () =>
        second.createIntent({
          tenantId: "tenant-a",
          intent: { ...intent, amountIn: "2.00" },
          idempotencyKey: "durable-key-0001",
        }),
      (error) => error instanceof GuardError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed operation releases its idempotency key instead of burning it", async () => {
  /* The key is claimed before the work runs, so a failure has to release it.
     Otherwise the first bad request would make that key permanently unusable
     and a corrected retry impossible — a worse outcome than the original
     error, and one the caller could not diagnose. */
  const service = createGuardService({
    now: () => "2026-08-06T00:00:00.000Z",
    createId: (prefix) => `${prefix}_release`,
  });
  const intent = {
    schemaVersion: "1.0.0",
    id: "int_release",
    tenantId: "tenant-a",
    createdAt: "2026-08-06T00:00:00.000Z",
    revision: 1,
    idempotencyKey: "release-key-0001",
    operationType: "TRANSFER",
    chainRef: "eip155:5042002",
    accountRef: "0x1111111111111111111111111111111111111111",
    recipientRef: "0x2222222222222222222222222222222222222222",
    assetRefIn: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
    amountIn: "1.00",
    policyRef: { id: "demo-stablecoin-policy", version: 1 },
    expiresAt: "2026-08-06T01:00:00.000Z",
  };

  // Wrong tenant on the intent body: rejected inside the claimed operation.
  await assert.rejects(
    () =>
      service.createIntent({
        tenantId: "tenant-a",
        intent: { ...intent, tenantId: "tenant-b" },
        idempotencyKey: "release-key-0001",
      }),
    (error) => error instanceof GuardError && error.code === "TENANT_FORBIDDEN",
  );

  // The same key now works for the corrected request.
  const created = await service.createIntent({
    tenantId: "tenant-a",
    intent,
    idempotencyKey: "release-key-0001",
  });
  assert.equal(created.id, "int_release");
});

test("reported limitations follow the configured adapter instead of a constant", async () => {
  const ephemeral = createGuardService({
    now: () => "2026-08-06T00:00:00.000Z",
    createId: (prefix) => `${prefix}_x`,
  });
  assert.equal(ephemeral.store.durability, "EPHEMERAL_SINGLE_INSTANCE");

  const directory = temporaryDirectory();
  try {
    const durable = createGuardService({
      now: () => "2026-08-06T00:00:00.000Z",
      createId: (prefix) => `${prefix}_y`,
      store: createFileGuardStore({ directory }),
    });
    const intent = {
      schemaVersion: "1.0.0",
      id: "int_limits",
      tenantId: "tenant-a",
      createdAt: "2026-08-06T00:00:00.000Z",
      revision: 1,
      idempotencyKey: "limits-key-0001",
      operationType: "TRANSFER",
      chainRef: "eip155:5042002",
      accountRef: "0x1111111111111111111111111111111111111111",
      recipientRef: "0x2222222222222222222222222222222222222222",
      assetRefIn: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
      amountIn: "1.00",
      policyRef: { id: "demo-stablecoin-policy", version: 1 },
      expiresAt: "2026-08-06T01:00:00.000Z",
    };
    await durable.createIntent({ tenantId: "tenant-a", intent, idempotencyKey: "limits-key-0001" });
    const status = await durable.getStatus({ tenantId: "tenant-a", intentId: "int_limits" });
    assert.deepEqual(status.limitations, ["ARC_TESTNET", "HACKATHON_PROTOTYPE", "DURABLE_SINGLE_WRITER_STORE"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the durable adapter recovers when its directory disappears under a live process", async () => {
  /* A long-lived process can outlive its own state directory: a cleanup script,
     a container restart with an unmounted volume, or an operator clearing state
     by hand. Creating the directory only at construction meant every later write
     threw ENOENT for the lifetime of the process, surfacing as a generic 503
     with no hint of the cause. */
  const directory = temporaryDirectory();
  try {
    const store = createFileGuardStore({ directory });
    await store.collection("intents").set("tenant-a:int_1", { id: "int_1" });

    rmSync(directory, { recursive: true, force: true });

    // Same live store instance, directory gone: the write must still succeed.
    await store.collection("intents").set("tenant-a:int_2", { id: "int_2" });

    const reopened = createFileGuardStore({ directory });
    assert.deepEqual(await reopened.collection("intents").get("tenant-a:int_2"), { id: "int_2" });
    /* And the earlier object comes back with it. Each write is a whole-collection
       atomic replace, so a live process re-persists everything it still holds
       rather than silently truncating the collection down to the one key it
       happened to be writing. Losing an authorized intent because a directory
       was cleaned up underneath the process would be far worse than restoring
       it, so this is the intended outcome, not a leak. */
    assert.deepEqual(await reopened.collection("intents").get("tenant-a:int_1"), { id: "int_1" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
