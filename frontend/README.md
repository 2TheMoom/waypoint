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
  against a deliverable, a public https verification URL, a **whole-line**
  marker, an optional reject marker, a challenge window and a recovery time.
  The form checks the URL and markers with the contract's own rules and shows
  the exact bond a challenge will post.
- **Accept / Submit**: the provider accepts the terms before work starts, then
  marks the deliverable ready. Until it accepts, the client can cancel.
- **Verify**: permissionless. Validators fetch the page and must agree the
  marker is a whole line and on the lines around it. That excerpt and its
  sha256 are shown on the engagement as the committed evidence.
- **Challenge / Resolve Dispute**: the client disputes inside the challenge
  window (1 hour to 7 days) by posting a bond of exactly 10% of the escrow.
  Anyone can resolve the dispute; reviewers weigh the objection against the
  committed excerpt and the page as it reads now, and an unclear answer
  changes nothing. Resolving only records the verdict (upheld or overturned);
  **Settle**, which anyone can send, pays it in a separate transaction.
- **Release / Reclaim**: pay the provider once the window closes, or let the
  client reclaim an unaccepted proposal, or an accepted one that missed its
  deadline.
- **Recover stuck engagements**: after the engagement's recovery time, a stuck
  submission is refunded to the client (client only) and a stuck dispute is
  split evenly with the bond going to the provider (any connected account).
- **Honest transaction status**: a write shows signed, sent, accepted, then
  *state confirmed* once the engagement reads back changed. Fund-moving writes
  keep watching until the transaction is FINALIZED (about 30 minutes on
  Bradbury), because that is when the transfer lands.
- **Trail visualization**: every engagement's real on-chain lifecycle
  rendered as a cairn-marked trail, plus a log of every engagement on the
  contract
