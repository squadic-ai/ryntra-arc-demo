import {
  parseAuthorizeRequest,
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
    const body = parseAuthorizeRequest(await readBoundedGuardJson(request));
    return {
      data: await service.authorize({ tenantId, intentId, idempotencyKey, ...body }),
    };
  });
}
