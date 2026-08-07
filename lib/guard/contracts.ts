import { z } from "zod";

import { hashCanonical } from "./service.ts";

const DECIMAL_STRING = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[a-z0-9-]+:[A-Za-z0-9-]+$/;
const ASSET_REF = /^[a-z0-9-]+:[A-Za-z0-9-]+\/[a-z0-9-]+:[A-Za-z0-9._%-]+$/;

const decimalString = z.string().min(1).max(128).regex(DECIMAL_STRING);
const timestamp = z.string().datetime({ offset: true });
const evidenceFactScalar = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const evidenceFactObject = z.record(z.string().min(1).max(128), evidenceFactScalar);
const evidenceFactValue = z.union([evidenceFactScalar, evidenceFactObject, z.array(z.union([evidenceFactScalar, evidenceFactObject])).max(128)]);

export const ExecutionIntentSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(3).max(128),
    tenantId: z.string().min(3).max(128),
    applicationId: z.string().min(3).max(128),
    externalPartnerId: z.string().min(1).max(256),
    subjectRef: z.string().min(1).max(256),
    walletAddress: z.string().regex(EVM_ADDRESS),
    walletType: z.enum(["EOA", "SMART_ACCOUNT", "SAFE", "ERC4337", "OTHER"]),
    chainRef: z.string().regex(CAIP2),
    environment: z.enum(["ARC_TESTNET", "TESTNET", "SANDBOX", "PRODUCTION"]),
    actionType: z.enum(["SWAP", "SEND", "SPEND", "BRIDGE"]),
    instrumentRef: z.string().min(3).max(256),
    sellAssetRef: z.string().regex(ASSET_REF),
    buyAssetRef: z.string().regex(ASSET_REF),
    amount: decimalString,
    amountType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
    recipient: z.string().regex(EVM_ADDRESS),
    venueRef: z.string().min(1).max(128),
    routeRef: z.string().min(1).max(256),
    quoteRef: z.string().min(1).max(256).nullable(),
    executionBindingKind: z.enum(["EVM_TRANSACTION", "APP_KIT_REQUEST"]).default("EVM_TRANSACTION"),
    target: z.string().regex(EVM_ADDRESS).nullable(),
    calldataHash: z.string().regex(HEX_HASH).nullable(),
    nativeValue: decimalString,
    adapterRequestHash: z.string().regex(HEX_HASH).nullable().default(null),
    productionCalldataBound: z.boolean().default(true),
    portfolioSnapshotRef: z.string().min(1).max(256).nullable(),
    policyRef: z
      .object({
        id: z.string().min(1).max(128),
        version: z.number().int().positive(),
      })
      .strict(),
    createdAt: timestamp,
    expiresAt: timestamp,
    revision: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Intent expiry must be after creation.",
      });
    }
    if (
      value.executionBindingKind === "EVM_TRANSACTION" &&
      (!value.target || !value.calldataHash || !value.productionCalldataBound)
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionBindingKind"],
        message: "EVM transaction binding requires target, calldata hash, and production binding.",
      });
    }
    if (
      value.executionBindingKind === "APP_KIT_REQUEST" &&
      (value.target !== null ||
        value.calldataHash !== null ||
        !value.adapterRequestHash ||
        value.productionCalldataBound)
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionBindingKind"],
        message: "App Kit request binding must expose that target and calldata are not prebound.",
      });
    }
  });

export const ArcMemoSchema = z
  .object({
    intentHash: z.string().regex(HEX_HASH),
    evidenceRoot: z.string().regex(HEX_HASH),
    policyHash: z.string().regex(HEX_HASH),
    receiptSchemaVersion: z.literal("1.0.0"),
  })
  .strict();

class ContractBoundaryError extends Error {
  readonly code: "CAPABILITY_UNAVAILABLE" | "VALIDATION_ERROR";

  constructor(code: "CAPABILITY_UNAVAILABLE" | "VALIDATION_ERROR", message: string) {
    super(message);
    this.name = "ContractBoundaryError";
    this.code = code;
  }
}

export function assertCapabilityEnvironment({
  state,
  runtimeEnvironment,
}: {
  state: "LIVE" | "LIMITED" | "TESTNET_ONLY" | "PLANNED" | "PAUSED" | "BLOCKED" | "UNVERIFIED" | "DEPRECATED";
  runtimeEnvironment: "SANDBOX" | "TESTNET" | "ARC_TESTNET" | "PRODUCTION";
}): void {
  if (
    runtimeEnvironment === "PRODUCTION" &&
    (state === "PLANNED" ||
      state === "TESTNET_ONLY" ||
      state === "PAUSED" ||
      state === "BLOCKED" ||
      state === "UNVERIFIED" ||
      state === "DEPRECATED")
  ) {
    throw new ContractBoundaryError(
      "CAPABILITY_UNAVAILABLE",
      "Capability state cannot be used in production.",
    );
  }
}

export function assertCredentialEnvironment({
  credentialEnvironment,
  runtimeEnvironment,
}: {
  credentialEnvironment: "SANDBOX" | "TESTNET" | "ARC_TESTNET" | "PRODUCTION";
  runtimeEnvironment: "SANDBOX" | "TESTNET" | "ARC_TESTNET" | "PRODUCTION";
}): void {
  if (credentialEnvironment !== runtimeEnvironment) {
    throw new ContractBoundaryError(
      "VALIDATION_ERROR",
      "Credential environment does not match runtime environment.",
    );
  }
}

type Integrity = {
  algorithm: "SHA-256";
  hash: string;
};

export function createIntegrityEnvelope<T extends Record<string, unknown>>(
  payload: T,
): T & { integrity: Integrity } {
  return {
    ...structuredClone(payload),
    integrity: {
      algorithm: "SHA-256",
      hash: hashCanonical(payload),
    },
  };
}

export function verifyIntegrityEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { integrity, ...payload } = value as Record<string, unknown>;
  if (
    !integrity ||
    typeof integrity !== "object" ||
    Array.isArray(integrity) ||
    (integrity as Record<string, unknown>).algorithm !== "SHA-256" ||
    typeof (integrity as Record<string, unknown>).hash !== "string"
  ) {
    return false;
  }
  return (integrity as Record<string, unknown>).hash === hashCanonical(payload);
}

const SENSITIVE_LOG_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "clientsecret",
  "client_secret",
  "entitysecret",
  "entity_secret",
  "privatekey",
  "private_key",
  "seedphrase",
  "seed_phrase",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
]);

export function redactGuardLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGuardLog);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_LOG_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactGuardLog(entry),
    ]),
  );
}

export const EvidenceItemSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(3).max(128),
    provider: z.string().min(1).max(128),
    sourceRef: z.string().min(1).max(512),
    adapter: z.string().min(1).max(128),
    adapterVersion: z.string().min(1).max(128),
    sourceType: z.string().min(1).max(128),
    observedAt: timestamp,
    receivedAt: timestamp,
    validUntil: timestamp,
    confidence: z.string().min(1).max(128),
    coverage: z
      .object({
        subjectRefs: z.array(z.string().min(1).max(256)).min(1).max(64),
        fields: z.array(z.string().min(1).max(128)).min(1).max(128),
        limitations: z.array(z.string().min(1).max(256)).max(64),
      })
      .strict(),
    availability: z.enum(["AVAILABLE", "PARTIAL", "UNAVAILABLE", "UNSUPPORTED"]),
    verificationStatus: z.enum([
      "PROVIDER_REPORTED",
      "DETERMINISTICALLY_DERIVED",
      "ONCHAIN_VERIFIED",
      "NOT_VERIFIED",
      "CONFLICTING",
    ]),
    chainRef: z.string().regex(CAIP2).nullable(),
    blockRef: z.string().min(1).max(256).nullable(),
    transactionRef: z.string().min(1).max(256).nullable(),
    status: z.enum(["VALID", "STALE", "MISSING", "CONFLICTING", "UNAVAILABLE", "UNSUPPORTED"]),
    requestHash: z.string().regex(HEX_HASH),
    responseHash: z.string().regex(HEX_HASH),
    responseDigest: z.string().regex(HEX_HASH),
    reason: z.string().min(1).max(512).nullable(),
    transformationVersion: z.string().min(1).max(128),
    fallbackUsed: z.boolean(),
    facts: z.record(z.string().min(1).max(128), evidenceFactValue),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.receivedAt) < Date.parse(value.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["receivedAt"],
        message: "Evidence cannot be received before it is observed.",
      });
    }
    if (Date.parse(value.validUntil) < Date.parse(value.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Evidence validity cannot precede observation.",
      });
    }
    if (value.responseDigest !== value.responseHash) {
      context.addIssue({
        code: "custom",
        path: ["responseDigest"],
        message: "Evidence response digest must match the compatibility response hash.",
      });
    }
    if (value.availability !== "AVAILABLE" && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Non-available evidence requires an explicit reason.",
      });
    }
    const expectedAvailability = {
      VALID: "AVAILABLE",
      STALE: "PARTIAL",
      MISSING: "PARTIAL",
      CONFLICTING: "PARTIAL",
      UNAVAILABLE: "UNAVAILABLE",
      UNSUPPORTED: "UNSUPPORTED",
    }[value.status];
    if (value.availability !== expectedAvailability) {
      context.addIssue({
        code: "custom",
        path: ["availability"],
        message: "Evidence availability must agree with its status.",
      });
    }
    if (value.fallbackUsed && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Fallback evidence must disclose why the fallback was used.",
      });
    }
  });

export const RiskSignalSchema = z
  .object({
    id: z.string().min(3).max(128),
    schemaVersion: z.literal("1.0.0"),
    category: z.enum([
      "MARKET_SESSION",
      "PRICE_FRESHNESS",
      "ORACLE_CONFIDENCE",
      "PRICE_DEVIATION",
      "SPREAD",
      "DEPTH",
      "SLIPPAGE",
      "FEES",
      "ROUTE",
      "ISSUER",
      "TOKEN_CONTRACT",
      "TRANSFER_RESTRICTION",
      "CORPORATE_ACTION",
      "REDEMPTION",
      "LIQUIDITY",
      "VENUE",
      "PORTFOLIO_EXPOSURE",
      "CONCENTRATION",
      "LEVERAGE",
      "LIQUIDATION",
      "SETTLEMENT",
      "RECOVERY",
      "COMPLIANCE",
      "CONTRACT_SIMULATION",
      "CAPABILITY",
      "AGENT_MANDATE",
    ]),
    subjectRef: z.string().min(1).max(256),
    status: z.enum(["VALID", "STALE", "MISSING", "CONFLICTING", "UNSUPPORTED"]),
    severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
    observedValue: z.string().max(256).optional(),
    unit: z.string().max(64).optional(),
    threshold: z.string().max(256).optional(),
    evidenceRefs: z.array(z.string().min(3).max(128)).max(64),
    sourceTimestamp: timestamp.optional(),
    validUntil: timestamp.optional(),
    confidence: z.string().max(128).optional(),
    explanationCode: z.string().min(1).max(128),
    remediation: z.string().max(512).optional(),
  })
  .strict();

const PolicyRuleSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("ALLOWED_CHAIN"),
      value: z.string().regex(CAIP2),
      onViolation: z.literal("BLOCK"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("ALLOWED_PAIR"),
      value: z.tuple([z.string().regex(ASSET_REF), z.string().regex(ASSET_REF)]),
      onViolation: z.literal("BLOCK"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("MAX_TOTAL_DEBIT"),
      value: decimalString,
      currencyAssetRef: z.string().regex(ASSET_REF),
      onViolation: z.literal("BLOCK"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("MAX_QUOTE_AGE_SECONDS"),
      value: z.number().int().positive().max(3_600),
      onViolation: z.literal("INSUFFICIENT_EVIDENCE"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("MAX_SLIPPAGE_BPS"),
      value: decimalString,
      onViolation: z.literal("REVIEW"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal("HUMAN_AUTHORIZATION_REQUIRED"),
      value: z.boolean(),
      onViolation: z.literal("REQUIRE_AUTHORIZATION"),
    })
    .strict(),
]);

export const GuardPolicySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    publishedAt: timestamp,
    immutable: z.literal(true),
    rules: z.array(PolicyRuleSchema).min(1).max(128),
  })
  .strict();

export const ExecutionFingerprintSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    intentId: z.string().min(3).max(128),
    intentRevision: z.number().int().positive(),
    chainRef: z.string().regex(CAIP2),
    walletAddress: z.string().regex(EVM_ADDRESS),
    bindingKind: z.enum(["EVM_TRANSACTION", "APP_KIT_REQUEST"]).default("EVM_TRANSACTION"),
    target: z.string().regex(EVM_ADDRESS).nullable(),
    calldataHash: z.string().regex(HEX_HASH).nullable(),
    nativeValue: decimalString,
    adapterRequestHash: z.string().regex(HEX_HASH).nullable().default(null),
    productionCalldataBound: z.boolean().default(true),
    sellAssetRef: z.string().regex(ASSET_REF),
    buyAssetRef: z.string().regex(ASSET_REF),
    amount: decimalString,
    recipient: z.string().regex(EVM_ADDRESS),
    venueRef: z.string().min(1).max(128),
    routeRef: z.string().min(1).max(256),
    quoteHash: z.string().regex(HEX_HASH),
    maxFee: decimalString,
    minimumOutput: decimalString,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.bindingKind === "EVM_TRANSACTION" &&
      (!value.target || !value.calldataHash || !value.productionCalldataBound)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bindingKind"],
        message: "EVM fingerprint requires target, calldata hash, and production binding.",
      });
    }
    if (
      value.bindingKind === "APP_KIT_REQUEST" &&
      (value.target !== null || value.calldataHash !== null || !value.adapterRequestHash || value.productionCalldataBound)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bindingKind"],
        message: "App Kit request fingerprint must disclose that target and calldata are not prebound.",
      });
    }
  });

export const HumanAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(3).max(128),
    tenantId: z.string().min(3).max(128),
    intentId: z.string().min(3).max(128),
    intentRevision: z.number().int().positive(),
    evaluationId: z.string().min(3).max(128),
    intentHash: z.string().regex(HEX_HASH),
    evidenceRoot: z.string().regex(HEX_HASH),
    policyHash: z.string().regex(HEX_HASH),
    preflightHash: z.string().regex(HEX_HASH),
    executionFingerprintHash: z.string().regex(HEX_HASH),
    materialWarningsShown: z.array(z.string().min(1).max(128)).max(64),
    subjectRef: z.string().min(1).max(256),
    method: z.enum(["PARTNER_AUTHENTICATED", "EIP712"]),
    decision: z.enum(["APPROVED", "REJECTED"]),
    createdAt: timestamp,
    expiresAt: timestamp,
    signatureRef: z.string().min(1).max(512).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Authorization expiry must follow creation.",
      });
    }
  });

const FinancialOutcomeSchema = z
  .object({
    amountIn: decimalString,
    amountOut: decimalString,
    feeAmount: decimalString,
  })
  .strict();

const ExpectedEffectsSchema = z
  .object({
    amountIn: decimalString,
    amountOut: decimalString,
    minimumAmountOut: decimalString,
    feeAmount: decimalString,
    totalDebit: decimalString,
  })
  .strict();

const ReconciliationStatusSchema = z.enum([
  "NOT_RECONCILED",
  "RECONCILIATION_REQUIRED",
  "MATCHED",
  "DEVIATION_RECORDED",
]);

const ExecutionReferenceSchema = z
  .object({
    transactionHash: z.string().regex(HEX_HASH),
    explorerUrl: z.string().url(),
  })
  .strict();

export const ReadinessEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(3).max(128),
    tenantId: z.string().min(3).max(128),
    intentId: z.string().min(3).max(128),
    intentRevision: z.number().int().positive(),
    version: z.number().int().positive(),
    amends: z.string().min(3).max(128).nullable(),
    intentHash: z.string().regex(HEX_HASH),
    instrumentRef: z.string().min(3).max(256),
    evidenceRoot: z.string().regex(HEX_HASH),
    evidenceRefs: z.array(z.string().min(3).max(128)).max(256),
    policyRef: z
      .object({
        id: z.string().min(1).max(128),
        version: z.number().int().positive(),
      })
      .strict(),
    policyHash: z.string().regex(HEX_HASH),
    policyVersion: z.number().int().positive(),
    policyDigest: z.string().regex(HEX_HASH),
    preflightHash: z.string().regex(HEX_HASH),
    dataStatus: z.enum(["COMPLETE", "PARTIAL", "INSUFFICIENT", "CONFLICTING", "UNAVAILABLE"]),
    evidenceStatus: z.enum(["COMPLETE", "PARTIAL", "INSUFFICIENT", "CONFLICTING", "UNAVAILABLE"]),
    outcome: z.enum([
      "ALLOWED_BY_POLICY",
      "REVIEW_REQUIRED",
      "BLOCKED_BY_RULE",
      "INSUFFICIENT_EVIDENCE",
      "UNSUPPORTED",
      "EXPIRED",
    ]),
    policyDecision: z.enum([
      "ALLOWED_BY_POLICY",
      "REVIEW_REQUIRED",
      "BLOCKED_BY_RULE",
      "INSUFFICIENT_EVIDENCE",
      "UNSUPPORTED",
      "EXPIRED",
    ]),
    policyStatus: z.enum(["PASS", "WARN", "BLOCK", "NOT_EVALUATED"]),
    authorizationStatus: z.enum([
      "NOT_REQUIRED",
      "PENDING",
      "APPROVED",
      "REJECTED",
      "EXPIRED",
      "REVOKED",
    ]),
    executionStatus: z.enum([
      "NOT_STARTED",
      "SUBMITTED",
      "SOURCE_CONFIRMED",
      "IN_TRANSIT",
      "DESTINATION_PENDING",
      "CONFIRMED",
      "FAILED",
      "RECOVERY_REQUIRED",
      "RECONCILIATION_REQUIRED",
      "CANCELLED",
    ]),
    riskSignals: z.array(RiskSignalSchema).max(512),
    warnings: z.array(z.string().min(1).max(256)).max(128),
    blockers: z.array(z.string().min(1).max(256)).max(128),
    missingEvidence: z.array(z.string().min(1).max(256)).max(128),
    humanAuthorizationId: z.string().min(3).max(128).nullable(),
    expectedOutcome: FinancialOutcomeSchema.nullable(),
    expectedEffects: ExpectedEffectsSchema.nullable(),
    executionReference: ExecutionReferenceSchema.nullable(),
    actualOutcome: FinancialOutcomeSchema.nullable(),
    actualEffects: FinancialOutcomeSchema.nullable(),
    reconciliationStatus: ReconciliationStatusSchema,
    settlementState: z.enum([
      "NOT_STARTED",
      "PENDING",
      "FUNDS_IN_MOTION",
      "DESTINATION_PENDING",
      "CONFIRMED",
      "FAILED",
    ]),
    recoveryState: z.enum(["NOT_REQUIRED", "AVAILABLE", "REQUIRED", "IN_PROGRESS", "RECOVERED", "FAILED"]),
    receiptHash: z.string().regex(HEX_HASH).nullable(),
    createdAt: timestamp,
    finalizedAt: timestamp.nullable(),
    limitations: z.array(z.string().min(1).max(128)).min(1).max(64),
  })
  .strict();

export const EvidenceReceiptSchema = ReadinessEnvelopeSchema.superRefine((value, context) => {
  if (
    value.executionStatus !== "CONFIRMED" ||
    value.settlementState !== "CONFIRMED" ||
    !value.executionReference ||
    !value.actualOutcome ||
    !value.actualEffects ||
    !value.receiptHash ||
    !["MATCHED", "DEVIATION_RECORDED"].includes(value.reconciliationStatus) ||
    !value.finalizedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "A finalized evidence receipt requires confirmed execution and settlement.",
    });
  }
});

const DecisionSettlementReconciliationEvidenceSchema = z
  .object({
    provider: z.string().min(1).max(128),
    sourceRef: z.string().min(1).max(512),
    verificationStatus: z.enum(["PROVIDER_REPORTED", "ONCHAIN_VERIFIED"]),
    responseDigest: z.string().regex(HEX_HASH),
  })
  .strict();

export const DecisionSettlementReceiptSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: z.string().min(3).max(128),
    tenantId: z.string().min(3).max(128),
    evidenceStatus: z.enum(["COMPLETE", "PARTIAL", "INSUFFICIENT", "CONFLICTING", "UNAVAILABLE"]),
    policyDecision: z.enum([
      "ALLOWED_BY_POLICY",
      "REVIEW_REQUIRED",
      "BLOCKED_BY_RULE",
      "INSUFFICIENT_EVIDENCE",
      "UNSUPPORTED",
      "EXPIRED",
    ]),
    executionStatus: z.literal("CONFIRMED"),
    policyVersion: z.number().int().positive(),
    policyDigest: z.string().regex(HEX_HASH),
    preflightHash: z.string().regex(HEX_HASH),
    expectedEffects: ExpectedEffectsSchema,
    actualEffects: FinancialOutcomeSchema,
    reconciliationStatus: z.enum(["MATCHED", "DEVIATION_RECORDED"]),
    intent: z
      .object({
        id: z.string().min(3).max(128),
        revision: z.number().int().positive(),
        hash: z.string().regex(HEX_HASH),
      })
      .strict(),
    evidence: z
      .object({
        root: z.string().regex(HEX_HASH),
        refs: z.array(z.string().min(3).max(128)).max(256),
      })
      .strict(),
    policy: z
      .object({
        id: z.string().min(1).max(128),
        version: z.number().int().positive(),
        hash: z.string().regex(HEX_HASH),
        outcome: z.enum([
          "ALLOWED_BY_POLICY",
          "REVIEW_REQUIRED",
          "BLOCKED_BY_RULE",
          "INSUFFICIENT_EVIDENCE",
          "UNSUPPORTED",
          "EXPIRED",
        ]),
      })
      .strict(),
    authorization: z
      .object({
        id: z.string().min(3).max(128),
        method: z.enum(["PARTNER_AUTHENTICATED", "EIP712"]),
        subjectRef: z.string().min(1).max(256),
        createdAt: timestamp,
      })
      .strict(),
    execution: z
      .object({
        id: z.string().min(3).max(128),
        fingerprintHash: z.string().regex(HEX_HASH),
        bindingKind: z.enum(["EVM_TRANSACTION", "APP_KIT_REQUEST"]),
        productionCalldataBound: z.boolean(),
        transactionHash: z.string().regex(HEX_HASH),
        status: z.literal("CONFIRMED"),
        explorerUrl: z.string().url(),
      })
      .strict(),
    reconciliation: z
      .object({
        status: z.enum(["MATCHED", "DEVIATION_RECORDED"]),
        expected: ExpectedEffectsSchema,
        actual: FinancialOutcomeSchema,
        evidence: DecisionSettlementReconciliationEvidenceSchema,
      })
      .strict(),
    settlement: z
      .object({
        status: z.literal("CONFIRMED"),
        recoveryState: z.literal("NOT_REQUIRED"),
      })
      .strict(),
    createdAt: timestamp,
    finalizedAt: timestamp,
    limitations: z.array(z.string().min(1).max(128)).min(1).max(64),
    receiptHash: z.string().regex(HEX_HASH),
    integrity: z
      .object({
        algorithm: z.literal("SHA-256"),
        hash: z.string().regex(HEX_HASH),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const relationshipsMatch =
      value.policyVersion === value.policy.version &&
      value.policyDigest === value.policy.hash &&
      value.policyDecision === value.policy.outcome &&
      value.executionStatus === value.execution.status &&
      value.reconciliationStatus === value.reconciliation.status &&
      hashCanonical(value.expectedEffects) === hashCanonical(value.reconciliation.expected) &&
      hashCanonical(value.actualEffects) === hashCanonical(value.reconciliation.actual);
    if (!relationshipsMatch) {
      context.addIssue({
        code: "custom",
        message: "Receipt summary fields must match their attributed lifecycle records.",
      });
    }
    const { receiptHash, integrity, ...receiptCore } = value;
    if (receiptHash !== hashCanonical(receiptCore)) {
      context.addIssue({
        code: "custom",
        path: ["receiptHash"],
        message: "Receipt hash does not match its canonical core.",
      });
    }
    if (integrity.hash !== hashCanonical({ ...receiptCore, receiptHash })) {
      context.addIssue({
        code: "custom",
        path: ["integrity", "hash"],
        message: "Receipt integrity hash does not match the finalized receipt.",
      });
    }
  });

const EnvelopeAmendmentSchema = z
  .object({
    id: z.string().min(3).max(128),
    executionStatus: ReadinessEnvelopeSchema.shape.executionStatus,
    executionReference: ExecutionReferenceSchema.nullable(),
    actualOutcome: FinancialOutcomeSchema.nullable(),
    actualEffects: FinancialOutcomeSchema.nullable(),
    reconciliationStatus: ReconciliationStatusSchema,
    settlementState: ReadinessEnvelopeSchema.shape.settlementState,
    recoveryState: ReadinessEnvelopeSchema.shape.recoveryState.optional(),
    receiptHash: z.string().regex(HEX_HASH).nullable(),
    finalizedAt: timestamp.nullable(),
  })
  .strict();

export function amendReadinessEnvelope(
  previousInput: z.input<typeof ReadinessEnvelopeSchema>,
  amendmentInput: z.input<typeof EnvelopeAmendmentSchema>,
): z.output<typeof ReadinessEnvelopeSchema> {
  const previous = ReadinessEnvelopeSchema.parse(previousInput);
  const amendment = EnvelopeAmendmentSchema.parse(amendmentInput);
  return ReadinessEnvelopeSchema.parse({
    ...structuredClone(previous),
    ...amendment,
    version: previous.version + 1,
    amends: previous.id,
  });
}
