import { publicGuardResponse } from "../../lib/guard/route.ts";
import { getGuardRuntime } from "../../lib/guard/runtime.ts";
import { RECORDED_RUN } from "../arc/arc-project.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  /* Persistence is reported from the adapter that is actually configured, not
     from a constant. A reviewer opening /health must be able to tell whether the
     lifecycle they are about to exercise survives the next request. */
  const guard = getGuardRuntime();
  return publicGuardResponse(request, {
    ok: true,
    service: "ryntra-guard",
    environment: "ARC_TESTNET",
    persistence: guard.store.durability,
    persistenceDetail: guard.store.description,
    deployment: guard.deployment,
    stateChangesAccepted: guard.writes.allowed,
    /* Read from the recorded proof, not typed. This field said NOT_VERIFIED for
       a day after Gate B passed — the third literal in this codebase to outlive
       the fact it described. A health endpoint that reports a stale capability
       is worse than one that reports none. */
    liveArcExecution: RECORDED_RUN.transactionHash ? "TESTNET_VERIFIED" : "NOT_VERIFIED",
    verifiedOperation: RECORDED_RUN.transactionHash
      ? "EOA_USDC_ERC20_TREASURY_TRANSFER"
      : null,
    /* Whatever the transfer proved, the swap is not covered by it. */
    swapExecution: "NOT_VERIFIED",
  });
}
