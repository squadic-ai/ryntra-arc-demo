# Ryntra Guard API v1

This contract exposes provider-neutral decision and settlement evidence. `evidenceStatus`, `policyDecision`, authorization state, and `executionStatus` are independently serialized; clients must not infer one from another.

## Server-to-server contract

```http
POST /v1/intents
GET  /v1/intents/{intentId}
POST /v1/intents/{intentId}/preflight
GET  /v1/evaluations/{evaluationId}
POST /v1/intents/{intentId}/authorize
POST /v1/intents/{intentId}/executions
GET  /v1/intents/{intentId}/status
GET  /v1/intents/{intentId}/receipt
GET  /v1/capabilities
GET  /health
```

The machine-readable contract is [ryntra-guard-v1.yaml](../../openapi/ryntra-guard-v1.yaml). The private headless SDK example is under `packages/guard-sdk`; the partner-style server example is `examples/partner-arc-app/server-flow.ts`. The package is not published to npm.

## Security contract

- Bearer authentication is server-to-server only.
- `RYNTRA_GUARD_DEMO_API_KEY` and `RYNTRA_GUARD_DEMO_TENANT_ID` must both exist or the API fails closed.
- Every state-changing request requires a bounded `Idempotency-Key`.
- An idempotency key is scoped to tenant and operation; same key/same payload replays the original result, while changed payload returns `IDEMPOTENCY_CONFLICT`.
- Correlation IDs are accepted only in a bounded character set or generated server-side.
- Requests are JSON-only and bounded to 64 KiB.
- Private/no-store headers are returned.
- The SDK never accepts or manages a wallet private key.

## Stable error shape

```json
{
  "error": {
    "code": "EVALUATION_EXPIRED",
    "message": "The readiness evaluation has expired.",
    "retryable": true,
    "requiredAction": "CREATE_NEW_EVALUATION",
    "correlationId": "corr_..."
  }
}
```

Implemented codes include validation, authentication, tenant isolation, capability unavailable, insufficient evidence, policy block, authorization required/expired, evaluation expired, fingerprint mismatch, idempotency conflict, unconfirmed execution, recovery/reconciliation required, and rate limiting.

## Prototype browser boundary

`/api/arc-guard` exists only for the reference client. It uses an opaque HttpOnly session, same-origin calls, strict rate limiting, a fixed Arc Testnet policy, and a server-only Circle App Kit estimate credential. It is not a replacement for partner authentication and must not be represented as multi-tenant production infrastructure.

## Small TypeScript integration example

```ts
const intent = await ryntra.intents.create(input, { idempotencyKey });
const evaluation = await ryntra.preflight(intent.id, evidence);

if (evaluation.policyDecision === "BLOCKED_BY_RULE") return showBlockers(evaluation);
if (evaluation.evidenceStatus !== "COMPLETE") return showMissing(evaluation);

const authorization = await ryntra.authorize({
  intentId: intent.id,
  evaluationId: evaluation.id,
  executionFingerprint,
});

// The partner wallet signs and broadcasts. Ryntra never receives its key.
```

## Known API limitations

Persistence is configuration, and the API reports it rather than assuming it. With the default `memory` store the lifecycle is lost on cold start; with `RYNTRA_GUARD_STORE=file` plus `RYNTRA_GUARD_STORE_DIR` it survives cold start for a single writer; with `RYNTRA_GUARD_STORE=postgres` plus `DATABASE_URL` it survives cold start and concurrent writers. `GET /v1/intents/{intentId}/status` returns the exact adapter limitation in `limitations`, and `GET /health` returns `persistence`, `deployment`, and `stateChangesAccepted`.

`RYNTRA_GUARD_STORE=postgres` with `DATABASE_URL` survives cold start and concurrent instances, and is the only configuration a multi-instance deployment accepts. Any other store returns `503 CAPABILITY_UNAVAILABLE` there for every state-changing call, with `requiredAction: CONFIGURE_DURABLE_MULTI_WRITER_GUARD_STORE`; reads stay available so the reason is visible.

The adapter has not yet run against a live database — its round-trip, concurrent-claim and tenant-isolation tests skip without `DATABASE_URL`. Tenant scoping is enforced by key prefix inside one shared table; production partner use additionally requires database-level tenant isolation.

The App Kit swap estimate is request-bound rather than exact-calldata-bound and therefore cannot yet proceed to wallet execution. The separate EOA ERC-20 USDC fallback has exact EVM binding but remains **NOT VERIFIED live** until a founder-approved wallet action produces a real transaction hash and Arcscan evidence.
