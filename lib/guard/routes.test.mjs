// Run from repo root: node --test lib/guard/routes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

const routeFiles = [
  "../../app/v1/intents/route.ts",
  "../../app/v1/intents/[intentId]/route.ts",
  "../../app/v1/intents/[intentId]/preflight/route.ts",
  "../../app/v1/evaluations/[evaluationId]/route.ts",
  "../../app/v1/intents/[intentId]/authorize/route.ts",
  "../../app/v1/intents/[intentId]/executions/route.ts",
  "../../app/v1/intents/[intentId]/status/route.ts",
  "../../app/v1/intents/[intentId]/receipt/route.ts",
  "../../app/v1/capabilities/route.ts",
  "../../app/health/route.ts",
];

test("the exact versioned Guard endpoint files exist", async () => {
  for (const file of routeFiles) await access(new URL(file, import.meta.url));
});

test("health and capability routes disclose prototype truth without authentication", async () => {
  const [{ GET: health }, { GET: capabilities }] = await Promise.all([
    import("../../app/health/route.ts"),
    import("../../app/v1/capabilities/route.ts"),
  ]);
  const healthResponse = await health(new Request("https://ryntra.test/health"));
  assert.equal(healthResponse.status, 200);
  /* Persistence and deployment are reported from the configured adapter. Under
     `node --test` no store is configured, so the honest answer is the ephemeral
     one — and a reviewer must be able to read that from /health rather than
     infer it. */
  const { RECORDED_RUN } = await import("../../app/arc/arc-project.ts");
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    service: "ryntra-guard",
    environment: "ARC_TESTNET",
    persistence: "EPHEMERAL_SINGLE_INSTANCE",
    persistenceDetail: "in-process memory (demo only; lost on cold start)",
    deployment: "SINGLE_INSTANCE",
    stateChangesAccepted: true,
    /* Derived from the recorded proof, not pinned to a literal. The previous
       version asserted `NOT_VERIFIED` and kept passing the day after Gate B —
       a test that pins a constant cannot notice the world changed, and this
       one had already helped a stale capability survive on three surfaces. */
    liveArcExecution: RECORDED_RUN.transactionHash ? "TESTNET_VERIFIED" : "NOT_VERIFIED",
    verifiedOperation: RECORDED_RUN.transactionHash
      ? "EOA_USDC_ERC20_TREASURY_TRANSFER"
      : null,
    /* Unconditional: whatever the transfer proved, the swap is not covered. */
    swapExecution: "NOT_VERIFIED",
  });
  const capabilityResponse = await capabilities(new Request("https://ryntra.test/v1/capabilities"));
  assert.equal(capabilityResponse.status, 200);
  const capabilityBody = await capabilityResponse.json();
  assert.equal(capabilityBody.data.some((entry) => entry.state === "LIVE" && entry.environment === "PRODUCTION"), false);
});

test("authenticated intent and preflight routes enforce tenant scope and structured errors", async () => {
  process.env.RYNTRA_GUARD_DEMO_API_KEY = "test-server-secret";
  process.env.RYNTRA_GUARD_DEMO_TENANT_ID = "tenant_route_test";
  const [{ POST: createIntent }, { GET: getIntent }, { POST: preflight }] = await Promise.all([
    import("../../app/v1/intents/route.ts"),
    import("../../app/v1/intents/[intentId]/route.ts"),
    import("../../app/v1/intents/[intentId]/preflight/route.ts"),
  ]);

  const now = Date.now();
  const observedAt = new Date(now - 1_000).toISOString();
  const validUntil = new Date(now + 60_000).toISOString();
  const body = {
    applicationId: "partner_arc_app",
    externalPartnerId: "route-test-order",
    subjectRef: "subject:route-test",
    walletAddress: "0x1111111111111111111111111111111111111111",
    walletType: "EOA",
    chainRef: "eip155:5042002",
    environment: "ARC_TESTNET",
    actionType: "SWAP",
    instrumentRef: "arc-testnet:stablecoin-fx:usdc-eurc",
    sellAssetRef: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
    buyAssetRef: "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a",
    amount: "10.00",
    amountType: "EXACT_INPUT",
    recipient: "0x1111111111111111111111111111111111111111",
    venueRef: "circle-app-kit",
    routeRef: "circle-app-kit:swap:Arc_Testnet",
    quoteRef: "quote_route_test",
    target: "0x2222222222222222222222222222222222222222",
    calldataHash: `0x${"ab".repeat(32)}`,
    nativeValue: "0",
    portfolioSnapshotRef: null,
    policyRef: { id: "demo-stablecoin-policy", version: 1 },
    expiresAt: new Date(now + 120_000).toISOString(),
  };
  const headers = {
    authorization: "Bearer test-server-secret",
    "content-type": "application/json",
    "idempotency-key": "idem-route-create-001",
    "x-correlation-id": "corr-route-create-001",
  };
  const createdResponse = await createIntent(
    new Request("https://ryntra.test/v1/intents", { method: "POST", headers, body: JSON.stringify(body) }),
  );
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("x-correlation-id"), "corr-route-create-001");
  const created = (await createdResponse.json()).data;

  const unauthorized = await getIntent(
    new Request(`https://ryntra.test/v1/intents/${created.id}`),
    { params: Promise.resolve({ intentId: created.id }) },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "AUTHENTICATION_REQUIRED");

  const fetched = await getIntent(
    new Request(`https://ryntra.test/v1/intents/${created.id}`, { headers: { authorization: "Bearer test-server-secret" } }),
    { params: Promise.resolve({ intentId: created.id }) },
  );
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).data.tenantId, "tenant_route_test");

  const evidence = {
    schemaVersion: "1.0.0",
    id: "ev_route_test",
    provider: "Circle App Kit",
    sourceRef: "circle-app-kit:estimateSwap",
    adapter: "circle-app-kit",
    adapterVersion: "1.11.0",
    sourceType: "SWAP_QUOTE",
    observedAt,
    receivedAt: observedAt,
    validUntil,
    confidence: "PROVIDER_REPORTED",
    coverage: {
      subjectRefs: ["eip155:5042002", body.sellAssetRef, body.buyAssetRef],
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
    transformationVersion: "arc-app-kit-estimate-v1",
    fallbackUsed: false,
    facts: {
      quoteRef: "quote_route_test",
      providerRef: "circle-app-kit",
      routeRef: "circle-app-kit:swap:Arc_Testnet",
      sellAssetRef: body.sellAssetRef,
      buyAssetRef: body.buyAssetRef,
      amountIn: "10.00",
      expectedAmountOut: "9.96",
      minimumAmountOut: "9.93",
      feeAmount: "0.02",
      totalDebit: "10.02",
      slippageBps: "20",
    },
  };
  const preflightResponse = await preflight(
    new Request(`https://ryntra.test/v1/intents/${created.id}/preflight`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "idem-route-preflight-001" },
      body: JSON.stringify({ evidence: [evidence] }),
    }),
    { params: Promise.resolve({ intentId: created.id }) },
  );
  assert.equal(preflightResponse.status, 200);
  const evaluation = (await preflightResponse.json()).data;
  assert.equal(evaluation.outcome, "ALLOWED_BY_POLICY");
  assert.equal("_evidence" in evaluation, false);
});

test("a multi-instance deployment without a multi-writer store refuses every state change", async () => {
  /* The runtime is cached per process, so the deployment shape is swapped and
     the cache cleared around this test. What is asserted is the rule the packet
     turns on: an ephemeral store behind several instances must fail closed with
     a structured error, never accept an intent it will lose. */
  process.env.RYNTRA_GUARD_DEMO_API_KEY = "test-server-secret";
  process.env.RYNTRA_GUARD_DEMO_TENANT_ID = "tenant_route_test";
  const previousDeployment = process.env.RYNTRA_GUARD_DEPLOYMENT;
  const previousRuntime = globalThis.__ryntraGuardPrototypeRuntime;
  process.env.RYNTRA_GUARD_DEPLOYMENT = "multi-instance";
  delete globalThis.__ryntraGuardPrototypeRuntime;

  try {
    const { POST: createIntent } = await import("../../app/v1/intents/route.ts");
    const blocked = await createIntent(
      new Request("https://ryntra.test/v1/intents", {
        method: "POST",
        headers: {
          authorization: "Bearer test-server-secret",
          "content-type": "application/json",
          "idempotency-key": "idem-route-durability-001",
        },
        body: JSON.stringify({ amount: "10.00" }),
      }),
    );
    assert.equal(blocked.status, 503);
    const body = await blocked.json();
    assert.equal(body.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(body.error.requiredAction, "CONFIGURE_DURABLE_MULTI_WRITER_GUARD_STORE");
    assert.match(body.error.message, /multi-instance deployment/i);

    // Reads stay available so a reviewer can still see why writes are refused.
    const { GET: health } = await import("../../app/health/route.ts");
    const healthBody = await (await health(new Request("https://ryntra.test/health"))).json();
    assert.equal(healthBody.deployment, "MULTI_INSTANCE");
    assert.equal(healthBody.stateChangesAccepted, false);
  } finally {
    if (previousDeployment === undefined) delete process.env.RYNTRA_GUARD_DEPLOYMENT;
    else process.env.RYNTRA_GUARD_DEPLOYMENT = previousDeployment;
    if (previousRuntime === undefined) delete globalThis.__ryntraGuardPrototypeRuntime;
    else globalThis.__ryntraGuardPrototypeRuntime = previousRuntime;
  }
});
