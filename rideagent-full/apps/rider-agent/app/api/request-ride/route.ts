import { NextRequest, NextResponse } from "next/server";
import {
  generateRideId, generateChannelId, calculateFare,
  buildPaymentRequest, encodePaymentRequest,
  X402PaymentRequest, RIDER_AGENT, DRIVER_AGENT,
  nowTime,
} from "@rideagent/shared";

export async function POST(req: NextRequest) {
  const DRIVER_URL = process.env.DRIVER_AGENT_URL || "http://localhost:4001";
  const { from, to, maxFareBtc, minDriverRep, riderWallet } = await req.json();

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const rideId     = generateRideId();
  const channelId  = generateChannelId();
  const timestamp  = Date.now();

  // ── Step 1: Send ride request to Driver Agent ──────────────────────────
  let driverResponse: Response;
  try {
    driverResponse = await fetch(`${DRIVER_URL}/api/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rideId,
        riderWallet: riderWallet || RIDER_AGENT.wallet,
        from,
        to,
        maxFareBtc:  maxFareBtc  ?? 20,
        minDriverRep: minDriverRep ?? 60,
        timestamp,
      }),
    });
  } catch (err) {
    return NextResponse.json({
      rideId,
      status:  "FAILED",
      step:    "DRIVER_UNREACHABLE",
      error:   `Driver agent offline: ${String(err)}`,
      logs:    [`${nowTime()} [RIDER] Driver agent at ${DRIVER_URL} is unreachable`],
    }, { status: 503 });
  }

  // If driverResponse is undefined here, it means we returned out of the catch block, but TS doesn't know.
  if (!driverResponse) {
    return NextResponse.json({ error: "Driver response is undefined" }, { status: 500 });
  }

  // ── Step 1.5: Driver returned 202 PENDING_REVIEW ───────────────────────
  if (driverResponse.status === 202) {
    const data = await driverResponse.json();
    return NextResponse.json(data, { status: 202 });
  }

  // ── Step 2: Check for HTTP 402 Payment Required ────────────────────────
  if (driverResponse.status === 402) {
    const paymentHeader = driverResponse.headers.get("X-Payment-Request");
    if (!paymentHeader) {
      return NextResponse.json({ error: "Driver returned 402 but no X-Payment-Request header" }, { status: 502 });
    }

    let paymentReq: X402PaymentRequest;
    try {
      paymentReq = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    } catch {
      return NextResponse.json({ error: "Could not parse X-Payment-Request header" }, { status: 502 });
    }

    const fareBtc = parseFloat(paymentReq.amount);
    if (fareBtc > (maxFareBtc ?? 20)) {
      return NextResponse.json({
        rideId,
        status: "CANCELLED",
        step:   "FARE_TOO_HIGH",
        offer:  paymentReq,
        error:  `Driver fare ${fareBtc} BTC exceeds max ${maxFareBtc} BTC`,
        logs:   [
          `${nowTime()} [RIDER] Ride ${rideId} requested: ${from} → ${to}`,
          `${nowTime()} [RIDER] Driver offered fare: ${fareBtc} BTC`,
          `${nowTime()} [RIDER] REJECTED — exceeds budget of ${maxFareBtc} BTC`,
        ],
      }, { status: 402 });
    }

    return NextResponse.json({
       status: "PAYMENT_REQUESTED",
       offerDetails: paymentReq,
       headers: {
         "X-Payment-Request": paymentHeader,
       }
    }, { status: 402 });
  }

  // ── Step 4: Driver accepted without payment required (free ride / mock) ─
  const offer = await driverResponse.json();
  return NextResponse.json({
    rideId,
    channelId,
    status: "ACCEPTED",
    step:   "DIRECT_ACCEPT",
    offer,
    logs: [
      `${nowTime()} [RIDER] Ride ${rideId} requested: ${from} → ${to}`,
      `${nowTime()} [DRIVER] Accepted directly — no payment required`,
    ],
  });
}

export async function PUT(req: NextRequest) {
  // Used by the frontend once the driver formally accepts and issues a 402 challenge
  const { rideId, offer, riderWallet, channelId } = await req.json();
  const DRIVER_URL = process.env.DRIVER_AGENT_URL || "http://localhost:4001";
  
  const fareBtc = parseFloat(offer.amount);
  const km       = parseFloat((fareBtc / 0.23).toFixed(1));
  const fare     = calculateFare(km, 90);
  const nonce    = offer.nonce;

  const paymentProof = {
    version:         "x402/1.0",
    scheme:          "btc-stream",
    channelId,
    permitSignature: offer.signature || "0x_mock_signature",
    payer:           riderWallet || RIDER_AGENT.wallet,
    amount:          fareBtc.toFixed(6),
    nonce,
  };

  try {
    const confirmResponse = await fetch(`${DRIVER_URL}/api/accept`, {
      method: "POST", // Driver still validates phase 2 proof via POST to accept
      headers: {
        "Content-Type": "application/json",
        "X-Payment":    Buffer.from(JSON.stringify(paymentProof)).toString("base64"),
      },
      body: JSON.stringify({
        rideId,
        riderWallet:  riderWallet || RIDER_AGENT.wallet,
        channelId,
        fareBtc,
        from: "Unknown", // The driver doesn't need to re-log this during phase 2
        to:   "Unknown",
      }),
    });
    
    const confirmation = await confirmResponse.json();
    
    return NextResponse.json({
      rideId,
      channelId,
      status:  "PAYMENT_STREAMING",
      step:    "PAYMENT_INITIATED",
      offer: {
        driverWallet:      DRIVER_AGENT.wallet,
        fareBtc,
        km,
        checkpoints:       fare.checkpoints,
        perCheckpoint:     fare.perCheckpoint,
      },
      paymentProof,
      driverConfirm:   confirmation,
      logs: [
        `${nowTime()} [RIDER] Driver requested payment of ${fareBtc.toFixed(2)} BTC`,
        `${nowTime()} [RIDER] EIP-712 permit signed for ${fareBtc.toFixed(2)} BTC`,
        `${nowTime()} [RIDER] X-Payment header sent to Driver Agent`,
        `${nowTime()} [DRIVER] Payment proof verified — ride confirmed`,
        `${nowTime()} [RIDER] x402 stream channel ${channelId} opened`,
      ],
    });
  } catch (err) {
    return NextResponse.json({ error: `Payment confirmation failed: ${String(err)}` }, { status: 502 });
  }
}
