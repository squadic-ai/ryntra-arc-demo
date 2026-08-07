import { requireGuardPathId, withGuardApi } from "../../../../lib/guard/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const evaluationId = requireGuardPathId((await params).evaluationId);
    return { data: await service.getEvaluation({ tenantId, evaluationId }) };
  });
}
