import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import { calculateFare, nowTime, RIDER_AGENT, DRIVER_AGENT } from "@rideagent/shared";

const DRIVER_URL = process.env.DRIVER_AGENT_URL || "http://127.0.0.1:4001";

// In-memory ledger of active payment channels
// In production: persist to Redis/DB
export const channels = new Map<string, {
  channelId:        string;
  rideId:           string;
  fareBtc:         number;
  km:               number;
  streamedBtc:     number;
  checkpoint:       number;
  totalCheckpoints: number;
  status:           string;
  riderWallet?:     string;
}>();

export async function POST(req: NextRequest) {
  const { channelId, rideId, fareBtc, km, action, riderWallet } = await req.json();

  if (!channelId) return NextResponse.json({ error: "channelId required" }, { status: 400 });

  const safeKm = km || (fareBtc ? fareBtc / 0.23 : (channels.get(channelId)?.km || 10));
  const fare = calculateFare(safeKm, 90);

  // ── Init channel ──────────────────────────────────────────────────────
  if (action === "open" || !channels.has(channelId)) {
    channels.set(channelId, {
      channelId,
      rideId:           rideId || channelId,
      fareBtc:         fareBtc || fare.total,
      km:               km || fareBtc / 0.23,
      streamedBtc:     0,
      checkpoint:       0,
      totalCheckpoints: fare.checkpoints,
      status:           "streaming",
      riderWallet:      riderWallet || RIDER_AGENT.wallet,
    });
  }

  const ch = channels.get(channelId)!;

  // ── Release one checkpoint ────────────────────────────────────────────
  if (action === "checkpoint" || !action) {
    if (ch.status === "settled") {
      return NextResponse.json({ ...ch, message: "Channel already settled" });
    }

    ch.checkpoint++;
    ch.streamedBtc = parseFloat(
      Math.min(ch.fareBtc, ch.checkpoint * fare.perCheckpoint).toFixed(4)
    );

    const isLast = ch.checkpoint >= ch.totalCheckpoints;
    if (isLast) ch.status = "settled";

    // Call real GOAT x402 API to process payment
    let realTxHash = `0x_mock_${Math.random().toString(16).slice(2, 10)}`;
    let apiError: string | null = null;
    
    // We only call the real API if we have the credentials set up
    if (process.env.GOATX402_API_KEY) {
      try {
        const goatApiUrl = process.env.GOATX402_API_URL || "https://x402-api-lx58aabp0r.testnet3.goat.network";
        const txAmount = fare.perCheckpoint;
        
        const payload = {
          from: ch.riderWallet || RIDER_AGENT.wallet,
          to: DRIVER_AGENT.wallet,
          amount_btc: txAmount.toFixed(10), // Increased precision for BTC
          channel_id: ch.channelId,
          nonce: Math.floor(Math.random() * 1000000).toString(),
          metadata: { rideId: ch.rideId, checkpoint: ch.checkpoint }
        };

        console.log(`[RIDER] Sending to GOAT x402 API:`, JSON.stringify(payload));
        const x402Res = await fetch(`${goatApiUrl}/api/v1/payments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GOATX402_API_KEY}`,
            "X-Merchant-ID": process.env.GOATX402_MERCHANT_ID || "nanda_dev",
            "X-Timestamp":   Date.now().toString(),
            "X-Nonce":       Math.random().toString(36).slice(2, 11)
          },
          body: JSON.stringify(payload)
        });
        
        const x402Data = await x402Res.json();
        console.log(`[RIDER] GOAT x402 API Response (${x402Res.status}):`, JSON.stringify(x402Data));

        if (x402Res.ok) {
           realTxHash = x402Data.tx_hash || x402Data.id || realTxHash;
        } else {
           apiError = `GOAT API error: ${x402Data.message || x402Res.statusText}`;
        }
      } catch (e) {
        apiError = `GOAT network unreachable: ${String(e)}`;
      }
    } else {
        apiError = "GOATX402_API_KEY missing - simulating payment";
    }

    // Notify Driver Agent of checkpoint release
    const checkpointPayload = {
      channelId:    ch.channelId,
      rideId:       ch.rideId,
      checkpoint:   ch.checkpoint,
      total:        ch.totalCheckpoints,
      amountBtc:   ch.fareBtc / ch.totalCheckpoints,
      streamedBtc: ch.streamedBtc,
      payer:        RIDER_AGENT.wallet,
      recipient:    DRIVER_AGENT.wallet,
      txHash:       realTxHash,
      settled:      isLast,
    };

    let driverAck = null;
    try {
      const res = await fetch(`${DRIVER_URL}/api/webhook`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(checkpointPayload),
      });
      driverAck = await res.json();
    } catch {
      // Driver offline — checkpoint still recorded locally
    }

    return NextResponse.json({
      ...ch,
      checkpointPayload,
      driverAck,
      logs: [
        `${nowTime()} [RIDER] Checkpoint ${ch.checkpoint}/${ch.totalCheckpoints} released`,
        `${nowTime()} [RIDER] Sent ${fare.perCheckpoint.toFixed(4)} BTC → ${DRIVER_AGENT.wallet.slice(0,10)}...`,
        apiError ? `${nowTime()} [warn] ${apiError}` : `${nowTime()} [x402] Tx confirmed on GOAT: ${realTxHash.slice(0,10)}...`,
        isLast ? `${nowTime()} [RIDER] Final checkpoint — channel settled` : "",
      ].filter(Boolean),
    });
  }

  // ── Settle / close channel ─────────────────────────────────────────────
  if (action === "settle") {
    ch.status       = "settled";
    ch.streamedBtc = ch.fareBtc;
    ch.checkpoint   = ch.totalCheckpoints;
    return NextResponse.json({
      ...ch,
      logs: [
        `${nowTime()} [RIDER] Channel ${channelId} force-settled`,
        `${nowTime()} [RIDER] Total paid: ${ch.fareBtc} BTC → Driver`,
      ],
    });
  }

  return NextResponse.json(ch);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get("channelId");
  if (channelId) {
    const ch = channels.get(channelId);
    return NextResponse.json(ch || { error: "Channel not found" });
  }
  return NextResponse.json(Array.from(channels.values()));
}
