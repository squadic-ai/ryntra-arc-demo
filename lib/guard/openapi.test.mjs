// Run from repo root: node --test lib/guard/openapi.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("OpenAPI declares the exact Guard v1 surface and fail-closed protocol fields", async () => {
  const source = await readFile(new URL("../../openapi/ryntra-guard-v1.yaml", import.meta.url), "utf8");
  for (const path of [
    "/v1/intents:",
    "/v1/intents/{intentId}:",
    "/v1/intents/{intentId}/preflight:",
    "/v1/evaluations/{evaluationId}:",
    "/v1/intents/{intentId}/authorize:",
    "/v1/intents/{intentId}/executions:",
    "/v1/intents/{intentId}/status:",
    "/v1/intents/{intentId}/receipt:",
    "/v1/capabilities:",
    "/health:",
  ]) assert.match(source, new RegExp(path.replace(/[{}]/g, "\\$&")));
  assert.match(source, /type: http\s+scheme: bearer/);
  assert.match(source, /name: Idempotency-Key/);
  assert.match(source, /name: X-Correlation-Id/);
  assert.match(source, /FINGERPRINT_MISMATCH/);
  assert.match(source, /IDEMPOTENCY_CONFLICT/);
  assert.match(source, /amount:\s+type: string/);
  assert.doesNotMatch(source, /amount:\s+type: number/);

  const receiptPath = source.slice(
    source.indexOf("/v1/intents/{intentId}/receipt:"),
    source.indexOf("/v1/capabilities:"),
  );
  assert.match(receiptPath, /ReceiptResponse/);
  assert.doesNotMatch(receiptPath, /StatusResponse/);
  const healthPath = source.slice(source.indexOf("/health:"), source.indexOf("components:"));
  assert.match(healthPath, /DataResponse/);
  assert.doesNotMatch(healthPath, /ReceiptResponse/);

  const evidenceSchema = source.slice(source.indexOf("    EvidenceItem:"), source.indexOf("    GuardEvaluation:"));
  for (const field of ["confidence", "chainRef", "blockRef", "transactionRef"]) {
    assert.match(evidenceSchema, new RegExp(`- ${field}`));
  }

  const decisionReceipt = source.slice(
    source.indexOf("    DecisionSettlementReceipt:"),
    source.indexOf("    ExecutionFingerprint:"),
  );
  assert.match(decisionReceipt, /DecisionSettlementReceipt:\s+[\s\S]{0,100}additionalProperties: false/);
  for (const field of [
    "schemaVersion", "id", "tenantId", "intent", "evidence", "policy", "authorization",
    "execution", "reconciliation", "settlement", "createdAt", "finalizedAt", "limitations",
    "integrity",
  ]) {
    assert.match(decisionReceipt, new RegExp(`- ${field}`));
  }
  for (const component of ["ReceiptIntent", "ReceiptEvidence", "ReceiptPolicy", "ReceiptAuthorization", "ReceiptExecution", "ReceiptReconciliation", "ReceiptSettlement", "ReceiptIntegrity"]) {
    assert.match(decisionReceipt, new RegExp(`#/components/schemas/${component}`));
  }
  assert.match(source, /ActualEffects:\s+[\s\S]{0,100}additionalProperties: false/);
});

test("the partner example uses the headless SDK and leaves wallet execution outside Ryntra", async () => {
  const source = await readFile(new URL("../../examples/partner-arc-app/server-flow.ts", import.meta.url), "utf8");
  assert.match(source, /RyntraGuardClient/);
  assert.match(source, /client\.intents\.create/);
  assert.match(source, /client\.preflight/);
  assert.match(source, /client\.authorize/);
  assert.match(source, /client\.executions\.record/);
  assert.match(source, /transactionHash/);
  assert.doesNotMatch(source, /privateKey|seedPhrase|wallet\.execute/i);
});
