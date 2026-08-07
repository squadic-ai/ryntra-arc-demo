import { guardCapabilities } from "../../../lib/guard/api.ts";
import { publicGuardResponse } from "../../../lib/guard/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return publicGuardResponse(request, {
    schemaVersion: "1.0.0",
    data: guardCapabilities,
    limitations: ["ARC_TESTNET", "HACKATHON_PROTOTYPE", "LIVE_EXECUTION_NOT_VERIFIED"],
  });
}
