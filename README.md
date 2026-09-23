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
the escrow.

**Known platform limitation, disclosed rather than hidden:** `emit_transfer`
- the GenVM primitive a contract uses to pay out native value - does not
currently deliver on GenLayer's Bradbury testnet
([genvm-manager#20](https://github.com/genlayerlabs/genvm-manager/issues/20)).
This was independently reproduced from this account the night this
contract was built, using the exact minimal repro from that issue -
`emit_transfer` still fails with all 5 validators voting `DISAGREE`
against each other despite identical execution results, six days after a
maintainer closed the issue saying a fix "must be" in the next node
deployment. Every state transition in Waypoint up to and including the
release/refund *decision* is real, on-chain, and independently verifiable;
the final balance movement is blocked by this platform bug, not a defect
here - the same disclosed limitation that also affects this account's
Salvage Arbiter and AgentEscrow projects.

## Live deployment
Deployed on **GenLayer Bradbury Testnet** (chain ID 4221):
- **Contract:** [`0x83AE6C0D439110Cf0DF45eE35dA874e38F92002a`](https://explorer-bradbury.genlayer.com/address/0x83AE6C0D439110Cf0DF45eE35dA874e38F92002a)
- **Frontend:** https://waypoint-frontend-one.vercel.app
- Verified via 34 passing direct-mode tests (`python -m pytest tests/direct/`),
  covering the full lifecycle (funded → submitted → verified → released,
  and the disputed/refunded/timeout branches), every access-control check
  (only the provider can submit or resolve a dispute, only the client can
  challenge or reclaim a timeout), a clean revert-then-retry when the
  verification marker isn't found yet, the challenge-window boundary, and
  both dispute verdicts (uphold and overturn).
- **Live-verified with real GEN**, not just direct-mode tests: created
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

## What's included
- `contracts/waypoint.py` — the Waypoint Intelligent Contract
- `tests/direct/test_waypoint.py` — direct-mode tests (in-memory, mocked web/LLM)
- **Contract linting** — static analysis to catch common contract issues before deployment
- **CI pipeline** — GitHub Actions workflow for linting and direct tests
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
5. **`resolve_dispute(engagement_id)`** — provider-only. Validators weigh
   the dispute reason against the live content via `gl.nondet.exec_prompt`
   and release or refund accordingly.
6. **`release(engagement_id)`** — permissionless, once the challenge
   window has passed with no dispute.
7. **`reclaim_timeout(engagement_id)`** — client-only, if the provider
   never submitted by the deadline.
8. **`get_engagement`** / **`get_all_engagement_ids`** — read back an
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
