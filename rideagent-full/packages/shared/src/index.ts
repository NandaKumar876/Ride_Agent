import { ethers } from "ethers";

// ─────────────────────────────────────────────
//  CHAIN & CONTRACT CONFIG
// ─────────────────────────────────────────────

export const CHAIN = {
  id:       2345,
  name:     "GOAT testnet3",
  rpcUrl:   "https://rpc.testnet3.goat.network",
  explorer: "https://explorer.testnet3.goat.network",
} as const;

export const CONTRACTS = {
  ERC8004:       "0x89e7dfd01a86e5393ce6d8A78c9aa6653Ee113A6",
  BTC:          "0xfe41e7e5cB3460c483AB2A38eb605Cda9e2d248E",
  PaymentStream: "0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa",
} as const;

export const RIDER_AGENT = {
  name:       "RiderAgent",
  merchantId: "rider_nanda",
  wallet:     process.env.RIDER_WALLET || "0x991a4040D036B487aeb9842583fC73F5665EDFC5",
  tokenId:    234,
  port:       4000,
} as const;

export const DRIVER_AGENT = {
  name:       "DriverAgent",
  merchantId: "driver_nanda",
  wallet:     process.env.DRIVER_WALLET || "0xd3f2aB4C91e5F3A08bD7c2E9f1234567890abcDE",
  tokenId:    235,
  port:       4001,
} as const;

// ─────────────────────────────────────────────
//  SHARED TYPES
// ─────────────────────────────────────────────

export type RideStatus =
  | "REQUESTED"
  | "ACCEPTED"
  | "PAYMENT_PENDING"
  | "PAYMENT_STREAMING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface RideRequest {
  rideId:       string;
  riderWallet:  string;
  from:         string;
  to:           string;
  maxFareBtc:  number;
  minDriverRep: number;
  timestamp:    number;
}

export interface RideOffer {
  rideId:            string;
  driverWallet:      string;
  driverRep:         number;
  estimatedKm:       number;
  estimatedFareBtc: number;
  ratePerKm:         number;
  eta:               number; // minutes
  timestamp:         number;
}

export interface PaymentChannel {
  channelId:        string;
  rideId:           string;
  riderWallet:      string;
  driverWallet:     string;
  totalBtc:        number;
  streamedBtc:     number;
  checkpoint:       number;
  totalCheckpoints: number;
  status:           "open" | "streaming" | "settled" | "failed";
}

export interface AgentMessage {
  type:      "RIDE_REQUEST" | "RIDE_OFFER" | "RIDE_ACCEPT" | "PAYMENT_INIT" |
             "PAYMENT_CHECKPOINT" | "RIDE_COMPLETE" | "RIDE_CANCEL" | "REP_UPDATE";
  from:      string; // wallet address
  to:        string;
  payload:   unknown;
  signature: string;
  timestamp: number;
}

export interface ReputationScore {
  wallet:             string;
  tokenId:            number;
  score:              number;
  completionRate:     number;
  onTimeRate:         number;
  paymentSuccessRate: number;
  totalRides:         number;
}

// ─────────────────────────────────────────────
//  x402 PAYMENT PROTOCOL
// ─────────────────────────────────────────────

/**
 * x402 Payment Request — sent in HTTP 402 response headers by the driver agent.
 * The rider agent reads this and initiates a BTC stream.
 */
export interface X402PaymentRequest {
  version:       "x402/1.0";
  scheme:        "btc-stream";
  network:       string;
  recipient:     string;  // driver wallet
  amount:        string;  // total in BTC (decimal string)
  ratePerUnit:   string;  // BTC per km
  unit:          "km";
  contract:      string;  // PaymentStream contract address
  nonce:         string;
  expiresAt:     number;
}

/**
 * x402 Payment Response — sent by rider agent after signing the permit.
 * Goes in the `X-Payment` request header on subsequent calls.
 */
export interface X402PaymentProof {
  version:         "x402/1.0";
  scheme:          "btc-stream";
  channelId:       string;
  permitSignature: string; // EIP-712
  payer:           string;
  amount:          string;
  nonce:           string;
}

/** Build a 402 Payment Required header value */
export function buildPaymentRequest(
  driverWallet: string,
  totalBtc: number,
  ratePerKm: number,
  nonce: string
): X402PaymentRequest {
  return {
    version:     "x402/1.0",
    scheme:      "btc-stream",
    network:     `eip155:${CHAIN.id}`,
    recipient:   driverWallet,
    amount:      totalBtc.toFixed(6),
    ratePerUnit: ratePerKm.toFixed(6),
    unit:        "km",
    contract:    CONTRACTS.PaymentStream,
    nonce,
    expiresAt:   Math.floor(Date.now() / 1000) + 3600,
  };
}

/** Encode payment request to base64 header value */
export function encodePaymentRequest(req: X402PaymentRequest): string {
  return Buffer.from(JSON.stringify(req)).toString("base64");
}

/** Decode base64 payment request header */
export function decodePaymentRequest(encoded: string): X402PaymentRequest {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}

// ─────────────────────────────────────────────
//  EIP-712 PERMIT HELPERS
// ─────────────────────────────────────────────

export const BTC_PERMIT_TYPES = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function btcToBigInt(amount: number): bigint {
  return ethers.parseUnits(amount.toFixed(12), 18);
}

export function bigIntToBtc(raw: bigint): string {
  return ethers.formatUnits(raw, 18);
}

// ─────────────────────────────────────────────
//  FARE CALCULATION
// ─────────────────────────────────────────────

export const RATE_PER_KM   = 0.23;  // BTC per km base rate
export const PLATFORM_FEE  = 0.03;  // 3% platform fee
export const CHECKPOINT_KM = 0.1;   // release payment every 100m

export function calculateFare(km: number, repScore: number): {
  base: number;
  fee: number;
  total: number;
  checkpoints: number;
  perCheckpoint: number;
} {
  // Rep discount: premium drivers (>=90) get +10% rate
  const repMultiplier = repScore >= 90 ? 1.1 : repScore >= 70 ? 1.0 : 0.9;
  const base          = km * RATE_PER_KM * repMultiplier;
  const fee           = base * PLATFORM_FEE;
  const total         = base + fee;
  const checkpoints   = Math.ceil(km / CHECKPOINT_KM);
  const perCheckpoint = total / checkpoints;
  return {
    base:          parseFloat(base.toFixed(4)),
    fee:           parseFloat(fee.toFixed(4)),
    total:         parseFloat(total.toFixed(4)),
    checkpoints,
    perCheckpoint: parseFloat(perCheckpoint.toFixed(6)),
  };
}

// ─────────────────────────────────────────────
//  ID GENERATORS
// ─────────────────────────────────────────────

export function generateRideId(): string {
  return `RIDE-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

export function generateChannelId(): string {
  return `CH-${Math.random().toString(16).slice(2, 18).toUpperCase()}`;
}

export function nowTime(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");
}
