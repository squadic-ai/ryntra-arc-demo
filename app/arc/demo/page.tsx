import type { Metadata } from "next";

import { ArcGuardDemo } from "../../arc-guard/arc-guard-demo.tsx";

/**
 * The direct demo route.
 *
 * It renders the same component the reference client uses, so there is one
 * implementation of the lifecycle and one place a defect can be fixed. The
 * route stays `noindex`: the demo is a live prototype surface whose state is
 * per-run, and `/` is the page a reviewer should land on.
 */
export const metadata: Metadata = {
  title: "Arc Testnet Demo — Ryntra Guard",
  description:
    "A testnet-only reference client for provider-neutral decision and settlement evidence, explicit human authorization, and reconciliation.",
  robots: { index: false, follow: false },
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ArcDemoPage() {
  return <ArcGuardDemo />;
}
