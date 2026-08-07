/* Relative rather than the `@/` alias: this module is imported directly by
   `node --test`, which does not resolve the TypeScript path alias.

   Network facts come from the registry rather than the App Kit adapter, and
   that is load-bearing. The adapter reaches the persistence port, which reaches
   `node:fs` — so importing it here pulled server-only modules into every client
   component that renders these facts, and the production build failed on it.
   The registry is pure data with no runtime dependencies, which is what makes
   it safe to read from either side. */
import {
  ARC_TESTNET_NETWORK,
  chainRefFor,
} from "../../lib/guard/networks.ts";

/**
 * Every fact the public `/arc` route is allowed to state, in one place.
 *
 * The page renders from this object and nothing else. That is deliberate: the
 * failure mode a reviewer page invites is copy that quietly runs ahead of the
 * implementation — a transaction hash that is really a sample, a "verified"
 * that means "written down". Here a proof either has a real value or it is
 * `null`, and `null` renders as an explicit pending row and never as a button.
 *
 * Canon §22.5 fixes the pre-Gate-B status vocabulary; §22.6 fixes the section
 * order; §22.7 fixes the truth label on every visual.
 */

export const ARC_PROJECT = {
  name: "Ryntra Guard for Arc",
  descriptor: "Decision & Settlement Evidence for Programmable Money",
  network: "Arc Public Testnet",
  chainRef: chainRefFor(ARC_TESTNET_NETWORK),
  track: "DeFi",
  explorerBaseUrl: ARC_TESTNET_NETWORK.explorerBaseUrl,
  /**
   * Gate B passed on 2026-08-07 for one exact operation: a direct-EOA ERC-20
   * USDC transfer. Canon §22.5 allows `TESTNET VERIFIED` only for the operation
   * actually proven, so the qualifier travels with the label everywhere. The
   * App Kit swap is NOT covered by it and stays unverified.
   */
  status: "TESTNET VERIFIED — direct-EOA ERC-20 USDC transfer only",
  statusRail: [
    "ARC PUBLIC TESTNET",
    "NON-CUSTODIAL",
    "HUMAN-AUTHORIZED",
    "REAL TX + EXPLORER",
    "RECONCILED RECEIPT",
  ],
  claimRail: ["INDEPENDENT PROJECT", "TESTNET ONLY", "NOT AUDITED", "NOT FINANCIAL ADVICE"],
} as const;

/**
 * The one recorded Arc Public Testnet run.
 *
 * Every value here was read back from the chain and from the finalized receipt,
 * and the receipt's own hash and integrity digest were recomputed independently
 * of the application before any of it was published.
 */
export const RECORDED_RUN = {
  network: "Arc Public Testnet",
  chainId: 5042002,
  operation: "Direct-EOA ERC-20 USDC transfer",
  transactionHash: "0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9",
  explorerUrl: "https://testnet.arcscan.app/tx/0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9",
  blockNumber: "55677295",
  onchainStatus: "SUCCESS (0x1)",
  intentId: "int_58e9bf523de5438c9bc118b5ec1e7dd1",
  receiptId: "rcpt_b6b010ec3d5e4be19b4c26cdfce28e73",
  preflightHash: "0xb9d52657e4ed10933e63b57adf597f8d1f75d7055d87206570155e92a0ae799c",
  policyDigest: "0x4134277b4a9b0660f8844de8aebb2b59f491d4e4138a52a9da6a7ebab257f8aa",
  executionFingerprintHash: "0x9dc7552c2cc6271474c89bd1930aec1cdbda01549b7b0d707cabe31e28ee93ed",
  evidenceRoot: "0x24aaa5bdc8db9129e87f3c4df03a2d0109b596375450d6d9a3883254d01e50fe",
  receiptHash: "0xb1530b1273adf5efd0a41ab194546da2c17f58d1842384a281dac173478e64f2",
  integrityHash: "0xed006ede12c4e99648a089e401a661d4e7d8c6c9afe5a0ea9892228327ebd1fe",
  amount: "1.000000 USDC",
  expectedFee: "0.001548973026 USDC",
  actualFee: "0.001530838950 USDC",
  reconciliationStatus: "MATCHED",
  verificationStatus: "ONCHAIN_VERIFIED",
  authorizationMethod: "PARTNER_AUTHENTICATED, recorded separately from the wallet signature",
  /**
   * The finding worth reading twice. Arc emitted the same movement as two
   * Transfer events: one from the native precompile at 18 decimals and one from
   * the ERC-20 interface at 6. An integration that sums both, or reads the
   * wrong one, is wrong by a factor of 10^12. This is the
   * `ARC_EVENT_DOUBLE_COUNT_RISK` the Arc pack was written against, and
   * reconciliation matched only the ERC-20 log.
   */
  dualEventNote:
    "Arc emitted this single movement as two Transfer events — 1000000000000000000 from the native precompile at 18 decimals, and 1000000 from the ERC-20 interface at 6. Reconciliation reads only the ERC-20 log, so the recorded amount is 1.000000 USDC rather than a 10^12 error.",
} as const;

/**
 * Reviewer links. A `url` of `null` means the artifact does not exist yet, and
 * the page must render it as a stated gap rather than a disabled-looking CTA.
 */
export type ReviewerLink = {
  id: string;
  label: string;
  url: string | null;
  /** Why it is missing, shown verbatim when `url` is null. */
  pending: string;
};

export const REVIEWER_LINKS: readonly ReviewerLink[] = [
  {
    id: "demo",
    label: "Open Testnet Demo",
    url: "/arc/demo",
    pending: "",
  },
  {
    id: "repository",
    label: "View GitHub",
    url: null,
    pending: "Public repository not created. Publication needs separate founder authorization and a secret scan.",
  },
  {
    id: "video",
    label: "Watch Demo",
    url: null,
    pending: "Three-minute demo video not recorded. It can only show a real run.",
  },
  {
    id: "presentation",
    label: "View Presentation",
    url: null,
    pending: "Public presentation not published.",
  },
  {
    id: "transaction",
    label: "View Arc Explorer Transaction",
    url: "https://testnet.arcscan.app/tx/0x6476dc81a38f0cbe385eab5162f391d7954a992a443db7d268e07b2698b8d5f9",
    pending: "",
  },
  {
    id: "receipt",
    label: "View Execution Receipt",
    url: "/arc#proof",
    pending: "",
  },
];

/** Canon §22.6 step 3 — the one complete flow the slice implements. */
export const LIFECYCLE = [
  { id: "intent", title: "Intent", body: "One normalized, versioned action: chain, asset, decimal amount, recipient, route, policy reference and expiry." },
  { id: "evidence", title: "Evidence Status", body: "Every input carries provider, source reference, observation time, validity, coverage and a response digest. Missing, stale or unsupported coverage stays visible." },
  { id: "policy", title: "Policy Decision", body: "A deterministic engine evaluates a versioned policy. No model returns the outcome, and no model can authorize." },
  { id: "authorization", title: "Human Authorization", body: "A distinct human act, recorded separately from the policy result and bound to the intent revision, evidence root and execution fingerprint." },
  { id: "settlement", title: "Arc Testnet Settlement", body: "The user's own wallet signs and broadcasts. Ryntra holds no key, no seed phrase and no withdrawal authority." },
  { id: "reconciliation", title: "Expected vs Actual", body: "Onchain effects are compared with the effects that were authorized, and a drift is reported rather than smoothed over." },
  { id: "receipt", title: "Execution Receipt", body: "A structured, hash-checkable record linking intent, evidence, decision, authorization, settlement and reconciliation." },
] as const;

/** Canon §22.6 step 4 — the working proof panel's required rows. */
export type ProofRow = { key: string; value: string | null; pending?: string };

export const PROOF_ROWS: readonly ProofRow[] = [
  { key: "Network", value: `${ARC_PROJECT.network} · ${ARC_PROJECT.chainRef}` },
  { key: "Supported operation", value: "Direct-EOA ERC-20 USDC treasury transfer. The Circle App Kit USDC→EURC swap path is preserved in source and is not confirmed end to end." },
  { key: "Custody boundary", value: "Non-custodial. Ryntra never receives a private key, seed phrase, entity secret or withdrawal authority." },
  { key: "Authorization actor", value: "The wallet owner, acting in their own wallet, after inspecting the exact payload." },
  { key: "Decimal handling", value: `Native Arc USDC ${ARC_TESTNET_NETWORK.nativeCurrency.decimals} decimals; ERC-20 USDC ${ARC_TESTNET_NETWORK.tokens.usdc.decimals} decimals. Converted with decimal strings and BigInt.` },
  { key: "Arc Transaction Memo", value: "memoSupported: false. No SCA, Safe or ERC-4337 memo support is claimed, and no receipt or personal data goes onchain." },
  { key: "Intent / preflight ID", value: `${RECORDED_RUN.intentId} · preflight ${RECORDED_RUN.preflightHash}` },
  { key: "Evidence status and freshness", value: `COMPLETE. Evidence root ${RECORDED_RUN.evidenceRoot}, provider Arc Testnet JSON-RPC, validity window 120 seconds.` },
  { key: "Policy decision and policy version", value: `ALLOWED_BY_POLICY under demo-arc-usdc-transfer-policy v1, digest ${RECORDED_RUN.policyDigest}.` },
  { key: "Human authorization", value: RECORDED_RUN.authorizationMethod },
  { key: "Execution fingerprint", value: `${RECORDED_RUN.executionFingerprintHash} — exact target, calldata and zero native value bound before signing.` },
  { key: "Expected effects", value: `Out ${RECORDED_RUN.amount}, fee ${RECORDED_RUN.expectedFee}.` },
  { key: "Transaction hash and Arc Explorer link", value: `${RECORDED_RUN.transactionHash} — block ${RECORDED_RUN.blockNumber}, ${RECORDED_RUN.onchainStatus}. ${RECORDED_RUN.explorerUrl}` },
  { key: "Actual effects", value: `Out ${RECORDED_RUN.amount}, fee ${RECORDED_RUN.actualFee} — read back from the chain, not from the estimate.` },
  { key: "Execution status", value: "CONFIRMED" },
  { key: "Reconciliation status and tolerance", value: `${RECORDED_RUN.reconciliationStatus} · ${RECORDED_RUN.verificationStatus}. Exact match required on sender, contract target, calldata digest, zero native value, transfer sender, transfer recipient and amount.` },
  { key: "Arc dual-event hazard", value: RECORDED_RUN.dualEventNote },
  { key: "Receipt ID / integrity", value: `${RECORDED_RUN.receiptId} · receiptHash ${RECORDED_RUN.receiptHash} · SHA-256 integrity ${RECORDED_RUN.integrityHash}. Both were recomputed independently of the application from the stored receipt.` },
  /* This IS the repository, so the row that reads "not created" in the private
     monorepo has to state what is true here: where the instructions live, and
     what they do and do not reproduce. */
  {
    key: "Repository and reproducibility",
    value:
      "This repository. README.md carries the requirements, install, typecheck, test, lint, build and run steps. They reproduce the implementation and its test suite; the recorded run above is a historical onchain fact and is not re-executed by them.",
  },
];

/**
 * Canon §22.7 — the three evidence frames, now carrying the recorded run.
 *
 * The label is deliberately precise. The values below are real and verifiable
 * against the chain; the screen captures for the demo video are not taken yet,
 * and saying so is cheaper than being caught claiming otherwise.
 */
export const PROOF_FRAMES = [
  {
    id: "before",
    number: "01",
    title: "Before — Intent, Evidence, Decision",
    label: "RECORDED RUN · CAPTURE PENDING",
    facts: [
      `Direct-EOA ERC-20 USDC transfer of ${RECORDED_RUN.amount} on ${RECORDED_RUN.network}`,
      `Evidence COMPLETE, root ${RECORDED_RUN.evidenceRoot.slice(0, 18)}…`,
      "No missing or stale evidence; validity window 120 seconds",
      "Policy demo-arc-usdc-transfer-policy v1 → ALLOWED_BY_POLICY",
      `Expected fee ${RECORDED_RUN.expectedFee}`,
    ],
  },
  {
    id: "settlement",
    number: "02",
    title: "Settlement — Human authorization and Arc result",
    label: "RECORDED RUN · CAPTURE PENDING",
    facts: [
      "Authorization recorded separately from the wallet signature",
      `Execution fingerprint ${RECORDED_RUN.executionFingerprintHash.slice(0, 18)}… bound before signing`,
      `Transaction ${RECORDED_RUN.transactionHash.slice(0, 18)}… — ${RECORDED_RUN.onchainStatus}`,
      `Block ${RECORDED_RUN.blockNumber}, Arc Explorer link published`,
    ],
  },
  {
    id: "after",
    number: "03",
    title: "After — Reconciliation and Receipt",
    label: "RECORDED RUN · CAPTURE PENDING",
    facts: [
      `Expected fee ${RECORDED_RUN.expectedFee} versus actual ${RECORDED_RUN.actualFee}`,
      `${RECORDED_RUN.reconciliationStatus} · ${RECORDED_RUN.verificationStatus}`,
      "Execution CONFIRMED, recovery NOT_REQUIRED",
      `Receipt ${RECORDED_RUN.receiptId}, hash and integrity independently recomputed`,
    ],
  },
] as const;

/** Canon §22.6 step 6 — only interfaces that actually run today. */
export const INTEGRATION_SURFACE = [
  { id: "api", title: "Versioned HTTP API", body: "Nine `/v1` endpoints covering intent, preflight, evaluation, authorization, execution, reconciliation, status and receipt, with tenant-scoped auth, `Idempotency-Key`, correlation IDs and structured errors." },
  { id: "openapi", title: "OpenAPI contract", body: "`openapi/ryntra-guard-v1.yaml` describes the exact implemented surface — no endpoint is documented that does not exist." },
  { id: "sdk", title: "TypeScript client", body: "A headless local package plus one runnable server example. It never handles a private key, and it is not published to npm." },
] as const;

/** Canon §22.13 — the disclosure block, verbatim. */
export const SCOPE_AND_LIMITATIONS = [
  "Public Testnet prototype.",
  "No custody or private-key access by Ryntra.",
  "No autonomous signing by Ryntra.",
  "Human/user-controlled wallet authorization.",
  "Not a compliance certification.",
  "No guarantee of safety, execution success or profit.",
  "Evidence may be partial, stale, conflicting or unavailable.",
  "Mainnet/production support is not claimed.",
] as const;

export const ADDITIONAL_LIMITATIONS = [
  "One operation is proven: a direct-EOA ERC-20 USDC transfer. `TESTNET VERIFIED` covers that operation and nothing else.",
  "The Circle App Kit USDC→EURC swap has NOT been executed. Its estimate is request-bound rather than exact-calldata-bound, so swap execution stays disabled.",
  "One recorded run is evidence that the lifecycle works, not a reliability claim. Gate C — idempotency under load, replay and TOCTOU protection, RPC failure handling, recovery and monitoring — has not been completed.",
  "The Circle App Kit swap estimate is request-bound rather than exact-calldata-bound, so swap execution stays disabled until an exact external-signing payload is verified.",
  "The lifecycle store is durable for a single writer at most; on a multi-instance deployment every state change is refused rather than silently lost.",
  "Testnet assets have no intended monetary value, and the network may reset, change or be unavailable.",
  "No security audit has been performed.",
] as const;

/** Canon §22.11 — the two surfaces over one kernel. */
export const TWO_SURFACES = {
  title: "One Evidence Kernel. Two product surfaces.",
  workspace:
    "Ryntra Workspace helps self-directed users understand risk, plan, authorize supported actions in their own wallet and review what happened.",
  guard:
    "Ryntra Guard is designed to let applications and teams consume the same evidence, decision, reconciliation and receipt model through documented boundaries.",
  /** Gate E has not passed, so Guard is labelled a preview rather than a product API. */
  guardLabel: "Arc Testnet MVP · Developer Preview",
} as const;
