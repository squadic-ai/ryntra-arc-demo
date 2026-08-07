import {
  assetRefFor,
  chainRefFor,
  hexChainIdFor,
  publishedRpcEndpoints,
  resolveArcNetwork,
  resolveArcRpcUrl,
} from "./networks.ts";

import type { estimateSwap } from "@circle-fin/app-kit/estimateSwap";

import { hashCanonical } from "./service.ts";

/**
 * The active Arc network, projected into the shape the Arc adapters already use.
 *
 * Every value is derived from the registry in `networks.ts`, so a chain id, an
 * asset reference or an explorer URL cannot drift from the network definition.
 * Adding a network is a registry entry; nothing here changes.
 */
export const ARC_NETWORK = resolveArcNetwork();

export const ARC_TESTNET = {
  appKitChain: ARC_NETWORK.appKitChain,
  chainId: ARC_NETWORK.chainId,
  chainRef: chainRefFor(ARC_NETWORK),
  hexChainId: hexChainIdFor(ARC_NETWORK),
  explorerBaseUrl: ARC_NETWORK.explorerBaseUrl,
  usdcAssetRef: assetRefFor(ARC_NETWORK, ARC_NETWORK.tokens.usdc),
  eurcAssetRef: ARC_NETWORK.tokens.eurc
    ? assetRefFor(ARC_NETWORK, ARC_NETWORK.tokens.eurc)
    : "",
} as const;

/**
 * Every RPC endpoint the active network's operator publishes, primary first.
 * Derived from the registry so a mirror can never drift out of sync with the
 * network it belongs to.
 */
export const ARC_TESTNET_RPC_ENDPOINTS = publishedRpcEndpoints(ARC_NETWORK);

/** The active network's own primary endpoint. */
export const ARC_TESTNET_DEFAULT_RPC_URL = ARC_NETWORK.rpc.primary;

/**
 * Server-side Arc RPC endpoint for the active network.
 *
 * The operator's primary sits behind a WAF that refuses some networks outright
 * (observed: Cloudflare error 1009 from a blocked region). When that happens the
 * browser can still sign and broadcast, but every server-side read fails — which
 * means preflight evidence and, worse, post-broadcast reconciliation fail while a
 * real transaction already exists onchain. Hence configuration, and hence the
 * published mirrors above.
 */
export function resolveArcTestnetRpcUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveArcRpcUrl(ARC_NETWORK, env);
}

/**
 * Arc exposes one USDC balance through two interfaces with different decimals.
 * Both come from the network definition; neither is typed here.
 */
export const ARC_USDC_INTERFACES = {
  NATIVE: { kind: "NATIVE", decimals: ARC_NETWORK.nativeCurrency.decimals },
  ERC20: {
    kind: "ERC20",
    decimals: ARC_NETWORK.tokens.usdc.decimals,
    address: ARC_NETWORK.tokens.usdc.address,
  },
} as const;

export type ArcUsdcInterfaceKind = keyof typeof ARC_USDC_INTERFACES;

export type ArcAppKitAdapterErrorCode =
  | "ARC_ESTIMATE_MISMATCH"
  | "ARC_ESTIMATE_INVALID"
  | "ARC_UNSUPPORTED_REQUEST";

export class ArcAppKitAdapterError extends Error {
  readonly code: ArcAppKitAdapterErrorCode;

  constructor(code: ArcAppKitAdapterErrorCode, message: string) {
    super(message);
    this.name = "ArcAppKitAdapterError";
    this.code = code;
  }
}

export function isArcAppKitAdapterError(
  error: unknown,
  code?: ArcAppKitAdapterErrorCode,
): error is ArcAppKitAdapterError {
  return error instanceof ArcAppKitAdapterError && (!code || error.code === code);
}

type CircleSwapEstimate = Awaited<ReturnType<typeof estimateSwap>>;

export type ArcSwapRequest = {
  chain: "Arc_Testnet";
  tokenIn: "USDC";
  tokenOut: "EURC";
  amountIn: string;
  recipientAddress: string;
  slippageBps: number;
};

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parseDecimal(value: string): { integer: string; fraction: string } {
  const match = DECIMAL.exec(value);
  if (!match) {
    throw new ArcAppKitAdapterError(
      "ARC_ESTIMATE_INVALID",
      "App Kit returned an invalid financial decimal string.",
    );
  }
  return { integer: match[1], fraction: match[2] ?? "" };
}

export function arcUsdcAmountToBaseUnits(
  value: string,
  interfaceKind: ArcUsdcInterfaceKind,
): bigint {
  const parsed = parseDecimal(value);
  const decimals = ARC_USDC_INTERFACES[interfaceKind].decimals;
  if (parsed.fraction.length > decimals) {
    throw new ArcAppKitAdapterError(
      "ARC_ESTIMATE_INVALID",
      `Arc ${interfaceKind} USDC supports at most ${decimals} decimal places.`,
    );
  }
  return BigInt(`${parsed.integer}${parsed.fraction.padEnd(decimals, "0")}`);
}

export function arcUsdcBaseUnitsToAmount(
  value: bigint,
  interfaceKind: ArcUsdcInterfaceKind,
): string {
  if (value < 0n) {
    throw new ArcAppKitAdapterError("ARC_ESTIMATE_INVALID", "Arc USDC amount cannot be negative.");
  }
  const decimals = ARC_USDC_INTERFACES[interfaceKind].decimals;
  const rendered = value.toString().padStart(decimals + 1, "0");
  const integer = rendered.slice(0, -decimals);
  const fraction = rendered.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function addDecimals(values: readonly string[]): string {
  const parsed = values.map(parseDecimal);
  const scale = parsed.reduce((maximum, value) => Math.max(maximum, value.fraction.length), 0);
  const total = parsed.reduce((sum, value) => {
    const digits = `${value.integer}${value.fraction.padEnd(scale, "0")}`;
    return sum + BigInt(digits || "0");
  }, 0n);
  const rendered = total.toString().padStart(scale + 1, "0");
  if (scale === 0) return rendered;
  return `${rendered.slice(0, -scale)}.${rendered.slice(-scale)}`;
}

function assetRef(token: string): string {
  if (token === "USDC") return ARC_TESTNET.usdcAssetRef;
  if (token === "EURC") return ARC_TESTNET.eurcAssetRef;
  throw new ArcAppKitAdapterError(
    "ARC_UNSUPPORTED_REQUEST",
    `The urgent Arc prototype does not support token ${token}.`,
  );
}

function assertRequest(request: ArcSwapRequest): void {
  if (
    request.chain !== ARC_TESTNET.appKitChain ||
    request.tokenIn !== "USDC" ||
    request.tokenOut !== "EURC"
  ) {
    throw new ArcAppKitAdapterError(
      "ARC_UNSUPPORTED_REQUEST",
      "The urgent prototype supports only USDC to EURC on Arc Testnet.",
    );
  }
  parseDecimal(request.amountIn);
  if (!ADDRESS.test(request.recipientAddress)) {
    throw new ArcAppKitAdapterError("ARC_UNSUPPORTED_REQUEST", "Recipient must be an EVM address.");
  }
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0) {
    throw new ArcAppKitAdapterError(
      "ARC_UNSUPPORTED_REQUEST",
      "Configured slippage must be a non-negative integer number of basis points.",
    );
  }
}

function assertEstimateMatches(request: ArcSwapRequest, estimate: CircleSwapEstimate): void {
  const matches =
    estimate.chainIn === request.chain &&
    estimate.chainOut === request.chain &&
    estimate.tokenIn === request.tokenIn &&
    estimate.tokenOut === request.tokenOut &&
    estimate.amountIn === request.amountIn &&
    estimate.fromAddress.toLowerCase() === request.recipientAddress.toLowerCase() &&
    estimate.toAddress.toLowerCase() === request.recipientAddress.toLowerCase() &&
    estimate.stopLimit.token === request.tokenOut &&
    estimate.estimatedOutput.token === request.tokenOut;
  if (!matches) {
    throw new ArcAppKitAdapterError(
      "ARC_ESTIMATE_MISMATCH",
      "The App Kit estimate is not bound to the requested Arc swap parameters.",
    );
  }
  parseDecimal(estimate.stopLimit.amount);
  parseDecimal(estimate.estimatedOutput.amount);
}

export function createArcAppKitRequestBinding(
  request: ArcSwapRequest,
  estimate: CircleSwapEstimate,
) {
  assertRequest(request);
  const payload = {
    schemaVersion: "1.0.0",
    adapter: "circle-app-kit",
    adapterVersion: "1.11.0",
    request: {
      ...request,
      recipientAddress: request.recipientAddress.toLowerCase(),
    },
    estimateHash: hashCanonical(estimate),
  };
  return {
    kind: "APP_KIT_REQUEST" as const,
    schemaVersion: "1.0.0" as const,
    hash: hashCanonical(payload),
    payload,
    productionCalldataBound: false,
    limitation: "Circle App Kit 1.11.0 does not expose prebuilt target/calldata in estimateSwap.",
  };
}

export function normalizeArcSwapEstimate({
  request,
  estimate,
  observedAt,
  receivedAt,
  freshnessSeconds,
}: {
  request: ArcSwapRequest;
  estimate: CircleSwapEstimate;
  observedAt: string;
  receivedAt: string;
  freshnessSeconds: number;
}) {
  assertRequest(request);
  assertEstimateMatches(request, estimate);
  const receivedAtMs = Date.parse(receivedAt);
  if (
    !Number.isFinite(Date.parse(observedAt)) ||
    !Number.isFinite(receivedAtMs) ||
    !Number.isInteger(freshnessSeconds) ||
    freshnessSeconds <= 0 ||
    freshnessSeconds > 3_600
  ) {
    throw new ArcAppKitAdapterError(
      "ARC_ESTIMATE_INVALID",
      "Evidence timestamps or freshness contract are invalid.",
    );
  }

  const fees = estimate.fees;
  const missingEvidence: string[] = [];
  if (!fees) missingEvidence.push("FEE_BREAKDOWN");
  for (const fee of fees ?? []) {
    if (fee.amount === null) missingEvidence.push(`FEE_AMOUNT:${fee.type}`);
    else parseDecimal(fee.amount);
    if (fee.token !== request.tokenIn) {
      missingEvidence.push(`FEE_CURRENCY_CONVERSION:${fee.token}`);
    }
  }
  const feeAmount =
    missingEvidence.length === 0 ? addDecimals((fees ?? []).map((fee) => fee.amount as string)) : null;
  const totalDebit = feeAmount === null ? null : addDecimals([request.amountIn, feeAmount]);
  const requestHash = hashCanonical(request);
  const responseHash = hashCanonical(estimate);
  const validUntil = new Date(receivedAtMs + freshnessSeconds * 1_000).toISOString();
  const quoteRef = `quote_arc_${responseHash.slice(2, 18)}`;

  return {
    schemaVersion: "1.0.0" as const,
    id: `ev_${responseHash.slice(2, 18)}`,
    provider: "Circle App Kit",
    sourceRef: "circle-app-kit:estimateSwap",
    adapter: "circle-app-kit",
    adapterVersion: "1.11.0",
    sourceType: "SWAP_QUOTE" as const,
    observedAt,
    receivedAt,
    validUntil,
    confidence: "PROVIDER_REPORTED",
    coverage: {
      subjectRefs: [ARC_TESTNET.chainRef, assetRef(request.tokenIn), assetRef(request.tokenOut)],
      fields: [
        "amountIn",
        "expectedAmountOut",
        "minimumAmountOut",
        "fees",
        "slippageBps",
      ],
      limitations: ["UNDERLYING_ROUTE_UNAVAILABLE_FROM_APP_KIT_ESTIMATE"],
    },
    availability: missingEvidence.length === 0 ? ("AVAILABLE" as const) : ("PARTIAL" as const),
    verificationStatus: "PROVIDER_REPORTED" as const,
    chainRef: ARC_TESTNET.chainRef,
    blockRef: null,
    transactionRef: null,
    status: missingEvidence.length === 0 ? ("VALID" as const) : ("MISSING" as const),
    requestHash,
    responseHash,
    responseDigest: responseHash,
    reason:
      missingEvidence.length === 0 ? null : `MISSING_FIELDS:${missingEvidence.join(",")}`,
    transformationVersion: "arc-app-kit-estimate-v1",
    fallbackUsed: false,
    facts: {
      quoteRef,
      providerRef: "circle-app-kit",
      routeRef: "circle-app-kit:swap:Arc_Testnet",
      underlyingRouteDisclosure: "UNAVAILABLE_FROM_APP_KIT_ESTIMATE",
      sellAssetRef: assetRef(request.tokenIn),
      buyAssetRef: assetRef(request.tokenOut),
      amountIn: request.amountIn,
      expectedAmountOut: estimate.estimatedOutput.amount,
      minimumAmountOut: estimate.stopLimit.amount,
      feeAmount,
      feeBreakdown: structuredClone(fees ?? []),
      totalDebit,
      slippageBps: String(request.slippageBps),
      missingEvidence,
    },
  };
}
