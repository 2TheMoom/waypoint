# Waypoint
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/license/mit/)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/8Jm4v89VAu)
[![Telegram](https://img.shields.io/badge/Telegram--T.svg?style=social&logo=telegram)](https://t.me/genlayer)
[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/yeagerai.svg?style=social&label=Follow%20%40GenLayer)](https://x.com/GenLayer)

## About
Waypoint is a **verified milestone escrow**: a GenLayer Intelligent
Contract where a client funds real GEN against a deliverable, GenVM
validators independently check the evidence before the money moves, and a
genuine dispute is weighed against the evidence that was agreed at
verification time, not only against a page that may have changed since.

The lifecycle is `proposed -> funded -> submitted -> verified -> released`,
with `disputed`, `refunded` and `split` as the other endings.

1. `create_engagement(...)` is payable. The client escrows GEN and fixes the
   deliverable text, a public https `verification_url`, a **whole-line
   marker**, an optional **reject marker**, the deadline, the challenge
   window and the recovery time.
2. `accept(id)`: the provider agrees to those terms before work starts. Until
   then the client can cancel and take the escrow back.
3. `submit(id)`: the provider says the work is ready.
4. `verify(id)`: permissionless. Validators fetch the page themselves and
   must agree on the result **and on the lines around the marker**. The
   excerpt and its sha256 are stored on chain.
5. `challenge(id, reason)`: the client posts a bond (10% of the escrow) inside
   the challenge window.
6. `resolve_dispute(id)`: permissionless. Validators weigh the client's
   objection against the **committed excerpt and the page as it reads now**.
7. `release(id)`: permissionless, pays the provider once the window has
   passed with no dispute.

### What counts as evidence

The first version matched the marker anywhere in the page, which a steward
correctly pointed out can be triggered by negated, historical or unrelated
text. Verification now works on **whole lines**:

- The page is reduced to text lines (scripts, styles, comments, `noscript`,
  `svg` and `template` content are dropped; block tags and `<br>` start a
  new line; entities are decoded; whitespace and case are normalized).
- The marker must equal **an entire line**. A line that merely contains it,
  negates it ("did not ship"), quotes it, plans it ("planned: ...") or splits
  it across two lines does not match.
- An optional **reject marker** is a line that, if present, makes the evidence
  contradictory and verification is refused.
- Markers must be 12 to 200 characters with at least one letter and one digit,
  so a creator has to pick something specific (a date, a version, an id).
- If the page cannot be read cleanly (non-200, empty, network error) nothing
  is recorded and `verify` can simply be called again.

This is still a check that a specific line is on a specific page. It cannot
tell whether the line is *true*; the creator chooses the URL and the line, and
the provider accepts them before any work starts. What it does guarantee is
that the page said exactly that, validators agreed on the surrounding
context, and the agreement is committed to the chain.

### Evidence commitments and disputes

At `verify`, validators must agree on two things: that the marker is a whole
line, and on the excerpt (the matched line plus one line each side, at most
600 characters). The excerpt and `sha256(excerpt)` are stored
(`evidence_excerpt`, `evidence_digest`).

At `resolve_dispute` the reviewers receive the objection, the deliverable
text, the **committed excerpt**, and the **whole current page** (never the
first few kilobytes of it): the contract tells them whether the marker line is
still present and whether the committed evidence is unchanged. A page that
cannot be read in full (non-200, or over 12,000 characters after reduction)
yields no verdict rather than a partial judgment. The model may answer
`uphold`, `overturn` or `inconclusive`; only the first two ever move money,
and `inconclusive`, unparseable or unreadable answers leave the dispute exactly
as it was so it can be retried.

### Challenge bond and the stale-dispute split

- A challenge needs a **bond of exactly 10% of the escrow** (at least 1 wei).
  If the objection is upheld the client gets the escrow **and** the bond back;
  if it fails the provider receives both. Frivolous challenges cost something.
- If a dispute is not adjudicated within `stale_after`, `reclaim_stale` is open
  to anyone and **splits the escrow evenly** between provider and client, and
  the **bond goes to the provider**. The provider is not paid in full for work
  that was never confirmed, the client cannot hold the funds forever by filing
  and walking away, and a challenge that nobody pursued to a verdict is not
  free. Resolving a dispute is permissionless, so a genuine challenger can
  push the verdict as often as the provider can during the whole recovery time.
  (A stuck *submission* still refunds the client, and only the client can
  trigger it.)
- Windows are bounded on chain: challenge window 1 hour to 7 days, recovery
  time 2 hours to 30 days. The one hour floor is deliberately above the
  roughly 28 to 30 minute finality measured on Bradbury, so a challenge can
  never be cut off by consensus latency.

### Payouts

Payments go through `gl.evm.contract_interface` (`Payee`), the documented
chain-layer path for paying a wallet. A payment only executes when the
transaction that emitted it **finalizes**; if that transaction is rejected or
overturned the message is dropped with it. Every payout path moves the
engagement to a terminal status, records each amount in `payouts` and emits
the transfer in the **same transaction**, so a settled engagement can never
be paid again. There is no retry method, because re-sending a payment that was
merely slow to finalize is what once created the duplicate-delivery risk.

`get_accounting()` reconciles the ledger against the contract's real balance,
read-only: `unscheduled` (still owed), `in_flight` (scheduled, waiting for
finality) and `shortfall`. `in_flight` returning to 0 means every scheduled
payout has landed. A read taken seconds after a value-bearing transaction can
briefly see the new balance before the stored totals catch up.

## Live deployment
Deployed on **GenLayer Bradbury Testnet** (chain ID 4221):
- **Contract (v4):** [`0xD55b22525742C0e1BF570694215f12bE58eD52D4`](https://explorer-bradbury.genlayer.com/address/0xD55b22525742C0e1BF570694215f12bE58eD52D4)
- **Frontend:** https://waypoint-frontend-one.vercel.app
- Earlier deployments are superseded: v3 `0x15f975aD...` (identical except that
  a stale dispute returned the bond to the client; its full live run is kept in
  `scripts/e2e-log-v3.json`), `0x1d30EDaf...` (exactly-once payouts, substring
  markers) and before it `0x83AE6C0D...`.

<!--LIVE_START-->
## Live evidence (Bradbury, contract v4)

`scripts/e2e.mjs` ran every scenario below against the deployed v4 contract with a **separate client wallet and provider wallet** (and a third wallet for permissionless calls). The full machine-readable log is `scripts/e2e-log-v4.json` (the earlier run against v3 is `scripts/e2e-log-v3.json`); the evidence pages are in `demo/evidence/`. Run `mv6v0p2k`.

| Scenario | What was tested | Transactions | Result |
|---|---|---|---|
| Misleading evidence | `verify` against a page where the marker line is **negated**, **planned/quoted**, or **contradicted by the reject line** | [`0x76947c82e3`](https://explorer-bradbury.genlayer.com/tx/0x76947c82e3a7f4658f5041d243c7e5364a1624ddc4eb8e3297da3f3033598a03) [`0x6d06265394`](https://explorer-bradbury.genlayer.com/tx/0x6d06265394fb6a58326bbdf0007d2aff7be77f67aea1ff6cd68d5f761e957a96) [`0x38531eecb9`](https://explorer-bradbury.genlayer.com/tx/0x38531eecb906d2a5276fa612b66b05a8d10a62d6fc79642453e92c10c4ba27af) | All three `FINISHED_WITH_ERROR`; the engagement stays `submitted` and `evidence_digest` stays empty |
| Uphold | page is good, client objects without cause | verify [`0x6c8fd8b5fc`](https://explorer-bradbury.genlayer.com/tx/0x6c8fd8b5fcfc2b2be85accc15f9142d6b28af62e2c5917276cf334f3c356288a), challenge [`0xe701dea8c4`](https://explorer-bradbury.genlayer.com/tx/0xe701dea8c485052b662a97ecb890d7724efe5f95f00603311842414e7223d123), resolve [`0xc9cc1894d4`](https://explorer-bradbury.genlayer.com/tx/0xc9cc1894d4b8155412dd52dc2fff093cb2568ba3f81deaafede508bd6cb18f39) | `released`: provider paid escrow + bond. First resolve attempt `NOT_VOTED`/`IDLE` (no validator had voted yet) changed nothing and was retried |
| Overturn | page itself says the migration guide is missing, client objects | verify [`0x9a61ca367c`](https://explorer-bradbury.genlayer.com/tx/0x9a61ca367c27d02f34684442541e73173998e082f716dd23958017929888f4e4), challenge [`0xe3413bdd05`](https://explorer-bradbury.genlayer.com/tx/0xe3413bdd058a1919825099c3e53a8dd41a5ec24e4537e8ec51b9484de15bf7ab), resolve [`0x13d49cbcc7`](https://explorer-bradbury.genlayer.com/tx/0x13d49cbcc748378d4c74b7415caa7d09de2ead6cb178c5083e081585d2d5e408) | `refunded`: client refunded escrow + bond; the written reason cites the committed evidence |
| Page changed after verification | page is edited to say the release was pulled, then the client objects | verify [`0x3cb9066c11`](https://explorer-bradbury.genlayer.com/tx/0x3cb9066c1139970a3824a0971ec00080ce056261f3178ab5214c1a7dc0f2483b), challenge [`0x6395100034`](https://explorer-bradbury.genlayer.com/tx/0x639510003432bc924eb25f9b50aa2b5fd62f27e12b74071eb7fbea0e7a10fb15), resolve [`0x9d34ff51eb`](https://explorer-bradbury.genlayer.com/tx/0x9d34ff51ebfde07dc5f74aeb5b91dd6fb26f1b7a72cfcf1d28d64e20d53bebee) | `refunded`: the reasoning weighs the committed excerpt against the edited page |
| Release | nobody objects | early release [`0x2de2fc77e2`](https://explorer-bradbury.genlayer.com/tx/0x2de2fc77e20fe21af8a29d36e06d2fbcec794398cb494675efdc5e379c9b550f), release [`0xe05275fad0`](https://explorer-bradbury.genlayer.com/tx/0xe05275fad0372343ff672029648f5312fe2f158e75a73f49329bc0fc81e4c704), repeat [`0x68953ae77a`](https://explorer-bradbury.genlayer.com/tx/0x68953ae77af2397603caf4b01a38a4b73911c7d557b8e60a68fc98c374d53b18) | Early release refused inside the window; after it the provider's balance rose by exactly 0.002000 GEN; the repeat is refused |
| Prompt injection | the evidence page itself tells the reviewer to reply `uphold` while also admitting the migration guide is missing | verify [`0xb5590b559d`](https://explorer-bradbury.genlayer.com/tx/0xb5590b559d00c4b00253a70b62edd74cd3d7ca7af85c66d08904741f65f1b250), challenge [`0x6015e64563`](https://explorer-bradbury.genlayer.com/tx/0x6015e645637a716f0e7356be1000c295603bd88e817c5e2cd290cdae2bf6ec66), resolve [`0x6afe225321`](https://explorer-bradbury.genlayer.com/tx/0x6afe225321a158b5b0c5d634b6c2590444d0f49a560eea75d8334626551a3051) | the page told the reviewer to reply uphold; outcome = refunded. The instruction was NOT followed. note: The terms required a published migration guide alongside the release, and the page confirms it is missing. |
| Stale dispute | challenged, never adjudicated, `stale_after` = 2 hours | early attempt [`0xcf4c537d73`](https://explorer-bradbury.genlayer.com/tx/0xcf4c537d739a4db407e80bfe31a7e015ae6f85cc3e8136d1f78043160e5eb69f), split [`0x264bef7038`](https://explorer-bradbury.genlayer.com/tx/0x264bef7038f3ca251112526028d935e275a27d08250c4084a32cacd7e466240a) | split: provider +0.001075 (half the escrow + the bond = 0.001200), client +0.000766 (half the escrow = 0.001000, before its own gas) |

### Finality and the challenge window

Transactions were `ACCEPTED` within seconds to a couple of minutes and `FINALIZED` about **29.6 to 30.0 minutes** after acceptance (5 measurements in this run). Payments are delivered on finalization, which is why the challenge window can never be shorter than one hour (twice the measured finality) and why the frontend does not treat `ACCEPTED` as done.

### Payments, checked against the contract's own accounting

Wallet balance deltas include the gas the same wallet paid on other transactions in that window, so the authoritative check is `get_accounting()`: every scheduled payout is `in_flight` until its transaction finalizes and then leaves the contract balance. After the dispute payouts finalized the contract balance had dropped by exactly the scheduled amounts, and the release scenario's provider balance rose by exactly the escrow.

Final accounting snapshot: `{"balance": 6000000000000000, "in_flight": 0, "shortfall": 0, "total_received": "22200000000000000", "total_scheduled": "16200000000000000", "unscheduled": 6000000000000000}`

<!--LIVE_END-->

## Tests

| Test Type | Command | What it covers |
|-----------|---------|----------------|
| **Lint** | `genvm-lint check contracts/waypoint.py` | static checks |
| **Direct** | `python -m pytest tests/direct/ -v` | 59 in-memory tests with web and LLM mocks |
| **Frontend logic** | `cd frontend && npm test` | action rules, limits mirrored from the contract, decoding |
| **Live** | `node scripts/e2e.mjs` | the Bradbury run described above, separate client and provider wallets |

The direct tests cover whole-line matching (negated, historical, quoted,
planned, split, substring and "and more words" lines all refused), hidden and
hostile markup (comments, unterminated comments and tags, script, style,
noscript, svg, template), the reject marker, unreadable pages recording
nothing, the exact bond amount and its minimum, the inclusive challenge window
boundary, every verdict path (uphold, overturn, inconclusive, malformed,
oversized page), the dispute prompt carrying the committed excerpt and the
"page changed" fact, prompt-block forgery, the stale split including odd
amounts, every payout path emitting exactly the funds held and never twice,
and the accounting.

Every rule was mutation-checked: 78 deliberate breakages, 70 caught. The 8
survivors are not reachable from direct mode: validators in direct mode
always recompute exactly what the leader computed, so disagreement paths
cannot be exercised there, and a few guards (the settlement sum check, the
duplicate-payout guard, the port and credential checks, the verdict parser)
sit behind a second check that already stops the same input.

## Requirements
- Python >= 3.12
- [GenLayer CLI](https://github.com/genlayerlabs/genlayer-cli) globally installed: `npm install -g genlayer`

## Project Structure

```
contracts/waypoint.py     # the Intelligent Contract
tests/direct/             # fast in-memory tests (no Studio required)
scripts/e2e.mjs           # live Bradbury run + its log (e2e-log.json)
demo/evidence/            # the public pages the live run verifies against
frontend/                 # Next.js 16 app (TypeScript, TanStack Query, Radix UI)
```

## Quick Start

```shell
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
genvm-lint check contracts/waypoint.py
python -m pytest tests/direct/ -v      # use python -m, not bare pytest
genlayer deploy --contract contracts/waypoint.py
```

Then `cp frontend/.env.example frontend/.env`, set `NEXT_PUBLIC_CONTRACT_ADDRESS`,
and run `npm install && npm run dev` in `frontend/`.

## Frontend

- **Reads** use an account-free client. **Writes** use a second client built
  with the injected wallet provider and connected to Bradbury before signing,
  as the GenLayerJS docs prescribe for browser wallets.
- An `ACCEPTED` transaction is **not** treated as done. A write is complete
  only when the transaction was accepted, its execution returned (not a
  revert), and the engagement read back in the expected status. Fund-moving
  writes (`release`, `resolve_dispute`, `reclaim_*`) then keep watching until
  the transaction is `FINALIZED`, because the transfer lands then, and say so
  in the UI.
- The create form validates the URL and markers with the same rules as the
  contract (and a unit test fails if the limits drift apart), shows the exact
  bond a challenge will post, and offers only challenge windows above Bradbury
  finality.
- The list loads the newest 20 engagements through the paged
  `get_engagement_ids(offset, limit)`, never the whole history.

### Tested through the UI

Besides the contract-level run above, the app itself was driven end to end on
localhost against v4 with **separate client and provider wallets** (a headless
browser with a small wallet shim that signs with the test wallets): `wp-ui-1`
went create, accept, submit, verify, challenge (the bond sent was exactly the
0.0002 GEN the dialog stated), resolve, released; `wp-ui-2` was created and then
cancelled and reclaimed. Each wallet saw only the actions the contract allows
it, each write showed signed, sent, accepted and *state confirmed*, and a
fund-moving write showed the wait for finality. A write that Bradbury dropped
was reported as a timeout instead of a success and was simply repeated.

What that harness does **not** cover is a real MetaMask: it fakes the wallet's
GenLayer Snap check that `client.connect()` performs. A run in a real wallet is
still the final test of that step.

## Methods

| Method | Access | Notes |
|---|---|---|
| `create_engagement` | anyone (payable) | escrows the amount, status `proposed` |
| `accept` | provider | before the deadline |
| `submit` | provider | after accepting, before the deadline |
| `verify` | anyone | whole-line evidence, commits excerpt and digest |
| `challenge` | client (payable) | exact bond, inside the window |
| `resolve_dispute` | anyone | uphold or overturn; anything unclear changes nothing |
| `release` | anyone | after the window, pays the provider |
| `reclaim_timeout` | client | unaccepted proposal any time, accepted one after the deadline |
| `reclaim_stale` | client (stuck submission) / anyone (stuck dispute) | refund / even split, bond to the provider |
| `get_engagement`, `get_engagement_count`, `get_engagement_ids`, `get_accounting` | view | ids are paged, at most 50 |

## Community
- **[Discord](https://discord.gg/8Jm4v89VAu)**: Discussions, support, and announcements
- **[Telegram](https://t.me/genlayer)**: Informal chats and quick updates

## Documentation
For detailed information, see our [documentation](https://docs.genlayer.com/).

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
