import {
  ARC_DEMO_POLICY,
  parsePreflightRequest,
  readBoundedGuardJson,
  requireIdempotencyKey,
} from "../../../../../lib/guard/api.ts";
import { requireGuardPathId, withGuardApi } from "../../../../../lib/guard/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const intentId = requireGuardPathId((await params).intentId);
    const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
    const body = parsePreflightRequest(await readBoundedGuardJson(request));
    return {
      data: await service.preflight({
        tenantId,
        intentId,
        evidence: body.evidence as unknown as Parameters<typeof service.preflight>[0]["evidence"],
        policy: ARC_DEMO_POLICY,
        idempotencyKey,
      }),
    };
  });
}
