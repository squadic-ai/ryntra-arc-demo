// Run from repo root: node --test lib/guard/kernel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = "2026-08-06T12:00:00.000Z";
const WALLET = "0x1111111111111111111111111111111111111111";
const USDC = "eip155:5042002/erc20:0x3600000000000000000000000000000000000000";
const EURC = "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a";

const intent = (overrides = {}) => ({
  schemaVersion: "1.0.0",
  id: "int_arc_demo_001",
  tenantId: "tenant_demo",
  applicationId: "partner_arc_app",
  externalPartnerId: "partner-order-001",
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
  routeRef: "circle-app-kit:swap",
  quoteRef: "quote_arc_001",
  target: "0x2222222222222222222222222222222222222222",
  calldataHash: `0x${"ab".repeat(32)}`,
  nativeValue: "0",
  portfolioSnapshotRef: null,
  policyRef: { id: "demo-stablecoin-policy", version: 1 },
  createdAt: "2026-08-06T11:59:00.000Z",
  expiresAt: "2026-08-06T12:02:00.000Z",
  revision: 1,
  idempotencyKey: "idem-intent-001",
  ...overrides,
});

const quoteEvidence = (overrides = {}) => ({
  schemaVersion: "1.0.0",
  id: "ev_quote_001",
  provider: "Circle App Kit",
  adapter: "circle-app-kit",
  adapterVersion: "current-official-contract",
  sourceType: "SWAP_QUOTE",
  observedAt: "2026-08-06T11:59:30.000Z",
  receivedAt: "2026-08-06T11:59:31.000Z",
  validUntil: "2026-08-06T12:01:30.000Z",
  confidence: "PROVIDER_REPORTED",
  chainRef: "eip155:5042002",
  blockRef: null,
  transactionRef: null,
  status: "VALID",
  requestHash: `0x${"01".repeat(32)}`,
  responseHash: `0x${"02".repeat(32)}`,
  transformationVersion: "arc-swap-quote-v1",
  fallbackUsed: false,
  facts: {
    quoteRef: "quote_arc_001",
    providerRef: "circle-app-kit",
    routeRef: "circle-app-kit:swap",
    sellAssetRef: USDC,
    buyAssetRef: EURC,
    amountIn: "10.00",
    expectedAmountOut: "9.96",
    minimumAmountOut: "9.93",
    feeAmount: "0.02",
    totalDebit: "10.02",
    slippageBps: "20",
  },
  ...overrides,
});

const policy = {
  schemaVersion: "1.0.0",
  id: "demo-stablecoin-policy",
  version: 1,
  publishedAt: "2026-08-06T00:00:00.000Z",
  rules: [
    { id: "allowed-chain", type: "ALLOWED_CHAIN", value: "eip155:5042002", onViolation: "BLOCK" },
    { id: "allowed-pair", type: "ALLOWED_PAIR", value: [USDC, EURC], onViolation: "BLOCK" },
    { id: "max-total-debit", type: "MAX_TOTAL_DEBIT", value: "100.00", currencyAssetRef: USDC, onViolation: "BLOCK" },
    { id: "max-quote-age", type: "MAX_QUOTE_AGE_SECONDS", value: 120, onViolation: "INSUFFICIENT_EVIDENCE" },
    { id: "max-slippage", type: "MAX_SLIPPAGE_BPS", value: "25", onViolation: "REVIEW" },
    { id: "human-auth", type: "HUMAN_AUTHORIZATION_REQUIRED", value: true, onViolation: "REQUIRE_AUTHORIZATION" },
  ],
};

async function loadKernel() {
  try {
    return await import("./kernel.ts");
  } catch (error) {
    assert.fail(`Guard kernel is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("fresh supported Arc quote passes deterministic policy and awaits human authorization", async () => {
  const { evaluateGuardReadiness } = await loadKernel();

  const evaluation = evaluateGuardReadiness({
    intent: intent(),
    evidence: [quoteEvidence()],
    policy,
    now: NOW,
  });

  assert.equal(evaluation.outcome, "ALLOWED_BY_POLICY");
  assert.equal(evaluation.dataStatus, "COMPLETE");
  assert.equal(evaluation.policyStatus, "PASS");
  assert.equal(evaluation.authorizationStatus, "PENDING");
  assert.equal(evaluation.executionStatus, "NOT_STARTED");
  assert.deepEqual(evaluation.blockers, []);
  assert.deepEqual(evaluation.missingEvidence, []);
});

test("deterministic Arc policy matrix distinguishes review, block, insufficient, expired, and unsupported", async () => {
  const { evaluateGuardReadiness } = await loadKernel();
  const cases = [
    {
      name: "soft slippage",
      input: {
        intent: intent(),
        evidence: [
          quoteEvidence({
            facts: { ...quoteEvidence().facts, slippageBps: "30" },
          }),
        ],
        policy,
        now: NOW,
      },
      expected: ["REVIEW_REQUIRED", "WARN", [], []],
    },
    {
      name: "amount over maximum",
      input: {
        intent: intent({ amount: "100.01" }),
        evidence: [
          quoteEvidence({
            facts: {
              ...quoteEvidence().facts,
              amountIn: "100.01",
              totalDebit: "100.03",
            },
          }),
        ],
        policy,
        now: NOW,
      },
      expected: ["BLOCKED_BY_RULE", "BLOCK", ["max-total-debit"], []],
    },
    {
      name: "missing quote",
      input: { intent: intent({ quoteRef: null }), evidence: [], policy, now: NOW },
      expected: ["INSUFFICIENT_EVIDENCE", "NOT_EVALUATED", [], ["SWAP_QUOTE"]],
    },
    {
      name: "expired quote",
      input: {
        intent: intent(),
        evidence: [
          quoteEvidence({
            observedAt: "2026-08-06T11:56:00.000Z",
            receivedAt: "2026-08-06T11:56:01.000Z",
            validUntil: "2026-08-06T11:58:00.000Z",
          }),
        ],
        policy,
        now: NOW,
      },
      expected: ["EXPIRED", "NOT_EVALUATED", [], ["FRESH_SWAP_QUOTE"]],
    },
    {
      name: "unsupported chain",
      input: {
        intent: intent({ chainRef: "eip155:1", environment: "PRODUCTION" }),
        evidence: [quoteEvidence({ chainRef: "eip155:1" })],
        policy,
        now: NOW,
      },
      expected: ["UNSUPPORTED", "BLOCK", ["allowed-chain"], []],
    },
  ];

  for (const entry of cases) {
    const actual = evaluateGuardReadiness(entry.input);
    assert.deepEqual(
      [actual.outcome, actual.policyStatus, actual.blockers, actual.missingEvidence],
      entry.expected,
      entry.name,
    );
  }
});
