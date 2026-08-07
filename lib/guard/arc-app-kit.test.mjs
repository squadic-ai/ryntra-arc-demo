// Run from repo root: node --test lib/guard/arc-app-kit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const WALLET = "0x1111111111111111111111111111111111111111";

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
  fees: [
    { token: "USDC", amount: "0.01", type: "provider" },
    { token: "USDC", amount: "0.02", type: "gas" },
  ],
};

async function loadAdapter() {
  try {
    return await import("./arc-app-kit.ts");
  } catch (error) {
    assert.fail(`Arc App Kit adapter is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("normalizes a current App Kit estimate without hiding route limits", async () => {
  const { normalizeArcSwapEstimate } = await loadAdapter();
  const { EvidenceItemSchema } = await import("./contracts.ts");
  const evidence = normalizeArcSwapEstimate({
    request,
    estimate,
    observedAt: "2026-08-06T12:00:00.000Z",
    receivedAt: "2026-08-06T12:00:01.000Z",
    freshnessSeconds: 120,
  });

  assert.equal(evidence.status, "VALID");
  assert.equal(evidence.provider, "Circle App Kit");
  assert.equal(evidence.adapterVersion, "1.11.0");
  assert.equal(evidence.chainRef, "eip155:5042002");
  assert.equal(evidence.validUntil, "2026-08-06T12:02:01.000Z");
  assert.equal(evidence.fallbackUsed, false);
  assert.equal(evidence.facts.amountIn, "10.00");
  assert.equal(evidence.facts.feeAmount, "0.03");
  assert.equal(evidence.facts.totalDebit, "10.03");
  assert.equal(evidence.facts.minimumAmountOut, "9.93");
  assert.equal(evidence.facts.underlyingRouteDisclosure, "UNAVAILABLE_FROM_APP_KIT_ESTIMATE");
  assert.match(evidence.requestHash, /^0x[0-9a-f]{64}$/);
  assert.match(evidence.responseHash, /^0x[0-9a-f]{64}$/);
  assert.equal(EvidenceItemSchema.safeParse(evidence).success, true);
});

test("a provider fee with no amount stays missing and never becomes zero", async () => {
  const { normalizeArcSwapEstimate } = await loadAdapter();
  const evidence = normalizeArcSwapEstimate({
    request,
    estimate: { ...estimate, fees: [{ token: "USDC", amount: null, type: "gas" }] },
    observedAt: "2026-08-06T12:00:00.000Z",
    receivedAt: "2026-08-06T12:00:01.000Z",
    freshnessSeconds: 120,
  });

  assert.equal(evidence.status, "MISSING");
  assert.equal(evidence.facts.feeAmount, null);
  assert.equal(evidence.facts.totalDebit, null);
  assert.deepEqual(evidence.facts.missingEvidence, ["FEE_AMOUNT:gas"]);
});

test("rejects an estimate that does not match the requested chain, pair, amount, or recipient", async () => {
  const { normalizeArcSwapEstimate, isArcAppKitAdapterError } = await loadAdapter();
  for (const changed of [
    { ...estimate, chainIn: "Ethereum" },
    { ...estimate, tokenOut: "USDC" },
    { ...estimate, amountIn: "10.01" },
    { ...estimate, toAddress: "0x2222222222222222222222222222222222222222" },
  ]) {
    assert.throws(
      () =>
        normalizeArcSwapEstimate({
          request,
          estimate: changed,
          observedAt: "2026-08-06T12:00:00.000Z",
          receivedAt: "2026-08-06T12:00:01.000Z",
          freshnessSeconds: 120,
        }),
      (error) => isArcAppKitAdapterError(error, "ARC_ESTIMATE_MISMATCH"),
    );
  }
});

test("request binding changes on every material App Kit parameter", async () => {
  const { createArcAppKitRequestBinding } = await loadAdapter();
  const original = createArcAppKitRequestBinding(request, estimate);

  for (const changed of [
    { ...request, amountIn: "10.01" },
    { ...request, recipientAddress: "0x2222222222222222222222222222222222222222" },
    { ...request, slippageBps: 21 },
  ]) {
    assert.notEqual(createArcAppKitRequestBinding(changed, estimate).hash, original.hash);
  }
  assert.throws(() => createArcAppKitRequestBinding({ ...request, tokenOut: "USDC" }, estimate));
  assert.equal(original.kind, "APP_KIT_REQUEST");
  assert.equal(original.productionCalldataBound, false);
});

test("the Arc Testnet RPC endpoint is configuration, and a bad value fails loudly", async () => {
  const { ARC_TESTNET_DEFAULT_RPC_URL, resolveArcTestnetRpcUrl } = await import("./arc-app-kit.ts");

  /* The official endpoint sits behind a WAF that refuses whole networks
     (observed: Cloudflare error 1009). The browser can still sign and broadcast
     from an allowed network while the server cannot read chain state — which
     breaks preflight evidence and, far worse, post-broadcast reconciliation
     after a real transaction already exists. So the endpoint must be
     redirectable without a source edit. */
  assert.equal(ARC_TESTNET_DEFAULT_RPC_URL, "https://rpc.testnet.arc.io");
  assert.equal(resolveArcTestnetRpcUrl({}), ARC_TESTNET_DEFAULT_RPC_URL);
  assert.equal(resolveArcTestnetRpcUrl({ ARC_TESTNET_RPC_URL: "   " }), ARC_TESTNET_DEFAULT_RPC_URL);
  assert.equal(
    resolveArcTestnetRpcUrl({ ARC_TESTNET_RPC_URL: " https://arc-testnet.example/rpc " }),
    "https://arc-testnet.example/rpc",
  );

  // A settlement path must never read chain state from an endpoint the operator
  // did not mean to use, so a malformed or downgraded value throws instead of
  // quietly falling back to the default.
  assert.throws(() => resolveArcTestnetRpcUrl({ ARC_TESTNET_RPC_URL: "not-a-url" }), /absolute URL/);
  assert.throws(() => resolveArcTestnetRpcUrl({ ARC_TESTNET_RPC_URL: "rpc.testnet.arc.io" }), /absolute URL/);
  assert.throws(() => resolveArcTestnetRpcUrl({ ARC_TESTNET_RPC_URL: "http://insecure.example/rpc" }), /https/);
});

test("every server-side Arc read goes through the resolver, not a hard-coded host", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["./arc-usdc-transfer.ts", "./arc-demo.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /transport: http\(resolveArcTestnetRpcUrl\(\)/, file + " must resolve its endpoint");
    assert.doesNotMatch(source, /http\("https:\/\//, file + " must not hard-code an RPC host");
  }
  /* The browser owns no chain facts at all. It renders whatever network the
     server says it is connected to, which is the only arrangement in which a
     client literal cannot disagree with the chain — the failure that shipped
     here once as a transposed hex chain id and killed every wallet session. */
  const client = await readFile(new URL("../../app/arc-guard/arc-guard-demo.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(client, /0x4C[0-9A-Fa-f]{4}/, "no hex chain id may be typed into the client");
  assert.doesNotMatch(client, /5[_]?042[_]?002/, "no decimal chain id either");
  assert.doesNotMatch(client, /https:\/\/rpc\./, "no RPC host may be typed into the client");
  assert.doesNotMatch(client, /arcscan\.app/, "no explorer host may be typed into the client");
  assert.match(client, /capability\?\.network \?\? null/, "the client takes its network from the API");
  assert.match(client, /network\.hexChainId/);
  assert.match(client, /rpcUrls: network\.rpcUrls/);
  assert.match(client, /blockExplorerUrls: \[network\.explorerBaseUrl\]/);
});
