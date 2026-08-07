// Run from repo root: node --test lib/guard/service.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = "2026-08-06T12:00:00.000Z";
const WALLET = "0x1111111111111111111111111111111111111111";
const USDC = "eip155:5042002/erc20:0x3600000000000000000000000000000000000000";
const EURC = "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const TX_HASH = `0x${"de".repeat(32)}`;

const intent = {
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
};

const quote = {
  schemaVersion: "1.0.0",
  id: "ev_quote_001",
  provider: "Circle App Kit",
  sourceRef: "circle-app-kit:estimateSwap",
  adapter: "circle-app-kit",
  adapterVersion: "current-official-contract",
  sourceType: "SWAP_QUOTE",
  observedAt: "2026-08-06T11:59:30.000Z",
  receivedAt: "2026-08-06T11:59:31.000Z",
  validUntil: "2026-08-06T12:01:30.000Z",
  confidence: "PROVIDER_REPORTED",
  coverage: {
    subjectRefs: ["eip155:5042002", USDC, EURC],
    fields: ["amountIn", "expectedAmountOut", "minimumAmountOut", "fees"],
    limitations: ["UNDERLYING_ROUTE_UNAVAILABLE"],
  },
  availability: "AVAILABLE",
  verificationStatus: "PROVIDER_REPORTED",
  chainRef: "eip155:5042002",
  blockRef: null,
  transactionRef: null,
  status: "VALID",
  requestHash: `0x${"01".repeat(32)}`,
  responseHash: `0x${"02".repeat(32)}`,
  responseDigest: `0x${"02".repeat(32)}`,
  reason: null,
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
};

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

async function loadService() {
  try {
    return await import("./service.ts");
  } catch (error) {
    assert.fail(`Guard service is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("authorization and exact fingerprint bind one execution through uncertainty to a finalized receipt", async () => {
  const { DecisionSettlementReceiptSchema, verifyIntegrityEnvelope } = await import("./contracts.ts");
  const { buildExecutionFingerprint, createGuardService, isGuardError } = await loadService();
  let idCounter = 0;
  const service = createGuardService({
    now: () => NOW,
    createId: (prefix) => `${prefix}_test_${++idCounter}`,
  });

  await service.createIntent({ tenantId: "tenant_demo", intent, idempotencyKey: "create-001" });
  const evaluation = await service.preflight({
    tenantId: "tenant_demo",
    intentId: intent.id,
    evidence: [quote],
    policy,
    idempotencyKey: "preflight-001",
  });
  assert.equal(evaluation.evidenceStatus, "COMPLETE");
  assert.equal(evaluation.policyDecision, "ALLOWED_BY_POLICY");
  assert.equal(evaluation.executionStatus, "NOT_STARTED");
  assert.equal(evaluation.policyVersion, 1);
  assert.equal(evaluation.policyDigest, evaluation.policyHash);
  assert.match(evaluation.preflightHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(evaluation.expectedEffects, {
    amountIn: "10.00",
    amountOut: "9.96",
    minimumAmountOut: "9.93",
    feeAmount: "0.02",
    totalDebit: "10.02",
  });
  assert.equal(evaluation.actualEffects, null);
  assert.equal(evaluation.reconciliationStatus, "NOT_RECONCILED");
  const fingerprint = buildExecutionFingerprint({ intent, quote });

  await assert.rejects(
    () => service.recordExecution({
        tenantId: "tenant_demo",
        intentId: intent.id,
        authorizationId: null,
        fingerprint,
        transactionHash: TX_HASH,
        idempotencyKey: "execute-without-auth",
      }),
    (error) => isGuardError(error, "HUMAN_AUTHORIZATION_REQUIRED"),
  );

  const authorization = await service.authorize({
    tenantId: "tenant_demo",
    intentId: intent.id,
    evaluationId: evaluation.id,
    fingerprint,
    subjectRef: "subject:demo",
    method: "PARTNER_AUTHENTICATED",
    idempotencyKey: "authorize-001",
  });
  assert.equal(authorization.preflightHash, evaluation.preflightHash);

  for (const changed of [
    { ...fingerprint, amount: "10.01" },
    { ...fingerprint, recipient: "0x3333333333333333333333333333333333333333" },
    { ...fingerprint, routeRef: "different-route" },
  ]) {
    await assert.rejects(
      () => service.recordExecution({
          tenantId: "tenant_demo",
          intentId: intent.id,
          authorizationId: authorization.id,
          fingerprint: changed,
          transactionHash: TX_HASH,
          idempotencyKey: `mismatch-${changed.amount}-${changed.routeRef}`,
        }),
      (error) => isGuardError(error, "FINGERPRINT_MISMATCH"),
    );
  }

  const submitted = await service.recordExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    authorizationId: authorization.id,
    fingerprint,
    transactionHash: TX_HASH,
    idempotencyKey: "execute-001",
  });
  assert.equal(submitted.status, "SUBMITTED");

  const duplicate = await service.recordExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    authorizationId: authorization.id,
    fingerprint,
    transactionHash: TX_HASH,
    idempotencyKey: "execute-001",
  });
  assert.equal(duplicate.id, submitted.id);
  assert.equal(duplicate.idempotentReplay, true);

  await assert.rejects(
    () => service.recordExecution({
        tenantId: "tenant_demo",
        intentId: intent.id,
        authorizationId: authorization.id,
        fingerprint,
        transactionHash: `0x${"ef".repeat(32)}`,
        idempotencyKey: "execute-second-broadcast",
      }),
    (error) => isGuardError(error, "IDEMPOTENCY_CONFLICT"),
    "one authorization/intent cannot record a second broadcast",
  );

  const uncertain = await service.reconcileExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    transactionHash: TX_HASH,
    observedState: "RPC_UNCERTAIN_AFTER_BROADCAST",
    idempotencyKey: "reconcile-uncertain-001",
  });
  assert.equal(uncertain.status, "RECONCILIATION_REQUIRED");
  assert.equal(uncertain.reconciliationStatus, "RECONCILIATION_REQUIRED");
  const uncertainReplay = await service.reconcileExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    transactionHash: TX_HASH,
    observedState: "RPC_UNCERTAIN_AFTER_BROADCAST",
    idempotencyKey: "reconcile-uncertain-001",
  });
  assert.equal(uncertainReplay.idempotentReplay, true);

  await assert.rejects(
    () => service.reconcileExecution({
        tenantId: "tenant_demo",
        intentId: intent.id,
        transactionHash: TX_HASH,
        observedState: "CONFIRMED",
        actualOutcome: {
          amountIn: "10.00",
          amountOut: "9.95",
          feeAmount: "0.02",
          explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH}`,
        },
        idempotencyKey: "reconcile-confirmed-without-provenance",
      }),
    (error) => isGuardError(error, "EVIDENCE_INSUFFICIENT"),
  );

  const reconciliationEvidence = {
    provider: "Partner application",
    sourceRef: `partner-reported:${TX_HASH}`,
    verificationStatus: "PROVIDER_REPORTED",
    responseDigest: `0x${"cd".repeat(32)}`,
  };

  const confirmed = await service.reconcileExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    transactionHash: TX_HASH,
    observedState: "CONFIRMED",
    actualOutcome: {
      amountIn: "10.00",
      amountOut: "9.95",
      feeAmount: "0.02",
      explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH}`,
    },
    reconciliationEvidence,
    idempotencyKey: "reconcile-confirmed-001",
  });
  assert.equal(confirmed.status, "CONFIRMED");
  const confirmedReplay = await service.reconcileExecution({
    tenantId: "tenant_demo",
    intentId: intent.id,
    transactionHash: TX_HASH,
    observedState: "CONFIRMED",
    actualOutcome: {
      amountIn: "10.00",
      amountOut: "9.95",
      feeAmount: "0.02",
      explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH}`,
    },
    reconciliationEvidence,
    idempotencyKey: "reconcile-confirmed-001",
  });
  assert.equal(confirmedReplay.idempotentReplay, true);

  const receipt = await service.getReceipt({ tenantId: "tenant_demo", intentId: intent.id });
  assert.equal(receipt.execution.transactionHash, TX_HASH);
  assert.equal(receipt.execution.status, "CONFIRMED");
  assert.equal(receipt.authorization.method, "PARTNER_AUTHENTICATED");
  assert.equal(receipt.reconciliation.expected.amountOut, "9.96");
  assert.equal(receipt.reconciliation.actual.amountOut, "9.95");
  assert.deepEqual(receipt.expectedEffects, receipt.reconciliation.expected);
  assert.deepEqual(receipt.actualEffects, receipt.reconciliation.actual);
  assert.equal(receipt.reconciliationStatus, "MATCHED");
  assert.equal(receipt.evidenceStatus, "COMPLETE");
  assert.equal(receipt.policyDecision, "ALLOWED_BY_POLICY");
  assert.equal(receipt.executionStatus, "CONFIRMED");
  assert.equal(receipt.policyVersion, 1);
  assert.equal(receipt.policyDigest, evaluation.policyDigest);
  assert.equal(receipt.preflightHash, evaluation.preflightHash);
  assert.match(receipt.receiptHash, /^0x[0-9a-f]{64}$/);
  assert.equal(DecisionSettlementReceiptSchema.safeParse(receipt).success, true);
  assert.equal(verifyIntegrityEnvelope(receipt), true);
  assert.equal(verifyIntegrityEnvelope({ ...receipt, actualEffects: { ...receipt.actualEffects, amountOut: "9.94" } }), false);

  assert.equal(receipt.reconciliation.evidence.verificationStatus, "PROVIDER_REPORTED");
  assert.equal(receipt.reconciliation.evidence.responseDigest, reconciliationEvidence.responseDigest);
  assert.equal(receipt.limitations.includes("PARTNER_REPORTED_RECONCILIATION"), true);
  assert.equal(receipt.finalizedAt, NOW);
  assert.equal(receipt.limitations.includes("HACKATHON_PROTOTYPE"), true);
});
