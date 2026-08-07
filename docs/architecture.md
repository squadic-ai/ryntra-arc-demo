# Architecture — Ryntra Guard for Arc

## Product boundary

Ryntra Guard is a provider-neutral **Decision & Settlement Evidence Layer for programmable money**. It normalizes a financial intent, records required and available evidence with provenance and freshness, evaluates versioned financial policies, preserves the user-authorization boundary, and reconciles expected effects with the final onchain result. Ryntra Workspace is its reference client. Arc is the first specialist pack and submission environment. Arcus remains a separate execution adapter and the current verified venue path.

The existing exact-input USDC-to-EURC App Kit path remains intact and is not rewritten for presentation. Because it is not confirmed end-to-end, the source also exposes one bounded fallback: a direct-EOA ERC-20 USDC treasury transfer on Arc Testnet. The fallback is labelled as a transfer, never a swap, and uses an exact target/calldata/value fingerprint.

This layer is not presented as the first transaction firewall, the first policy engine, or the only receipt product. Hypernative Transaction Guard, Blockaid Cosigner, Fordefi, Fireblocks, Turnkey, Circle Agent Wallet policies, Circle Compliance Engine, and Arc Transaction Memos are direct competitors, adjacent controls, or substitutes depending on the integration. Ryntra records a provider result only when working code and credentials actually exist; this prototype claims none of those live integrations.

## Current request path

```text
Partner reference client (/arc-guard)
  -> same-origin demo session (HttpOnly, SameSite=Strict)
  -> choose one honestly labelled path
     -> preserved Circle App Kit swap estimate (server-only key; execution binding incomplete)
     OR
     -> EOA ERC-20 USDC transfer (live RPC evidence; exact calldata binding)
  -> normalized EvidenceItem + provenance/freshness/digests
  -> versioned ExecutionIntent + expectedEffects
  -> deterministic versioned policy evaluation
  -> partner-authenticated HumanAuthorization bound to preflightHash
  -> separate owner wallet signature
  -> transaction observation + actualEffects
  -> reconciliationStatus + receiptHash
```

The independent B2B contract is available separately:

```text
Partner server
  -> tenant-scoped Bearer key
  -> /v1 Intent / Preflight / Authorization / Execution / Receipt
  -> private headless TypeScript integration client
```

## Trust boundaries

1. **Circle credential boundary.** `CIRCLE_APP_KIT_KEY` is read only by the Node.js route. It is never returned, logged, placed in telemetry, or prefixed with `NEXT_PUBLIC_`.
2. **Wallet boundary.** The partner/user wallet owns transaction signing. Ryntra receives no private key, seed phrase, entity secret, withdrawal authority, or custody.
3. **Decision boundary.** The policy engine is deterministic. An LLM does not return a structured policy outcome or authorize execution.
4. **Evidence boundary.** Missing, stale, conflicting, unavailable, unsupported, and fallback evidence remain explicit. A timeout or unsupported coverage cannot produce `ALLOWED_BY_POLICY`; provider errors are never converted to zero.
5. **Execution boundary.** The current App Kit estimate does not expose final target/calldata. The prototype labels its binding `APP_KIT_REQUEST_NOT_CALLDATA` and disables swap execution until an exact external-signing payload can be verified. The EOA transfer path binds the ERC-20 contract target, transfer calldata, native value, amount, recipient, chain, and expiry.
6. **Persistence boundary.** The lifecycle lives behind an asynchronous store port (`lib/guard/store.ts`) with three adapters, and the adapter — never a constant — decides what the API is allowed to claim:

   | Adapter | `RYNTRA_GUARD_STORE` | Durability | Reported limitation |
   |---|---|---|---|
   | in-process memory | `memory` (default) | lost on cold start | `EPHEMERAL_SINGLE_INSTANCE_STORE` |
   | JSON files | `file` + `RYNTRA_GUARD_STORE_DIR` | survives cold start, one writer | `DURABLE_SINGLE_WRITER_STORE` |
   | Postgres | `postgres` + `DATABASE_URL` | survives cold start and concurrent writers | `DURABLE_MULTI_WRITER_STORE` |

   The port carries `insertIfAbsent`, which is the one operation that cannot be composed from the others. Read-then-write is a race — two instances both see an idempotency key, an intent id or a transaction hash unclaimed, and both write. That window does not exist on a single writer, which is why the guarantee belongs to the adapter rather than the caller: the caller cannot tell which adapter it is talking to. The Postgres adapter settles it with `INSERT … ON CONFLICT DO NOTHING`; the in-process adapters settle it by running to completion without an intervening `await`.

   The port is asynchronous for the same reason. A store safe for concurrent writers lives across a network, and the previous synchronous `Map`-shaped surface made one unrepresentable — which is why a multi-instance deployment had to refuse every state change outright.

   Postgres is reached over TLS verified against the system trust store. That connection carries the authorization and settlement record, so an unverified peer would let anyone on the path read and rewrite the evidence the system exists to preserve.

   When the deployment is multi-instance — declared by `RYNTRA_GUARD_DEPLOYMENT`, assumed on a managed platform — a store weaker than multi-writer refuses every state-changing request with `CAPABILITY_UNAVAILABLE` and `requiredAction: CONFIGURE_DURABLE_MULTI_WRITER_GUARD_STORE`. Naming a durable adapter without its configuration is a startup error rather than a silent downgrade. `/health` reports the configured persistence, the deployment shape, and whether state changes are accepted.
7. **Memo boundary.** `memoSupported` is currently `false`. Any future Arc memo may contain only a digest/reference, must use a verified direct EOA caller, and may not claim SCA, Safe, or ERC-4337 support.

## Domain objects

- `ExecutionIntent` — exact tenant/application, subject, wallet, chain, asset, decimal amount, recipient, venue/route, policy, revision, expiry, and idempotency binding.
- `EvidenceItem` — `provider`, `sourceRef`, `observedAt`, `validUntil`, `coverage`, `availability`, `verificationStatus`, `responseDigest`, `reason`, adapter/version, confidence, fallback, and source state.
- `RiskSignal` — fact or computed feature, never permission.
- `PolicyResult` — immutable `policyVersion`/`policyDigest`, rule versions, evidence references, and deterministic `policyDecision`.
- `HumanAuthorization` — exact intent/evaluation/evidence/policy/fingerprint plus `preflightHash`, separate from wallet signature.
- `ExecutionFingerprint` — request or transaction material fields with expiry; the transfer path binds exact EVM target/calldata/value.
- `ReadinessEnvelope` — pre-execution snapshot with independent `evidenceStatus`, `policyDecision`, authorization status, and execution status.
- `DecisionSettlementReceipt` — append-oriented `expectedEffects`, `actualEffects`, `reconciliationStatus`, `preflightHash`, `receiptHash`, settlement state, and transaction evidence.

## Independent status axes

`evidenceStatus`, `policyDecision`, authorization status, and `executionStatus` are separate. Evidence completeness is not a market claim. `ALLOWED_BY_POLICY` does not mean human-approved; human authorization does not mean wallet-signed; `SUBMITTED` does not mean confirmed; an RPC timeout after broadcast becomes `RECONCILIATION_REQUIRED`, not automatic failure.

## Arc USDC interface normalization

- Arc native USDC: 18 decimals; used for native balance and gas accounting.
- Arc Testnet ERC-20 USDC: 6 decimals; used by the transfer calldata and ERC-20 balance.
- Conversion uses decimal strings and `BigInt`; excess precision and scientific notation are rejected rather than rounded.

## Production hardening path

Before an external pilot, replace the prototype session and store with scoped API credentials or OAuth client credentials, database-level tenant isolation, durable append-oriented objects, tenant-aware queues/cache, signed webhooks, observability, secret rotation, receipt offline verification, and recovery runbooks. Implement a short-lived, one-time decision token bound to a final transaction fingerprint. None of those future items is claimed as present.
