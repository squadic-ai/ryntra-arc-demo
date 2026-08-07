import { z, ZodError } from "zod";

import { authorizedBearer } from "../security.ts";
import {
  EvidenceItemSchema,
  ExecutionFingerprintSchema,
  ExecutionIntentSchema,
  GuardPolicySchema,
} from "./contracts.ts";
import { GuardError } from "./service.ts";

export const GUARD_MAX_BODY_BYTES = 64 * 1024;

export type GuardApiErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_REQUIRED"
  | "TENANT_FORBIDDEN"
  | "CAPABILITY_UNAVAILABLE"
  | "EVIDENCE_INSUFFICIENT"
  | "POLICY_BLOCKED"
  | "HUMAN_AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_EXPIRED"
  | "EVALUATION_EXPIRED"
  | "FINGERPRINT_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "EXECUTION_NOT_CONFIRMED"
  | "RECOVERY_REQUIRED"
  | "RECONCILIATION_REQUIRED"
  | "RATE_LIMITED";

export class GuardApiError extends Error {
  readonly code: GuardApiErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: string | null;

  constructor(
    code: GuardApiErrorCode,
    message: string,
    options: { retryable?: boolean; requiredAction?: string | null } = {},
  ) {
    super(message);
    this.name = "GuardApiError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requiredAction = options.requiredAction ?? null;
  }
}

export function isGuardApiError(
  error: unknown,
  code?: GuardApiErrorCode,
): error is GuardApiError {
  return error instanceof GuardApiError && (!code || error.code === code);
}

export function authenticateGuardApi({
  authorization,
  configuredApiKey,
  configuredTenantId,
}: {
  authorization: string | null;
  configuredApiKey: string | undefined;
  configuredTenantId: string | undefined;
}): { tenantId: string } {
  if (!configuredApiKey || !configuredTenantId) {
    throw new GuardApiError(
      "CAPABILITY_UNAVAILABLE",
      "Ryntra Guard API is not configured for this environment.",
      { requiredAction: "CONFIGURE_SERVER_SIDE_GUARD_CREDENTIAL" },
    );
  }
  if (!authorizedBearer(authorization, configuredApiKey)) {
    throw new GuardApiError(
      "AUTHENTICATION_REQUIRED",
      "A valid tenant-scoped Bearer credential is required.",
      { requiredAction: "PROVIDE_BEARER_CREDENTIAL" },
    );
  }
  return { tenantId: configuredTenantId };
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,256}$/;

export function correlationIdFromHeader(
  value: string | null,
  create: () => string,
): string {
  return value && CORRELATION_ID.test(value) ? value : create();
}

export function requireIdempotencyKey(value: string | null): string {
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new GuardApiError(
      "VALIDATION_ERROR",
      "A bounded Idempotency-Key header is required for this operation.",
      { requiredAction: "PROVIDE_IDEMPOTENCY_KEY" },
    );
  }
  return value;
}

function validationError(message = "Request validation failed."): GuardApiError {
  return new GuardApiError("VALIDATION_ERROR", message, { requiredAction: "CORRECT_REQUEST" });
}

export async function readBoundedGuardJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw validationError("Content-Type must be application/json.");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > GUARD_MAX_BODY_BYTES) {
    throw validationError("Request body exceeds the Guard prototype limit.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > GUARD_MAX_BODY_BYTES) {
    throw validationError("Request body exceeds the Guard prototype limit.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw validationError("Request body must be valid JSON.");
  }
}

function parseOrApiError<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

export function createIntentFromApiInput({
  body,
  tenantId,
  idempotencyKey,
  now,
  intentId,
}: {
  body: unknown;
  tenantId: string;
  idempotencyKey: string;
  now: string;
  intentId: string;
}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw validationError();
  const client = { ...(body as Record<string, unknown>) };
  for (const serverOwned of [
    "schemaVersion",
    "id",
    "tenantId",
    "createdAt",
    "revision",
    "idempotencyKey",
  ]) {
    delete client[serverOwned];
  }
  try {
    return ExecutionIntentSchema.parse({
      ...client,
      schemaVersion: "1.0.0",
      id: intentId,
      tenantId,
      createdAt: now,
      revision: 1,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

export const PreflightRequestSchema = z
  .object({ evidence: z.array(EvidenceItemSchema).min(1).max(64) })
  .strict();

export const AuthorizeRequestSchema = z
  .object({
    evaluationId: z.string().min(3).max(128),
    fingerprint: ExecutionFingerprintSchema,
    subjectRef: z.string().min(1).max(256),
    method: z.enum(["PARTNER_AUTHENTICATED", "EIP712"]),
  })
  .strict();

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const FINANCIAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const RecordExecutionRequestSchema = z
  .object({
    operation: z.literal("RECORD").default("RECORD"),
    authorizationId: z.string().min(3).max(128),
    fingerprint: ExecutionFingerprintSchema,
    transactionHash: z.string().regex(TRANSACTION_HASH),
  })
  .strict();

export const ReconcileExecutionRequestSchema = z
  .object({
    operation: z.literal("RECONCILE"),
    transactionHash: z.string().regex(TRANSACTION_HASH),
    observedState: z.enum(["RPC_UNCERTAIN_AFTER_BROADCAST", "CONFIRMED"]),
    actualOutcome: z
      .object({
        amountIn: z.string().regex(FINANCIAL_DECIMAL),
        amountOut: z.string().regex(FINANCIAL_DECIMAL),
        feeAmount: z.string().regex(FINANCIAL_DECIMAL),
        explorerUrl: z.string().url().startsWith("https://testnet.arcscan.app/tx/"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.observedState === "CONFIRMED" && !value.actualOutcome) {
      context.addIssue({ code: "custom", path: ["actualOutcome"], message: "Required for confirmation." });
    }
  });

export const ARC_DEMO_POLICY = GuardPolicySchema.parse({
  schemaVersion: "1.0.0",
  id: "demo-stablecoin-policy",
  version: 1,
  publishedAt: "2026-08-06T00:00:00.000Z",
  immutable: true,
  rules: [
    { id: "allowed-chain", type: "ALLOWED_CHAIN", value: "eip155:5042002", onViolation: "BLOCK" },
    {
      id: "allowed-pair",
      type: "ALLOWED_PAIR",
      value: [
        "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
        "eip155:5042002/erc20:0x89b50855aa3be2f677cd6303cec089b5f319d72a",
      ],
      onViolation: "BLOCK",
    },
    {
      id: "max-total-debit",
      type: "MAX_TOTAL_DEBIT",
      value: "100.00",
      currencyAssetRef: "eip155:5042002/erc20:0x3600000000000000000000000000000000000000",
      onViolation: "BLOCK",
    },
    { id: "max-quote-age", type: "MAX_QUOTE_AGE_SECONDS", value: 120, onViolation: "INSUFFICIENT_EVIDENCE" },
    { id: "max-slippage", type: "MAX_SLIPPAGE_BPS", value: "25", onViolation: "REVIEW" },
    { id: "human-auth", type: "HUMAN_AUTHORIZATION_REQUIRED", value: true, onViolation: "REQUIRE_AUTHORIZATION" },
  ],
});

export const guardCapabilities = Object.freeze([
  {
    id: "guard-kernel-v1",
    state: "TESTNET_ONLY",
    environment: "ARC_TESTNET",
    protocolCapability: "NOT_APPLICABLE",
    ryntraImplementationCapability: "VERIFIED_BY_DETERMINISTIC_TESTS",
    currentWalletCapability: "NOT_APPLICABLE",
    verifiedAt: "2026-08-06T00:00:00.000Z",
    evidenceSource: "source-tests",
  },
  {
    id: "guard-api-sdk-v1",
    state: "TESTNET_ONLY",
    environment: "ARC_TESTNET",
    protocolCapability: "NOT_APPLICABLE",
    ryntraImplementationCapability: "IMPLEMENTED_NOT_DEPLOYED",
    currentWalletCapability: "NOT_APPLICABLE",
    verifiedAt: null,
    evidenceSource: "source-only",
  },
  {
    id: "arc-app-kit-usdc-eurc-swap",
    state: "UNVERIFIED",
    environment: "ARC_TESTNET",
    protocolCapability: "DOCUMENTED_BY_PROVIDER",
    ryntraImplementationCapability: "IMPLEMENTED_NOT_LIVE_VERIFIED",
    currentWalletCapability: "UNVERIFIED",
    verifiedAt: null,
    evidenceSource: "official-docs-and-installed-types; live transaction absent",
  },
  {
    id: "arc-eoa-usdc-transfer",
    state: "TESTNET_ONLY",
    environment: "ARC_TESTNET",
    protocolCapability: "DOCUMENTED_BY_PROVIDER",
    ryntraImplementationCapability: "VERIFIED_BY_DETERMINISTIC_TESTS_NOT_LIVE",
    currentWalletCapability: "UNVERIFIED",
    verifiedAt: null,
    evidenceSource:
      "official Arc chain/token configuration and source tests; live transaction absent",
  },
] as const);

const STATUS_BY_CODE: Record<GuardApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTHENTICATION_REQUIRED: 401,
  TENANT_FORBIDDEN: 403,
  CAPABILITY_UNAVAILABLE: 503,
  EVIDENCE_INSUFFICIENT: 422,
  POLICY_BLOCKED: 422,
  HUMAN_AUTHORIZATION_REQUIRED: 409,
  AUTHORIZATION_EXPIRED: 409,
  EVALUATION_EXPIRED: 409,
  FINGERPRINT_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  EXECUTION_NOT_CONFIRMED: 409,
  RECOVERY_REQUIRED: 409,
  RECONCILIATION_REQUIRED: 409,
  RATE_LIMITED: 429,
};

function normalizedApiError(error: unknown): GuardApiError {
  if (error instanceof GuardApiError) return error;
  if (error instanceof GuardError) {
    return new GuardApiError(error.code, error.message, {
      retryable: error.retryable,
      requiredAction: error.requiredAction,
    });
  }
  if (error instanceof ZodError) return validationError();
  return new GuardApiError(
    "CAPABILITY_UNAVAILABLE",
    "Ryntra Guard could not complete this request.",
    { retryable: true, requiredAction: "RETRY_OR_CONTACT_OPERATOR" },
  );
}

export function structuredGuardError(error: unknown, correlationId: string) {
  const normalized = normalizedApiError(error);
  /* A modelled error is already fully described by the structured response. An
     unmodelled one is a defect, and returning only RETRY_OR_CONTACT_OPERATOR
     leaves the operator with nothing to act on — exactly the situation this
     product exists to avoid. The cause is logged server-side, keyed by the same
     correlation id the caller sees; the response body is unchanged, so nothing
     internal reaches the client. */
  const modelled =
    error instanceof GuardApiError || error instanceof GuardError || error instanceof ZodError;
  if (!modelled) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[guard] unhandled error correlationId=${correlationId} ${cause}`);
  }
  return {
    status: STATUS_BY_CODE[normalized.code],
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        requiredAction: normalized.requiredAction,
        correlationId,
      },
    },
  };
}

export function parsePreflightRequest(value: unknown) {
  return parseOrApiError(PreflightRequestSchema, value);
}

export function parseAuthorizeRequest(value: unknown) {
  return parseOrApiError(AuthorizeRequestSchema, value);
}

export function parseExecutionRequest(value: unknown) {
  const operation =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).operation
      : undefined;
  return operation === "RECONCILE"
    ? parseOrApiError(ReconcileExecutionRequestSchema, value)
    : parseOrApiError(RecordExecutionRequestSchema, value);
}
