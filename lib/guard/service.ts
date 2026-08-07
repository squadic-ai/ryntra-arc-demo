import { createHash } from "node:crypto";

import { compareDecimalStrings, evaluateGuardReadiness } from "./kernel.ts";
import {
  createMemoryGuardStore,
  guardStoreLimitations,
  type GuardCollection,
  type GuardStore,
} from "./store.ts";

export type GuardErrorCode =
  | "VALIDATION_ERROR"
  | "TENANT_FORBIDDEN"
  | "EVIDENCE_INSUFFICIENT"
  | "POLICY_BLOCKED"
  | "HUMAN_AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_EXPIRED"
  | "EVALUATION_EXPIRED"
  | "FINGERPRINT_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "EXECUTION_NOT_CONFIRMED"
  | "RECOVERY_REQUIRED"
  | "RECONCILIATION_REQUIRED";

export class GuardError extends Error {
  readonly code: GuardErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: string | null;

  constructor(
    code: GuardErrorCode,
    message: string,
    options: { retryable?: boolean; requiredAction?: string | null } = {},
  ) {
    super(message);
    this.name = "GuardError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requiredAction = options.requiredAction ?? null;
  }
}

export function isGuardError(error: unknown, code?: GuardErrorCode): error is GuardError {
  return error instanceof GuardError && (!code || error.code === code);
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GuardError("VALIDATION_ERROR", "Non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new GuardError("VALIDATION_ERROR", "Value is not canonical JSON.");
}

export function hashCanonical(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

type Intent = {
  id: string;
  tenantId: string;
  schemaVersion: string;
  revision: number;
  subjectRef: string;
  walletAddress: string;
  chainRef: string;
  sellAssetRef: string;
  buyAssetRef: string;
  amount: string;
  recipient: string;
  venueRef: string;
  routeRef: string;
  quoteRef: string | null;
  executionBindingKind?: "EVM_TRANSACTION" | "APP_KIT_REQUEST";
  target: string | null;
  calldataHash: string | null;
  nativeValue: string;
  adapterRequestHash?: string | null;
  productionCalldataBound?: boolean;
  expiresAt: string;
  policyRef: { id: string; version: number };
  [key: string]: unknown;
};

type QuoteEvidence = {
  id: string;
  sourceType: string;
  responseHash: string;
  responseDigest?: string;
  validUntil: string;
  facts: {
    quoteRef: string;
    routeRef: string;
    amountIn: string;
    expectedAmountOut: string;
    minimumAmountOut: string;
    feeAmount: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function financialPlanEvidence(evidence: QuoteEvidence[]): QuoteEvidence | undefined {
  return evidence.find(
    (entry) => entry.sourceType === "SWAP_QUOTE" || entry.sourceType === "TRANSFER_PLAN",
  );
}

function expectedEffectsFromEvidence(evidence: QuoteEvidence | undefined) {
  if (!evidence) return null;
  const { amountIn, expectedAmountOut, minimumAmountOut, feeAmount, totalDebit } = evidence.facts;
  if (
    typeof amountIn !== "string" ||
    typeof expectedAmountOut !== "string" ||
    typeof minimumAmountOut !== "string" ||
    typeof feeAmount !== "string" ||
    typeof totalDebit !== "string"
  ) {
    return null;
  }
  return { amountIn, amountOut: expectedAmountOut, minimumAmountOut, feeAmount, totalDebit };
}

export type ExecutionFingerprint = {
  schemaVersion: "1.0.0";
  intentId: string;
  intentRevision: number;
  chainRef: string;
  walletAddress: string;
  bindingKind: "EVM_TRANSACTION" | "APP_KIT_REQUEST";
  target: string | null;
  calldataHash: string | null;
  nativeValue: string;
  adapterRequestHash: string | null;
  productionCalldataBound: boolean;
  sellAssetRef: string;
  buyAssetRef: string;
  amount: string;
  recipient: string;
  venueRef: string;
  routeRef: string;
  quoteHash: string;
  maxFee: string;
  minimumOutput: string;
  expiresAt: string;
};

export function buildExecutionFingerprint({
  intent,
  quote,
}: {
  intent: Intent;
  quote: QuoteEvidence;
}): ExecutionFingerprint {
  const bindingKind = intent.executionBindingKind ?? "EVM_TRANSACTION";
  if (bindingKind === "EVM_TRANSACTION" && (!intent.target || !intent.calldataHash)) {
    throw new GuardError(
      "VALIDATION_ERROR",
      "EVM transaction binding requires target and calldata hash.",
    );
  }
  if (
    bindingKind === "APP_KIT_REQUEST" &&
    (!intent.adapterRequestHash || intent.productionCalldataBound !== false)
  ) {
    throw new GuardError(
      "VALIDATION_ERROR",
      "App Kit request binding requires an explicit request hash and non-production limitation.",
    );
  }
  return {
    schemaVersion: "1.0.0",
    intentId: intent.id,
    intentRevision: intent.revision,
    chainRef: intent.chainRef,
    walletAddress: intent.walletAddress.toLowerCase(),
    bindingKind,
    target: bindingKind === "EVM_TRANSACTION" ? intent.target!.toLowerCase() : null,
    calldataHash: bindingKind === "EVM_TRANSACTION" ? intent.calldataHash!.toLowerCase() : null,
    nativeValue: intent.nativeValue,
    adapterRequestHash:
      bindingKind === "APP_KIT_REQUEST" ? intent.adapterRequestHash!.toLowerCase() : null,
    productionCalldataBound: bindingKind === "EVM_TRANSACTION",
    sellAssetRef: intent.sellAssetRef.toLowerCase(),
    buyAssetRef: intent.buyAssetRef.toLowerCase(),
    amount: intent.amount,
    recipient: intent.recipient.toLowerCase(),
    venueRef: intent.venueRef,
    routeRef: intent.routeRef,
    quoteHash: (quote.responseDigest ?? quote.responseHash).toLowerCase(),
    maxFee: quote.facts.feeAmount,
    minimumOutput: quote.facts.minimumAmountOut,
    expiresAt:
      Date.parse(intent.expiresAt) < Date.parse(quote.validUntil)
        ? intent.expiresAt
        : quote.validUntil,
  };
}

type ServiceOptions = {
  now: () => string;
  createId: (prefix: string) => string;
  /**
   * Persistence adapter. Defaults to per-process memory so unit tests stay
   * isolated; the runtime supplies the configured adapter and refuses writes
   * when its durability is weaker than the deployment requires.
   */
  store?: GuardStore;
};

type IdempotencyRecord = {
  requestHash: string;
  /** Absent while `inFlight` — the response does not exist yet. */
  response?: unknown;
  /** True between claiming the key and storing the result. */
  inFlight?: boolean;
};

export function createGuardService(options: ServiceOptions) {
  const store = options.store ?? createMemoryGuardStore();
  const intents = store.collection<Intent>("intents");
  const evaluations = store.collection<Record<string, unknown>>("evaluations");
  const authorizations = store.collection<Record<string, unknown>>("authorizations");
  const executions = store.collection<Record<string, unknown>>("executions");
  const receipts = store.collection<Record<string, unknown>>("receipts");
  const idempotency = store.collection<IdempotencyRecord>("idempotency");
  const transactionIndex = store.collection<string>("transactionIndex");
  /* Reported verbatim by GET status so a caller can never read a durable
     lifecycle into an ephemeral one. It follows the adapter, not a constant. */
  const storeLimitations = guardStoreLimitations(store);

  const objectKey = (tenantId: string, id: string) => `${tenantId}:${id}`;

  function publicEvaluation(value: Record<string, unknown>) {
    return clone(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "_evidence" && key !== "_policy"),
      ),
    );
  }

  async function requireTenantObject<T>(
    collection: GuardCollection<T>,
    tenantId: string,
    id: string,
  ): Promise<T> {
    const result = await collection.get(objectKey(tenantId, id));
    if (!result) {
      throw new GuardError("TENANT_FORBIDDEN", "Object is unavailable to this tenant.");
    }
    return result;
  }

  /**
   * Run `create` at most once per idempotency key, across every instance.
   *
   * The key is claimed atomically *before* the work runs. Claiming afterwards
   * would let two instances that both saw a free key each execute `create` —
   * which for this service means two intents, or worse, two recorded
   * broadcasts of the same authorization. Whoever loses the claim either
   * replays the winner's stored response or, if the winner has not finished
   * yet, is told to retry rather than being handed a half-built answer.
   */
  async function withIdempotency<T extends Record<string, unknown>>(
    tenantId: string,
    operation: string,
    key: string,
    request: unknown,
    create: () => Promise<T>,
  ): Promise<T & { idempotentReplay?: boolean }> {
    if (!key) throw new GuardError("VALIDATION_ERROR", "Idempotency-Key is required.");
    const scope = `${tenantId}:${operation}:${key}`;
    const requestHash = hashCanonical(request);

    const claimed = await idempotency.insertIfAbsent(scope, { requestHash, inFlight: true });
    if (!claimed) {
      const existing = await idempotency.get(scope);
      if (!existing) {
        /* The record vanished between the failed claim and this read. Refusing
           is the only safe answer: re-running could duplicate the effect the
           key exists to prevent. */
        throw new GuardError("IDEMPOTENCY_CONFLICT", "The idempotency key is in an unknown state.", {
          retryable: true,
        });
      }
      if (existing.requestHash !== requestHash) {
        throw new GuardError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different request.",
        );
      }
      if (existing.inFlight) {
        throw new GuardError(
          "IDEMPOTENCY_CONFLICT",
          "The same request is already in flight; retry to read its result.",
          { retryable: true, requiredAction: "RETRY_IN_FLIGHT_REQUEST" },
        );
      }
      return { ...(clone(existing.response) as T), idempotentReplay: true };
    }

    try {
      const response = await create();
      await idempotency.set(scope, { requestHash, response: clone(response) });
      return clone(response);
    } catch (error) {
      /* Release the claim so a corrected request can be retried. Any effect
         `create` managed to write before failing keeps its own protection —
         intent ids and transaction hashes are claimed atomically too, so a
         retry surfaces the real conflict instead of silently duplicating. */
      await idempotency.delete(scope);
      throw error;
    }
  }

  function createIntent({
    tenantId,
    intent,
    idempotencyKey,
  }: {
    tenantId: string;
    intent: Intent;
    idempotencyKey: string;
  }) {
    return withIdempotency(tenantId, "intent.create", idempotencyKey, intent, async () => {
      if (intent.tenantId !== tenantId) {
        throw new GuardError("TENANT_FORBIDDEN", "Intent tenant does not match authentication.");
      }
      const key = objectKey(tenantId, intent.id);
      const stored = clone(intent);
      /* Claimed atomically rather than checked then written: two instances
         creating the same intent id must not both believe they succeeded. */
      if (!(await intents.insertIfAbsent(key, stored))) {
        throw new GuardError("IDEMPOTENCY_CONFLICT", "Intent ID already exists.");
      }
      return stored;
    });
  }

  function preflight({
    tenantId,
    intentId,
    evidence,
    policy,
    idempotencyKey,
  }: {
    tenantId: string;
    intentId: string;
    evidence: QuoteEvidence[];
    policy: { id: string; version: number; rules: unknown[]; [key: string]: unknown };
    idempotencyKey: string;
  }) {
    return withIdempotency(
      tenantId,
      "intent.preflight",
      idempotencyKey,
      { intentId, evidence, policy },
      async () => {
        const storedIntent = await requireTenantObject(intents, tenantId, intentId);
        const readiness = evaluateGuardReadiness({
          intent: storedIntent,
          evidence,
          policy,
          now: options.now(),
        } as unknown as Parameters<typeof evaluateGuardReadiness>[0]);
        const quote = financialPlanEvidence(evidence);
        const expectedEffects = expectedEffectsFromEvidence(quote);
        const policyDigest = hashCanonical(policy);
        const intentHash = hashCanonical(storedIntent);
        const evidenceRoot = hashCanonical(evidence);
        const createdAt = options.now();
        const expiresAt = quote?.validUntil ?? storedIntent.expiresAt;
        const evaluationWithoutPreflightHash = {
          schemaVersion: "1.0.0",
          id: options.createId("eval"),
          tenantId,
          intentId,
          intentRevision: storedIntent.revision,
          intentHash,
          evidenceRoot,
          evidenceRefs: evidence.map((entry) => entry.id),
          policyRef: { id: policy.id, version: policy.version },
          policyVersion: policy.version,
          policyDigest,
          policyHash: policyDigest,
          createdAt,
          expiresAt,
          ...readiness,
          expectedEffects,
          actualEffects: null,
          reconciliationStatus: "NOT_RECONCILED",
        };
        const preflightHash = hashCanonical({
          schemaVersion: evaluationWithoutPreflightHash.schemaVersion,
          tenantId,
          intentId,
          intentRevision: storedIntent.revision,
          intentHash,
          evidenceRoot,
          evidenceRefs: evaluationWithoutPreflightHash.evidenceRefs,
          policyVersion: policy.version,
          policyDigest,
          evidenceStatus: readiness.evidenceStatus,
          policyDecision: readiness.policyDecision,
          expectedEffects,
          createdAt,
          expiresAt,
        });
        const evaluation = {
          ...evaluationWithoutPreflightHash,
          preflightHash,
          _evidence: clone(evidence),
          _policy: clone(policy),
        };
        await evaluations.set(objectKey(tenantId, evaluation.id), evaluation);
        return publicEvaluation(evaluation);
      },
    );
  }

  function authorize({
    tenantId,
    intentId,
    evaluationId,
    fingerprint,
    subjectRef,
    method,
    idempotencyKey,
  }: {
    tenantId: string;
    intentId: string;
    evaluationId: string;
    fingerprint: ExecutionFingerprint;
    subjectRef: string;
    method: "PARTNER_AUTHENTICATED" | "EIP712";
    idempotencyKey: string;
  }) {
    return withIdempotency(
      tenantId,
      "intent.authorize",
      idempotencyKey,
      { intentId, evaluationId, fingerprint, subjectRef, method },
      async () => {
        const storedIntent = await requireTenantObject(intents, tenantId, intentId);
        const evaluation = await requireTenantObject(evaluations, tenantId, evaluationId);
        if (
          evaluation.intentId !== intentId ||
          evaluation.intentRevision !== storedIntent.revision
        ) {
          throw new GuardError("FINGERPRINT_MISMATCH", "Evaluation is not bound to this intent revision.");
        }
        if (Date.parse(String(evaluation.expiresAt)) <= Date.parse(options.now())) {
          throw new GuardError("EVALUATION_EXPIRED", "The readiness evaluation has expired.", {
            retryable: true,
            requiredAction: "CREATE_NEW_EVALUATION",
          });
        }
        if (evaluation.outcome === "BLOCKED_BY_RULE") {
          throw new GuardError("POLICY_BLOCKED", "Policy blocks authorization.");
        }
        if (
          evaluation.outcome === "INSUFFICIENT_EVIDENCE" ||
          evaluation.outcome === "EXPIRED" ||
          evaluation.outcome === "UNSUPPORTED"
        ) {
          throw new GuardError("EVIDENCE_INSUFFICIENT", "Evidence does not permit authorization.");
        }
        const evidence = evaluation._evidence as QuoteEvidence[];
        const quote = financialPlanEvidence(evidence);
        if (!quote) throw new GuardError("EVIDENCE_INSUFFICIENT", "Swap quote is missing.");
        const expected = buildExecutionFingerprint({ intent: storedIntent, quote });
        if (hashCanonical(expected) !== hashCanonical(fingerprint)) {
          throw new GuardError("FINGERPRINT_MISMATCH", "Authorization fingerprint does not match intent.");
        }
        const authorization = {
          schemaVersion: "1.0.0",
          id: options.createId("auth"),
          tenantId,
          intentId,
          intentRevision: storedIntent.revision,
          evaluationId,
          intentHash: evaluation.intentHash,
          evidenceRoot: evaluation.evidenceRoot,
          policyHash: evaluation.policyHash,
          policyVersion: evaluation.policyVersion,
          policyDigest: evaluation.policyDigest,
          preflightHash: evaluation.preflightHash,
          executionFingerprintHash: hashCanonical(fingerprint),
          materialWarningsShown:
            evaluation.outcome === "REVIEW_REQUIRED" ? ["MAX_SLIPPAGE_BPS"] : [],
          subjectRef,
          method,
          decision: "APPROVED",
          createdAt: options.now(),
          expiresAt: fingerprint.expiresAt,
          signatureRef: null,
        };
        await authorizations.set(objectKey(tenantId, authorization.id), authorization);
        return authorization;
      },
    );
  }

  function recordExecution({
    tenantId,
    intentId,
    authorizationId,
    fingerprint,
    transactionHash,
    idempotencyKey,
  }: {
    tenantId: string;
    intentId: string;
    authorizationId: string | null;
    fingerprint: ExecutionFingerprint;
    transactionHash: string;
    idempotencyKey: string;
  }) {
    return withIdempotency(
      tenantId,
      "intent.execute",
      idempotencyKey,
      { intentId, authorizationId, fingerprint, transactionHash },
      async () => {
        const storedIntent = await requireTenantObject(intents, tenantId, intentId);
        if (!authorizationId) {
          throw new GuardError(
            "HUMAN_AUTHORIZATION_REQUIRED",
            "Execution requires explicit human authorization.",
          );
        }
        const authorization = await requireTenantObject(authorizations, tenantId, authorizationId);
        if (
          authorization.intentId !== intentId ||
          authorization.intentRevision !== storedIntent.revision ||
          authorization.decision !== "APPROVED"
        ) {
          throw new GuardError("FINGERPRINT_MISMATCH", "Authorization is not bound to this intent.");
        }
        if (Date.parse(String(authorization.expiresAt)) <= Date.parse(options.now())) {
          throw new GuardError("AUTHORIZATION_EXPIRED", "Authorization has expired.", {
            retryable: true,
            requiredAction: "CREATE_NEW_EVALUATION",
          });
        }
        if (authorization.executionFingerprintHash !== hashCanonical(fingerprint)) {
          throw new GuardError("FINGERPRINT_MISMATCH", "Execution differs from authorization.");
        }
        const intentExecutionKey = objectKey(tenantId, intentId);
        const txKey = `${tenantId}:${fingerprint.chainRef}:${transactionHash.toLowerCase()}`;
        const execution = {
          schemaVersion: "1.0.0",
          id: options.createId("exec"),
          tenantId,
          intentId,
          intentRevision: storedIntent.revision,
          authorizationId,
          bindingKind: fingerprint.bindingKind,
          productionCalldataBound: fingerprint.productionCalldataBound,
          executionFingerprintHash: hashCanonical(fingerprint),
          transactionHash: transactionHash.toLowerCase(),
          status: "SUBMITTED",
          reconciliationStatus: "NOT_RECONCILED",
          submittedAt: options.now(),
          confirmedAt: null,
          actualOutcome: null,
        };
        /* Both claims are atomic, and the order matters. One intent may record
           exactly one execution, and one transaction hash may bind to exactly
           one intent; a read-then-write pair would let two instances broadcast
           the same authorization and each believe it was the only one. */
        if (!(await executions.insertIfAbsent(intentExecutionKey, execution))) {
          throw new GuardError(
            "IDEMPOTENCY_CONFLICT",
            "This intent already has a recorded execution; a second broadcast is rejected.",
          );
        }
        if (!(await transactionIndex.insertIfAbsent(txKey, intentId))) {
          /* Release the execution claim. Leaving it would permanently block an
             intent on a transaction that was never bound to it. */
          await executions.delete(intentExecutionKey);
          throw new GuardError("IDEMPOTENCY_CONFLICT", "Transaction was already recorded.");
        }
        return execution;
      },
    );
  }

  function reconcileExecution({
    tenantId,
    intentId,
    transactionHash,
    observedState,
    actualOutcome,
    reconciliationEvidence,
    idempotencyKey,
  }: {
    tenantId: string;
    intentId: string;
    transactionHash: string;
    observedState: "RPC_UNCERTAIN_AFTER_BROADCAST" | "CONFIRMED";
    actualOutcome?: {
      amountIn: string;
      amountOut: string;
      feeAmount: string;
      explorerUrl: string;
    };
    reconciliationEvidence?: {
      provider: string;
      sourceRef: string;
      verificationStatus: "PROVIDER_REPORTED" | "ONCHAIN_VERIFIED";
      responseDigest: string;
    };
    idempotencyKey?: string;
  }) {
    const applyReconciliation = async () => {
    const execution = await requireTenantObject(executions, tenantId, intentId);
    if (execution.transactionHash !== transactionHash.toLowerCase()) {
      throw new GuardError("FINGERPRINT_MISMATCH", "Transaction does not match execution.");
    }
    if (observedState === "RPC_UNCERTAIN_AFTER_BROADCAST") {
      execution.status = "RECONCILIATION_REQUIRED";
      execution.reconciliationStatus = "RECONCILIATION_REQUIRED";
      await executions.set(objectKey(tenantId, intentId), execution);
      return clone(execution);
    }
    if (!actualOutcome) {
      throw new GuardError("VALIDATION_ERROR", "Confirmed execution requires actual outcome.");
    }
    if (
      !reconciliationEvidence ||
      reconciliationEvidence.provider.length < 1 ||
      reconciliationEvidence.provider.length > 128 ||
      reconciliationEvidence.sourceRef.length < 1 ||
      reconciliationEvidence.sourceRef.length > 512 ||
      !["PROVIDER_REPORTED", "ONCHAIN_VERIFIED"].includes(
        reconciliationEvidence.verificationStatus,
      ) ||
      !/^0x[0-9a-fA-F]{64}$/.test(reconciliationEvidence.responseDigest)
    ) {
      throw new GuardError(
        "EVIDENCE_INSUFFICIENT",
        "Confirmed execution requires explicit reconciliation provenance.",
      );
    }
    execution.status = "CONFIRMED";
    execution.confirmedAt = options.now();
    execution.actualOutcome = clone(actualOutcome);
    await executions.set(objectKey(tenantId, intentId), execution);

    const storedIntent = await requireTenantObject(intents, tenantId, intentId);
    const authorization = await requireTenantObject(
      authorizations,
      tenantId,
      String(execution.authorizationId),
    );
    const evaluation = await requireTenantObject(
      evaluations,
      tenantId,
      String(authorization.evaluationId),
    );
    const evidence = evaluation._evidence as QuoteEvidence[];
    const quote = financialPlanEvidence(evidence);
    const expectedEffects = expectedEffectsFromEvidence(quote);
    if (!quote || !expectedEffects) {
      throw new GuardError("EVIDENCE_INSUFFICIENT", "Receipt financial-plan evidence is missing.");
    }
    const actualEffects = {
      amountIn: actualOutcome.amountIn,
      amountOut: actualOutcome.amountOut,
      feeAmount: actualOutcome.feeAmount,
    };
    const reconciliationStatus =
      compareDecimalStrings(actualOutcome.amountIn, expectedEffects.amountIn) === 0 &&
      compareDecimalStrings(actualOutcome.amountOut, expectedEffects.minimumAmountOut) !== -1 &&
      compareDecimalStrings(actualOutcome.feeAmount, expectedEffects.feeAmount) !== 1
        ? "MATCHED"
        : "DEVIATION_RECORDED";
    execution.reconciliationStatus = reconciliationStatus;
    await executions.set(objectKey(tenantId, intentId), execution);
    const receiptCore = {
      schemaVersion: "1.0.0",
      id: options.createId("rcpt"),
      tenantId,
      evidenceStatus: evaluation.evidenceStatus,
      policyDecision: evaluation.policyDecision,
      executionStatus: execution.status,
      policyVersion: evaluation.policyVersion,
      policyDigest: evaluation.policyDigest,
      preflightHash: evaluation.preflightHash,
      expectedEffects,
      actualEffects,
      reconciliationStatus,
      intent: {
        id: storedIntent.id,
        revision: storedIntent.revision,
        hash: evaluation.intentHash,
      },
      evidence: {
        root: evaluation.evidenceRoot,
        refs: evaluation.evidenceRefs,
      },
      policy: {
        ...storedIntent.policyRef,
        hash: evaluation.policyDigest,
        outcome: evaluation.outcome,
      },
      authorization: {
        id: authorization.id,
        method: authorization.method,
        subjectRef: authorization.subjectRef,
        createdAt: authorization.createdAt,
      },
      execution: {
        id: execution.id,
        fingerprintHash: execution.executionFingerprintHash,
        bindingKind: execution.bindingKind,
        productionCalldataBound: execution.productionCalldataBound,
        transactionHash: execution.transactionHash,
        status: execution.status,
        explorerUrl: actualOutcome.explorerUrl,
      },
      reconciliation: {
        status: reconciliationStatus,
        expected: expectedEffects,
        actual: actualEffects,
        evidence: clone(reconciliationEvidence),
      },
      settlement: {
        status: "CONFIRMED",
        recoveryState: "NOT_REQUIRED",
      },
      createdAt: execution.submittedAt,
      finalizedAt: options.now(),
      limitations: [
        "ARC_TESTNET",
        "HACKATHON_PROTOTYPE",
        "NOT_AUDITED",
        "NOT_FINANCIAL_ADVICE",
        "PARTNER_AUTHENTICATED_AUTHORIZATION",
        ...(execution.productionCalldataBound === false
          ? ["APP_KIT_REQUEST_BINDING_NOT_CALLDATA"]
          : []),
        ...(reconciliationEvidence.verificationStatus === "PROVIDER_REPORTED"
          ? ["PARTNER_REPORTED_RECONCILIATION"]
          : []),
      ],
    };
    const receiptHash = hashCanonical(receiptCore);
    const receiptWithoutIntegrity = { ...receiptCore, receiptHash };
    const receipt = {
      ...receiptWithoutIntegrity,
      integrity: {
        algorithm: "SHA-256",
        hash: hashCanonical(receiptWithoutIntegrity),
      },
    };
    await receipts.set(objectKey(tenantId, intentId), receipt);
    return clone(execution);
    };
    if (!idempotencyKey) return applyReconciliation();
    return withIdempotency(
      tenantId,
      "intent.reconcile",
      idempotencyKey,
      { intentId, transactionHash, observedState, actualOutcome, reconciliationEvidence },
      applyReconciliation,
    );
  }

  async function getIntent({ tenantId, intentId }: { tenantId: string; intentId: string }) {
    return clone(await requireTenantObject(intents, tenantId, intentId));
  }

  async function getEvaluation({
    tenantId,
    evaluationId,
  }: {
    tenantId: string;
    evaluationId: string;
  }) {
    return publicEvaluation(await requireTenantObject(evaluations, tenantId, evaluationId));
  }

  async function latestForIntent(
    collection: GuardCollection<Record<string, unknown>>,
    tenantId: string,
    intentId: string,
  ): Promise<Record<string, unknown> | null> {
    let latest: Record<string, unknown> | null = null;
    /* Scoped by key prefix so one tenant's status can never be assembled from
       another tenant's rows in a shared table. */
    for (const value of await collection.valuesWithPrefix(`${tenantId}:`)) {
      if (value.tenantId === tenantId && value.intentId === intentId) latest = value;
    }
    return latest;
  }

  async function getStatus({ tenantId, intentId }: { tenantId: string; intentId: string }) {
    const intent = await requireTenantObject(intents, tenantId, intentId);
    const evaluation = await latestForIntent(evaluations, tenantId, intentId);
    const authorization = await latestForIntent(authorizations, tenantId, intentId);
    const execution = (await executions.get(objectKey(tenantId, intentId))) ?? null;
    const receiptFinalized = await receipts.has(objectKey(tenantId, intentId));
    return clone({
      schemaVersion: "1.0.0",
      tenantId,
      intentId,
      intentRevision: intent.revision,
      evidenceStatus: evaluation?.evidenceStatus ?? "INSUFFICIENT",
      dataStatus: evaluation?.dataStatus ?? "INSUFFICIENT",
      policyDecision: evaluation?.policyDecision ?? "INSUFFICIENT_EVIDENCE",
      policyStatus: evaluation?.policyStatus ?? "NOT_EVALUATED",
      authorizationStatus: authorization ? "APPROVED" : (evaluation?.authorizationStatus ?? "PENDING"),
      executionStatus: execution?.status ?? "NOT_STARTED",
      policyVersion: evaluation?.policyVersion ?? intent.policyRef.version,
      policyDigest: evaluation?.policyDigest ?? null,
      preflightHash: evaluation?.preflightHash ?? null,
      expectedEffects: evaluation?.expectedEffects ?? null,
      actualEffects: execution?.actualOutcome ?? null,
      reconciliationStatus: execution?.reconciliationStatus ?? "NOT_RECONCILED",
      receiptStatus: receiptFinalized ? "FINALIZED" : "NOT_FINALIZED",
      limitations: ["ARC_TESTNET", "HACKATHON_PROTOTYPE", ...storeLimitations],
    });
  }

  /**
   * The tenant's operations, newest first, with just enough state to render a
   * ledger row without a second call per intent.
   *
   * This is what makes the surface a workspace rather than a form: an operation
   * that vanishes when the page reloads was never really recorded, whatever the
   * screen said at the time. The scan is prefix-scoped, so one tenant's ledger
   * can never be assembled from another tenant's rows.
   */
  async function listIntents({ tenantId, limit = 50 }: { tenantId: string; limit?: number }) {
    const stored = await intents.valuesWithPrefix(`${tenantId}:`);
    const rows = await Promise.all(
      stored
        .filter((intent) => intent.tenantId === tenantId)
        .map(async (intent) => {
          const execution = await executions.get(objectKey(tenantId, intent.id));
          /* Field names follow the canonical Intent contract in contracts.ts —
             actionType, amount, sellAssetRef, recipient. Reading them by any
             other name yields `undefined`, which renders as a blank ledger cell
             rather than an error, so it is worth being exact here. */
          return {
            intentId: intent.id,
            revision: intent.revision,
            createdAt: intent.createdAt,
            actionType: intent.actionType,
            chainRef: intent.chainRef,
            amount: intent.amount,
            amountType: intent.amountType,
            sellAssetRef: intent.sellAssetRef,
            buyAssetRef: intent.buyAssetRef,
            recipient: intent.recipient ?? null,
            executionStatus: (execution?.status as string | undefined) ?? "NOT_STARTED",
            reconciliationStatus:
              (execution?.reconciliationStatus as string | undefined) ?? "NOT_RECONCILED",
            transactionHash: (execution?.transactionHash as string | undefined) ?? null,
            receiptStatus: (await receipts.has(objectKey(tenantId, intent.id)))
              ? "FINALIZED"
              : "NOT_FINALIZED",
          };
        }),
    );
    /* Newest first by creation time, with the id as the tiebreaker so two
       intents created in the same millisecond still order deterministically
       across instances rather than by whichever row the database returned. */
    rows.sort((left, right) =>
      left.createdAt === right.createdAt
        ? right.intentId.localeCompare(left.intentId)
        : Date.parse(String(right.createdAt)) - Date.parse(String(left.createdAt)),
    );
    return clone({ intents: rows.slice(0, Math.max(1, Math.min(limit, 200))), total: rows.length });
  }

  async function getReceipt({ tenantId, intentId }: { tenantId: string; intentId: string }) {
    await requireTenantObject(intents, tenantId, intentId);
    const receipt = await receipts.get(objectKey(tenantId, intentId));
    if (!receipt) {
      throw new GuardError(
        "EXECUTION_NOT_CONFIRMED",
        "A finalized evidence receipt is not available for this intent.",
        { retryable: true, requiredAction: "RECONCILE_EXECUTION" },
      );
    }
    return clone(receipt);
  }

  return {
    store,
    createIntent,
    getIntent,
    listIntents,
    preflight,
    getEvaluation,
    authorize,
    recordExecution,
    reconcileExecution,
    getStatus,
    getReceipt,
  };
}
