import type { NextConfig } from "next";

/*
 * Security headers for a wallet-signing prototype.
 *
 * `connect-src 'self'` is deliberate and load-bearing: the browser client owns
 * no chain facts and talks to exactly one upstream — this app's own
 * `/api/arc-guard`, which serves the whole network definition from the server
 * that is actually connected to it. The wallet extension makes its own RPC
 * calls outside the page context, so widening this list would only permit
 * requests the product does not make.
 *
 * 'unsafe-inline' for scripts is required by Next's hydration payload. The
 * value here is blocking EXTERNAL script, frame and object sources, not inline.
 * Dev additionally needs 'unsafe-eval' for React Refresh; the production build
 * does not.
 */
const isDev = process.env.NODE_ENV === "development";

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
