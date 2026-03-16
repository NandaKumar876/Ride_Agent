import { NextResponse } from "next/server";
import { RIDER_AGENT, CHAIN } from "@rideagent/shared";

export async function GET() {
  return NextResponse.json({
    agent: {
      name:       RIDER_AGENT.name,
      wallet:     RIDER_AGENT.wallet,
      merchantId: RIDER_AGENT.merchantId,
      tokenId:    RIDER_AGENT.tokenId,
      network:    CHAIN.name,
      status:     "online",
    },
    timestamp: Date.now(),
  });
}
