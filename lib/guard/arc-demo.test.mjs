// Run from repo root: node --test lib/guard/arc-demo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const WALLET = "0x1111111111111111111111111111111111111111";
const SECRET = "KIT_KEY:test-id:test-secret";

const request = {
  chain: "Arc_Testnet",
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "10.00",
  recipientAddress: WALLET,
  slippageBps: 20,
};

const estimate = {
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "10.00",
  chainIn: "Arc_Testnet",
  chainOut: "Arc_Testnet",
  chain: "Arc_Testnet",
  fromAddress: WALLET,
  toAddress: WALLET,
  stopLimit: { token: "EURC", amount: "9.93" },
  estimatedOutput: { token: "EURC", amount: "9.96" },
  fees: [{ token: "USDC", amount: "0.01", type: "provider" }],
};

async function loadDemo() {
  try {
    return await import("./arc-demo.ts");
  } catch (error) {
    assert.fail(`Arc demo boundary is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("fails closed before a Circle request when the server-side kit key is absent", async () => {
  const { estimateArcSwapForDemo, isArcDemoError } = await loadDemo();
  let called = false;

  await assert.rejects(
    estimateArcSwapForDemo({
      request,
      kitKey: undefined,
      estimateWithCircle: async () => {
        called = true;
        return estimate;
      },
      now: () => "2026-08-06T12:00:00.000Z",
    }),
    (error) => isArcDemoError(error, "CIRCLE_APP_KIT_KEY_REQUIRED"),
  );
  assert.equal(called, false);
});

test("keeps the kit key server-side while returning normalized quote evidence", async () => {
  const { estimateArcSwapForDemo } = await loadDemo();
  let receivedKey = null;
  const result = await estimateArcSwapForDemo({
    request,
    kitKey: SECRET,
    estimateWithCircle: async ({ kitKey }) => {
      receivedKey = kitKey;
      return estimate;
    },
    now: (() => {
      const values = ["2026-08-06T12:00:00.000Z", "2026-08-06T12:00:01.000Z"];
      return () => values.shift() ?? "2026-08-06T12:00:01.000Z";
    })(),
  });

  assert.equal(receivedKey, SECRET);
  assert.equal(result.evidence.status, "VALID");
  assert.equal(result.evidence.facts.expectedAmountOut, "9.96");
  assert.equal(result.binding.productionCalldataBound, false);
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test("creates a schema-valid server-owned intent bound to the exact App Kit request", async () => {
  const { buildArcDemoIntent, estimateArcSwapForDemo } = await loadDemo();
  const result = await estimateArcSwapForDemo({
    request,
    kitKey: SECRET,
    estimateWithCircle: async () => estimate,
    now: (() => {
      const values = ["2026-08-06T12:00:00.000Z", "2026-08-06T12:00:01.000Z"];
      return () => values.shift() ?? "2026-08-06T12:00:01.000Z";
    })(),
  });
  const intent = buildArcDemoIntent({
    tenantId: "arc_demo_session_12345678",
    intentId: "int_demo_12345678",
    idempotencyKey: "idem_demo_12345678",
    request,
    evidence: result.evidence,
    binding: result.binding,
    createdAt: "2026-08-06T12:00:01.000Z",
  });

  assert.equal(intent.tenantId, "arc_demo_session_12345678");
  assert.equal(intent.quoteRef, result.evidence.facts.quoteRef);
  assert.equal(intent.adapterRequestHash, result.binding.hash);
  assert.equal(intent.executionBindingKind, "APP_KIT_REQUEST");
  assert.equal(intent.productionCalldataBound, false);
  assert.equal(intent.target, null);
  assert.equal(intent.calldataHash, null);
  assert.equal(intent.amount, "10.00");
  assert.equal(intent.recipient, WALLET);
});

test("rejects malformed or out-of-scope public demo requests before provider use", async () => {
  const { parseArcDemoSwapRequest, isArcDemoError } = await loadDemo();

  for (const value of [
    { ...request, amountIn: "1e3" },
    { ...request, amountIn: "1000.01" },
    { ...request, tokenOut: "USDC" },
    { ...request, recipientAddress: "not-an-address" },
    { ...request, slippageBps: 101 },
  ]) {
    assert.throws(
      () => parseArcDemoSwapRequest(value),
      (error) => isArcDemoError(error, "VALIDATION_ERROR"),
    );
  }
});
