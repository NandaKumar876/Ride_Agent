# RideAgent — Full Agent-to-Agent Payment System

Two autonomous Next.js agents that negotiate rides and settle payments via the **x402 micropayment protocol** and **ERC-8004 on-chain reputation**.

```
RiderAgent (port 3000)  ←→  DriverAgent (port 3001)
        ↓ POST /api/accept
        ← HTTP 402  (X-Payment-Request header)
        ↓ POST /api/accept + X-Payment header
        ← 200 Confirmed
        ↓ POST /api/webhook  (every 100m checkpoint)
        ← ACK  (+BTC received)
        ... repeat until ride complete ...
        ← Channel settled, ERC-8004 scores updated
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp apps/rider-agent/.env.example  apps/rider-agent/.env.local
cp apps/driver-agent/.env.example apps/driver-agent/.env.local
# Edit both files with your keys
```

### 3. Run both agents simultaneously
```bash
npm run dev
# Rider → http://localhost:3000
# Driver → http://localhost:3001
```

Or run them separately:
```bash
npm run rider    # port 3000
npm run driver   # port 3001
```

---

## How It Works

### The x402 Payment Flow

| Step | Who  | Action |
|------|------|--------|
| 1    | Rider | `POST /api/accept` → Driver with ride details |
| 2    | Driver | Returns **HTTP 402** + `X-Payment-Request` header (base64 JSON with fare, nonce, contract address) |
| 3    | Rider | Evaluates fare vs budget. If OK → signs **EIP-712 BTC permit** |
| 4    | Rider | `POST /api/accept` again with `X-Payment` header (base64 permit proof) |
| 5    | Driver | Verifies permit → confirms ride |
| 6    | Rider | Opens payment channel, calls `POST /api/pay` with `action: "checkpoint"` every 100m |
| 7    | Rider | Each checkpoint POSTs to Driver's `POST /api/webhook` |
| 8    | Driver | Receives BTC per checkpoint, updates earnings ledger |
| 9    | Both  | On completion: channel settled, ERC-8004 reputation scores updated on-chain |

### Project Structure

```
rideagent-full/
├── package.json                  ← npm workspaces root
│
├── packages/
│   └── shared/src/index.ts       ← Types, fare calc, x402 helpers, contract ABIs
│
├── apps/
│   ├── rider-agent/              ← Next.js on port 3000
│   │   └── app/
│   │       ├── page.tsx          ← Ride request UI + protocol visualiser + logs
│   │       └── api/
│   │           ├── request-ride/route.ts  ← Orchestrates full ride request + 402 flow
│   │           ├── pay/route.ts           ← Manages payment channel + checkpoints
│   │           └── status/route.ts        ← Agent health endpoint
│   │
│   └── driver-agent/             ← Next.js on port 3001
│       └── app/
│           ├── page.tsx          ← Live ride dashboard + earnings ledger + logs
│           └── api/
│               ├── accept/route.ts   ← Returns 402 or confirms on payment proof
│               └── webhook/route.ts  ← Receives checkpoint payments from Rider
```

---

## API Reference

### Rider Agent (port 3000)

| Method | Path               | Description |
|--------|--------------------|-------------|
| POST   | `/api/request-ride`| Full ride request flow (handles 402 automatically) |
| POST   | `/api/pay`         | Open / release checkpoint / settle channel |
| GET    | `/api/pay`         | List all payment channels |
| GET    | `/api/status`      | Agent health + identity |

**POST /api/request-ride**
```json
{
  "from": "Marina Bay Sands",
  "to": "Changi Airport T3",
  "maxFareBtc": 10,
  "minDriverRep": 60
}
```

**POST /api/pay**
```json
{
  "channelId": "CH-ABC123",
  "rideId": "RIDE-...",
  "fareBtc": 4.60,
  "km": 20,
  "action": "open" | "checkpoint" | "settle"
}
```

---

### Driver Agent (port 3001)

| Method | Path           | Description |
|--------|----------------|-------------|
| POST   | `/api/accept`  | Receive ride request → return 402, or verify payment |
| GET    | `/api/accept`  | List all rides |
| POST   | `/api/webhook` | Receive checkpoint payment release |
| GET    | `/api/webhook` | Payment ledger + summary |

**POST /api/accept** (initial request — no X-Payment header)  
Returns HTTP 402 with headers:
```
X-Payment-Request: <base64 JSON>
X-Payment-Amount: 4.600000
X-Payment-Nonce: 1234567-abc
X-Driver-Wallet: 0xd3f2...
X-Driver-Rep: 96.1
```

**POST /api/accept** (with X-Payment header)  
```
X-Payment: <base64 JSON permit proof>
```
Returns 200 with ride confirmation.

---

## Agent Identities

| Agent       | Wallet                                       | ERC-8004 Token | Port |
|-------------|----------------------------------------------|----------------|------|
| RiderAgent  | 0x991a4040D036B487aeb9842583fC73F5665EDFC5   | #234           | 3000 |
| DriverAgent | 0xd3f2aB4C91e5F3A08bD7c2E9f1234567890abcDE  | #235           | 3001 |

## Smart Contracts (GOAT testnet3)

| Contract      | Address |
|---------------|---------|
| ERC-8004      | 0x89e7dfd01a86e5393ce6d8A78c9aa6653Ee113A6 |
| BTC          | 0xfe41e7e5cB3460c483AB2A38eb605Cda9e2d248E |
| PaymentStream | 0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa |

## To connect real on-chain payments

1. Replace the `permitSignature` placeholder in `rider-agent/app/api/request-ride/route.ts` with a real `ethers.Wallet.signTypedData()` call using `RIDER_PRIVATE_KEY`
2. Uncomment the `verifyPermit()` call in `driver-agent/app/api/accept/route.ts`
3. Replace simulated `txHash` values in `/api/pay` with real `PaymentStream.releaseCheckpoint()` transactions

## Tech Stack

Next.js 14 · React 18 · TypeScript · Tailwind CSS · ethers v6 · npm workspaces
