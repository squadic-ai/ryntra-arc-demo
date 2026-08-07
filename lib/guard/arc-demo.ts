import type { estimateSwap } from "@circle-fin/app-kit/estimateSwap";
import { z } from "zod";

import { compareDecimalStrings } from "./kernel.ts";
import {
  ARC_TESTNET,
  createArcAppKitRequestBinding,
  normalizeArcSwapEstimate,
  resolveArcTestnetRpcUrl,
  type ArcSwapRequest,
} from "./arc-app-kit.ts";
import { ARC_DEMO_POLICY } from "./api.ts";
import { ExecutionIntentSchema } from "./contracts.ts";

type CircleSwapEstimate = Awaited<ReturnType<typeof estimateSwap>>;

export type ArcDemoErrorCode =
  | "VALIDATION_ERROR"
  | "CIRCLE_APP_KIT_KEY_REQUIRED"
  | "ARC_ESTIMATE_UNAVAILABLE";

export class ArcDemoError extends Error {
  readonly code: ArcDemoErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: string;

  constructor(
    code: ArcDemoErrorCode,
    message: string,
    options: { retryable?: boolean; requiredAction: string },
  ) {
    super(message);
    this.name = "ArcDemoError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requiredAction = options.requiredAction;
  }
}

export function isArcDemoError(
  error: unknown,
  code?: ArcDemoErrorCode,
): error is ArcDemoError {
  return error instanceof ArcDemoError && (!code || error.code === code);
}

const ArcDemoSwapRequestSchema = z
  .object({
    chain: z.literal("Arc_Testnet"),
    tokenIn: z.literal("USDC"),
    tokenOut: z.literal("EURC"),
    amountIn: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    recipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    slippageBps: z.number().int().min(0).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.amountIn)) return;
    if (compareDecimalStrings(value.amountIn, "0") !== 1) {
      context.addIssue({ code: "custom", path: ["amountIn"], message: "Amount must be positive." });
    }
    if (compareDecimalStrings(value.amountIn, "1000.00") === 1) {
      context.addIssue({ code: "custom", path: ["amountIn"], message: "Demo amount exceeds its public boundary." });
    }
  });

export function parseArcDemoSwapRequest(value: unknown): ArcSwapRequest {
  const parsed = ArcDemoSwapRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArcDemoError("VALIDATION_ERROR", "The Arc demo request is invalid or out of scope.", {
      requiredAction: "CORRECT_ARC_DEMO_REQUEST",
    });
  }
  return parsed.data;
}

type EstimateWithCircle = (input: {
  request: ArcSwapRequest;
  kitKey: string;
}) => Promise<CircleSwapEstimate>;

async function realCircleEstimate({
  request,
  kitKey,
}: {
  request: ArcSwapRequest;
  kitKey: string;
}): Promise<CircleSwapEstimate> {
  const [{ AppKit }, { ArcTestnet }, { createViemAdapter }, { createPublicClient, http }] =
    await Promise.all([
      import("@circle-fin/app-kit"),
      import("@circle-fin/app-kit/chains"),
      import("@circle-fin/adapter-viem-v2/next"),
      import("viem"),
    ]);

  const adapter = createViemAdapter({
    capabilities: {
      addressContext: "user-controlled",
      supportedChains: [ArcTestnet],
    },
    address: request.recipientAddress as `0x${string}`,
    getPublicClient: ({ chain }) =>
      createPublicClient({
        chain,
        transport: http(resolveArcTestnetRpcUrl(), { timeout: 12_000 }),
      }),
  });
  const kit = new AppKit({ disableAnalytics: true, disableErrorReporting: true });
  return kit.estimateSwap({
    from: { adapter, chain: request.chain },
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    config: {
      allowanceStrategy: "approve",
      kitKey,
      slippageBps: request.slippageBps,
    },
  });
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new ArcDemoError("ARC_ESTIMATE_UNAVAILABLE", "Circle App Kit estimate timed out.", {
                retryable: true,
                requiredAction: "RETRY_ESTIMATE",
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function estimateArcSwapForDemo({
  request: rawRequest,
  kitKey,
  estimateWithCircle = realCircleEstimate,
  now = () => new Date().toISOString(),
}: {
  request: unknown;
  kitKey: string | undefined;
  estimateWithCircle?: EstimateWithCircle;
  now?: () => string;
}) {
  const request = parseArcDemoSwapRequest(rawRequest);
  if (!kitKey) {
    throw new ArcDemoError(
      "CIRCLE_APP_KIT_KEY_REQUIRED",
      "Circle App Kit estimate is unavailable because the server credential is not configured.",
      { requiredAction: "CONFIGURE_SERVER_SIDE_CIRCLE_APP_KIT_KEY" },
    );
  }

  const observedAt = now();
  let estimate: CircleSwapEstimate;
  try {
    estimate = await within(estimateWithCircle({ request, kitKey }), 15_000);
  } catch (error) {
    if (isArcDemoError(error)) throw error;
    throw new ArcDemoError(
      "ARC_ESTIMATE_UNAVAILABLE",
      "Circle App Kit did not return a usable Arc Testnet estimate.",
      { retryable: true, requiredAction: "RETRY_OR_VERIFY_CIRCLE_CONFIGURATION" },
    );
  }
  const receivedAt = now();
  return {
    request,
    estimate,
    evidence: normalizeArcSwapEstimate({
      request,
      estimate,
      observedAt,
      receivedAt,
      freshnessSeconds: 120,
    }),
    binding: createArcAppKitRequestBinding(request, estimate),
  };
}

export function buildArcDemoIntent({
  tenantId,
  intentId,
  idempotencyKey,
  request,
  evidence,
  binding,
  createdAt,
}: {
  tenantId: string;
  intentId: string;
  idempotencyKey: string;
  request: ArcSwapRequest;
  evidence: ReturnType<typeof normalizeArcSwapEstimate>;
  binding: ReturnType<typeof createArcAppKitRequestBinding>;
  createdAt: string;
}) {
  return ExecutionIntentSchema.parse({
    schemaVersion: "1.0.0",
    id: intentId,
    tenantId,
    applicationId: "partner-arc-demo",
    externalPartnerId: "hackathon-reference-client",
    subjectRef: `wallet:${request.recipientAddress.toLowerCase()}`,
    walletAddress: request.recipientAddress.toLowerCase(),
    walletType: "EOA",
    chainRef: ARC_TESTNET.chainRef,
    environment: "ARC_TESTNET",
    actionType: "SWAP",
    instrumentRef: "instrument:arc-testnet:usdc-eurc-spot-swap",
    sellAssetRef: ARC_TESTNET.usdcAssetRef,
    buyAssetRef: ARC_TESTNET.eurcAssetRef,
    amount: request.amountIn,
    amountType: "EXACT_INPUT",
    recipient: request.recipientAddress.toLowerCase(),
    venueRef: "circle-app-kit",
    routeRef: String(evidence.facts.routeRef),
    quoteRef: String(evidence.facts.quoteRef),
    executionBindingKind: "APP_KIT_REQUEST",
    target: null,
    calldataHash: null,
    nativeValue: "0",
    adapterRequestHash: binding.hash,
    productionCalldataBound: false,
    portfolioSnapshotRef: null,
    policyRef: { id: ARC_DEMO_POLICY.id, version: ARC_DEMO_POLICY.version },
    createdAt,
    expiresAt: evidence.validUntil,
    revision: 1,
    idempotencyKey,
  });
}
