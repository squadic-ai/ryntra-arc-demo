# Ryntra Guard for Arc

**Decision & Settlement Evidence for Programmable Money**

`ARC PUBLIC TESTNET` · `NON-CUSTODIAL` · `HUMAN-AUTHORIZED` · `REAL TX + EXPLORER` · `RECONCILED RECEIPT`

> **Status: TESTNET VERIFIED — direct-EOA ERC-20 USDC transfer only.**
> One real owner-authorized operation completed the full lifecycle on Arc Public Testnet. That
> qualifier travels with the label everywhere in this repository, because it is the only operation
> the claim covers.

`INDEPENDENT PROJECT` · `TESTNET ONLY` · `NOT AUDITED` · `NOT FINANCIAL ADVICE`

---

## What this is

A decision taken before signing does not prove what settled. Evidence can be stale, partial,
unavailable or in conflict at the moment it matters, and the effects a user authorized can differ
from the effects that landed on chain — and the comparison is often nobody's job.

Ryntra Guard checks a supported programmable-money intent against available evidence and a declared
policy **before** wallet authorization, tracks its Arc Testnet settlement, compares expected and
actual effects, and produces a structured, hash-checkable Execution Receipt.

This repository is the bounded Arc Public Testnet reference implementation: the deterministic
kernel, the versioned `/v1` HTTP API, its OpenAPI contract, a headless TypeScript client, one
runnable partner example, and the reference web client.

It is one surface of a larger product. Ryntra Workspace is the human-facing product; Ryntra Guard is
the developer and infrastructure surface. Both use the same Evidence Kernel and the same receipt
model — only Guard's Arc slice is in this repository.

---

## The lifecycle

```text
Intent
  → Evidence Status
    → Policy Decision
      → Human Authorization
        → Arc Testnet Settlement
          → Expected vs Actual Reconciliation
            → Execution Receipt
```

Four state axes stay **independent** and are serialized separately in every API response. Collapsing
them into one boolean is the design mistake this kernel exists to avoid:

| Axis | Values |
|---|---|
| `evidenceStatus` | `COMPLETE` `INCOMPLETE` `STALE` `CONFLICTING` `UNSUPPORTED` `SOURCE_ERROR` |
| `policyDecision` | `ALLOWED_BY_POLICY` `REVIEW_REQUIRED` `BLOCKED_BY_RULE` |
| `executionStatus` | `DRAFT` `NOT_SUBMITTED` `AUTHORIZED` `SUBMITTED` `PENDING` `CONFIRMED` `FAILED` `RECOVERY_REQUIRED` `CANCELLED` |
| `reconciliationStatus` | `NOT_APPLICABLE` `PENDING` `MATCHED` `WITHIN_TOLERANCE` `DRIFT_DETECTED` `INCOMPLETE` `UNRECONCILED` `FAILED` |

`ALLOWED_BY_POLICY` means one thing only: this exact intent matched this exact policy version given
the evidence available at evaluation time. It does not mean the asset is safe, the transaction is
legal, or the counterparty is trustworthy.

No model returns a decision, and no model can authorize. The policy engine is deterministic code.

---

## The recorded run

Every value below was read back from the chain or from the finalized receipt. The receipt hash and
its SHA-256 integrity digest were recomputed **independently of this application** before any of it
was published.

| Fact | Value |
|---|---|
| Network | Arc Public Testnet, chain `5042002` |
| Operation | Direct-EOA ERC-20 USDC transfer of `1.000000 USDC` |
| Transaction | `0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9` |
| Explorer | https://testnet.arcscan.app/tx/0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9 |
| Block / status | `55677295` · `0x1` SUCCESS |
| Intent | `int_58e9bf523de5438c9bc118b5ec1e7dd1` |
| Policy | `demo-arc-usdc-transfer-policy` v1 → `ALLOWED_BY_POLICY` |
| Expected fee | `0.001548973026 USDC` |
| Actual fee | `0.001530838950 USDC` (read from the chain, not the estimate) |
| Reconciliation | `MATCHED` · `ONCHAIN_VERIFIED` |
| Receipt | `rcpt_b6b010ec3d5e4be19b4c26cdfce28e73` · hash `0xb1530b1273adf5efd0a41ab194546da2c17f58d1842384a281dac173478e64f2` |

The canonical source for these facts is [`app/arc/arc-project.ts`](app/arc/arc-project.ts). The
landing page, the API and the health route all read from it, so no surface can drift from the run it
describes.

### The finding worth reading twice

Arc emitted this **single** movement as **two** `Transfer` events:

- `1000000000000000000` from the native precompile, at 18 decimals;
- `1000000` from the ERC-20 interface, at 6 decimals.

Reconciliation matches only the ERC-20 log, so the recorded amount is `1.000000 USDC`. An
integration that sums both, or reads the native log as 6-decimal, is wrong by a factor of 10^12.

This hazard was written into the Arc pack as `ARC_EVENT_DOUBLE_COUNT_RISK` **before** the run, and
then confirmed on a real transaction rather than inferred from documentation.

---

## Requirements

- Node.js 20.9+ (22 LTS recommended — the test runner uses `node --test`)
- npm 10+
- A browser wallet on Arc Public Testnet, funded with testnet USDC, to exercise the signing path

## Install, verify, run

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run dev
```

Then open http://localhost:3000 for the project overview and http://localhost:3000/arc/demo for the
direct demo.

`npm test` runs 73 tests. Four Postgres tests skip unless `DATABASE_URL` is set — they exercise the
multi-writer adapter against a live database and are skipped rather than faked.

## Configuration

Copy `.env.example` to `.env.local` and read it — every value is documented in place, including why
a durable store named without its configuration is a startup error rather than a silent downgrade.

```bash
cp .env.example .env.local
```

Nothing in `.env.example` is a credential. No value here may be prefixed `NEXT_PUBLIC_` unless it is
public by design.

### Network facts are configuration, not code

[`lib/guard/networks.ts`](lib/guard/networks.ts) is the single source for every Arc network fact:
chain id, App Kit name, explorer, published RPC endpoints, native currency, token addresses and
decimals. `chainRef`, the wallet hex chain id and CAIP asset references are **derived** from the
chain id and never typed by hand. `GET /api/arc-guard` serves the whole network definition, so the
browser holds no chain facts of its own and configures a wallet from what the server is actually
connected to. Tests forbid any hex chain id, decimal chain id, RPC host or explorer host appearing
in the client bundle.

`arc-mainnet` exists in that registry as `DESIGNED` with `carriesRealValue: true`. Selecting it
**throws** with its gate string rather than falling back to testnet: a silent fallback would leave
an operator who believed they had switched to mainnet transacting on a network with no real value.
Adding a network is a data change; permission to use one that carries real value is not.

### If the Arc RPC is unreachable from your network

Arc's primary endpoint sits behind a WAF that refuses whole regions with Cloudflare error 1009. When
that happens the browser can still sign and broadcast while the server cannot read chain state,
which strands a real transaction at `RECONCILIATION_REQUIRED`.

Point `ARC_TESTNET_RPC_URL` at an endpoint the server can actually reach. Arc publishes one primary
host and three provider mirrors; all four are listed in `.env.example`. A malformed or non-HTTPS
value is a startup error, never a silent fallback.

---

## Layout

```text
app/
  page.tsx                 project overview, rendered from arc-project.ts
  arc/arc-project.ts       every fact any surface is allowed to state
  arc/demo/page.tsx        the direct demo route
  arc-guard/               the reference client
  api/arc-guard/           the demo lifecycle endpoint
  health/                  persistence, deployment shape, chain reachability
  v1/                      the versioned partner API
lib/
  guard/                   kernel, contracts, policy, store, Arc adapters
  http-control.ts          request control surface
  security.ts              hashing and comparison helpers
packages/guard-sdk/        headless TypeScript client
examples/partner-arc-app/  one runnable server flow
openapi/                   the contract for the endpoints that exist
docs/                      architecture, API, limitations, demo script
```

## API

Nine `/v1` endpoints cover intent, preflight, evaluation, authorization, execution, reconciliation,
status and receipt, with tenant-scoped auth, `Idempotency-Key`, correlation IDs and structured
errors. See [`docs/api.md`](docs/api.md) and
[`openapi/ryntra-guard-v1.yaml`](openapi/ryntra-guard-v1.yaml). No endpoint is documented that does
not exist.

`GET /health` reports the configured persistence, the deployment shape and whether state changes are
accepted. It is the fastest way to see whether an instance is safe to write to.

---

## Limitations

Read this section before drawing any conclusion from the demo.

- Public Testnet prototype.
- No custody or private-key access by this project.
- No autonomous signing by this project.
- Human/user-controlled wallet authorization.
- Not a compliance certification.
- No guarantee of safety, execution success or profit.
- Evidence may be partial, stale, conflicting or unavailable.
- Mainnet/production support is **not** claimed.
- One operation is proven: a direct-EOA ERC-20 USDC transfer. `TESTNET VERIFIED` covers that
  operation and nothing else.
- The Circle App Kit USDC→EURC swap has **not** been executed. Its estimate is request-bound rather
  than exact-calldata-bound, so swap execution stays disabled until an exact external-signing
  payload is verified.
- One recorded run is evidence that the lifecycle works, not a reliability claim. Idempotency under
  load, replay and TOCTOU protection, RPC failure handling, recovery and monitoring are not
  complete.
- The lifecycle store is durable for a single writer at most unless Postgres is configured. On a
  multi-instance deployment every state change is refused with `CAPABILITY_UNAVAILABLE` rather than
  silently lost.
- Testnet assets have no intended monetary value, and the network may reset, change or be
  unavailable.
- **No security audit has been performed.**

[`docs/limitations.md`](docs/limitations.md) carries the full list.

## Security

- This project never receives a private key, seed phrase, entity secret or withdrawal authority.
- The wallet owner signs in their own wallet, after inspecting the exact payload.
- Human authorization is recorded **separately** from the policy result, and is bound to the intent
  revision, the evidence root and the execution fingerprint. A material change to amount, asset,
  recipient, chain, route, target or calldata invalidates both the evaluation and the authorization.
- The Arc Transaction Memo path reports `memoSupported: false`. No SCA, Safe or ERC-4337 memo
  support is claimed, and no receipt or personal data goes on chain.

Found something? Open an issue without a proof-of-concept exploit and without any credential, and
say that you would like a private channel.

## License

MIT — see [LICENSE](LICENSE).

The license covers the code in this repository. It grants no right to the Ryntra name or marks, and
it is not a warranty: read the Limitations section above, which is the accurate description of what
this software has and has not been proven to do.
