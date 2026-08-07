import { randomUUID } from "node:crypto";

/**
 * The browser demo's tenant identity.
 *
 * The public Arc surface has no accounts, so a tenant is derived from an
 * httpOnly session cookie. That is what keeps one visitor's ledger from
 * appearing in another's: every stored object is keyed by this tenant id, and
 * the store scans by key prefix, so two visitors on the same deployment cannot
 * read each other's intents, executions or receipts.
 *
 * It lives here rather than inside a route module because more than one route
 * needs it — the operation endpoint and the activity ledger must agree on who
 * the caller is, and two copies of this derivation would eventually not.
 */

export const ARC_DEMO_SESSION_COOKIE = "ryntra_arc_demo_session";

const SESSION_PATTERN = /^demo_[0-9a-f]{32}$/;

export type ArcDemoSession = {
  session: string;
  tenantId: string;
};

export function arcDemoSessionFromRequest(request: Request): ArcDemoSession {
  const cookie = request.headers.get("cookie") ?? "";
  const existing = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ARC_DEMO_SESSION_COOKIE}=`))
    ?.slice(ARC_DEMO_SESSION_COOKIE.length + 1);
  /* An unrecognised value is replaced rather than trusted: the cookie is
     attacker-controlled input, and a tenant id assembled from it is a lookup
     key into every other visitor's objects. */
  const session =
    existing && SESSION_PATTERN.test(existing)
      ? existing
      : `demo_${randomUUID().replaceAll("-", "")}`;
  return {
    session,
    tenantId: `arc_demo_${session.slice("demo_".length)}`,
  };
}

/** The Set-Cookie value for a session, given whether the request is over TLS. */
export function arcDemoSessionCookie(session: string, secure: boolean): string {
  return `${ARC_DEMO_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${
    secure ? "; Secure" : ""
  }`;
}
