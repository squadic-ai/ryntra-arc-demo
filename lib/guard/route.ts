import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";

import { clientIp, privateNoStoreHeaders, rateLimitHeaders } from "../http-control.ts";
import {
  GuardApiError,
  authenticateGuardApi,
  correlationIdFromHeader,
  structuredGuardError,
} from "./api.ts";
import { getGuardRuntime } from "./runtime.ts";

/**
 * `data` is deliberately not `unknown`.
 *
 * Every service method returns a promise, and `unknown` accepted one happily —
 * a forgotten `await` typechecked, then serialized to `{}` and returned 200
 * with an empty body. Nine routes shipped that way and no gate caught it.
 * Excluding a thenable makes the missing `await` a compile error at the exact
 * line that caused it.
 */
export type GuardRouteResult<TData = unknown> = {
  data: TData extends PromiseLike<unknown> ? never : TData;
  status?: number;
};

const PATH_ID = /^[A-Za-z0-9_-]{3,128}$/;

export function requireGuardPathId(value: string): string {
  if (!PATH_ID.test(value)) {
    throw new GuardApiError("VALIDATION_ERROR", "Path identifier is invalid.", {
      requiredAction: "CORRECT_REQUEST",
    });
  }
  return value;
}

function responseHeaders(correlationId: string, extra: Record<string, string> = {}) {
  return {
    ...privateNoStoreHeaders(),
    "X-Correlation-Id": correlationId,
    "X-Ryntra-Prototype": "ARC_TESTNET_HACKATHON",
    ...extra,
  };
}

export async function withGuardApi<TData>(
  request: Request,
  handler: (context: {
    tenantId: string;
    correlationId: string;
    service: ReturnType<typeof getGuardRuntime>["service"];
  }) => Promise<GuardRouteResult<TData>> | GuardRouteResult<TData>,
): Promise<NextResponse> {
  const correlationId = correlationIdFromHeader(
    request.headers.get("x-correlation-id"),
    () => `corr_${randomUUID().replaceAll("-", "")}`,
  );
  try {
    const { tenantId } = authenticateGuardApi({
      authorization: request.headers.get("authorization"),
      configuredApiKey: process.env.RYNTRA_GUARD_DEMO_API_KEY,
      configuredTenantId: process.env.RYNTRA_GUARD_DEMO_TENANT_ID,
    });
    const runtime = getGuardRuntime();
    const rate = runtime.limiter.consume(`${tenantId}:${clientIp(request.headers)}`);
    if (!rate.allowed) {
      throw new GuardApiError("RATE_LIMITED", "Guard API rate limit reached.", {
        retryable: true,
        requiredAction: "RETRY_AFTER_RATE_LIMIT",
      });
    }
    /* Every state change in this API is a POST, so the durability gate is
       enforced once here rather than remembered in each route. A deployment
       whose store cannot outlive one instance is refused outright instead of
       accepting an intent it will lose on the next request. */
    if (request.method !== "GET" && !runtime.writes.allowed) {
      throw new GuardApiError("CAPABILITY_UNAVAILABLE", runtime.writes.reason, {
        retryable: false,
        requiredAction: runtime.writes.requiredAction,
      });
    }
    const result = await handler({ tenantId, correlationId, service: runtime.service });
    return NextResponse.json(
      { data: result.data },
      { status: result.status ?? 200, headers: responseHeaders(correlationId, rateLimitHeaders(rate)) },
    );
  } catch (error) {
    const structured = structuredGuardError(error, correlationId);
    return NextResponse.json(structured.body, {
      status: structured.status,
      headers: responseHeaders(correlationId),
    });
  }
}

export function publicGuardResponse(request: Request, body: unknown, status = 200): NextResponse {
  const correlationId = correlationIdFromHeader(
    request.headers.get("x-correlation-id"),
    () => `corr_${randomUUID().replaceAll("-", "")}`,
  );
  return NextResponse.json(body, { status, headers: responseHeaders(correlationId) });
}
