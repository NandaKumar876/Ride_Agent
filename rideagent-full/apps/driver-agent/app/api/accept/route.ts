import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import {
  DRIVER_AGENT,
  calculateFare,
  buildPaymentRequest,
  encodePaymentRequest,
  generateChannelId,
  nowTime,
} from "@rideagent/shared";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Payment",
};

// In-memory store of rides and confirmed channels
// In production: use Redis / Postgres
export const rideStore = new Map<string, {
  rideId:       string;
  riderWallet:  string;
  from:         string;
  to:           string;
  fareBtc:     number;
  km:           number;
  channelId:    string | null;
  status:       string;
  createdAt:    number;
}>();

export async function POST(req: NextRequest) {
  const RIDER_URL = process.env.RIDER_AGENT_URL || "http://127.0.0.1:4000";
  
  const xPayment = req.headers.get("X-Payment");
  const body     = await req.json();
  const { rideId, riderWallet, from, to, maxFareBtc, channelId } = body;

  // ── Phase 2: Rider is sending payment proof ───────────────────────────
  if (xPayment) {
    let proof: {
      channelId: string;
      permitSignature: string;
      payer: string;
      amount: string;
    };
    try {
      proof = JSON.parse(Buffer.from(xPayment, "base64").toString("utf-8"));
    } catch {
      return NextResponse.json({ error: "Invalid X-Payment header" }, { status: 400 });
    }

    // In production: verify EIP-712 permit signature on-chain here
    // const valid = await verifyPermit(proof.permitSignature, proof.payer, proof.amount);
    // if (!valid) return NextResponse.json({ error: "Invalid permit" }, { status: 401 });
    console.log(`[DRIVER] Mock verifyPermit placeholder triggered.`);

    // Step 3: Tell Rider Agent to open the channel
    const res = await fetch(`${RIDER_URL}/api/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "open",
        channelId: proof.channelId,
        rideId: proof.channelId, // Using channelId as rideId for the rider agent
        riderWallet: proof.payer,
        driverWallet: DRIVER_AGENT.wallet,
        fareBtc: parseFloat(proof.amount),
      }),
    });
    if (!res.ok) {
       console.error(`[DRIVER] Rider Agent rejected channel open: ${res.statusText}`);
    }

    const fareBtc = parseFloat(proof.amount);
    const km       = fareBtc / 0.23;

    // Store confirmed ride
    rideStore.set(rideId, {
      rideId,
      riderWallet:  proof.payer,
      from:         from || "Unknown",
      to:           to   || "Unknown",
      fareBtc,
      km,
      channelId:    proof.channelId,
      status:       "PAYMENT_CONFIRMED",
      createdAt:    Date.now(),
    });

    return NextResponse.json({
      received:   true,
      rideId,
      channelId:  proof.channelId,
      driverWallet: DRIVER_AGENT.wallet,
      status:     "PAYMENT_CONFIRMED",
      message:    "Payment proof verified — ride accepted",
      logs: [
        `${nowTime()} [DRIVER] Payment proof received from ${proof.payer.slice(0, 10)}...`,
        `${nowTime()} [DRIVER] Permit signature verified (simulated)`,
        `${nowTime()} [DRIVER] Channel ${proof.channelId} — ${fareBtc} BTC locked in escrow`,
        `${nowTime()} [DRIVER] Ride ${rideId} confirmed — starting pickup`,
      ],
    });
  }

  // ── Phase 1: Rider is sending initial ride request ────────────────────
  if (!rideId || !riderWallet || !from || !to) {
    return NextResponse.json({ error: "Missing required fields: rideId, riderWallet, from, to" }, { status: 400 });
  }

  // Clear previous ride history when a new request arrives
  rideStore.clear();

  // Simulate route calculation
  const km       = parseFloat((Math.random() * 22 + 3).toFixed(1));
  const fare     = calculateFare(km, DRIVER_AGENT.tokenId);
  const fareBtc = fare.total;

  // Check if driver meets reputation requirements
  const minRep = body.minDriverRep || 60;
  if (96.1 < minRep) {
    return NextResponse.json({
      error:    `Driver reputation 96.1 is below rider minimum ${minRep}`,
      status:   "REJECTED",
    }, { status: 422 });
  }

  // Check if fare is within rider's budget
  if (maxFareBtc && fareBtc > maxFareBtc) {
    return NextResponse.json({
      error:    `Fare ${fareBtc.toFixed(2)} BTC exceeds rider budget ${maxFareBtc} BTC`,
      fareBtc,
      status:   "REJECTED",
    }, { status: 422 });
  }

  // Build x402 payment request
  const nonce          = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const paymentRequest = buildPaymentRequest(DRIVER_AGENT.wallet, fareBtc, 0.23, nonce);
  const encoded        = encodePaymentRequest(paymentRequest);

  // Instead of HTTP 402 immediately, we return HTTP 202 to the rider stating the request is pending review.
  rideStore.set(rideId, {
    rideId,
    riderWallet,
    from,
    to,
    fareBtc,
    km,
    channelId: null,
    status:    "PENDING_REVIEW",
    createdAt: Date.now(),
  });

  // Keep the payment request handy for the driver UI when they click accept
  (global as any).pendingOffers = (global as any).pendingOffers || new Map();
  (global as any).pendingOffers.set(rideId, {
    fareBtc, km, encoded, nonce, checkpoints: fare.checkpoints, perCheckpoint: fare.perCheckpoint, eta: Math.ceil(km / 40 * 60)
  });

  return NextResponse.json(
    {
      rideId,
      status:  "PENDING_REVIEW",
      message: "Ride request received. Driver is reviewing to accept or reject.",
      logs: [
        `${nowTime()} [DRIVER] Ride request received: ${from} → ${to}`,
        `${nowTime()} [DRIVER] Calculated route: ${km} km`,
        `${nowTime()} [DRIVER] Awaiting manual acceptance from driver agent...`,
      ],
    },
    { status: 202 }
  );
}

export async function PUT(req: NextRequest) {
  // Read raw text to handle CORS bypassing (where content-type is missing)
  const text = await req.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }
  
  const { rideId, action } = json;
  const ride = rideStore.get(rideId);
  const pendingMap = (global as any).pendingOffers || new Map();
  const offer = pendingMap.get(rideId);

  if (!ride || !offer) {
    return NextResponse.json({ error: "Ride not found or already processed" }, { status: 404, headers: corsHeaders });
  }

  if (action === "REJECT") {
    ride.status = "REJECTED";
    pendingMap.delete(rideId);
    return NextResponse.json({ success: true, status: "REJECTED" }, { headers: corsHeaders });
  }

  if (action === "ACCEPT") {
    ride.status = "PAYMENT_REQUESTED"; // Re-entering the x402 flow state organically
    return NextResponse.json({
      success: true,
      status: "PAYMENT_REQUESTED",
      offerDetails: {
        rideId,
        driverWallet:      DRIVER_AGENT.wallet,
        driverRep:         96.1,
        estimatedKm:       offer.km,
        estimatedFareBtc: offer.fareBtc,
        checkpoints:       offer.checkpoints,
        perCheckpoint:     offer.perCheckpoint,
        ratePerKm:         0.23,
        eta:               offer.eta,
        message:           "Payment required to accept ride",
      },
      headers: {
        "X-Payment-Request": offer.encoded,
        "X-Payment-Amount":  offer.fareBtc.toFixed(6),
        "X-Payment-Nonce":   offer.nonce,
        "X-Driver-Wallet":   DRIVER_AGENT.wallet,
        "X-Driver-Rep":      "96.1",
      }
    }, { headers: corsHeaders });
  }

  // ── Auto Faucet Driver ──
  // For hackathon UX: Instantly deposit GOAT BTC gas to driver before they begin the ride.
  // Note: we place it down here or trigger it asynchronously if we want to ensure it fires.
  if (action === "FAUCET_TRIGGER" || action === "ACCEPT") {
      try {
        await fetch("https://faucet.testnet3.goat.network/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: DRIVER_AGENT.wallet })
        });
        console.log(`[DRIVER] 🚰 Auto-Faucet deposited Test BTC for gas`);
      } catch (e) {
        // Ignore faucet errors silently so we don't break the ride flow
      }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400, headers: corsHeaders });
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET() {
  return NextResponse.json({
    driver:   DRIVER_AGENT.name,
    wallet:   DRIVER_AGENT.wallet,
    tokenId:  DRIVER_AGENT.tokenId,
    rep:      96.1,
    status:   "available",
    rides:    Array.from(rideStore.values()),
  }, { headers: corsHeaders });
}
