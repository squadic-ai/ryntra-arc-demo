import { randomUUID } from "node:crypto";

import {
  createIntentFromApiInput,
  readBoundedGuardJson,
  requireIdempotencyKey,
} from "../../../lib/guard/api.ts";
import { withGuardApi } from "../../../lib/guard/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tenant's operation ledger.
 *
 * A read, so it stays available even where the durability gate refuses state
 * changes — a reviewer on a misconfigured deployment can still see what the
 * instance holds and why it will not accept more.
 */
export async function GET(request: Request) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const limit = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
    return {
      data: await service.listIntents({
        tenantId,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    };
  });
}

export async function POST(request: Request) {
  return withGuardApi(request, async ({ tenantId, service }) => {
    const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
    const body = await readBoundedGuardJson(request);
    const intent = createIntentFromApiInput({
      body,
      tenantId,
      idempotencyKey,
      now: new Date().toISOString(),
      intentId: `int_${randomUUID().replaceAll("-", "")}`,
    });
    return {
      data: await service.createIntent({ tenantId, intent, idempotencyKey }),
      status: 201,
    };
  });
}
