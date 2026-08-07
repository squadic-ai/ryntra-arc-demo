import { requireGuardPathId, withGuardApi } from "../../../../lib/guard/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const intentId = requireGuardPathId((await params).intentId);
    return { data: await service.getIntent({ tenantId, intentId }) };
  });
}
