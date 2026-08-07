"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  Code,
  Copy,
  FileCode,
  Fingerprint,
  LockKey,
  Plug,
  ShieldCheck,
  WarningCircle,
  Wallet,
} from "@phosphor-icons/react";

import { ARC_PROJECT } from "../arc/arc-project.ts";
import styles from "./arc-guard.module.css";
import { OperationLifecycle } from "./operation-lifecycle.tsx";

type EthereumProvider = {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type ArcNetworkDefinition = {
  id: string;
  label: string;
  shortLabel: string;
  chainId: number;
  hexChainId: string;
  chainRef: string;
  explorerBaseUrl: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  carriesRealValue: boolean;
};

type Capability = {
  /** Served by the API. The browser holds no chain facts of its own. */
  network: ArcNetworkDefinition;
  environment: "ARC_TESTNET";
  chainRef: string;
  chainId: number;
  flow: string;
  fallbackFlow: string;
  fallbackExecutionBinding: string;
  nativeUsdcDecimals: 18;
  erc20UsdcDecimals: 6;
  memoSupported: false;
  circleCredentialConfigured: boolean;
  liveExecutionVerified: false;
  transactionHash: null;
  explorerUrl: null;
  authorizationMethod: "PARTNER_AUTHENTICATED";
  executionBinding: "APP_KIT_REQUEST_NOT_CALLDATA";
  limitations: string[];
};

type FingerprintValue = Record<string, unknown> & {
  intentId: string;
  walletAddress: string;
};

type PolicyDecision =
  | "ALLOWED_BY_POLICY"
  | "REVIEW_REQUIRED"
  | "BLOCKED_BY_RULE"
  | "INSUFFICIENT_EVIDENCE"
  | "UNSUPPORTED"
  | "EXPIRED";

type Evaluation = Record<string, unknown> & {
  id: string;
  outcome: PolicyDecision;
  dataStatus: string;
  evidenceStatus: string;
  policyDecision: PolicyDecision;
  policyStatus: string;
  authorizationStatus: string;
  executionStatus: string;
  blockers: string[];
  missingEvidence: string[];
};

type WalletTransaction = {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
};

type DemoFlow = {
  flowKind: "APP_KIT_SWAP" | "EOA_USDC_TRANSFER";
  intent: Record<string, unknown> & { id: string };
  estimate: {
    provider: string;
    route: string;
    amountIn: string;
    expectedAmountOut: string;
    minimumAmountOut: string;
    feeAmount: string | null;
    totalDebit: string | null;
    slippageBps: string;
    validUntil: string;
    missingEvidence: string[];
  };
  evidence: Record<string, unknown>;
  evaluation: Evaluation;
  fingerprint: FingerprintValue | null;
  transaction: WalletTransaction | null;
  executionAvailable: boolean;
  executionBlocker: string | null;
  memoSupported: false;
};

type Authorization = Record<string, unknown> & {
  id: string;
  decision: "APPROVED";
  method: "PARTNER_AUTHENTICATED";
};

type EvidenceReceipt = Record<string, unknown> & {
  receiptHash: string;
  preflightHash: string;
  reconciliationStatus: "MATCHED" | "DEVIATION_RECORDED";
  execution: { transactionHash: string; explorerUrl: string; status: string };
  expectedEffects: Record<string, string>;
  actualEffects: Record<string, string>;
};

type ApiFailure = {
  error?: {
    code?: string;
    message?: string;
    requiredAction?: string | null;
    correlationId?: string;
  };
};

/*
 * No network constants live here any more.
 *
 * The chain id, RPC endpoints, explorer and native currency are served by
 * `GET /api/arc-guard` from the server's own network registry. A hand-written
 * hex chain id shipped here once with two transposed digits: the wallet
 * reported the real chain, the client compared it against one that does not
 * exist, and every session died at "wrong network". A browser cannot be the
 * authority on which network the server is talking to.
 */

const SDK_EXAMPLE = `const intent = await ryntra.intents.create(input, { idempotencyKey });
const evaluation = await ryntra.preflight(intent.id, evidence);
if (evaluation.evidenceStatus !== "COMPLETE") return showMissing(evaluation);
if (evaluation.policyDecision === "BLOCKED_BY_RULE") return showBlockers(evaluation);
const authorization = await ryntra.authorize({
  intentId: intent.id,
  evaluationId: evaluation.id,
  executionFingerprint,
});
const txHash = await partnerWallet.execute(transaction);
await ryntra.executions.record({ intentId: intent.id, authorizationId: authorization.id, executionFingerprint, txHash });`;

const API_EXAMPLE = `POST /v1/intents/{intentId}/preflight
Authorization: Bearer <tenant-scoped-server-key>
Idempotency-Key: demo-preflight-001

{
  "evidence": [{ "sourceType": "SWAP_QUOTE", "status": "VALID" }]
}`;

const WAITING_CHECKS = [
  ["Arc Testnet network", "WAITING"],
  ["Supported USDC → EURC pair", "WAITING"],
  ["Quote and provider evidence", "WAITING"],
  ["Total debit ≤ 100 USDC", "WAITING"],
  ["Quote age ≤ 120 seconds", "WAITING"],
  ["Slippage ≤ 25 bps", "WAITING"],
] as const;

function shortAddress(value: string | null) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Not connected";
}

function createIdempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data?: T } & ApiFailure;
  if (!response.ok || !body.data) {
    const code = body.error?.code ?? "REQUEST_FAILED";
    const message = body.error?.message ?? "The request could not be completed.";
    const action = body.error?.requiredAction ? ` Required: ${body.error.requiredAction}.` : "";
    throw new Error(`${code}: ${message}${action}`);
  }
  return body.data;
}

/**
 * @param embedded Render only the operation itself, for the Arc Workspace.
 *
 * The standalone page keeps its own chrome, status rail, lifecycle stepper and
 * developer panel — a reviewer arriving there needs the explanation. Inside the
 * workspace all four are scaffolding: the shell already states the network and
 * limitations, and an operator doing the work does not need the software
 * narrating its own procedure back at them.
 */
export function ArcGuardDemo({ embedded = false }: { embedded?: boolean } = {}) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [flowMode, setFlowMode] = useState<"swap" | "transfer">("transfer");
  const [amount, setAmount] = useState("10.00");
  const [slippageBps, setSlippageBps] = useState("20");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [flow, setFlow] = useState<DemoFlow | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [executionRecorded, setExecutionRecorded] = useState(false);
  const [recordExecutionKey, setRecordExecutionKey] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<EvidenceReceipt | null>(null);
  const [busy, setBusy] = useState<
    "connect" | "estimate" | "authorize" | "execute" | "reconcile" | null
  >(null);
  const [message, setMessage] = useState("Connect an EVM wallet to begin the Testnet flow.");
  const [error, setError] = useState<string | null>(null);
  const [devTab, setDevTab] = useState<"sdk" | "api" | "receipt">("sdk");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/arc-guard", { cache: "no-store" })
      .then((response) => parseResponse<Capability>(response))
      .then((data) => {
        if (active) setCapability(data);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Capability check failed.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    const accountsChanged = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0] : [];
      setWalletAddress(typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null);
      setFlow(null);
      setAuthorization(null);
      setTransactionHash(null);
      setExecutionRecorded(false);
      setRecordExecutionKey(null);
      setReceipt(null);
    };
    const chainChanged = (...args: unknown[]) => {
      setChainId(typeof args[0] === "string" ? args[0] : null);
      setFlow(null);
      setAuthorization(null);
      setTransactionHash(null);
      setExecutionRecorded(false);
      setRecordExecutionKey(null);
      setReceipt(null);
    };
    provider.on("accountsChanged", accountsChanged);
    provider.on("chainChanged", chainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
    };
  }, []);

  const network = capability?.network ?? null;
  const onArc = network !== null && chainId?.toLowerCase() === network.hexChainId.toLowerCase();
  const evaluation = flow?.evaluation ?? null;
  const canAuthorize = Boolean(
    flow?.fingerprint &&
      !authorization &&
      (evaluation?.policyDecision === "ALLOWED_BY_POLICY" || evaluation?.policyDecision === "REVIEW_REQUIRED"),
  );
  const isTransfer = flowMode === "transfer";
  const canExecuteTransfer = Boolean(
    flow?.flowKind === "EOA_USDC_TRANSFER" &&
      flow.executionAvailable &&
      flow.transaction &&
      authorization &&
      onArc &&
      walletAddress === flow.fingerprint?.walletAddress.toLowerCase() &&
      !transactionHash,
  );
  const explorerUrl = receipt?.execution.explorerUrl ??
    (network
      ? transactionHash
        ? `${network.explorerBaseUrl}/tx/${transactionHash}`
        : network.explorerBaseUrl
      : null);
  const outputSymbol = flow?.flowKind === "EOA_USDC_TRANSFER" || isTransfer ? "USDC" : "EURC";
  const resetFlow = () => {
    setFlow(null);
    setAuthorization(null);
    setTransactionHash(null);
    setExecutionRecorded(false);
    setRecordExecutionKey(null);
    setReceipt(null);
    setError(null);
  };

  const checks = useMemo(() => {
    if (!evaluation) return WAITING_CHECKS;
    const blocked = new Set(evaluation.blockers);
    const missing = evaluation.missingEvidence.length > 0;
    const transfer = flow?.flowKind === "EOA_USDC_TRANSFER";
    return [
      ["Arc Testnet network", onArc ? "PASS" : "BLOCK"],
      [transfer ? "EOA USDC transfer capability" : "Supported USDC to EURC pair", blocked.has("allowed-pair") ? "BLOCK" : "PASS"],
      [transfer ? "Onchain state and gas evidence" : "Quote and provider evidence", missing ? "MISSING" : "PASS"],
      ["Total debit ≤ 100 USDC", blocked.has("max-total-debit") ? "BLOCK" : "PASS"],
      ["Evidence age <= 120 seconds", evaluation.policyDecision === "EXPIRED" ? "EXPIRED" : "PASS"],
      [transfer ? "Exact target and calldata bound" : "Slippage <= 25 bps", evaluation.policyDecision === "REVIEW_REQUIRED" ? "REVIEW" : "PASS"],
    ] as const;
  }, [evaluation, flow?.flowKind, onArc]);

  async function connectWallet() {
    setBusy("connect");
    setError(null);
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("No injected EVM wallet was detected.");
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const currentChain = (await provider.request({ method: "eth_chainId" })) as string;
      if (!accounts[0]) throw new Error("The wallet returned no account.");
      setWalletAddress(accounts[0].toLowerCase());
      setChainId(currentChain);
      setMessage("Wallet connected. Confirm Arc Testnet before requesting evidence.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setBusy(null);
    }
  }

  async function switchToArc() {
    if (!network) {
      // The network arrives with the capability payload. Until it does there is
      // no network to switch to, and guessing one is how the client used to
      // disagree with the chain.
      setError("Network configuration has not loaded yet. Retry in a moment.");
      return;
    }
    setBusy("connect");
    setError(null);
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("No injected EVM wallet was detected.");
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: network.hexChainId }],
        });
      } catch (cause) {
        const code = cause && typeof cause === "object" && "code" in cause ? Number(cause.code) : null;
        if (code !== 4902) throw cause;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: network.hexChainId,
              chainName: network.label,
              nativeCurrency: network.nativeCurrency,
              // Every endpoint the network operator publishes, so the wallet can
              // fall back when the first host refuses this user's region.
              rpcUrls: network.rpcUrls,
              blockExplorerUrls: [network.explorerBaseUrl],
            },
          ],
        });
      }
      const currentChain = (await provider.request({ method: "eth_chainId" })) as string;
      setChainId(currentChain);
      setMessage("Arc Testnet confirmed. The estimate remains server-authenticated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Network switch failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runPreflight() {
    if (!walletAddress || !onArc) return;
    setBusy("estimate");
    setError(null);
    setFlow(null);
    setAuthorization(null);
    setTransactionHash(null);
    setExecutionRecorded(false);
    setRecordExecutionKey(null);
    setReceipt(null);
    try {
      const transfer = flowMode === "transfer";
      const response = await fetch("/api/arc-guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          transfer
            ? {
                action: "PREPARE_TRANSFER",
                walletAddress,
                recipientAddress,
                amount,
                idempotencyKey: createIdempotencyKey("transfer"),
              }
            : {
                action: "ESTIMATE_AND_PREFLIGHT",
                walletAddress,
                amountIn: amount,
                slippageBps: Number(slippageBps),
                idempotencyKey: createIdempotencyKey("estimate"),
              },
        ),
      });
      const data = await parseResponse<DemoFlow>(response);
      setFlow(data);
      setMessage(`Preflight completed: ${data.evaluation.policyDecision}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preflight failed.");
    } finally {
      setBusy(null);
    }
  }

  async function authorize() {
    if (!flow?.fingerprint) return;
    setBusy("authorize");
    setError(null);
    try {
      const response = await fetch("/api/arc-guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "AUTHORIZE",
          intentId: flow.intent.id,
          evaluationId: flow.evaluation.id,
          fingerprint: flow.fingerprint,
          idempotencyKey: createIdempotencyKey("authorize"),
        }),
      });
      const data = await parseResponse<{ authorization: Authorization }>(response);
      setAuthorization(data.authorization);
      setMessage("Human authorization recorded. This is separate from a wallet signature.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization failed.");
    } finally {
      setBusy(null);
    }
  }

  async function executeTransfer() {
    if (!flow?.transaction || !flow.fingerprint || !authorization || !flow.executionAvailable) return;
    const recordKey = recordExecutionKey ?? createIdempotencyKey("record");
    let broadcastHash: string | null = null;
    setBusy("execute");
    setError(null);
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("No injected EVM wallet was detected.");
      const activeChain = (await provider.request({ method: "eth_chainId" })) as string;
      const activeAccounts = (await provider.request({ method: "eth_accounts" })) as string[];
      const activeAccount = activeAccounts[0]?.toLowerCase();
      if (!network || activeChain.toLowerCase() !== network.hexChainId.toLowerCase()) {
        throw new Error("Arc Testnet must remain active before wallet execution.");
      }
      if (!activeAccount || activeAccount !== flow.fingerprint.walletAddress.toLowerCase()) {
        throw new Error("The active wallet account differs from the authorized execution.");
      }
      if (flow.transaction.from.toLowerCase() !== activeAccount) {
        throw new Error("The prepared transaction sender differs from the active wallet account.");
      }
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [flow.transaction],
      })) as string;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("Wallet returned an invalid transaction hash.");
      }
      const normalizedHash = hash.toLowerCase();
      broadcastHash = normalizedHash;
      setRecordExecutionKey(recordKey);
      setTransactionHash(normalizedHash);
      const response = await fetch("/api/arc-guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "RECORD_EXECUTION",
          intentId: flow.intent.id,
          authorizationId: authorization.id,
          fingerprint: flow.fingerprint,
          transactionHash: normalizedHash,
          idempotencyKey: recordKey,
        }),
      });
      await parseResponse(response);
      setExecutionRecorded(true);
      setMessage("Wallet broadcast recorded. Reconcile only after Arc confirms the transaction.");
    } catch (cause) {
      if (broadcastHash) {
        setTransactionHash(broadcastHash);
        setMessage(
          "A wallet transaction hash exists but the Ryntra record is uncertain. Do not broadcast again; retry reconciliation.",
        );
      }
      setError(cause instanceof Error ? cause.message : "Wallet execution failed.");
    } finally {
      setBusy(null);
    }
  }

  async function reconcileTransfer() {
    if (!flow?.fingerprint || !authorization || !transactionHash || !recordExecutionKey) return;
    setBusy("reconcile");
    setError(null);
    try {
      if (!executionRecorded) {
        const recordResponse = await fetch("/api/arc-guard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "RECORD_EXECUTION",
            intentId: flow.intent.id,
            authorizationId: authorization.id,
            fingerprint: flow.fingerprint,
            transactionHash,
            idempotencyKey: recordExecutionKey,
          }),
        });
        await parseResponse(recordResponse);
        setExecutionRecorded(true);
      }
      const response = await fetch("/api/arc-guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "RECONCILE_TRANSFER",
          intentId: flow.intent.id,
          transactionHash,
          idempotencyKey: createIdempotencyKey("reconcile"),
        }),
      });
      const data = await parseResponse<{
        execution: Record<string, unknown>;
        receipt: EvidenceReceipt | null;
        requiredAction: string | null;
      }>(response);
      setReceipt(data.receipt);
      setMessage(
        data.receipt
          ? `Receipt finalized: ${data.receipt.reconciliationStatus}.`
          : "Arc confirmation is not yet available. Reconciliation remains required.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconciliation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function copyDeveloperExample() {
    const value =
      devTab === "sdk"
        ? SDK_EXAMPLE
        : devTab === "api"
          ? API_EXAMPLE
          : receipt
            ? JSON.stringify(receipt, null, 2)
            : "Receipt is unavailable until a real Arc transaction is confirmed.";
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  const outcomeClass = evaluation
    ? evaluation.policyDecision === "ALLOWED_BY_POLICY"
      ? styles.pass
      : evaluation.policyDecision === "REVIEW_REQUIRED"
        ? styles.review
        : styles.block
    : styles.waiting;

  return (
    <div className={embedded ? styles.embedded : styles.shell}>
      {embedded ? null : (
        <header className={styles.header}>
          <Link className={styles.brand} href="/" aria-label="Ryntra home">
            RYN<span>TRA</span>
          </Link>
          <div className={styles.productName}>Guard for Arc</div>
          {/* Back to the reviewer page, not the homepage: /arc is where this run's
              scope, limitations and proof state are explained. */}
          <Link className={styles.backLink} href="/arc">
            <ArrowLeft size={15} aria-hidden /> Back to Arc project
          </Link>
        </header>
      )}

      <main className={embedded ? styles.mainEmbedded : styles.main}>
        {embedded ? null : (
          <section className={styles.statusRail} aria-label="Prototype status">
            <span>INDEPENDENT PROJECT</span>
            <span className={styles.cyan}>ARC TESTNET</span>
            <span>TESTNET ONLY</span>
            <span>NOT AUDITED</span>
            <span>NOT FINANCIAL ADVICE</span>
          </section>
        )}

        {embedded ? null : (
        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Decision &amp; Settlement Evidence Layer</p>
            <h1>Know whether this action is ready — and preserve the evidence.</h1>
            <p className={styles.lead}>
              Normalize intent, preserve provider provenance and freshness, apply versioned
              financial policy, keep authorization separate, and reconcile the final Arc result.
            </p>
          </div>
          <div className={styles.capabilityCard}>
            <span className={styles.capabilityLabel}>CURRENT CAPABILITY</span>
            {/* Read from ARC_PROJECT rather than typed here. This card went on
                declaring the transaction unverified after Gate B had passed, so
                the demo contradicted the page that links to it — the reviewer's
                first impression of a product whose whole claim is that its
                surfaces agree with its evidence. One source removes that class,
                and the test asserts the stale wording cannot return. */}
            <strong>{ARC_PROJECT.status}</strong>
            <p>
              {capability?.circleCredentialConfigured
                ? "The exact EOA transfer path is proven by one recorded Arc Testnet run. The App Kit swap estimate is available in source and has never executed."
                : "The exact EOA USDC fallback does not expose a signing secret, and is the path the recorded run proved. App Kit swap estimates still require a server-only key."}
            </p>
          </div>
        </section>
        )}

        {/* The numbered CONNECT…EXECUTE stepper is scaffolding: it narrates the
            software's own procedure back to the operator. Useful on a reviewer
            page that has to explain the lifecycle, wrong inside the workspace
            where the operator is doing the work rather than reading about it. */}
        {embedded ? null : (
          <ol className={styles.steps} aria-label="Intent to receipt workflow">
            {["CONNECT", "INTENT", "EVIDENCE", "POLICY", "AUTHORIZE", "EXECUTE"].map((step, index) => (
              <li key={step} className={index === 0 && walletAddress ? styles.stepDone : undefined}>
                <span>{String(index + 1).padStart(2, "0")}</span>{step}
              </li>
            ))}
          </ol>
        )}

        <section className={styles.workspace}>
          <aside className={styles.workflowPanel}>
            <div className={styles.panelHead}>
              <div>
                <p>PARTNER ARC APP</p>
                <h2>Wallet boundary</h2>
              </div>
              <Wallet size={22} aria-hidden />
            </div>
            <div className={styles.walletBox}>
              <span>CONNECTED ACCOUNT</span>
              <strong className={styles.mono}>{shortAddress(walletAddress)}</strong>
              <small>
                {onArc && network
                  ? `${network.label} · ${network.chainId}`
                  : chainId
                    ? `Wrong network · ${chainId}`
                    : "Network not checked"}
              </small>
            </div>
            {!walletAddress ? (
              <button className={styles.primaryButton} onClick={connectWallet} disabled={busy !== null}>
                <Plug size={17} aria-hidden /> {busy === "connect" ? "Connecting…" : "Connect wallet"}
              </button>
            ) : !onArc ? (
              <button className={styles.primaryButton} onClick={switchToArc} disabled={busy !== null}>
                <WarningCircle size={17} aria-hidden /> Confirm Arc Testnet
              </button>
            ) : (
              <div className={styles.networkOk}><CheckCircle size={18} weight="fill" aria-hidden /> Correct testnet confirmed</div>
            )}
            <div className={styles.boundaryNote}>
              <LockKey size={18} aria-hidden />
              <p><strong>Non-custodial boundary</strong>Ryntra receives no private key or seed phrase. Wallet signing is a separate user action.</p>
            </div>
          </aside>

          <section className={styles.intentPanel}>
            <div className={styles.panelHead}>
              <div>
                <p>VERSIONED INTENT</p>
                <h2>{isTransfer ? "EOA USDC treasury transfer" : "USDC → EURC swap"}</h2>
              </div>
              <span className={styles.testnetBadge}>ARC TESTNET</span>
            </div>
            <div className={styles.flowSwitch} role="group" aria-label="Arc demo flow">
              <button
                type="button"
                aria-pressed={flowMode === "transfer"}
                onClick={() => { setFlowMode("transfer"); resetFlow(); }}
                disabled={busy !== null}
              >
                EOA TRANSFER FALLBACK
              </button>
              <button
                type="button"
                aria-pressed={flowMode === "swap"}
                onClick={() => { setFlowMode("swap"); resetFlow(); }}
                disabled={busy !== null}
              >
                APP KIT SWAP
              </button>
            </div>
            <div className={styles.formGrid}>
              <label>
                <span>SELL AMOUNT</span>
                <div className={styles.inputWrap}>
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="decimal"
                    aria-describedby="amount-help"
                    disabled={busy !== null}
                  />
                  <b>USDC</b>
                </div>
                <small id="amount-help">Decimal string · policy max total debit 100.00</small>
              </label>
              <label>
                <span>{isTransfer ? "TREASURY RECIPIENT EOA" : "SLIPPAGE LIMIT"}</span>
                <div className={styles.inputWrap}>
                  {isTransfer ? (
                    <input
                      value={recipientAddress}
                      onChange={(event) => { setRecipientAddress(event.target.value); resetFlow(); }}
                      inputMode="text"
                      placeholder="0x…"
                      aria-label="Treasury recipient EOA"
                      disabled={busy !== null}
                    />
                  ) : (
                    <>
                      <input
                        value={slippageBps}
                        onChange={(event) => setSlippageBps(event.target.value)}
                        inputMode="numeric"
                        disabled={busy !== null}
                      />
                      <b>BPS</b>
                    </>
                  )}
                </div>
                <small>{isTransfer ? "Direct EOA caller only · ERC-20 USDC uses 6 decimals." : "Above 25 bps requires review."}</small>
              </label>
            </div>
            <button
              className={styles.primaryButton}
              onClick={runPreflight}
              disabled={!walletAddress || !onArc || busy !== null || (isTransfer && !/^0x[0-9a-fA-F]{40}$/.test(recipientAddress))}
            >
              <ShieldCheck size={18} aria-hidden />
              {busy === "estimate" ? "Collecting evidence…" : isTransfer ? "Prepare exact transfer & preflight" : "Estimate swap & run preflight"}
            </button>

            <div className={styles.estimateGrid} aria-label="Provider evidence snapshot">
              <Metric label="Expected output" value={flow?.estimate.expectedAmountOut ? `${flow.estimate.expectedAmountOut} ${outputSymbol}` : "—"} />
              <Metric label="Minimum received" value={flow?.estimate.minimumAmountOut ? `${flow.estimate.minimumAmountOut} ${outputSymbol}` : "—"} />
              <Metric label="Fees" value={flow?.estimate.feeAmount ? `${flow.estimate.feeAmount} USDC` : flow ? "MISSING" : "—"} />
              <Metric label="Total debit" value={flow?.estimate.totalDebit ? `${flow.estimate.totalDebit} USDC` : "—"} />
              <Metric label="Provider" value={flow?.estimate.provider ?? "—"} />
              <Metric label="Evidence valid until" value={flow ? new Date(flow.estimate.validUntil).toLocaleTimeString() : "—"} />
            </div>
            <p className={styles.routeDisclosure}>
              Route: {flow?.estimate.route ?? "waiting"} · {flow?.flowKind === "EOA_USDC_TRANSFER" ? "Exact target, calldata and zero native value are fingerprint-bound. Arc native gas uses 18 decimals; ERC-20 USDC uses 6." : "Underlying DEX route is not exposed by the current App Kit estimate."}
            </p>
          </section>

          <aside className={styles.guardPanel}>
            <div className={styles.panelHead}>
              <div>
                <p>DETERMINISTIC POLICY</p>
                <h2>Readiness checks</h2>
              </div>
              <Fingerprint size={23} aria-hidden />
            </div>
            <div className={`${styles.outcome} ${outcomeClass}`}>
              <span>POLICY DECISION</span>
              <strong>{evaluation?.policyDecision ?? "WAITING FOR EVIDENCE"}</strong>
            </div>
            <div className={styles.axisGrid} aria-label="Independent Guard status axes">
              <span><small>EVIDENCE</small><b>{evaluation?.evidenceStatus ?? "NOT COLLECTED"}</b></span>
              <span><small>POLICY</small><b>{evaluation?.policyDecision ?? "NOT EVALUATED"}</b></span>
              <span><small>EXECUTION</small><b>{receipt ? "CONFIRMED" : transactionHash ? "SUBMITTED" : "NOT STARTED"}</b></span>
            </div>
            <ul className={styles.checks}>
              {checks.map(([label, status]) => (
                <li key={label}>
                  <span>{status === "PASS" ? <CheckCircle size={17} weight="fill" aria-hidden /> : <WarningCircle size={17} aria-hidden />}{label}</span>
                  <b data-status={status}>{status}</b>
                </li>
              ))}
            </ul>
            <button
              className={styles.authorizeButton}
              onClick={authorize}
              disabled={!canAuthorize || busy !== null}
            >
              <Fingerprint size={18} aria-hidden />
              {authorization ? "Human authorized" : busy === "authorize" ? "Recording…" : "Authorize exact intent"}
            </button>
            <button
              className={styles.walletButton}
              onClick={transactionHash ? reconcileTransfer : executeTransfer}
              disabled={busy !== null || (!canExecuteTransfer && !transactionHash) || Boolean(receipt)}
              title={flow?.flowKind === "APP_KIT_SWAP" ? "Secure App Kit external-signing handshake is not implemented" : undefined}
            >
              <Wallet size={18} aria-hidden />
              {receipt
                ? "Receipt finalized"
                : busy === "execute"
                  ? "Open wallet…"
                  : busy === "reconcile"
                    ? "Checking Arc…"
                    : transactionHash
                      ? "Reconcile Arc transaction"
                      : canExecuteTransfer
                        ? "Sign exact transfer in wallet"
                        : "Wallet signature unavailable"}
            </button>
            {/* Six states, listed separately. Ryntra recording that a human
                approved an exact intent and a key holder signing a transaction
                are different facts with different weight, and the single line
                that used to sit here invited a reader to believe the
                application authorized the money movement. It authorized
                nothing but its own record of a decision. */}
            <div className={styles.lifecycleBlock}>
              <OperationLifecycle
                authorized={Boolean(authorization)}
                transactionHash={transactionHash}
                confirmed={Boolean(receipt)}
                reconciliation={
                  receipt?.reconciliationStatus ??
                  (transactionHash ? "RECONCILIATION_REQUIRED" : null)
                }
                finalized={Boolean(receipt)}
                /* The failing stage is derived from how far the operation got,
                   not from parsing the message. What matters is which step an
                   operator has to act on: a wallet rejection before any hash
                   exists means nothing moved, while the same red text after a
                   hash exists means a real transaction is sitting unread. */
                failure={
                  error
                    ? {
                        stage: !authorization
                          ? "RYNTRA_AUTHORIZATION"
                          : !transactionHash
                            ? "WALLET_SIGNATURE"
                            : "RECONCILIATION",
                        message: error,
                      }
                    : null
                }
                busy={
                  busy === "authorize"
                    ? "RYNTRA_AUTHORIZATION"
                    : busy === "execute"
                      ? "WALLET_SIGNATURE"
                      : busy === "reconcile"
                        ? "RECONCILIATION"
                        : null
                }
              />
              {authorization ? (
                <p className={styles.authNote}>
                  Authorization method: {authorization.method}. Recorded by Ryntra, separately
                  from the wallet signature.
                </p>
              ) : null}
            </div>
          </aside>
        </section>

        <div className={styles.liveMessage} aria-live="polite">
          {error ? <span className={styles.error}><WarningCircle size={18} aria-hidden />{error}</span> : <span><CheckCircle size={18} aria-hidden />{message}</span>}
        </div>

        {/* The one state an operator must never walk away from: a real
            transaction exists on Arc and nobody has read what it did. It is
            recoverable and it is not automatic — Ryntra will not rebroadcast,
            because a second broadcast of a transaction that already succeeded
            would move the money twice. So the recovery is stated, with the
            hash, and the operator decides. */}
        {transactionHash && !receipt ? (
          <div className={styles.recoveryNotice} role="status">
            <WarningCircle size={20} aria-hidden />
            <div>
              <strong>Reconciliation required</strong>
              <p>
                Transaction <code>{transactionHash}</code> was broadcast and its result has not
                been read. The transaction is safe: it is on Arc whether or not this page is
                open, and Ryntra never rebroadcasts — a second broadcast of a transaction that
                already succeeded would move the money twice.
              </p>
              <p>
                Recover by pressing <strong>Reconcile Arc transaction</strong>. If the Arc RPC
                endpoint is unreachable from this server, the operation stays recorded and can
                be reconciled later from{" "}
                <Link href="/arc/workspace/activity">activity</Link>, or verified directly on{" "}
                <a
                  href={`${network?.explorerBaseUrl ?? ""}/tx/${transactionHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  the Arc Explorer
                </a>
                .
              </p>
            </div>
          </div>
        ) : null}

        <section className={embedded ? styles.evidenceRowEmbedded : styles.evidenceRow}>
          {/* Integration code is reference material, not part of the operation.
              In the workspace it lives on its own screen so the operator's flow
              is the operator's flow. */}
          {embedded ? null : (
          <div className={styles.developerPanel}>
            <div className={styles.devHeader}>
              <div>
                <p>FOR DEVELOPERS</p>
                <h2>Embed the same Guard kernel</h2>
              </div>
              <div className={styles.tabs} role="tablist" aria-label="Developer examples">
                {(["sdk", "api", "receipt"] as const).map((tab) => (
                  <button key={tab} role="tab" aria-selected={devTab === tab} onClick={() => setDevTab(tab)}>{tab.toUpperCase()}</button>
                ))}
              </div>
            </div>
            <div className={styles.codeWrap}>
              <pre><code>{devTab === "sdk"
                ? SDK_EXAMPLE
                : devTab === "api"
                  ? API_EXAMPLE
                  : receipt
                    ? JSON.stringify(receipt, null, 2)
                    : flow
                      ? JSON.stringify({ intent: flow.intent.id, receipt: "NOT_AVAILABLE", reason: "EXECUTION_NOT_CONFIRMED" }, null, 2)
                      : "Receipt is unavailable until a real Arc transaction is confirmed."}</code></pre>
              <button onClick={copyDeveloperExample} aria-label="Copy developer example"><Copy size={16} aria-hidden />{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
          )}

          <div className={styles.receiptPanel}>
            <div className={styles.panelHead}>
              <div><p>DECISION &amp; SETTLEMENT RECEIPT</p><h2>{receipt ? "Finalized" : "Not finalized"}</h2></div>
              <FileCode size={22} aria-hidden />
            </div>
            <dl>
              <div><dt>Intent</dt><dd className={styles.mono}>{flow?.intent.id ?? "—"}</dd></div>
              <div><dt>Ryntra authorization</dt><dd>{authorization ? "RECORDED" : "PENDING"}</dd></div>
              <div><dt>Wallet signature</dt><dd>{transactionHash ? "SIGNED BY KEY HOLDER" : "NOT SIGNED"}</dd></div>
              <div><dt>Transaction</dt><dd className={styles.mono}>{transactionHash ? shortAddress(transactionHash) : "NOT VERIFIED"}</dd></div>
              <div><dt>Reconciliation</dt><dd>{receipt?.reconciliationStatus ?? (transactionHash ? "REQUIRED" : "NOT STARTED")}</dd></div>
              <div><dt>Receipt hash</dt><dd className={styles.mono}>{receipt ? shortAddress(receipt.receiptHash) : "—"}</dd></div>
            </dl>
            <div className={receipt ? styles.receiptSuccess : styles.receiptBlocker}>
              {receipt
                ? "Expected and actual effects are recorded with a reconciliation result. This is not a safety or compliance guarantee."
                : "A receipt cannot finalize without a real Arc Testnet transaction hash and confirmed reconciliation."}
            </div>
            {explorerUrl ? (
              <a href={explorerUrl} target="_blank" rel="noreferrer" className={styles.explorerLink}>
                {transactionHash ? "Open exact transaction" : `Open ${network?.label ?? "explorer"}`}{" "}
                <ArrowSquareOut size={15} aria-hidden />
              </a>
            ) : null}
          </div>
        </section>

        {embedded ? null : (
          <footer className={styles.footer}>
            <span><Code size={16} aria-hidden /> Reference client for Ryntra Guard API + SDK</span>
            <span>Swap: request-bound. EOA fallback: exact calldata-bound. Memo support: false.</span>
          </footer>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong></div>;
}
