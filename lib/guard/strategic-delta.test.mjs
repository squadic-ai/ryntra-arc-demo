// Run from repo root: node --test lib/guard/strategic-delta.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const HASH_A = `0x${"ab".repeat(32)}`;
const HASH_B = `0x${"cd".repeat(32)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

test("provider-neutral evidence fields are explicit and unavailable coverage cannot allow policy", async () => {
  const [{ EvidenceItemSchema }, { evaluateGuardReadiness }] = await Promise.all([
    import("./contracts.ts"),
    import("./kernel.ts"),
  ]);
  const evidence = EvidenceItemSchema.parse({
    schemaVersion: "1.0.0",
    id: "ev_provider_neutral_001",
    provider: "Circle App Kit",
    sourceRef: "circle-app-kit:estimateSwap",
    adapter: "circle-app-kit",
    adapterVersion: "1.11.0",
    sourceType: "SWAP_QUOTE",
    observedAt: "2026-08-06T11:59:30.000Z",
    receivedAt: "2026-08-06T11:59:31.000Z",
    validUntil: "2026-08-06T12:01:30.000Z",
    confidence: "PROVIDER_REPORTED",
    coverage: {
      subjectRefs: ["eip155:5042002"],
      fields: ["amountIn", "expectedAmountOut", "minimumAmountOut"],
      limitations: ["UNDERLYING_ROUTE_UNAVAILABLE"],
    },
    availability: "AVAILABLE",
    verificationStatus: "PROVIDER_REPORTED",
    chainRef: "eip155:5042002",
    blockRef: null,
    transactionRef: null,
    status: "VALID",
    requestHash: HASH_A,
    responseHash: HASH_B,
    responseDigest: HASH_B,
    reason: null,
    transformationVersion: "arc-swap-quote-v1",
    fallbackUsed: false,
    facts: {
      quoteRef: "quote_arc_001",
      providerRef: "circle-app-kit",
      routeRef: "circle-app-kit:swap",
      sellAssetRef: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
      buyAssetRef: "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a",
      amountIn: "10.00",
      expectedAmountOut: "9.96",
      minimumAmountOut: "9.93",
      feeAmount: "0.02",
      totalDebit: "10.02",
      slippageBps: "20",
    },
  });

  assert.equal(evidence.responseDigest, evidence.responseHash);
  assert.equal(
    EvidenceItemSchema.safeParse({ ...evidence, responseDigest: HASH_A }).success,
    false,
  );

  const policy = {
    rules: [
      { id: "allowed-chain", type: "ALLOWED_CHAIN", value: "eip155:5042002" },
      {
        id: "allowed-pair",
        type: "ALLOWED_PAIR",
        value: [evidence.facts.sellAssetRef, evidence.facts.buyAssetRef],
      },
      { id: "max-total-debit", type: "MAX_TOTAL_DEBIT", value: "100.00" },
      { id: "max-quote-age", type: "MAX_QUOTE_AGE_SECONDS", value: 120 },
      { id: "max-slippage", type: "MAX_SLIPPAGE_BPS", value: "25" },
      { id: "human-auth", type: "HUMAN_AUTHORIZATION_REQUIRED", value: true },
    ],
  };
  const intent = {
    chainRef: "eip155:5042002",
    sellAssetRef: evidence.facts.sellAssetRef,
    buyAssetRef: evidence.facts.buyAssetRef,
    quoteRef: evidence.facts.quoteRef,
  };
  const allowed = evaluateGuardReadiness({
    intent,
    evidence: [evidence],
    policy,
    now: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(allowed.evidenceStatus, "COMPLETE");
  assert.equal(allowed.policyDecision, "ALLOWED_BY_POLICY");
  assert.equal(allowed.executionStatus, "NOT_STARTED");

  const unavailable = evaluateGuardReadiness({
    intent,
    evidence: [
      {
        ...evidence,
        availability: "UNAVAILABLE",
        status: "UNAVAILABLE",
        reason: "PROVIDER_TIMEOUT",
      },
    ],
    policy,
    now: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(unavailable.evidenceStatus, "UNAVAILABLE");
  assert.equal(unavailable.policyDecision, "INSUFFICIENT_EVIDENCE");
  assert.notEqual(unavailable.policyDecision, "ALLOWED_BY_POLICY");
});

test("Arc native and ERC-20 USDC units stay distinct and fallback binds exact EOA transfer calldata", async () => {
  const [
    { arcUsdcAmountToBaseUnits, arcUsdcBaseUnitsToAmount },
    {
      buildArcUsdcTransferIntent,
      prepareArcUsdcTreasuryTransfer,
      reconcileArcUsdcTreasuryTransfer,
    },
  ] = await Promise.all([import("./arc-app-kit.ts"), import("./arc-usdc-transfer.ts")]);

  assert.equal(arcUsdcAmountToBaseUnits("1.000001", "ERC20"), 1_000_001n);
  assert.equal(
    arcUsdcAmountToBaseUnits("1.000000000000000001", "NATIVE"),
    1_000_000_000_000_000_001n,
  );
  assert.equal(arcUsdcBaseUnitsToAmount(1_000_001n, "ERC20"), "1.000001");
  assert.throws(() => arcUsdcAmountToBaseUnits("1.0000001", "ERC20"));

  const prepared = await prepareArcUsdcTreasuryTransfer({
    request: {
      walletType: "EOA",
      walletAddress: WALLET,
      recipientAddress: RECIPIENT,
      amount: "1.000001",
    },
    collectOnchainState: async () => ({
      chainId: 5_042_002,
      blockNumber: "123456",
      contractCodeDigest: HASH_A,
      decimals: 6,
      tokenBalanceBaseUnits: "2000000",
      nativeBalanceBaseUnits: "1000000000000000000",
      gasLimit: "65000",
      gasPriceBaseUnits: "1000000000",
    }),
    now: () => "2026-08-06T12:00:00.000Z",
  });

  assert.equal(prepared.transaction.to, "0x3600000000000000000000000000000000000000");
  assert.equal(prepared.transaction.value, "0x0");
  assert.match(prepared.transaction.data, /^0xa9059cbb[0-9a-f]{128}$/);
  assert.equal(prepared.evidence.availability, "AVAILABLE");
  assert.equal(prepared.evidence.verificationStatus, "ONCHAIN_VERIFIED");
  assert.equal(prepared.evidence.facts.amountIn, "1.000001");
  assert.equal(prepared.evidence.facts.expectedAmountOut, "1.000001");
  assert.equal(prepared.binding.productionCalldataBound, true);
  assert.equal(prepared.binding.target, prepared.transaction.to);
  assert.match(prepared.binding.calldataHash, /^0x[0-9a-f]{64}$/);

  const intent = buildArcUsdcTransferIntent({
    tenantId: "tenant_demo",
    intentId: "int_arc_transfer_001",
    idempotencyKey: "idem-arc-transfer-001",
    prepared,
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(intent.actionType, "SEND");
  assert.equal(intent.walletType, "EOA");
  assert.equal(intent.target, prepared.transaction.to);
  assert.equal(intent.calldataHash, prepared.binding.calldataHash);
  assert.equal(intent.policyRef.id, "demo-arc-usdc-transfer-policy");

  const txHash = `0x${"ef".repeat(32)}`;
  const confirmed = await reconcileArcUsdcTreasuryTransfer({
    transactionHash: txHash,
    intent,
    collectTransactionState: async () => ({
      transactionFound: true,
      receiptFound: true,
      receiptStatus: "success",
      from: WALLET,
      to: prepared.transaction.to,
      input: prepared.transaction.data,
      valueBaseUnits: "0",
      transferFrom: WALLET,
      transferTo: RECIPIENT,
      transferAmountBaseUnits: "1000001",
      gasUsed: "50000",
      effectiveGasPriceBaseUnits: "1000000000",
    }),
  });
  assert.equal(confirmed.observedState, "CONFIRMED");
  assert.deepEqual(confirmed.actualOutcome, {
    amountIn: "1.000001",
    amountOut: "1.000001",
    feeAmount: "0.00005",
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  });

  await assert.rejects(
    () =>
      reconcileArcUsdcTreasuryTransfer({
        transactionHash: txHash,
        intent,
        collectTransactionState: async () => ({
          transactionFound: true,
          receiptFound: true,
          receiptStatus: "success",
          from: WALLET,
          to: prepared.transaction.to,
          input: prepared.transaction.data,
          valueBaseUnits: "0",
          transferFrom: WALLET,
          transferTo: WALLET,
          transferAmountBaseUnits: "1000001",
          gasUsed: "50000",
          effectiveGasPriceBaseUnits: "1000000000",
        }),
      }),
    (error) => error?.code === "FINGERPRINT_MISMATCH",
  );

  await assert.rejects(
    () =>
      prepareArcUsdcTreasuryTransfer({
        request: {
          walletType: "EOA",
          walletAddress: WALLET,
          recipientAddress: RECIPIENT,
          amount: "1.00",
        },
        collectOnchainState: async () => ({
          chainId: 1,
          blockNumber: "123456",
          contractCodeDigest: HASH_A,
          decimals: 6,
          tokenBalanceBaseUnits: "2000000",
          nativeBalanceBaseUnits: "1000000000000000000",
          gasLimit: "65000",
          gasPriceBaseUnits: "1000000000",
        }),
      }),
    /chain ID/i,
  );

  await assert.rejects(
    () =>
      prepareArcUsdcTreasuryTransfer({
        request: {
          walletType: "SAFE",
          walletAddress: WALLET,
          recipientAddress: RECIPIENT,
          amount: "1.00",
        },
        collectOnchainState: async () => {
          throw new Error("must not probe unsupported wallet");
        },
      }),
    /EOA/,
  );
});
