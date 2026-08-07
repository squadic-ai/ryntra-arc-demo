import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server.js";
import { z } from "zod";

import {
  ARC_DEMO_POLICY,
  GuardApiError,
  correlationIdFromHeader,
  readBoundedGuardJson,
  structuredGuardError,
} from "../../../lib/guard/api.ts";
import {
  buildArcDemoIntent,
  estimateArcSwapForDemo,
  isArcDemoError,
} from "../../../lib/guard/arc-demo.ts";
import { ARC_NETWORK, ARC_TESTNET, ARC_USDC_INTERFACES } from "../../../lib/guard/arc-app-kit.ts";
import { ARC_NETWORKS, hexChainIdFor, publishedRpcEndpoints } from "../../../lib/guard/networks.ts";
import { RECORDED_RUN } from "../../arc/arc-project.ts";
import {
  ARC_USDC_TRANSFER_POLICY,
  ArcUsdcTransferError,
  buildArcUsdcTransferIntent,
  prepareArcUsdcTreasuryTransfer,
  reconcileArcUsdcTreasuryTransfer,
} from "../../../lib/guard/arc-usdc-transfer.ts";
import { DecisionSettlementReceiptSchema, ExecutionFingerprintSchema } from "../../../lib/guard/contracts.ts";
import { getGuardRuntime } from "../../../lib/guard/runtime.ts";
import { guardStoreLimitations } from "../../../lib/guard/store.ts";
import { buildExecutionFingerprint, hashCanonical } from "../../../lib/guard/service.ts";
import {
  clientIp,
  privateNoStoreHeaders,
  rateLimitHeaders,
} from "../../../lib/http-control.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "ryntra_arc_demo_session";
const SESSION = /^demo_[0-9a-f]{32}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,256}$/;

const EstimateActionSchema = z
  .object({
    action: z.literal("ESTIMATE_AND_PREFLIGHT"),
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    amountIn: z.string(),
    slippageBps: z.number().int(),
    idempotencyKey: z.string().regex(IDEMPOTENCY),
  })
  .strict();

const AuthorizeActionSchema = z
  .object({
    action: z.literal("AUTHORIZE"),
    intentId: z.string().min(3).max(128),
    evaluationId: z.string().min(3).max(128),
    fingerprint: ExecutionFingerprintSchema,
    idempotencyKey: z.string().regex(IDEMPOTENCY),
  })
  .strict();

const PrepareTransferActionSchema = z
  .object({
    action: z.literal("PREPARE_TRANSFER"),
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    recipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    amount: z.string(),
    idempotencyKey: z.string().regex(IDEMPOTENCY),
  })
  .strict();

const RecordExecutionActionSchema = z
  .object({
    action: z.literal("RECORD_EXECUTION"),
    intentId: z.string().min(3).max(128),
    authorizationId: z.string().min(3).max(128),
    fingerprint: ExecutionFingerprintSchema,
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    idempotencyKey: z.string().regex(IDEMPOTENCY),
  })
  .strict();

const ReconcileTransferActionSchema = z
  .object({
    action: z.literal("RECONCILE_TRANSFER"),
    intentId: z.string().min(3).max(128),
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    idempotencyKey: z.string().regex(IDEMPOTENCY),
  })
  .strict();

const DemoActionSchema = z.discriminatedUnion("action", [
  EstimateActionSchema,
  PrepareTransferActionSchema,
  AuthorizeActionSchema,
  RecordExecutionActionSchema,
  ReconcileTransferActionSchema,
]);

function sessionFromRequest(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const existing = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const session = existing && SESSION.test(existing)
    ? existing
    : `demo_${randomUUID().replaceAll("-", "")}`;
  return {
    session,
    tenantId: `arc_demo_${session.slice("demo_".length)}`,
  };
}

function demoHeaders({
  request,
  correlationId,
  session,
  rate,
}: {
  request: Request;
  correlationId: string;
  session: string;
  rate?: ReturnType<ReturnType<typeof getGuardRuntime>["limiter"]["consume"]>;
}) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    ...privateNoStoreHeaders(),
    ...(rate ? rateLimitHeaders(rate) : {}),
    "Set-Cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200${secure}`,
    "X-Correlation-Id": correlationId,
    "X-Ryntra-Prototype": "ARC_TESTNET_HACKATHON",
  };
}

function publicObject(value: Record<string, unknown>) {
  const publicValue = { ...value };
  delete publicValue.tenantId;
  return publicValue;
}

function translateDemoError(error: unknown): unknown {
  if (error instanceof ArcUsdcTransferError) {
    if (error.code === "ARC_TRANSFER_INVALID" || error.code === "ARC_TRANSFER_UNSUPPORTED_WALLET") {
      return new GuardApiError("VALIDATION_ERROR", error.message, {
        requiredAction: "CORRECT_EOA_TRANSFER_REQUEST",
      });
    }
    return new GuardApiError("EVIDENCE_INSUFFICIENT", error.message, {
      retryable: error.code === "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      requiredAction:
        error.code === "ARC_TRANSFER_INSUFFICIENT_BALANCE"
          ? "FUND_OWNER_CONTROLLED_ARC_TESTNET_EOA"
          : "RETRY_OR_VERIFY_ARC_TESTNET_RPC",
    });
  }
  if (!isArcDemoError(error)) return error;
  if (error.code === "VALIDATION_ERROR") {
    return new GuardApiError("VALIDATION_ERROR", error.message, {
      requiredAction: error.requiredAction,
    });
  }
  if (error.code === "CIRCLE_APP_KIT_KEY_REQUIRED") {
    return new GuardApiError("CAPABILITY_UNAVAILABLE", error.message, {
      requiredAction: error.requiredAction,
    });
  }
  return new GuardApiError("EVIDENCE_INSUFFICIENT", error.message, {
    retryable: error.retryable,
    requiredAction: error.requiredAction,
  });
}

function validationError() {
  return new GuardApiError("VALIDATION_ERROR", "The Arc demo request is invalid.", {
    requiredAction: "CORRECT_REQUEST",
  });
}

export async function GET(request: Request) {
  const correlationId = correlationIdFromHeader(
    request.headers.get("x-correlation-id"),
    () => `corr_${randomUUID().replaceAll("-", "")}`,
  );
  const { session } = sessionFromRequest(request);
  return NextResponse.json(
    {
      data: {
        schemaVersion: "1.0.0",
        /* The whole network definition is served, so the browser owns no chain
           facts of its own. A wallet is configured from what the server is
           actually connected to — which is why a transposed hex literal in the
           client cannot silently disagree with the chain again, and why adding
           a network later is server configuration rather than a client release. */
        network: {
          id: ARC_NETWORK.id,
          label: ARC_NETWORK.label,
          shortLabel: ARC_NETWORK.shortLabel,
          status: ARC_NETWORK.status,
          chainId: ARC_NETWORK.chainId,
          hexChainId: hexChainIdFor(ARC_NETWORK),
          chainRef: ARC_TESTNET.chainRef,
          appKitChain: ARC_NETWORK.appKitChain,
          explorerBaseUrl: ARC_NETWORK.explorerBaseUrl,
          rpcUrls: publishedRpcEndpoints(ARC_NETWORK),
          rpcEndpoints: publishedRpcEndpoints(ARC_NETWORK),
          /* The browser makes its own RPC calls from the operator's network, so
             the wallet needs an endpoint reachable from there — which is not
             necessarily the one the server uses. Public by design. */
          browserRpcUrl:
            process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL?.trim() || ARC_NETWORK.rpc.primary,
          nativeCurrency: ARC_NETWORK.nativeCurrency,
          tokens: ARC_NETWORK.tokens,
          carriesRealValue: ARC_NETWORK.carriesRealValue,
        },
        /* Every selectable network, so the workspace can show that mainnet is
           modelled and gated rather than hiding it. A gate the operator can
           read is worth more than an option they never knew existed. */
        networks: ARC_NETWORKS.map((entry) => ({
          id: entry.id,
          label: entry.label,
          shortLabel: entry.shortLabel,
          status: entry.status,
          carriesRealValue: entry.carriesRealValue,
          gate: entry.gate,
        })),
        environment: "ARC_TESTNET",
        chainRef: ARC_TESTNET.chainRef,
        chainId: ARC_NETWORK.chainId,
        flow: "USDC_TO_EURC_SWAP",
        fallbackFlow: "EOA_USDC_ERC20_TREASURY_TRANSFER",
        circleCredentialConfigured: Boolean(process.env.CIRCLE_APP_KIT_KEY),
        /* Derived from the recorded run rather than typed. This field read
           `false` with a `null` hash for a day after Gate B passed, because a
           literal cannot notice that the world changed. Capability status is
           evidence, so it is read from the evidence. */
        liveExecutionVerified: RECORDED_RUN.transactionHash !== null,
        verifiedOperation: RECORDED_RUN.transactionHash ? "EOA_USDC_ERC20_TREASURY_TRANSFER" : null,
        transactionHash: RECORDED_RUN.transactionHash,
        explorerUrl: RECORDED_RUN.explorerUrl,
        authorizationMethod: "PARTNER_AUTHENTICATED",
        executionBinding: "APP_KIT_REQUEST_NOT_CALLDATA",
        fallbackExecutionBinding: "EXACT_EVM_TARGET_CALLDATA_VALUE",
        nativeUsdcDecimals: ARC_USDC_INTERFACES.NATIVE.decimals,
        erc20UsdcDecimals: ARC_USDC_INTERFACES.ERC20.decimals,
        memoSupported: false,
        /* Two of these used to be literals and both were capable of lying: the
           execution limitation survived Gate B, and the store limitation named
           one adapter while the process ran another. Each is now read from the
           thing it describes. */
        limitations: [
          "INDEPENDENT_PROJECT",
          "ARC_TESTNET",
          "HACKATHON_PROTOTYPE",
          "NOT_AUDITED",
          "NOT_FINANCIAL_ADVICE",
          ...(RECORDED_RUN.transactionHash ? [] : ["LIVE_EXECUTION_NOT_VERIFIED"]),
          "SWAP_NOT_VERIFIED",
          ...guardStoreLimitations(getGuardRuntime().store),
        ],
      },
    },
    { headers: demoHeaders({ request, correlationId, session }) },
  );
}

export async function POST(request: Request) {
  const correlationId = correlationIdFromHeader(
    request.headers.get("x-correlation-id"),
    () => `corr_${randomUUID().replaceAll("-", "")}`,
  );
  const { session, tenantId } = sessionFromRequest(request);
  let rate: ReturnType<ReturnType<typeof getGuardRuntime>["limiter"]["consume"]> | undefined;
  try {
    const runtimeState = getGuardRuntime();
    rate = runtimeState.limiter.consume(`arc-demo:${tenantId}:${clientIp(request.headers)}`);
    if (!rate.allowed) {
      throw new GuardApiError("RATE_LIMITED", "Arc demo rate limit reached.", {
        retryable: true,
        requiredAction: "RETRY_AFTER_RATE_LIMIT",
      });
    }
    /* Same fail-closed durability gate the versioned API applies: every demo
       action below writes lifecycle state, so a deployment whose store cannot
       outlive one instance is refused instead of losing the intent between the
       estimate and the wallet signature. */
    if (!runtimeState.writes.allowed) {
      throw new GuardApiError("CAPABILITY_UNAVAILABLE", runtimeState.writes.reason, {
        retryable: false,
        requiredAction: runtimeState.writes.requiredAction,
      });
    }
    const parsed = DemoActionSchema.safeParse(await readBoundedGuardJson(request));
    if (!parsed.success) throw validationError();

    if (parsed.data.action === "ESTIMATE_AND_PREFLIGHT") {
      const requestInput = {
        chain: "Arc_Testnet" as const,
        tokenIn: "USDC" as const,
        tokenOut: "EURC" as const,
        amountIn: parsed.data.amountIn,
        recipientAddress: parsed.data.walletAddress,
        slippageBps: parsed.data.slippageBps,
      };
      const estimate = await estimateArcSwapForDemo({
        request: requestInput,
        kitKey: process.env.CIRCLE_APP_KIT_KEY,
      });
      const intentId = `int_${randomUUID().replaceAll("-", "")}`;
      const intent = buildArcDemoIntent({
        tenantId,
        intentId,
        idempotencyKey: parsed.data.idempotencyKey,
        request: estimate.request,
        evidence: estimate.evidence,
        binding: estimate.binding,
        createdAt: estimate.evidence.receivedAt,
      });
      const storedIntent = await runtimeState.service.createIntent({
        tenantId,
        intent: intent as Parameters<typeof runtimeState.service.createIntent>[0]["intent"],
        idempotencyKey: parsed.data.idempotencyKey,
      });
      const evaluation = await runtimeState.service.preflight({
        tenantId,
        intentId,
        evidence: [
          estimate.evidence as unknown as Parameters<
            typeof runtimeState.service.preflight
          >[0]["evidence"][number],
        ],
        policy: ARC_DEMO_POLICY,
        idempotencyKey: `${parsed.data.idempotencyKey}:preflight`,
      });
      const authorizable =
        evaluation.outcome === "ALLOWED_BY_POLICY" || evaluation.outcome === "REVIEW_REQUIRED";
      const fingerprint = authorizable
        ? buildExecutionFingerprint({
            intent: intent as Parameters<typeof buildExecutionFingerprint>[0]["intent"],
            quote: estimate.evidence as unknown as Parameters<
              typeof buildExecutionFingerprint
            >[0]["quote"],
          })
        : null;

      return NextResponse.json(
        {
          data: {
            flowKind: "APP_KIT_SWAP",
            intent: publicObject(storedIntent),
            estimate: {
              provider: estimate.evidence.provider,
              route: estimate.evidence.facts.routeRef,
              amountIn: estimate.evidence.facts.amountIn,
              expectedAmountOut: estimate.evidence.facts.expectedAmountOut,
              minimumAmountOut: estimate.evidence.facts.minimumAmountOut,
              feeAmount: estimate.evidence.facts.feeAmount,
              totalDebit: estimate.evidence.facts.totalDebit,
              slippageBps: estimate.evidence.facts.slippageBps,
              validUntil: estimate.evidence.validUntil,
              missingEvidence: estimate.evidence.facts.missingEvidence,
            },
            evidence: estimate.evidence,
            evaluation: publicObject(evaluation),
            fingerprint,
            transaction: null,
            executionAvailable: false,
            executionBlocker: "SECURE_APP_KIT_EXTERNAL_SIGNING_HANDSHAKE_NOT_IMPLEMENTED",
            memoSupported: false,
          },
        },
        {
          status: 201,
          headers: demoHeaders({ request, correlationId, session, rate }),
        },
      );
    }

    if (parsed.data.action === "PREPARE_TRANSFER") {
      const prepared = await prepareArcUsdcTreasuryTransfer({
        request: {
          walletType: "EOA",
          walletAddress: parsed.data.walletAddress,
          recipientAddress: parsed.data.recipientAddress,
          amount: parsed.data.amount,
        },
      });
      const intentId = `int_${randomUUID().replaceAll("-", "")}`;
      const intent = buildArcUsdcTransferIntent({
        tenantId,
        intentId,
        idempotencyKey: parsed.data.idempotencyKey,
        prepared,
        createdAt: prepared.evidence.receivedAt,
      });
      const storedIntent = await runtimeState.service.createIntent({
        tenantId,
        intent: intent as Parameters<typeof runtimeState.service.createIntent>[0]["intent"],
        idempotencyKey: parsed.data.idempotencyKey,
      });
      const evaluation = await runtimeState.service.preflight({
        tenantId,
        intentId,
        evidence: [
          prepared.evidence as unknown as Parameters<
            typeof runtimeState.service.preflight
          >[0]["evidence"][number],
        ],
        policy: ARC_USDC_TRANSFER_POLICY,
        idempotencyKey: `${parsed.data.idempotencyKey}:preflight`,
      });
      const authorizable =
        evaluation.policyDecision === "ALLOWED_BY_POLICY" ||
        evaluation.policyDecision === "REVIEW_REQUIRED";
      const fingerprint = authorizable
        ? buildExecutionFingerprint({
            intent: intent as Parameters<typeof buildExecutionFingerprint>[0]["intent"],
            quote: prepared.evidence as unknown as Parameters<
              typeof buildExecutionFingerprint
            >[0]["quote"],
          })
        : null;
      return NextResponse.json(
        {
          data: {
            flowKind: "EOA_USDC_TRANSFER",
            intent: publicObject(storedIntent),
            estimate: {
              provider: prepared.evidence.provider,
              route: prepared.evidence.facts.routeRef,
              amountIn: prepared.evidence.facts.amountIn,
              expectedAmountOut: prepared.evidence.facts.expectedAmountOut,
              minimumAmountOut: prepared.evidence.facts.minimumAmountOut,
              feeAmount: prepared.evidence.facts.feeAmount,
              totalDebit: prepared.evidence.facts.totalDebit,
              slippageBps: prepared.evidence.facts.slippageBps,
              validUntil: prepared.evidence.validUntil,
              missingEvidence: [],
            },
            evidence: prepared.evidence,
            evaluation: publicObject(evaluation),
            fingerprint,
            transaction: prepared.transaction,
            executionAvailable: Boolean(authorizable && fingerprint),
            executionBlocker: authorizable ? null : "TRANSFER_PREFLIGHT_NOT_AUTHORIZABLE",
            memoSupported: false,
          },
        },
        { status: 201, headers: demoHeaders({ request, correlationId, session, rate }) },
      );
    }

    if (parsed.data.action === "AUTHORIZE") {
    const intent = await runtimeState.service.getIntent({
      tenantId,
      intentId: parsed.data.intentId,
    });
    if (intent.walletAddress !== parsed.data.fingerprint.walletAddress) {
      throw new GuardApiError("FINGERPRINT_MISMATCH", "Wallet differs from the intent.", {
        requiredAction: "CREATE_NEW_EVALUATION",
      });
    }
    const authorization = await runtimeState.service.authorize({
      tenantId,
      intentId: parsed.data.intentId,
      evaluationId: parsed.data.evaluationId,
      fingerprint: parsed.data.fingerprint,
      subjectRef: String(intent.subjectRef),
      method: "PARTNER_AUTHENTICATED",
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const exactTransactionBound =
      intent.executionBindingKind === "EVM_TRANSACTION" &&
      intent.productionCalldataBound === true;
    return NextResponse.json(
      {
        data: {
          authorization: publicObject(authorization),
          walletSignatureStatus: "NOT_STARTED",
          executionAvailable: exactTransactionBound,
          executionBlocker: exactTransactionBound
            ? null
            : "SECURE_APP_KIT_EXTERNAL_SIGNING_HANDSHAKE_NOT_IMPLEMENTED",
        },
      },
      { headers: demoHeaders({ request, correlationId, session, rate }) },
    );
    }

    if (parsed.data.action === "RECORD_EXECUTION") {
      const execution = await runtimeState.service.recordExecution({
        tenantId,
        intentId: parsed.data.intentId,
        authorizationId: parsed.data.authorizationId,
        fingerprint: parsed.data.fingerprint,
        transactionHash: parsed.data.transactionHash,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return NextResponse.json(
        {
          data: {
            execution: publicObject(execution),
            receipt: null,
            requiredAction: "RECONCILE_ARC_TRANSACTION",
          },
        },
        { status: 201, headers: demoHeaders({ request, correlationId, session, rate }) },
      );
    }

    const intent = await runtimeState.service.getIntent({
      tenantId,
      intentId: parsed.data.intentId,
    });
    if (intent.actionType !== "SEND" || intent.walletType !== "EOA") {
      throw new GuardApiError("CAPABILITY_UNAVAILABLE", "Only the EOA USDC transfer fallback can reconcile here.", {
        requiredAction: "USE_MATCHING_EXECUTION_ADAPTER",
      });
    }
    const observed = await reconcileArcUsdcTreasuryTransfer({
      transactionHash: parsed.data.transactionHash,
      intent: {
        walletAddress: String(intent.walletAddress),
        recipient: String(intent.recipient),
        amount: String(intent.amount),
        target: typeof intent.target === "string" ? intent.target : null,
        calldataHash: typeof intent.calldataHash === "string" ? intent.calldataHash : null,
      },
    });
    const execution = await runtimeState.service.reconcileExecution({
      tenantId,
      intentId: parsed.data.intentId,
      transactionHash: parsed.data.transactionHash,
      observedState: observed.observedState,
      ...(observed.observedState === "CONFIRMED" ? { actualOutcome: observed.actualOutcome } : {}),
      ...(observed.observedState === "CONFIRMED"
        ? {
            reconciliationEvidence: {
              provider: "Arc Testnet JSON-RPC",
              sourceRef: `${ARC_TESTNET.chainRef}:tx:${parsed.data.transactionHash.toLowerCase()}`,
              verificationStatus: "ONCHAIN_VERIFIED" as const,
              responseDigest: hashCanonical(observed),
            },
          }
        : {}),
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const receipt =
      observed.observedState === "CONFIRMED"
        ? DecisionSettlementReceiptSchema.parse(await runtimeState.service.getReceipt({ tenantId, intentId: parsed.data.intentId }))
        : null;
    return NextResponse.json(
      {
        data: {
          execution: publicObject(execution),
          receipt: receipt ? publicObject(receipt) : null,
          requiredAction:
            observed.observedState === "CONFIRMED" ? null : "RETRY_RECONCILIATION",
        },
      },
      { headers: demoHeaders({ request, correlationId, session, rate }) },
    );
  } catch (rawError) {
    const error = translateDemoError(rawError);
    const structured = structuredGuardError(error, correlationId);
    return NextResponse.json(structured.body, {
      status: structured.status,
      headers: demoHeaders({ request, correlationId, session, rate }),
    });
  }
}
