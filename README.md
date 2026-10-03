# Waypoint
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/license/mit/)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/8Jm4v89VAu)
[![Telegram](https://img.shields.io/badge/Telegram--T.svg?style=social&logo=telegram)](https://t.me/genlayer)
[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/yeagerai.svg?style=social&label=Follow%20%40GenLayer)](https://x.com/GenLayer)

## About
Waypoint is a **verified milestone escrow** - a GenLayer Intelligent
Contract where a client funds real GEN against a deliverable, and GenVM
validators independently confirm the work before the money moves, only
escalating to reasoned judgment when a client genuinely disputes the
result.

`create_engagement(engagement_id, provider, deliverable_description, verification_url, verification_marker, deadline)`
is a payable call: the client escrows the agreed amount and locks in a
`verification_url` and `verification_marker` they expect to find there
once the work is done. `submit(engagement_id)` lets the provider mark the
deliverable ready. `verify(engagement_id)` - the common path - is fully
deterministic: validators independently fetch `verification_url` and check
whether `verification_marker` is present in the response, with **no LLM
involved**. That's enough to prove a deliverable is genuinely live - the
page is deployed, the PR shows "Merged", the API reports
`status: complete` - without trusting either party's word for it.

A deterministic pass isn't the same as a deliverable being *right*, so the
client has a 10-minute window after verification to `challenge` it with a
reason. Only a genuine dispute escalates to `gl.nondet.exec_prompt` -
validators re-fetch the live content and weigh the client's specific
objection against it, and only the verdict (`uphold`/`overturn`) is
consensus-critical; the reasoning text is informational. If nobody
disputes within the window, `release()` pays the provider. If the provider
never submits by the deadline, `reclaim_timeout()` lets the client recover
the escrow - and `reclaim_stale()` covers the two states that can
otherwise strand the escrow forever: submitted but never verified, or
disputed with nobody willing to trigger resolution (which is itself now
permissionless, not provider-only, for the same reason).

**Payouts and refunds go through `gl.evm.contract_interface` (`Payee`),
not `gl.get_contract_at()`.** Clients and providers are EOAs (plain
wallets), and `gl.get_contract_at(addr).emit_transfer(...)` is an internal
Intelligent-Contract dispatch message - for an address holding no
contract code, that message is resolved by a handler that doesn't
reliably reach validator majority, so the payout can leave this contract
and be credited to nobody, intermittently and unpredictably.
`gl.evm.contract_interface` instead emits a genuine external chain-layer
value transfer (`EthSend` with empty calldata) - the SDK's documented
primitive for paying an EOA. This was flagged directly by a GenLayer
steward reviewing this project; previously this repo (like several others
on this account) mischaracterized the resulting intermittent failures as
an unconfirmed platform bug in
[genvm-manager#20](https://github.com/genlayerlabs/genvm-manager/issues/20)
rather than what it actually was: the wrong transfer primitive for the
recipient type.

## Live deployment
Deployed on **GenLayer Bradbury Testnet** (chain ID 4221):
- **Contract:** [`0xF9C9CC08826E464a5Dd177B739e1E7054CA43Aa1`](https://explorer-bradbury.genlayer.com/address/0xF9C9CC08826E464a5Dd177B739e1E7054CA43Aa1)
- **Frontend:** https://waypoint-frontend-one.vercel.app
- Verified via 50 passing direct-mode tests (`python -m pytest tests/direct/`),
  covering the full lifecycle (funded → submitted → verified → released,
  and the disputed/refunded/timeout branches), every access-control check
  (only the provider can submit, only the client can challenge or
  reclaim), a clean revert-then-retry when the verification marker isn't
  found yet, the challenge-window boundary, both dispute verdicts (uphold
  and overturn), `resolve_dispute`'s new permissionless access,
  `reclaim_stale`'s recovery paths (stuck-submitted, stuck-disputed,
  too-early, non-client caller, already-healthy engagement), a failed/
  unreachable adjudication reverting cleanly instead of defaulting to
  either verdict, and the dispute prompt genuinely wrapping untrusted
  input in isolating tags (verified by requiring those tags in the mock
  match pattern itself, not just asserting on the output).
- **Live-verified with real GEN (previous deployment,
  `0x83AE6C0D439110Cf0DF45eE35dA874e38F92002a`, superseded by the address
  above after the `Payee` fix and other steward-requested changes)**: created
  three real engagements funded with genuine escrowed value.
  - `wp-live-1` deliberately proved the safety property rather than just
    the happy path: `verify()` correctly reverted when the chosen marker
    phrase turned out to wrap across a line break in the actual rendered
    document (so the literal substring wasn't present) - the engagement
    stayed cleanly at `submitted`, exactly the re-callable revert behavior
    the direct-mode tests already cover, now confirmed against a real
    fetch of a real URL.
  - `wp-live-2` and `wp-live-3` both reached `create_engagement` →
    `submit` → `verify` → `challenge` cleanly (5/5 validator agreement on
    every deterministic step). `resolve_dispute`'s LLM step, however, hit
    genuine `DETERMINISTIC_VIOLATION`s on both - five consecutive attempts
    across two different dispute scenarios (one deliberately ambiguous,
    one deliberately factual and clear-cut) all failed to reach validator
    consensus on the verdict, with contract state safely unchanged after
    every failed attempt (still `disputed`, re-resolvable). This lines up
    with the same Bradbury render/LLM-path degradation independently
    observed against Summit (a sibling project on this account) the same
    night - not specific to this contract's prompt design, since it
    reproduced on both an ambiguous and an unambiguous dispute equally.
    The deterministic majority of Waypoint's surface (everything except
    the dispute-escalation path) is fully proven live end-to-end.

### Second steward round: payout reconciliation and dispute-reason floor
A later steward pass found the `Payee` fix alone insufficient: every
payout site treated a silent `emit_transfer` as delivery with no way back
if it failed to land, and `challenge()` accepted any non-empty reason,
down to a single trivial word, for a dispute that then escalates to real
LLM adjudication. Fixed with one shared `_payout()` helper that records
the owed amount in `pending_payouts` before every `release`/
`reclaim_timeout`/`resolve_dispute`/`reclaim_stale` payout, plus a single
`retry_payout(engagement_id)` that re-attempts delivery to whichever
status (`released`/`refunded`) the engagement already settled at; and by
adding `MIN_DISPUTE_REASON_LENGTH` (20 characters) alongside the existing
maximum.

### Third steward round: a real fund-safety bug in the retry itself
This fix was still wrong: `pending_payouts` was never cleared after a
successful delivery, so a provider/client whose payout actually landed
could call `retry_payout` again anyway, firing a second real transfer of
the same amount and consuming GEN owed to other engagements - an
unbounded drain, not a rare edge case, and the steward caught it
correctly. Fixed with a `pending_floor` snapshot: the recipient's balance
is recorded right before the first attempt, and `retry_payout` now reads
the recipient's *current* balance and compares it against `floor +
amount` - if the payout already landed, it clears `pending_payouts` and
refuses instead of re-sending. `test_retry_payout_blocked_once_balance_
confirms_delivery` proves this directly (simulates delivery via the
direct-mode harness's `deal()`, confirms retry refuses and the record is
actually cleared, not just blocked once). 50 tests pass, lint clean.
Redeployed: `0xF9C9CC08826E464a5Dd177B739e1E7054CA43Aa1`.

A real end-to-end `create_engagement → submit → verify → release` cycle
against the current address, isolating whether `Payee`'s payout is
*reliable* rather than merely possible, needs a payable transaction - the
bare `genlayer write` CLI has no flag for attaching native value to a
call at all (`--fee-value` is the consensus fee deposit, not the call's
value). A ready-to-run script (`verify-payee-live.mjs`, `genlayer-js`
with real `value:`) is included in this repo for whoever holds the
deployer key to run directly.

## What's included
- `contracts/waypoint.py` — the Waypoint Intelligent Contract
- `tests/direct/test_waypoint.py` — direct-mode tests (in-memory, mocked web/LLM)
- **Contract linting** — static analysis to catch common contract issues before deployment
- **CI pipeline** — GitHub Actions workflow for linting and direct tests
- `verify-payee-live.mjs` — a real end-to-end script proving the `Payee`
  payout mechanism delivers value, for whoever holds the deployer key
- A Next.js 16 frontend (TypeScript, TanStack Query, Radix UI) — a
  survey-benchmark themed dashboard: a cairn-marked trail visualizing each
  engagement's real on-chain lifecycle, a live challenge-window countdown,
  and a "Field Registration" wallet-connect sequence
- Configuration file template and deployment scripts

## Requirements
- Python >= 3.12
- [GenLayer CLI](https://github.com/genlayerlabs/genlayer-cli) globally installed: `npm install -g genlayer`
- GenLayer Studio (for integration tests and deployment): Install from [Docs](https://docs.genlayer.com/developers/intelligent-contracts/tooling-setup#using-the-genlayer-studio) or use the hosted [GenLayer Studio](https://studio.genlayer.com/)

## Project Structure

```
contracts/              # Python intelligent contracts
  waypoint.py              # Waypoint
tests/
  direct/                 # Fast in-memory tests (no Studio required)
    test_waypoint.py
frontend/                # Next.js 16 app (TypeScript, TanStack Query, Radix UI)
deploy/                  # TypeScript deployment scripts
gltest.config.yaml       # Test runner network configuration
pyproject.toml           # Python/pytest configuration
.github/workflows/       # CI pipeline
```

## Quick Start

### 1. Set up Python environment

```shell
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Lint the contract

```shell
genvm-lint check contracts/waypoint.py
```

### 3. Run direct mode tests

```shell
python -m pytest tests/direct/ -v
```

Use `python -m pytest`, not bare `pytest` - depending on your installed
pytest version, running the bare command can fail to put the project
root on `sys.path`, breaking test discovery with
`ModuleNotFoundError: No module named 'tests'`.

### 4. Deploy the contract

1. Choose your network: `genlayer network`
2. Deploy: `genlayer deploy` (runs the script in `/deploy/deployScript.ts`)

### 5. Set up the frontend

1. Copy `frontend/.env.example` to `frontend/.env`
2. Add your deployed contract address as `NEXT_PUBLIC_CONTRACT_ADDRESS`
3. Run:

```shell
cd frontend
npm install
npm run dev
```

The app will be available at http://localhost:3000/.

## How Waypoint Works

1. **`create_engagement(...)`** — payable. The client escrows GEN and
   locks in the deliverable, verification URL, and marker.
2. **`submit(engagement_id)`** — provider-only, marks the deliverable
   ready for verification.
3. **`verify(engagement_id)`** — permissionless, deterministic. Reverts
   cleanly (re-callable) if the marker isn't found yet.
4. **`challenge(engagement_id, reason)`** — client-only, within a
   10-minute window after verification.
5. **`resolve_dispute(engagement_id)`** — permissionless (not
   provider-only): an uncooperative provider can't strand a disputed
   engagement forever. Validators weigh the dispute reason against the
   live content via `gl.nondet.exec_prompt` and release or refund
   accordingly.
6. **`release(engagement_id)`** — permissionless, once the challenge
   window has passed with no dispute.
7. **`reclaim_timeout(engagement_id)`** — client-only, if the provider
   never submitted by the deadline.
8. **`reclaim_stale(engagement_id)`** — client-only recovery for an
   engagement stuck 24 hours past deadline and still `submitted` (the
   marker never appeared), or past `disputed_at` and still `disputed`
   (adjudication never reached a clear verdict).
9. **`get_engagement`** / **`get_all_engagement_ids`** — read back an
   engagement's full state, or enumerate every engagement on the contract.

## Testing Strategy

| Test Type | Command | Speed | Requires Studio |
|-----------|---------|-------|-----------------|
| **Lint** | `genvm-lint check contracts/waypoint.py` | ~250ms | No |
| **Direct** | `python -m pytest tests/direct/ -v` | ~ms/test | No |

## Community
- **[Discord](https://discord.gg/8Jm4v89VAu)**: Discussions, support, and announcements
- **[Telegram](https://t.me/genlayer)**: Informal chats and quick updates

## Documentation
For detailed information, see our [documentation](https://docs.genlayer.com/).

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
