import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";

import {
  ARC_TESTNET,
  ARC_USDC_INTERFACES,
  arcUsdcAmountToBaseUnits,
  arcUsdcBaseUnitsToAmount,
  resolveArcTestnetRpcUrl,
} from "./arc-app-kit.ts";
import { compareDecimalStrings } from "./kernel.ts";
import { ExecutionIntentSchema, GuardPolicySchema } from "./contracts.ts";
import { GuardError, hashCanonical } from "./service.ts";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const ARC_USDC_TRANSFER_POLICY = GuardPolicySchema.parse({
  schemaVersion: "1.0.0",
  id: "demo-arc-usdc-transfer-policy",
  version: 1,
  publishedAt: "2026-08-06T00:00:00.000Z",
  immutable: true,
  rules: [
    { id: "allowed-chain", type: "ALLOWED_CHAIN", value: ARC_TESTNET.chainRef, onViolation: "BLOCK" },
    {
      id: "allowed-pair",
      type: "ALLOWED_PAIR",
      value: [ARC_TESTNET.usdcAssetRef, ARC_TESTNET.usdcAssetRef],
      onViolation: "BLOCK",
    },
    {
      id: "max-total-debit",
      type: "MAX_TOTAL_DEBIT",
      value: "100.00",
      currencyAssetRef: ARC_TESTNET.usdcAssetRef,
      onViolation: "BLOCK",
    },
    { id: "max-quote-age", type: "MAX_QUOTE_AGE_SECONDS", value: 120, onViolation: "INSUFFICIENT_EVIDENCE" },
    { id: "max-slippage", type: "MAX_SLIPPAGE_BPS", value: "0", onViolation: "REVIEW" },
    { id: "human-auth", type: "HUMAN_AUTHORIZATION_REQUIRED", value: true, onViolation: "REQUIRE_AUTHORIZATION" },
  ],
});

export type ArcUsdcTransferRequest = {
  walletType: "EOA" | "SMART_ACCOUNT" | "SAFE" | "ERC4337" | "OTHER";
  walletAddress: string;
  recipientAddress: string;
  amount: string;
};

export type ArcUsdcOnchainState = {
  chainId: number;
  blockNumber: string;
  contractCodeDigest: string;
  decimals: number;
  tokenBalanceBaseUnits: string;
  nativeBalanceBaseUnits: string;
  gasLimit: string;
  gasPriceBaseUnits: string;
};

export type ArcUsdcOnchainCollector = (input: {
  walletAddress: `0x${string}`;
  transaction: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: Hex;
    value: "0x0";
  };
}) => Promise<ArcUsdcOnchainState>;

export class ArcUsdcTransferError extends Error {
  readonly code:
    | "ARC_TRANSFER_INVALID"
    | "ARC_TRANSFER_UNSUPPORTED_WALLET"
    | "ARC_TRANSFER_EVIDENCE_UNAVAILABLE"
    | "ARC_TRANSFER_INSUFFICIENT_BALANCE";

  constructor(code: ArcUsdcTransferError["code"], message: string) {
    super(message);
    this.name = "ArcUsdcTransferError";
    this.code = code;
  }
}

function parseAddress(value: string, label: string): `0x${string}` {
  if (!EVM_ADDRESS.test(value)) {
    throw new ArcUsdcTransferError("ARC_TRANSFER_INVALID", `${label} must be an EVM address.`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function parseUnsignedInteger(value: string, label: string): bigint {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new ArcUsdcTransferError("ARC_TRANSFER_EVIDENCE_UNAVAILABLE", `${label} is invalid.`);
  }
  return BigInt(value);
}

export async function collectArcUsdcOnchainState({
  walletAddress,
  transaction,
}: Parameters<ArcUsdcOnchainCollector>[0]): Promise<ArcUsdcOnchainState> {
  const client = createPublicClient({
    transport: http(resolveArcTestnetRpcUrl(), { timeout: 12_000 }),
  });
  const tokenAddress = ARC_USDC_INTERFACES.ERC20.address;
  const [chainId, blockNumber, code, decimals, tokenBalance, nativeBalance, gasLimit, gasPrice] =
    await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getBytecode({ address: tokenAddress }),
      client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      }),
      client.getBalance({ address: walletAddress }),
      client.estimateGas({
        account: walletAddress,
        to: transaction.to,
        data: transaction.data,
        value: 0n,
      }),
      client.getGasPrice(),
    ]);
  if (!code || code === "0x") {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      "Arc Testnet USDC contract bytecode is unavailable.",
    );
  }
  return {
    chainId,
    blockNumber: blockNumber.toString(),
    contractCodeDigest: keccak256(code),
    decimals: Number(decimals),
    tokenBalanceBaseUnits: tokenBalance.toString(),
    nativeBalanceBaseUnits: nativeBalance.toString(),
    gasLimit: gasLimit.toString(),
    gasPriceBaseUnits: gasPrice.toString(),
  };
}

export async function prepareArcUsdcTreasuryTransfer({
  request,
  collectOnchainState = collectArcUsdcOnchainState,
  now = () => new Date().toISOString(),
}: {
  request: ArcUsdcTransferRequest;
  collectOnchainState?: ArcUsdcOnchainCollector;
  now?: () => string;
}) {
  if (request.walletType !== "EOA") {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_UNSUPPORTED_WALLET",
      "The Arc fallback supports a direct EOA caller only; Safe, SCA, and ERC-4337 are not claimed.",
    );
  }
  const walletAddress = parseAddress(request.walletAddress, "Wallet");
  const recipientAddress = parseAddress(request.recipientAddress, "Recipient");
  const amountBaseUnits = arcUsdcAmountToBaseUnits(request.amount, "ERC20");
  if (amountBaseUnits === 0n) {
    throw new ArcUsdcTransferError("ARC_TRANSFER_INVALID", "Transfer amount must be positive.");
  }
  const tokenAddress = ARC_USDC_INTERFACES.ERC20.address;
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [recipientAddress, amountBaseUnits],
  });
  const baseTransaction = {
    from: walletAddress,
    to: tokenAddress,
    data,
    value: "0x0" as const,
  };

  let state: ArcUsdcOnchainState;
  try {
    state = await collectOnchainState({ walletAddress, transaction: baseTransaction });
  } catch (error) {
    if (error instanceof ArcUsdcTransferError) throw error;
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      `Arc Testnet RPC evidence is unavailable at ${resolveArcTestnetRpcUrl()}; transfer authorization remains blocked. Set ARC_TESTNET_RPC_URL to an HTTPS endpoint this server can actually reach.`,
    );
  }
  if (state.chainId !== 5_042_002) {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      "The RPC chain ID does not match Arc Testnet.",
    );
  }
  if (state.decimals !== ARC_USDC_INTERFACES.ERC20.decimals) {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      "The onchain Arc USDC decimals do not match the documented ERC-20 interface.",
    );
  }
  const tokenBalance = parseUnsignedInteger(state.tokenBalanceBaseUnits, "ERC-20 balance");
  const nativeBalance = parseUnsignedInteger(state.nativeBalanceBaseUnits, "Native balance");
  const gasLimit = parseUnsignedInteger(state.gasLimit, "Gas limit");
  const gasPrice = parseUnsignedInteger(state.gasPriceBaseUnits, "Gas price");
  if (gasLimit === 0n || gasPrice === 0n) {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      "A non-zero Arc gas estimate is required before authorization.",
    );
  }
  const gasFeeBaseUnits = gasLimit * gasPrice;
  if (tokenBalance < amountBaseUnits || nativeBalance < gasFeeBaseUnits) {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_INSUFFICIENT_BALANCE",
      "The EOA lacks confirmed ERC-20 USDC or native Arc USDC for the planned transfer and gas.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(state.contractCodeDigest)) {
    throw new ArcUsdcTransferError(
      "ARC_TRANSFER_EVIDENCE_UNAVAILABLE",
      "The Arc USDC contract-code digest is invalid.",
    );
  }

  const observedAt = now();
  const validUntil = new Date(Date.parse(observedAt) + 120_000).toISOString();
  const nativeFeeAmount = arcUsdcBaseUnitsToAmount(gasFeeBaseUnits, "NATIVE");
  const economicAmountBaseUnits = amountBaseUnits * 10n ** 12n;
  const totalDebit = arcUsdcBaseUnitsToAmount(economicAmountBaseUnits + gasFeeBaseUnits, "NATIVE");
  if (compareDecimalStrings(totalDebit, request.amount) === -1) {
    throw new ArcUsdcTransferError("ARC_TRANSFER_INVALID", "Transfer debit normalization failed.");
  }
  const requestDigest = hashCanonical({
    chainRef: ARC_TESTNET.chainRef,
    walletAddress,
    recipientAddress,
    amount: request.amount,
    tokenInterface: "ERC20_6_DECIMALS",
  });
  const responseDigest = hashCanonical(state);
  const calldataHash = keccak256(data);
  const quoteRef = `transfer_arc_${responseDigest.slice(2, 18)}`;
  const transaction = {
    ...baseTransaction,
    gas: toHex(gasLimit),
    gasPrice: toHex(gasPrice),
  };
  const evidence = {
    schemaVersion: "1.0.0" as const,
    id: `ev_${responseDigest.slice(2, 18)}`,
    provider: "Arc Testnet JSON-RPC",
    sourceRef: `${ARC_TESTNET.chainRef}:${tokenAddress}@${state.blockNumber}`,
    adapter: "ryntra-arc-usdc-transfer",
    adapterVersion: "1.0.0",
    sourceType: "TRANSFER_PLAN" as const,
    observedAt,
    receivedAt: observedAt,
    validUntil,
    confidence: "ONCHAIN_POINT_IN_TIME",
    coverage: {
      subjectRefs: [ARC_TESTNET.chainRef, ARC_TESTNET.usdcAssetRef, walletAddress],
      fields: [
        "chainId",
        "contractCode",
        "decimals",
        "erc20Balance",
        "nativeBalance",
        "gasLimit",
        "gasPrice",
      ],
      limitations: ["GAS_PRICE_CAN_CHANGE", "EXECUTION_NOT_YET_CONFIRMED"],
    },
    availability: "AVAILABLE" as const,
    verificationStatus: "ONCHAIN_VERIFIED" as const,
    chainRef: ARC_TESTNET.chainRef,
    blockRef: state.blockNumber,
    transactionRef: null,
    status: "VALID" as const,
    requestHash: requestDigest,
    responseHash: responseDigest,
    responseDigest,
    reason: "PRIMARY_SWAP_NOT_CONFIRMED_E2E",
    transformationVersion: "arc-usdc-eoa-transfer-v1",
    fallbackUsed: true,
    facts: {
      quoteRef,
      providerRef: "arc-testnet-json-rpc",
      routeRef: "arc-usdc-erc20:eoa-transfer",
      sellAssetRef: ARC_TESTNET.usdcAssetRef,
      buyAssetRef: ARC_TESTNET.usdcAssetRef,
      amountIn: request.amount,
      expectedAmountOut: request.amount,
      minimumAmountOut: request.amount,
      feeAmount: nativeFeeAmount,
      feeAssetInterface: "NATIVE_USDC_18_DECIMALS",
      totalDebit,
      slippageBps: "0",
      recipientAddress,
      tokenAddress,
      calldataHash,
      tokenDecimals: "6",
      nativeDecimals: "18",
      chainId: String(state.chainId),
      blockNumber: state.blockNumber,
      contractCodeDigest: state.contractCodeDigest.toLowerCase(),
    },
  };

  return {
    request: { ...request, walletAddress, recipientAddress },
    transaction,
    evidence,
    expectedEffects: {
      amountIn: request.amount,
      amountOut: request.amount,
      minimumAmountOut: request.amount,
      feeAmount: nativeFeeAmount,
      totalDebit,
    },
    binding: {
      bindingKind: "EVM_TRANSACTION" as const,
      target: tokenAddress,
      calldataHash,
      nativeValue: "0",
      maxFee: nativeFeeAmount,
      productionCalldataBound: true,
      expiresAt: validUntil,
    },
  };
}

export function buildArcUsdcTransferIntent({
  tenantId,
  intentId,
  idempotencyKey,
  prepared,
  createdAt,
}: {
  tenantId: string;
  intentId: string;
  idempotencyKey: string;
  prepared: Awaited<ReturnType<typeof prepareArcUsdcTreasuryTransfer>>;
  createdAt: string;
}) {
  return ExecutionIntentSchema.parse({
    schemaVersion: "1.0.0",
    id: intentId,
    tenantId,
    applicationId: "partner-arc-demo",
    externalPartnerId: "hackathon-reference-client-transfer-fallback",
    subjectRef: `wallet:${prepared.request.walletAddress}`,
    walletAddress: prepared.request.walletAddress,
    walletType: "EOA",
    chainRef: ARC_TESTNET.chainRef,
    environment: "ARC_TESTNET",
    actionType: "SEND",
    instrumentRef: "instrument:arc-testnet:usdc-erc20-treasury-transfer",
    sellAssetRef: ARC_TESTNET.usdcAssetRef,
    buyAssetRef: ARC_TESTNET.usdcAssetRef,
    amount: prepared.request.amount,
    amountType: "EXACT_INPUT",
    recipient: prepared.request.recipientAddress,
    venueRef: "arc-testnet-eoa",
    routeRef: String(prepared.evidence.facts.routeRef),
    quoteRef: String(prepared.evidence.facts.quoteRef),
    executionBindingKind: "EVM_TRANSACTION",
    target: prepared.binding.target,
    calldataHash: prepared.binding.calldataHash,
    nativeValue: prepared.binding.nativeValue,
    adapterRequestHash: null,
    productionCalldataBound: true,
    portfolioSnapshotRef: null,
    policyRef: {
      id: ARC_USDC_TRANSFER_POLICY.id,
      version: ARC_USDC_TRANSFER_POLICY.version,
    },
    createdAt,
    expiresAt: prepared.binding.expiresAt,
    revision: 1,
    idempotencyKey,
  });
}

export type ArcUsdcTransactionState = {
  transactionFound: boolean;
  receiptFound: boolean;
  receiptStatus: "success" | "reverted" | null;
  from: string | null;
  to: string | null;
  input: string | null;
  valueBaseUnits: string | null;
  transferFrom: string | null;
  transferTo: string | null;
  transferAmountBaseUnits: string | null;
  gasUsed: string | null;
  effectiveGasPriceBaseUnits: string | null;
};

export type ArcUsdcTransactionCollector = (transactionHash: `0x${string}`) => Promise<ArcUsdcTransactionState>;

export async function collectArcUsdcTransactionState(
  transactionHash: `0x${string}`,
): Promise<ArcUsdcTransactionState> {
  const client = createPublicClient({
    transport: http(resolveArcTestnetRpcUrl(), { timeout: 12_000 }),
  });
  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: transactionHash }),
      client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    const transferLog = receipt.logs
      .filter((log) => log.address.toLowerCase() === ARC_USDC_INTERFACES.ERC20.address)
      .map((log) => {
        try {
          return decodeEventLog({ abi: ERC20_ABI, eventName: "Transfer", data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.eventName === "Transfer");
    const args = transferLog?.args as
      | { from?: `0x${string}`; to?: `0x${string}`; value?: bigint }
      | undefined;
    return {
      transactionFound: true,
      receiptFound: true,
      receiptStatus: receipt.status,
      from: transaction.from,
      to: transaction.to,
      input: transaction.input,
      valueBaseUnits: transaction.value.toString(),
      transferFrom: args?.from ?? null,
      transferTo: args?.to ?? null,
      transferAmountBaseUnits: args?.value?.toString() ?? null,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceBaseUnits: receipt.effectiveGasPrice.toString(),
    };
  } catch {
    return {
      transactionFound: false,
      receiptFound: false,
      receiptStatus: null,
      from: null,
      to: null,
      input: null,
      valueBaseUnits: null,
      transferFrom: null,
      transferTo: null,
      transferAmountBaseUnits: null,
      gasUsed: null,
      effectiveGasPriceBaseUnits: null,
    };
  }
}

export async function reconcileArcUsdcTreasuryTransfer({
  transactionHash,
  intent,
  collectTransactionState = collectArcUsdcTransactionState,
}: {
  transactionHash: string;
  intent: {
    walletAddress: string;
    recipient: string;
    amount: string;
    target: string | null;
    calldataHash: string | null;
  };
  collectTransactionState?: ArcUsdcTransactionCollector;
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw new GuardError("VALIDATION_ERROR", "Arc transaction hash is invalid.");
  }
  const state = await collectTransactionState(transactionHash.toLowerCase() as `0x${string}`);
  if (!state.transactionFound || !state.receiptFound) {
    return { observedState: "RPC_UNCERTAIN_AFTER_BROADCAST" as const };
  }
  if (state.receiptStatus !== "success") {
    throw new GuardError("RECONCILIATION_REQUIRED", "Arc transaction reverted or lacks success evidence.", {
      requiredAction: "REVIEW_ARC_TRANSACTION",
    });
  }
  if (
    !state.from ||
    !state.to ||
    !state.input ||
    state.valueBaseUnits === null ||
    !state.transferFrom ||
    !state.transferTo ||
    state.transferAmountBaseUnits === null ||
    state.gasUsed === null ||
    state.effectiveGasPriceBaseUnits === null ||
    !intent.target ||
    !intent.calldataHash
  ) {
    throw new GuardError("RECONCILIATION_REQUIRED", "Arc receipt evidence is incomplete.", {
      requiredAction: "RETRY_RECONCILIATION",
    });
  }
  const expectedAmount = arcUsdcAmountToBaseUnits(intent.amount, "ERC20");
  const exactMatch =
    state.from.toLowerCase() === intent.walletAddress.toLowerCase() &&
    state.to.toLowerCase() === intent.target.toLowerCase() &&
    keccak256(state.input as Hex).toLowerCase() === intent.calldataHash.toLowerCase() &&
    parseUnsignedInteger(state.valueBaseUnits, "Native value") === 0n &&
    state.transferFrom.toLowerCase() === intent.walletAddress.toLowerCase() &&
    state.transferTo.toLowerCase() === intent.recipient.toLowerCase() &&
    parseUnsignedInteger(state.transferAmountBaseUnits, "Transfer amount") === expectedAmount;
  if (!exactMatch) {
    throw new GuardError("FINGERPRINT_MISMATCH", "Confirmed Arc transaction differs from the authorized transfer.");
  }
  const actualFeeBaseUnits =
    parseUnsignedInteger(state.gasUsed, "Gas used") *
    parseUnsignedInteger(state.effectiveGasPriceBaseUnits, "Effective gas price");
  return {
    observedState: "CONFIRMED" as const,
    actualOutcome: {
      amountIn: intent.amount,
      amountOut: intent.amount,
      feeAmount: arcUsdcBaseUnitsToAmount(actualFeeBaseUnits, "NATIVE"),
      explorerUrl: `${ARC_TESTNET.explorerBaseUrl}/tx/${transactionHash.toLowerCase()}`,
    },
  };
}
