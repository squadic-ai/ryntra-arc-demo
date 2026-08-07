import { requireGuardPathId, withGuardApi } from "../../../../../lib/guard/route.ts";
import { DecisionSettlementReceiptSchema } from "../../../../../lib/guard/contracts.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const intentId = requireGuardPathId((await params).intentId);
    return { data: DecisionSettlementReceiptSchema.parse(await service.getReceipt({ tenantId, intentId })) };
  });
}
