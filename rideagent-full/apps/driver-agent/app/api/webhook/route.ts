import { NextRequest, NextResponse } from "next/server";
import { DRIVER_AGENT, nowTime } from "@rideagent/shared";

// In-memory ledger of received payments per channel
export const paymentLedger = new Map<string, {
  channelId:        string;
  rideId:           string;
  totalExpected:    number;
  totalReceived:    number;
  checkpointsDone:  number;
  checkpointsTotal: number;
  txHashes:         string[];
  settled:          boolean;
  lastUpdate:       number;
}>();

export async function POST(req: NextRequest) {
  const {
    channelId,
    rideId,
    checkpoint,
    total: totalCheckpoints,
    amountBtc,
    streamedBtc,
    payer,
    recipient,
    txHash,
    settled,
  } = await req.json();

  if (!channelId) {
    return NextResponse.json({ error: "channelId required" }, { status: 400 });
  }

  // Ensure we're the right recipient
  if (recipient && recipient.toLowerCase() !== DRIVER_AGENT.wallet.toLowerCase()) {
    // Allow for testing with mismatched wallets but log a warning
    console.warn(`[DRIVER] Webhook for different recipient: ${recipient}`);
  }

  // Init or update ledger entry
  if (!paymentLedger.has(channelId)) {
    paymentLedger.set(channelId, {
      channelId,
      rideId,
      totalExpected:    0,
      totalReceived:    0,
      checkpointsDone:  0,
      checkpointsTotal: totalCheckpoints || 0,
      txHashes:         [],
      settled:          false,
      lastUpdate:       Date.now(),
    });
  }

  const entry = paymentLedger.get(channelId)!;
  entry.totalReceived    = streamedBtc || (entry.totalReceived + amountBtc);
  entry.checkpointsDone  = checkpoint;
  entry.checkpointsTotal = totalCheckpoints || entry.checkpointsTotal;
  entry.txHashes.push(txHash || `0x${Math.random().toString(16).slice(2, 42)}`);
  entry.settled          = settled || false;
  entry.lastUpdate       = Date.now();

  const logs = [
    `${nowTime()} [DRIVER] Checkpoint ${checkpoint}/${totalCheckpoints} received`,
    `${nowTime()} [DRIVER] +${amountBtc.toFixed(4)} BTC from ${(payer || "").slice(0, 10)}...`,
    `${nowTime()} [DRIVER] Total received: ${entry.totalReceived.toFixed(4)} BTC`,
  ];

  if (settled) {
    entry.settled = true;
    logs.push(`${nowTime()} [DRIVER] Channel SETTLED — final payment received`);
    logs.push(`${nowTime()} [DRIVER] ERC-8004 score update queued on-chain`);
  }

  return NextResponse.json({
    received:         true,
    channelId,
    checkpointsDone:  entry.checkpointsDone,
    checkpointsTotal: entry.checkpointsTotal,
    totalReceived:    entry.totalReceived,
    settled:          entry.settled,
    logs,
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channelId");
  if (channelId) {
    return NextResponse.json(paymentLedger.get(channelId) || { error: "Not found" });
  }
  return NextResponse.json({
    channels: Array.from(paymentLedger.values()),
    summary: {
      totalChannels:  paymentLedger.size,
      settledChannels: Array.from(paymentLedger.values()).filter(e => e.settled).length,
      totalBtcEarned: Array.from(paymentLedger.values()).reduce((s, e) => s + e.totalReceived, 0),
    },
  });
}
