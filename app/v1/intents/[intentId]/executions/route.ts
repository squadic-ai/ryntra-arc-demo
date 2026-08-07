import {
  parseExecutionRequest,
  readBoundedGuardJson,
  requireIdempotencyKey,
} from "../../../../../lib/guard/api.ts";
import { requireGuardPathId, withGuardApi } from "../../../../../lib/guard/route.ts";
import { hashCanonical } from "../../../../../lib/guard/service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const intentId = requireGuardPathId((await params).intentId);
    const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
    const body = parseExecutionRequest(await readBoundedGuardJson(request));
    if (body.operation === "RECONCILE") {
      return {
        data: await service.reconcileExecution({
          tenantId,
          intentId,
          transactionHash: body.transactionHash,
          observedState: body.observedState,
          actualOutcome: body.actualOutcome,
          reconciliationEvidence:
            body.observedState === "CONFIRMED"
              ? {
                  provider: "Partner application",
                  sourceRef: `partner-api:${body.transactionHash.toLowerCase()}`,
                  verificationStatus: "PROVIDER_REPORTED",
                  responseDigest: hashCanonical({
                    transactionHash: body.transactionHash.toLowerCase(),
                    actualOutcome: body.actualOutcome,
                  }),
                }
              : undefined,
          idempotencyKey,
        }),
      };
    }
    return {
      data: await service.recordExecution({
        tenantId,
        intentId,
        authorizationId: body.authorizationId,
        fingerprint: body.fingerprint,
        transactionHash: body.transactionHash,
        idempotencyKey,
      }),
      status: 202,
    };
  });
}
