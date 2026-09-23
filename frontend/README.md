# Waypoint Frontend

Next.js frontend for Waypoint - a verified milestone escrow on GenLayer.
Reads and writes the deployed `Waypoint` contract on **GenLayer Bradbury
Testnet** (chain ID 4221).

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` file:

```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
   - `NEXT_PUBLIC_CONTRACT_ADDRESS` - your deployed Waypoint contract address
   - `NEXT_PUBLIC_GENLAYER_RPC_URL` - Bradbury RPC (default: `https://rpc-bradbury.genlayer.com`)
   - `NEXT_PUBLIC_GENLAYER_CHAIN_ID` - must stay `4221` (Bradbury), consistent with the RPC URL above

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Build

```bash
npm run build
npm start
```

## Tech Stack

- **Next.js 16** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS v4** - Styling
- **genlayer-js** - GenLayer blockchain SDK
- **TanStack Query (React Query)** - Data fetching and caching
- **Radix UI** - Accessible component primitives

## Wallet

Connects via MetaMask (or any injected EIP-1193 provider) and prompts the
user to add/switch to the GenLayer Bradbury Testnet if needed. No private
keys are ever generated, imported, or stored by this app. The connect flow
is framed as a "Field Registration" sequence (instrument detected, datum
check, sight taken, mark set) matching the app's survey-benchmark theme,
rather than a generic modal dialog.

## Features

- **Fund an engagement**: `create_engagement(...)` escrows real GEN
  against a deliverable, a verification URL, and a marker string
- **Submit**: the provider marks a deliverable ready for verification
- **Verify**: permissionless, deterministic - validators independently
  confirm the marker is present at the verification URL, no LLM
- **Challenge / Resolve Dispute**: the client can dispute a verified
  result within a 10-minute window; validators weigh the dispute against
  the live content via reasoned judgment only when genuinely escalated
- **Release / Reclaim**: pay the provider once the challenge window
  passes, or let the client reclaim the escrow if the provider never
  submitted by the deadline
- **Trail visualization**: every engagement's real on-chain lifecycle
  rendered as a cairn-marked trail, plus a log of every engagement on the
  contract
