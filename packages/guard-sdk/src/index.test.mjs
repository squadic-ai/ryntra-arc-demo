// Run from repo root: node --test packages/guard-sdk/src/index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadSdk() {
  try {
    return await import("./index.ts");
  } catch (error) {
    assert.fail(`Headless Guard SDK is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("the SDK sends server credentials in headers and idempotency on every mutation", async () => {
  const { RyntraGuardClient } = await loadSdk();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: "int_sdk_001" } }), {
      status: 201,
      headers: { "content-type": "application/json", "x-correlation-id": "corr_server_001" },
    });
  };
  const client = new RyntraGuardClient({
    baseUrl: "https://guard.example/",
    apiKey: "server-only-key",
    fetch,
    createCorrelationId: () => "corr_sdk_001",
  });
  const result = await client.intents.create(
    { amount: "10.00", chainRef: "eip155:5042002" },
    { idempotencyKey: "idem-sdk-create-001" },
  );
  assert.equal(result.id, "int_sdk_001");
  assert.equal(calls[0].url, "https://guard.example/v1/intents");
  assert.equal(calls[0].init.headers.authorization, "Bearer server-only-key");
  assert.equal(calls[0].init.headers["idempotency-key"], "idem-sdk-create-001");
  assert.equal(calls[0].init.headers["x-correlation-id"], "corr_sdk_001");
  assert.equal(new URL(calls[0].url).searchParams.has("key"), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), { amount: "10.00", chainRef: "eip155:5042002" });
});

test("the SDK exposes the exact intent lifecycle endpoints", async () => {
  const { RyntraGuardClient } = await loadSdk();
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new RyntraGuardClient({ baseUrl: "https://guard.example", apiKey: "key", fetch });
  await client.intents.get("int_001");
  await client.preflight("int_001", { evidence: [] }, { idempotencyKey: "idem-preflight-001" });
  await client.evaluations.get("eval_001");
  await client.authorize(
    { intentId: "int_001", evaluationId: "eval_001", fingerprint: {}, subjectRef: "subject", method: "PARTNER_AUTHENTICATED" },
    { idempotencyKey: "idem-authorize-001" },
  );
  await client.executions.record(
    { intentId: "int_001", authorizationId: "auth_001", fingerprint: {}, transactionHash: `0x${"ab".repeat(32)}` },
    { idempotencyKey: "idem-execute-001" },
  );
  await client.status.getByIntent("int_001");
  await client.receipts.getByIntent("int_001");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/v1/intents/int_001",
    "/v1/intents/int_001/preflight",
    "/v1/evaluations/eval_001",
    "/v1/intents/int_001/authorize",
    "/v1/intents/int_001/executions",
    "/v1/intents/int_001/status",
    "/v1/intents/int_001/receipt",
  ]);
});

test("structured API failures become typed SDK errors with correlation and remediation", async () => {
  const { RyntraGuardApiError, RyntraGuardClient } = await loadSdk();
  const fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "FINGERPRINT_MISMATCH",
          message: "Execution differs from authorization.",
          retryable: false,
          requiredAction: "CREATE_NEW_EVALUATION",
          correlationId: "corr_failure_001",
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  const client = new RyntraGuardClient({ baseUrl: "https://guard.example", apiKey: "key", fetch });
  await assert.rejects(
    () => client.receipts.getByIntent("int_001"),
    (error) => {
      assert.equal(error instanceof RyntraGuardApiError, true);
      assert.equal(error.code, "FINGERPRINT_MISMATCH");
      assert.equal(error.status, 409);
      assert.equal(error.correlationId, "corr_failure_001");
      return true;
    },
  );
});

test("the headless SDK contains no private-key or seed-phrase execution surface", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /privateKey|private_key|seedPhrase|seed_phrase|wallet\.execute/i);
});
