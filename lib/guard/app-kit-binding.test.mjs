// Run from repo root: node --test lib/guard/app-kit-binding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = "2026-08-06T12:00:00.000Z";
const WALLET = "0x1111111111111111111111111111111111111111";
const USDC = "eip155:5042002/erc20:0x3600000000000000000000000000000000000000";
const EURC = "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

const intent = {
  schemaVersion: "1.0.0",
  id: "int_appkit_001",
  tenantId: "tenant_demo",
  applicationId: "partner_arc_app",
  externalPartnerId: "partner-order-appkit",
  subjectRef: "subject:demo",
  walletAddress: WALLET,
  walletType: "EOA",
  chainRef: "eip155:5042002",
  environment: "ARC_TESTNET",
  actionType: "SWAP",
  instrumentRef: "arc-testnet:stablecoin-fx:usdc-eurc",
  sellAssetRef: USDC,
  buyAssetRef: EURC,
  amount: "10.00",
  amountType: "EXACT_INPUT",
  recipient: WALLET,
  venueRef: "circle-app-kit",
  routeRef: "circle-app-kit:swap:Arc_Testnet",
  quoteRef: "quote_arc_001",
  executionBindingKind: "APP_KIT_REQUEST",
  target: null,
  calldataHash: null,
  nativeValue: "0",
  adapterRequestHash: HASH_A,
  productionCalldataBound: false,
  portfolioSnapshotRef: null,
  policyRef: { id: "demo-stablecoin-policy", version: 1 },
  createdAt: "2026-08-06T11:59:00.000Z",
  expiresAt: "2026-08-06T12:02:00.000Z",
  revision: 1,
  idempotencyKey: "idem-appkit-001",
};

const quote = {
  schemaVersion: "1.0.0",
  id: "ev_quote_appkit",
  provider: "Circle App Kit",
  adapter: "circle-app-kit",
  adapterVersion: "1.11.0",
  sourceType: "SWAP_QUOTE",
  observedAt: "2026-08-06T11:59:30.000Z",
  receivedAt: "2026-08-06T11:59:31.000Z",
  validUntil: "2026-08-06T12:01:30.000Z",
  confidence: "PROVIDER_REPORTED",
  chainRef: "eip155:5042002",
  blockRef: null,
  transactionRef: null,
  status: "VALID",
  requestHash: HASH_A,
  responseHash: HASH_B,
  transformationVersion: "arc-app-kit-estimate-v1",
  fallbackUsed: false,
  facts: {
    quoteRef: "quote_arc_001",
    providerRef: "circle-app-kit",
    routeRef: "circle-app-kit:swap:Arc_Testnet",
    sellAssetRef: USDC,
    buyAssetRef: EURC,
    amountIn: "10.00",
    expectedAmountOut: "9.96",
    minimumAmountOut: "9.93",
    feeAmount: "0.02",
    totalDebit: "10.02",
    slippageBps: "20",
  },
};

const policy = {
  id: "demo-stablecoin-policy",
  version: 1,
  rules: [
    { id: "chain", type: "ALLOWED_CHAIN", value: "eip155:5042002" },
    { id: "pair", type: "ALLOWED_PAIR", value: [USDC, EURC] },
    { id: "debit", type: "MAX_TOTAL_DEBIT", value: "100.00" },
    { id: "age", type: "MAX_QUOTE_AGE_SECONDS", value: 120 },
    { id: "slippage", type: "MAX_SLIPPAGE_BPS", value: "25" },
    { id: "human", type: "HUMAN_AUTHORIZATION_REQUIRED", value: true },
  ],
};

test("the versioned intent and fingerprint contracts admit explicit non-calldata App Kit binding", async () => {
  const { ExecutionIntentSchema, ExecutionFingerprintSchema } = await import("./contracts.ts");
  const { buildExecutionFingerprint } = await import("./service.ts");
  const parsed = ExecutionIntentSchema.parse(intent);
  const fingerprint = buildExecutionFingerprint({ intent: parsed, quote });
  assert.equal(fingerprint.bindingKind, "APP_KIT_REQUEST");
  assert.equal(fingerprint.target, null);
  assert.equal(fingerprint.calldataHash, null);
  assert.equal(fingerprint.adapterRequestHash, HASH_A);
  assert.equal(fingerprint.productionCalldataBound, false);
  assert.equal(ExecutionFingerprintSchema.parse(fingerprint).bindingKind, "APP_KIT_REQUEST");
});

test("authorization binds the App Kit request hash and records the prototype limitation", async () => {
  const { buildExecutionFingerprint, createGuardService, isGuardError } = await import("./service.ts");
  let sequence = 0;
  const service = createGuardService({
    now: () => NOW,
    createId: (prefix) => `${prefix}_appkit_${++sequence}`,
  });
  await service.createIntent({ tenantId: "tenant_demo", intent, idempotencyKey: "create-appkit" });
  const evaluation = await service.preflight({
    tenantId: "tenant_demo",
    intentId: intent.id,
    evidence: [quote],
    policy,
    idempotencyKey: "preflight-appkit",
  });
  const fingerprint = buildExecutionFingerprint({ intent, quote });
  const authorization = await service.authorize({
    tenantId: "tenant_demo",
    intentId: intent.id,
    evaluationId: evaluation.id,
    fingerprint,
    subjectRef: "subject:demo",
    method: "PARTNER_AUTHENTICATED",
    idempotencyKey: "authorize-appkit",
  });

  await assert.rejects(
    () => service.recordExecution({
        tenantId: "tenant_demo",
        intentId: intent.id,
        authorizationId: authorization.id,
        fingerprint: { ...fingerprint, adapterRequestHash: HASH_B },
        transactionHash: `0x${"cc".repeat(32)}`,
        idempotencyKey: "changed-appkit-request",
      }),
    (error) => isGuardError(error, "FINGERPRINT_MISMATCH"),
  );

  const submitted = await service.recordExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    authorizationId: authorization.id,
    fingerprint,
    transactionHash: `0x${"cc".repeat(32)}`,
    idempotencyKey: "execute-appkit",
  });
  assert.equal(submitted.bindingKind, "APP_KIT_REQUEST");
  assert.equal(submitted.productionCalldataBound, false);
});
