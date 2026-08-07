// Run from repo root: node --test lib/guard/arc-demo-route.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

async function loadRoute() {
  try {
    return await import("../../app/api/arc-guard/route.ts");
  } catch (error) {
    assert.fail(`Arc Guard demo route is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("GET exposes only truthful testnet capability state and creates an httpOnly session", async () => {
  const { GET } = await loadRoute();
  const response = await GET(new Request("http://localhost/api/arc-guard"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.chainRef, "eip155:5042002");
  assert.equal(body.data.environment, "ARC_TESTNET");

  /* Execution state is checked against the recorded proof rather than against a
     literal. The previous version of this test asserted `false` with a `null`
     hash — written before Gate B and still passing the day after it, which is
     how the surface came to advertise LIVE TX UNVERIFIED over a real
     transaction. A test that pins a constant cannot notice the world changed;
     one that pins the relationship can. */
  const { RECORDED_RUN } = await import("../../app/arc/arc-project.ts");
  assert.equal(body.data.transactionHash, RECORDED_RUN.transactionHash);
  assert.equal(body.data.explorerUrl, RECORDED_RUN.explorerUrl);
  assert.equal(body.data.liveExecutionVerified, Boolean(RECORDED_RUN.transactionHash));
  assert.equal(
    body.data.limitations.includes("LIVE_EXECUTION_NOT_VERIFIED"),
    !RECORDED_RUN.transactionHash,
  );

  /* Whatever the transfer proved, the swap is not covered by it. This one must
     hold unconditionally: it is the exact overclaim the label invites. */
  assert.ok(body.data.limitations.includes("SWAP_NOT_VERIFIED"));
  assert.equal(body.data.circleCredentialConfigured, false);
  assert.match(response.headers.get("set-cookie") ?? "", /ryntra_arc_demo_session=/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("valid estimate request fails closed when the server-side Circle credential is absent", async () => {
  const { POST } = await loadRoute();
  const previous = process.env.CIRCLE_APP_KIT_KEY;
  delete process.env.CIRCLE_APP_KIT_KEY;
  try {
    const response = await POST(
      new Request("http://localhost/api/arc-guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "ESTIMATE_AND_PREFLIGHT",
          walletAddress: "0x1111111111111111111111111111111111111111",
          amountIn: "10.00",
          slippageBps: 20,
          idempotencyKey: "demo-estimate-12345678",
        }),
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(body.error.requiredAction, "CONFIGURE_SERVER_SIDE_CIRCLE_APP_KIT_KEY");
    assert.doesNotMatch(JSON.stringify(body), /KIT_KEY:/);
  } finally {
    if (previous === undefined) delete process.env.CIRCLE_APP_KIT_KEY;
    else process.env.CIRCLE_APP_KIT_KEY = previous;
  }
});

test("invalid public body receives the stable structured error contract", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://localhost/api/arc-guard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "ESTIMATE_AND_PREFLIGHT", amountIn: "1e3" }),
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.match(body.error.correlationId, /^corr_/);
  assert.equal(typeof body.error.retryable, "boolean");
});

test("authorization cannot cross an opaque demo session boundary", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("http://localhost/api/arc-guard", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ryntra_arc_demo_session=demo_11111111111111111111111111111111",
      },
      body: JSON.stringify({
        action: "AUTHORIZE",
        intentId: "int_unknown_12345678",
        evaluationId: "eval_unknown_12345678",
        fingerprint: {
          schemaVersion: "1.0.0",
          intentId: "int_unknown_12345678",
          intentRevision: 1,
          chainRef: "eip155:5042002",
          walletAddress: "0x1111111111111111111111111111111111111111",
          bindingKind: "APP_KIT_REQUEST",
          target: null,
          calldataHash: null,
          nativeValue: "0",
          adapterRequestHash: `0x${"1".repeat(64)}`,
          productionCalldataBound: false,
          sellAssetRef: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
          buyAssetRef: "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a",
          amount: "10.00",
          recipient: "0x1111111111111111111111111111111111111111",
          venueRef: "circle-app-kit",
          routeRef: "circle-app-kit:swap:Arc_Testnet",
          quoteHash: `0x${"2".repeat(64)}`,
          maxFee: "0.01",
          minimumOutput: "9.90",
          expiresAt: "2026-08-06T12:02:00.000Z",
        },
        idempotencyKey: "demo-authorize-12345678",
      }),
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, "TENANT_FORBIDDEN");
});
