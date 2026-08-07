# Limitations and blockers

## Current implementation state

| Area | State | Evidence / required action |
|---|---|---|
| Guard schemas and deterministic policy | IMPLEMENTED_NOT_VERIFIED_IN_DEPLOYMENT | Source and focused tests exist; final lint/full-suite/build gate still required. |
| Independent status axes | IMPLEMENTED_NOT_VERIFIED_IN_DEPLOYMENT | `evidenceStatus`, `policyDecision`, authorization, `executionStatus`, and `reconciliationStatus` are separate in source/OpenAPI. |
| Evidence provenance contract | IMPLEMENTED_NOT_VERIFIED_IN_DEPLOYMENT | Required provider/source/freshness/coverage/availability/verification/digest/reason fields exist; no third-party security/compliance credentials or integrations exist. |
| Versioned `/v1` API and OpenAPI | IMPLEMENTED_NOT_DEPLOYED | Configure server-only demo tenant credentials and deploy only after separate authorization. |
| Headless TypeScript integration client | IMPLEMENTED_NOT_PUBLISHED | Private local package and one server example only; no npm publication. |
| Reference client | IMPLEMENTED_NOT_DEPLOYED | Local browser re-verification is required after the final source delta; no live URL. |
| Preserved App Kit USDC-to-EURC path | WORKING_WITH_LIMITS / LIVE NOT VERIFIED | Source path remains. Permissionless estimate smoke returned HTTP 403 for missing authorization; exact live quote, liquidity, final calldata, wallet execution, and swap remain unverified. |
| EOA ERC-20 USDC transfer fallback | IMPLEMENTED_NOT_LIVE_VERIFIED | Exact calldata/fingerprint, 6-decimal ERC-20 amount, 18-decimal native gas state, authorization, dedupe, observation, and reconciliation exist in source. A funded owner EOA and reachable Arc RPC are still required. |
| Arc Testnet RPC reachability | RESOLVED 2026-08-07 | Arc's primary host `https://rpc.testnet.arc.io` bans Ukraine at the WAF (Cloudflare error 1009, confirmed in the founder's own browser and from the agent sandbox, with and without browser-like headers). The three provider mirrors Arc documents alongside it — Blockdaemon, dRPC, QuickNode — answer normally from both networks. Both the server (`ARC_TESTNET_RPC_URL`) and the wallet network definition (`NEXT_PUBLIC_ARC_TESTNET_RPC_URL`) are now configurable, defaulting to Arc's primary. A malformed or non-HTTPS value is a startup error, never a silent fallback. |
| Arc Testnet chain and USDC contract | VERIFIED 2026-08-07 | Read live through `rpc.blockdaemon.testnet.arc.io`: chain id `0x4cef52` = 5042002 as pinned in source; ERC-20 USDC at `0x3600000000000000000000000000000000000000` has 1,798 bytes of deployed bytecode, `decimals()` = 6, `symbol()` = `name()` = `USDC`. This supersedes the earlier `contract bytecode NOT VERIFIED` state. Native and ERC-20 views report the same underlying balance at 18 and 6 decimals respectively, which is exactly the `ARC_NATIVE_ERC20_INTERFACE_AMBIGUITY` the Arc pack normalizes. |
| Server-side preflight against live Arc | VERIFIED 2026-08-07 | `PREPARE_TRANSFER` through the local demo API returned HTTP 201 with a real gas estimate from the chain (`feeAmount 0.001021345938`), evidence bound to a real block height, `evidenceStatus COMPLETE`, `missingEvidence []`, `policyDecision ALLOWED_BY_POLICY`, `executionStatus NOT_STARTED`, an exact-calldata transaction prepared, and `memoSupported false`. Insufficient balance still fails closed with `ARC_TRANSFER_INSUFFICIENT_BALANCE`. No transaction was signed or broadcast. |
| Arc Testnet transaction | VERIFIED 2026-08-07 | `0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9`, block 55677295, status `0x1`. Owner-authorized in the founder's own wallet; Ryntra never held a key. Explorer: https://testnet.arcscan.app/tx/0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9 |
| Arc dual `Transfer` event | HANDLED, CONFIRMED LIVE | The one movement emitted two events — 18-decimal native precompile and 6-decimal ERC-20. Reconciliation matches only the ERC-20 log. Reading the wrong one is a 10^12 error. |
| Expected-versus-actual reconciliation | VERIFIED 2026-08-07 | `MATCHED` · `ONCHAIN_VERIFIED`. Expected fee 0.001548973026, actual 0.001530838950 read from the chain. Receipt `0xb1530b1273adf5efd0a41ab194546da2c17f58d1842384a281dac173478e64f2`; hash and SHA-256 integrity recomputed independently of the application. |
| Gate C reliability | NOT COMPLETE | One successful run is not a reliability claim. Idempotency under load, replay/TOCTOU protection, RPC failure handling, recovery and monitoring remain unproven. |
| Transaction Memo | NOT IMPLEMENTED | `memoSupported: false`. Optional only after exact direct-EOA compatibility is verified; SCA/Safe/ERC-4337 support is not claimed. |
| Durable single-writer store | IMPLEMENTED | `RYNTRA_GUARD_STORE=file` persists the whole lifecycle across cold start under one writer; the default remains in-process memory. |
| Multi-writer store / multi-instance operation | IMPLEMENTED · NOT VERIFIED AGAINST A LIVE DATABASE | `RYNTRA_GUARD_STORE=postgres` with `DATABASE_URL` declares `DURABLE_MULTI_WRITER` and satisfies the write gate. Idempotency keys, intent ids and transaction hashes are claimed with `INSERT … ON CONFLICT DO NOTHING` rather than read-then-write. The live round-trip, concurrent-claim, shared-state and tenant-prefix tests in `lib/guard/store-postgres.test.mjs` are skipped until `DATABASE_URL` is set, so the adapter has not yet run against a real database. |
| Security audit | NOT DONE | Required public label remains `NOT AUDITED`. |
| Public repository / deployment / video / presentation | NOT CREATED | Separate founder authorization and final verified evidence required. |
| Encode registration, DeFi Track, submission | NOT VERIFIED / NOT PERFORMED | Founder action in the authenticated form; Codex must not press Submit. |

## Explicit non-claims

This prototype does not prove that an asset is safe, prevent losses, guarantee settlement, provide custody, perform AML/KYT, replace transaction simulation/security, operate on mainnet, support every Arc application, or hold an Arc/Circle partnership. It is not the first transaction firewall, first policy engine, or only execution-receipt product.

No live integration is claimed for Blockaid, Hypernative, TRM, Chainalysis, Fordefi, Fireblocks, Turnkey, Circle Compliance Engine, Circle Agent Wallet policies, or any other provider without actual credentials, working code, and fresh test evidence.

## App Kit swap limitation

The current swap estimate is bound to chain, pair, amount, recipient, slippage, quote hash, and request hash. It is **not** the final onchain target/calldata. The authorization record therefore cannot authorize a swap wallet transaction yet. Swap execution stays disabled until an exact external-signing payload is captured, re-preflighted, and freshly authorized with one-time replay protection.

## EOA transfer limitation

The transfer fallback is direct EOA only. It prepares an ERC-20 `transfer(address,uint256)` call to the official Arc Testnet ERC-20 USDC interface, while native USDC remains separately normalized for gas. Source preparation does not prove contract bytecode, wallet funds, RPC reachability, a broadcast, confirmation, or reconciliation in the current environment.

## Evidence limitation

`INSUFFICIENT_EVIDENCE` describes completeness for the configured policy; it is not a unique market or safety claim. Provider timeouts and unsupported coverage remain explicit and cannot become `ALLOWED_BY_POLICY`. Provider-reported evidence is not described as independently audited by Ryntra.

## Memo limitations

If Arc Transaction Memo is later used, it may contain only `preflightHash` or another bounded digest/reference. No PII, email, wallet portfolio, raw policy, full receipt, jurisdiction, secret, or private partner metadata may be placed onchain. The direct caller must be verified as an EOA. Smart-account, Safe, and ERC-4337 flows retain `memoSupported: false`.
