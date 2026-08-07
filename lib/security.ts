import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison for secrets (headers, webhook params). Both sides are
 * SHA-256-digested first so the timingSafeEqual inputs are ALWAYS equal-length — no early
 * return on length mismatch, so not even the secret's length leaks through timing.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Token from an `Authorization: Bearer <token>` header value, else null. Scheme is case-insensitive. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

/**
 * True when the Authorization header carries a Bearer token equal (constant-time) to one of
 * the given secrets. Secrets travel in headers, never URLs — query strings end up in access
 * logs, CDN caches and browser history; headers don't.
 */
export function authorizedBearer(
  authorization: string | null | undefined,
  ...secrets: (string | null | undefined)[]
): boolean {
  const token = bearerToken(authorization);
  if (!token) return false;
  let ok = false;
  for (const secret of secrets) if (safeEqual(token, secret)) ok = true;
  return ok;
}
