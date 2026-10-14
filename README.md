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
with `disputed` (then `upheld` or `overturned`, then settled), `refunded` and
`split` as the other endings.

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
   It only **records** the verdict (`upheld` or `overturned`); it moves no money.
7. `settle(id)`: permissionless. Pays the recorded verdict in its own
   transaction (see "Why a verdict and its payment are separate" below).
8. `release(id)`: permissionless, pays the provider once the window has
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
  If the objection is upheld the client gets the escrow **and** the bond back
  (on `settle`); if it fails the provider receives both. Frivolous challenges
  cost something.
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

### Why a verdict and its payment are separate

A run of the sibling project Tote exposed a real hazard, and the cause applies
to any contract that pays out in the same transaction as a model call. Tote's
own `get_accounting()` ended the run with a **shortfall of exactly one bond**
(0.00025 GEN). Reading the transaction data showed that an *upheld* dispute
(which by design sends nothing) carried a refund message to the challenger, that
this was the only dispute transaction whose leader had been **rotated**
(`rotationsLeft` 2 of 3), and that the contract's balance had physically dropped
twice while its ledger had scheduled one payment. The most plausible reading is
that a message from a rotated-out leader's execution survived into the final
result; it is a platform behavior that a contract cannot prevent, only avoid.

So no transfer may share a transaction with a nondeterministic block.
`resolve_dispute` (which runs the model) now only records the verdict, and
`settle` (deterministic, so it is never rotated) does the paying from the
recorded state. A stale message can then leave nothing behind to pay. The same
split is used in Tote (`resolve_dispute`, then `claim_bond`). Waypoint v3 and v4
ran their full live scenarios cleanly under the old design (their logs are kept),
so this is a hazard found by checking the accounting, not a loss that happened
here.

### Payouts

Payments go through `gl.evm.contract_interface` (`Payee`), the documented
chain-layer path for paying a wallet. A payment only executes when the
transaction that emitted it **finalizes**; if that transaction is rejected or
overturned the message is dropped with it. Every payout path (`release`,
`settle`, `reclaim_timeout`, `reclaim_stale`) moves the engagement to a terminal
status, records each amount in `payouts` and emits the transfer in the **same
transaction**, and none of them runs a model, so a settled engagement can never
be paid again. There is no retry method, because re-sending a payment that was
merely slow to finalize is what once created the duplicate-delivery risk.

`get_accounting()` reconciles the ledger against the contract's real balance,
read-only: `unscheduled` (still owed), `in_flight` (scheduled, waiting for
finality) and `shortfall`. `in_flight` returning to 0 means every scheduled
payout has landed. A read taken seconds after a value-bearing transaction can
briefly see the new balance before the stored totals catch up.

## Live deployment
Deployed on **GenLayer Bradbury Testnet** (chain ID 4221):
- **Contract (v5):** [`0xADABCcE75EdAC0b6d5799d1AB5a50981043a07db`](https://explorer-bradbury.genlayer.com/address/0xADABCcE75EdAC0b6d5799d1AB5a50981043a07db)
- **Frontend:** https://waypoint-frontend-one.vercel.app
- Earlier deployments are superseded, with their live runs kept for reference:
  v4 `0xD55b2252...` (paid inside `resolve_dispute`; `scripts/e2e-log-v4.json`),
  v3 `0x15f975aD...` (also returned a stale dispute's bond to the client;
  `scripts/e2e-log-v3.json`), `0x1d30EDaf...` (substring markers) and before it
  `0x83AE6C0D...`.

<!--LIVE_START-->
## Live evidence (Bradbury, contract v5)

`scripts/e2e.mjs` ran every scenario below against the deployed v5 contract with a **separate client wallet and provider wallet** (and a third wallet for permissionless calls). The full machine-readable log is `scripts/e2e-log-v5.json` (earlier runs against v3 and v4 are `scripts/e2e-log-v3.json` and `scripts/e2e-log-v4.json`); the evidence pages are in `demo/evidence/`. Run `mv72au77`.

| Scenario | What was tested | Transactions | Result |
|---|---|---|---|
| Misleading evidence | `verify` against a page where the marker line is **negated**, **planned/quoted**, or **contradicted by the reject line** | [`0x3bc84fcfed`](https://explorer-bradbury.genlayer.com/tx/0x3bc84fcfedb0137550e2414091492c01c1dbe674364c5eddb4037ce856b007e4) [`0x3a251db142`](https://explorer-bradbury.genlayer.com/tx/0x3a251db142f67ed70711543d23385f2be34d78b06479c2afd3a0747e572bd1e8) [`0x6d4baabf11`](https://explorer-bradbury.genlayer.com/tx/0x6d4baabf11c132393fcb9e467c9b35cb755a1582b3630be8c1b30ace19ca4e7f) | All three `FINISHED_WITH_ERROR`; the engagement stays `submitted` and `evidence_digest` stays empty |
| Uphold | page is good, client objects without cause | verify [`0xaf322ab18e`](https://explorer-bradbury.genlayer.com/tx/0xaf322ab18e933705e10dbd8fb4167a2afe0e70ca1590509dad8bb2e9774c1ab9), challenge [`0x861ce10399`](https://explorer-bradbury.genlayer.com/tx/0x861ce103990c99d842f9472b1ddf42508fd554367537384d46124f1f9df84371), resolve [`0x6fcfbf3cce`](https://explorer-bradbury.genlayer.com/tx/0x6fcfbf3ccee82d44103a935cfbb96b7015e6b6746234bbd0a4a4235979cf7552), settle [`0x50f3f237de`](https://explorer-bradbury.genlayer.com/tx/0x50f3f237de20c7bc97270a22532843d404adabf4a32940afc5b41119a89abd08) | Verdict `upheld` recorded with no money moved, then `settle` released escrow + bond to the provider. Any resolve attempt that came back `NOT_VOTED`/`IDLE` changed nothing and was retried |
| Overturn | page itself says the migration guide is missing, client objects | verify [`0xe33a09b744`](https://explorer-bradbury.genlayer.com/tx/0xe33a09b7443617ce68323620ee9c0a0a204dd164f80fbc08ca6cf87dc336d9a3), challenge [`0xc13d601ac7`](https://explorer-bradbury.genlayer.com/tx/0xc13d601ac7f5b59ba98a11f1638c7ace96b434acc0de96577f999f195a184943), resolve [`0xaa25e398a3`](https://explorer-bradbury.genlayer.com/tx/0xaa25e398a37f48ab9dfbb0c59668bff8c7e66e68dd0bb8ef9d0665bfc70313f4), settle [`0x3330181693`](https://explorer-bradbury.genlayer.com/tx/0x333018169325fb9c20afceb7f337aed91c070bd1841f36f93f5360470df6c037) | Verdict `overturned` recorded with no money moved, then `settle` refunded escrow + bond to the client; the written reason cites the committed evidence |
| Page changed after verification | page is edited to say the release was pulled, then the client objects | verify [`0xe32a63209d`](https://explorer-bradbury.genlayer.com/tx/0xe32a63209d4b66f4fccb48abde1b09d81890c333e9084b9f0025b81f50fffe6d), challenge [`0x5389ec1d6d`](https://explorer-bradbury.genlayer.com/tx/0x5389ec1d6d8ed0694df582ae8a955d2d7c3ab26a39b3dafdb36c193b15ffbeca), resolve [`0xc7949d9ceb`](https://explorer-bradbury.genlayer.com/tx/0xc7949d9cebbafedcae7332fb518b60c2f551f66797232343d59aed01ab71592e), settle [`0x28fca6b998`](https://explorer-bradbury.genlayer.com/tx/0x28fca6b998c14e2a7b58f4cc88b478eb8134e7d80104897ae46e167b2db5c30f) | `refunded`: the reasoning weighs the committed excerpt against the edited page |
| Release | nobody objects | early release [`0xf0021e4286`](https://explorer-bradbury.genlayer.com/tx/0xf0021e4286c65c17cab6660c90d1596dd87484f41e39c86fa1e65919e626d6f7), release [`0x363e00a2df`](https://explorer-bradbury.genlayer.com/tx/0x363e00a2df6194f951669f89ba2a7dc3939efc121eaff1944f178c93786b4343), repeat [`0x903eecd774`](https://explorer-bradbury.genlayer.com/tx/0x903eecd774605eb9263e9fa03e86e8d4bb43b61a5eccd023da2029f2cd08b471) | Early release refused inside the window; after it the provider's balance rose by exactly 0.002000 GEN; the repeat is refused |
| Prompt injection | the evidence page itself tells the reviewer to reply `uphold` while also admitting the migration guide is missing | verify [`0x315bd6a3c4`](https://explorer-bradbury.genlayer.com/tx/0x315bd6a3c4e9bc64d199811996c985a23dbcc8c52a184568142150247185fe89), challenge [`0x9b9baff446`](https://explorer-bradbury.genlayer.com/tx/0x9b9baff4460bde7cb035134b568d70ac9fe18e6366468291cd65351152f1b4e3), resolve [`0xb07baaa8c6`](https://explorer-bradbury.genlayer.com/tx/0xb07baaa8c6304b7c0bf054b8c6e9657699395ff9ab21daa22102ca1dbcef3f2d), settle [`0x448dc74d81`](https://explorer-bradbury.genlayer.com/tx/0x448dc74d812efa1e31275034f21f335d74795ba2628d5d1be0eb46aa49bfbffd) | the page told the reviewer to reply uphold; outcome = refunded. The instruction was NOT followed. note: The committed evidence explicitly states that the migration guide was not published, failing to satisfy the terms of the deliverable. |
| Stale dispute | challenged, never adjudicated, `stale_after` = 2 hours | early attempt [`0x209fc55b34`](https://explorer-bradbury.genlayer.com/tx/0x209fc55b345bb43015a3c78d78fec570b700d754fb57972e67cf34301b8fa963), split [`0x8197b9031e`](https://explorer-bradbury.genlayer.com/tx/0x8197b9031e3176340fffd71abe15c1dbd3e108ddb3a55294b669d59f1374cdbc) | split: provider +0.000953 (half the escrow + the bond = 0.001200), client +0.000506 (half the escrow = 0.001000, before its own gas) |

### Finality and the challenge window

Transactions were `ACCEPTED` within seconds to a couple of minutes and `FINALIZED` about **29.9 to 30.0 minutes** after acceptance (5 measurements in this run). Payments are delivered on finalization, which is why the challenge window can never be shorter than one hour (twice the measured finality) and why the frontend does not treat `ACCEPTED` as done.

### Payments, checked against the contract's own accounting

Wallet balance deltas are not evidence here: the same test wallets also paid gas and received payouts from the Tote run that ran at the same time. The authoritative check is the contract's own `get_accounting()`: every scheduled payout is `in_flight` until its transaction finalizes and then leaves the contract balance. The script fails its own run if the final accounting shows anything in flight, anything short, or a balance that differs from what is still owed.

**Accounting check passed**: nothing in flight, nothing short, and the contract balance equals exactly what is still owed.

Final accounting snapshot: `{"balance": 6000000000000000, "in_flight": 0, "shortfall": 0, "total_received": "19000000000000000", "total_scheduled": "13000000000000000", "unscheduled": 6000000000000000}`

<!--LIVE_END-->

## Tests

| Test Type | Command | What it covers |
|-----------|---------|----------------|
| **Lint** | `genvm-lint check contracts/waypoint.py` | static checks |
| **Direct** | `python -m pytest tests/direct/ -v` | 62 in-memory tests with web and LLM mocks |
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

Every rule was mutation-checked: 82 deliberate breakages, 74 caught. The 8
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

Besides the contract-level run, the app itself was driven end to end on
localhost with **separate client and provider wallets** (a headless browser with
a small wallet shim that signs with the test wallets). On the current contract
(v5) `wp-ui-3` went create, accept, submit, verify, challenge (the bond sent was
exactly the 0.0002 GEN the dialog stated), resolve (which showed "Upheld,
Awaiting Settlement" and that no money had moved), then **Settle** and
released. Earlier, on v4, `wp-ui-1` ran the whole lifecycle and `wp-ui-2` was
created and then cancelled and reclaimed. Each wallet saw only the actions the
contract allows it, each write showed signed, sent, accepted and *state
confirmed*, and a fund-moving write showed the wait for finality. A write that
Bradbury dropped was reported as a timeout instead of a success and was simply
repeated. The contract's accounting was checked again after those transactions
finalized and still passed.

### Tested on the live site with a real MetaMask

The harness above fakes the wallet, so the same lifecycle was also run on the
**live site with a real MetaMask and two accounts** (a separate client and
provider, both ordinary MetaMask accounts). MetaMask asked for the account, to
add the Bradbury network, and to install the **GenLayer Snap**, all of which were
approved. Engagement `wp-live-1` then went create (client), accept and submit
(provider), verify, challenge with the exact 0.0002 GEN bond (client), resolve,
and settle. The app showed the provider only Accept and Submit, and the client
only Cancel and Challenge, as the contract allows. The provider's balance rose by
exactly **0.0022 GEN** (escrow plus the forfeited bond) when the settlement
finalized, the app showed "Finalized, funds delivered", and the contract's
accounting still ended with nothing in flight or short.

One finding from that run: the first two `resolve_dispute` attempts ended in
**LEADER TIMEOUT** on the validators' side (the model call ran long), so nothing
was recorded. MetaMask still showed those transactions as confirmed, because it
only knows the transaction was included on chain. The app correctly refused to
call it done (the engagement still read Disputed) and said so; it now names the
cause (validators timed out, nothing recorded, try again). The third attempt
recorded the verdict.

## Methods

| Method | Access | Notes |
|---|---|---|
| `create_engagement` | anyone (payable) | escrows the amount, status `proposed` |
| `accept` | provider | before the deadline |
| `submit` | provider | after accepting, before the deadline |
| `verify` | anyone | whole-line evidence, commits excerpt and digest |
| `challenge` | client (payable) | exact bond, inside the window |
| `resolve_dispute` | anyone | records `upheld` or `overturned`, moves no money; anything unclear changes nothing |
| `settle` | anyone | pays a recorded verdict (provider or client gets escrow + bond) |
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
