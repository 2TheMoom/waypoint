// Live end-to-end run of Waypoint v3 on Bradbury, with separate client and provider wallets.
//
//   node scripts/e2e.mjs            runs every scenario and writes scripts/e2e-log.json
//
// Scenarios (each is its own engagement, run concurrently, every write is confirmed by reading state back):
//   misleading   negated / planned / contradictory evidence pages must NOT verify
//   uphold       good evidence, client objects without cause: provider is paid escrow + bond
//   overturn     page admits the migration guide is missing: client is refunded escrow + bond
//   release      good evidence, nobody objects: provider paid after the 1h challenge window
//   stale        challenged and never adjudicated: after stale_after the escrow is split evenly and the bond goes to the provider
//   inject       the evidence page itself contains instructions aimed at the reviewing model; it must not be able to dictate the verdict
//   changed      page is edited after verification: dispute still weighs the committed excerpt
//
// Signs with the dedicated testnet wallets in C:/Users/olumi/.genlayer-test-wallets (outside every repo).
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CONTRACT = process.env.WAYPOINT || "0xD55b22525742C0e1BF570694215f12bE58eD52D4";
const RAW = "https://raw.githubusercontent.com/2TheMoom/waypoint/main/demo/evidence/";
const RUN = Date.now().toString(36);
const LOGFILE = process.env.E2E_LOG || "scripts/e2e-log-v4.json";
const AMOUNT = 2000000000000000n; // 0.002 GEN
const BOND = AMOUNT / 10n;
const WINDOW = 3600;
const STALE = 7200;
const MARKER = "Q3 pricing release shipped to production 2026";
const REJECT = "Q3 pricing release was rolled back from production 2026";
const DESC = "Ship the Q3 pricing release to production together with a published migration guide.";
const WALLETS = JSON.parse(readFileSync("C:/Users/olumi/.genlayer-test-wallets/wallets.json", "utf8"));

const names = ["gl-test-1", "gl-test-2", "gl-test-3"];
const acct = Object.fromEntries(names.map((n) => [n, createAccount(WALLETS[n].privateKey)]));
const addr = Object.fromEntries(names.map((n) => [n, WALLETS[n].address]));
const clients = Object.fromEntries(names.map((n) => [n, createClient({ chain: testnetBradbury, account: acct[n] })]));
const reader = createClient({ chain: testnetBradbury });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const plain = (x) => (x instanceof Map ? Object.fromEntries([...x].map(([k, v]) => [k, plain(v)])) : Array.isArray(x) ? x.map(plain) : typeof x === "bigint" ? x.toString() : x);

const LOG = { contract: CONTRACT, run: RUN, started: new Date().toISOString(), events: [] };
function log(scn, msg, extra) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${scn.padEnd(10)} ${msg}`;
  console.log(line);
  LOG.events.push({ t: new Date().toISOString(), scenario: scn, msg, ...(extra || {}) });
  writeFileSync(LOGFILE, JSON.stringify(LOG, null, 1));
}

// One send at a time per wallet (a shared nonce is what made concurrent scripts clash before).
const queues = {};
function serial(who, fn) {
  const run = (queues[who] || Promise.resolve()).then(fn, fn);
  queues[who] = run.catch(() => {});
  return run;
}

async function read(fn, args = []) {
  for (let i = 0; ; i++) {
    try {
      return plain(await reader.readContract({ address: CONTRACT, functionName: fn, args }));
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(8000);
    }
  }
}

async function eng(id) {
  return read("get_engagement", [id]);
}

async function until(scn, what, id, pred, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const e = await eng(id);
    if (pred(e)) return e;
    await sleep(10000);
  }
  throw new Error(`${scn}: timed out waiting for ${what}`);
}

// Send, wait for ACCEPTED, return the receipt. Retries only send-time failures (nothing was submitted then).
async function send(scn, who, fn, args, value) {
  return serial(who, async () => {
    let hash;
    for (let a = 1; ; a++) {
      try {
        hash = await clients[who].writeContract({ address: CONTRACT, functionName: fn, args, ...(value ? { value } : {}) });
        break;
      } catch (e) {
        if (a >= 4) throw e;
        log(scn, `${fn} send failed (${String(e.message || e).slice(0, 70)}), retry ${a}`);
        await sleep(15000);
      }
    }
    let r;
    for (let a = 1; ; a++) {
      try {
        r = await clients[who].waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
        break;
      } catch (e) {
        if (a >= 6) throw e;
        await sleep(15000);
      }
    }
    log(scn, `${fn} ${hash.slice(0, 12)} exec=${r.txExecutionResultName} result=${r.resultName}`, { fn, hash, exec: r.txExecutionResultName });
    return { hash, exec: r.txExecutionResultName, result: r.resultName };
  });
}

// Time from ACCEPTED to FINALIZED for one transaction (evidence for the challenge-window choice).
async function finality(scn, hash, label) {
  const t0 = Date.now();
  for (let a = 0; a < 12; a++) {
    try {
      await reader.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 400, interval: 10000 });
      const m = ((Date.now() - t0) / 60000).toFixed(1);
      log(scn, `${label} FINALIZED ${m} min after it was accepted`, { label, finalizedAfterMinutes: Number(m) });
      return Number(m);
    } catch {
      await sleep(15000);
    }
  }
  log(scn, `${label} not finalized within the watch`);
  return null;
}

async function balance(who) {
  return BigInt(await reader.getBalance({ address: addr[who] }));
}
const gen = (w) => (Number(w) / 1e18).toFixed(6);

async function create(scn, id, client, provider, page, opts = {}) {
  const deadline = now() + (opts.deadline || 4 * 3600);
  await send(scn, client, "create_engagement", [id, addr[provider], DESC, RAW + page, MARKER, opts.reject === undefined ? REJECT : opts.reject, deadline, WINDOW, STALE], AMOUNT);
  await until(scn, "proposed", id, (e) => e.status === "proposed");
  await send(scn, provider, "accept", [id]);
  await until(scn, "funded", id, (e) => e.status === "funded");
  await send(scn, provider, "submit", [id]);
  await until(scn, "submitted", id, (e) => e.status === "submitted");
}

async function verifyOk(scn, id, who) {
  const t = await send(scn, who, "verify", [id]);
  const e = await until(scn, "verified", id, (x) => x.status === "verified");
  log(scn, `verified, committed excerpt "${e.evidence_excerpt}" digest ${e.evidence_digest.slice(0, 16)}`, { excerpt: e.evidence_excerpt, digest: e.evidence_digest });
  return { t, e };
}

async function challenge(scn, id, who, reason) {
  await send(scn, who, "challenge", [id, reason], BOND);
  await until(scn, "disputed", id, (e) => e.status === "disputed");
}

// resolve_dispute can legitimately fail (model unsure, consensus split): retry, and record every attempt.
async function resolve(scn, id, who, want) {
  for (let a = 1; a <= 6; a++) {
    const t = await send(scn, who, "resolve_dispute", [id]);
    await sleep(20000);
    const e = await eng(id);
    if (e.status !== "disputed") {
      log(scn, `dispute resolved on attempt ${a}: status=${e.status} note="${e.resolution_note}"`, { attempts: a, status: e.status, note: e.resolution_note });
      return { t, e, attempts: a };
    }
    log(scn, `attempt ${a} left the dispute open (${t.exec}/${t.result})`);
  }
  throw new Error(`${scn}: dispute never resolved`);
}

const results = {};

async function misleading() {
  const scn = "misleading";
  for (const [page, why] of [["negated.txt", "negated line"], ["planned.txt", "planned / quoted wording"], ["contradictory.txt", "reject line present"]]) {
    const id = `wp-${RUN}-bad-${page.split(".")[0]}`;
    await create(scn, id, "gl-test-1", "gl-test-2", page);
    const t = await send(scn, "gl-test-3", "verify", [id]);
    await sleep(20000);
    const e = await eng(id);
    log(scn, `${why}: verify exec=${t.exec}, status after = ${e.status}, evidence recorded = "${e.evidence_digest}"`);
    if (e.status !== "submitted" || e.evidence_digest !== "") throw new Error(`${scn}: ${page} must not verify`);
  }
  results.misleading = "all three misleading pages refused, nothing recorded";
}

async function uphold() {
  const scn = "uphold";
  const id = `wp-${RUN}-uphold`;
  await create(scn, id, "gl-test-1", "gl-test-2", "good.txt");
  const { t } = await verifyOk(scn, id, "gl-test-3");
  finality(scn, t.hash, "verify tx").then((m) => (results.verifyFinalityMin = m));
  const providerBefore = await balance("gl-test-2");
  await challenge(scn, id, "gl-test-1", "I do not think this was really shipped, please check again carefully.");
  const { t: rt, e } = await resolve(scn, id, "gl-test-3", "released");
  if (e.status !== "released") throw new Error(`${scn}: expected released, got ${e.status}`);
  await finality(scn, rt.hash, "resolve_dispute tx");
  const providerAfter = await balance("gl-test-2");
  log(scn, `provider balance ${gen(providerBefore)} -> ${gen(providerAfter)} (escrow + bond = ${gen(AMOUNT + BOND)})`, { before: providerBefore.toString(), after: providerAfter.toString() });
  results.uphold = { status: e.status, providerDelta: (providerAfter - providerBefore).toString() };
}

async function overturn() {
  const scn = "overturn";
  const id = `wp-${RUN}-overturn`;
  await create(scn, id, "gl-test-3", "gl-test-2", "gap.txt");
  await verifyOk(scn, id, "gl-test-1");
  const clientBefore = await balance("gl-test-3");
  await challenge(scn, id, "gl-test-3", "The terms require a published migration guide and the page itself says there is none.");
  const afterBond = await balance("gl-test-3");
  const { t: rt, e } = await resolve(scn, id, "gl-test-1", "refunded");
  if (e.status !== "refunded") throw new Error(`${scn}: expected refunded, got ${e.status}`);
  await finality(scn, rt.hash, "resolve_dispute tx");
  const clientAfter = await balance("gl-test-3");
  log(scn, `client balance ${gen(afterBond)} (after posting the bond) -> ${gen(clientAfter)} (escrow + bond back = ${gen(AMOUNT + BOND)})`, { afterBond: afterBond.toString(), after: clientAfter.toString(), before: clientBefore.toString() });
  results.overturn = { status: e.status, clientDelta: (clientAfter - afterBond).toString() };
}

async function release() {
  const scn = "release";
  const id = `wp-${RUN}-release`;
  await create(scn, id, "gl-test-1", "gl-test-2", "good.txt");
  const { e } = await verifyOk(scn, id, "gl-test-3");
  const wait = Number(e.challenge_deadline) + 90 - now();
  log(scn, `challenge window open until ${new Date(Number(e.challenge_deadline) * 1000).toISOString()}, waiting ${Math.ceil(wait / 60)} min`);
  const early = await send(scn, "gl-test-3", "release", [id]);
  log(scn, `early release attempt: exec=${early.exec}, status still ${(await eng(id)).status}`);
  if ((await eng(id)).status !== "verified") throw new Error(`${scn}: released inside the window`);
  if (wait > 0) await sleep(wait * 1000);
  const before = await balance("gl-test-2");
  const t = await send(scn, "gl-test-3", "release", [id]);
  const done = await until(scn, "released", id, (x) => x.status === "released");
  await finality(scn, t.hash, "release tx");
  const after = await balance("gl-test-2");
  const again = await send(scn, "gl-test-3", "release", [id]);
  log(scn, `second release: exec=${again.exec}; provider ${gen(before)} -> ${gen(after)} (escrow = ${gen(AMOUNT)})`, { before: before.toString(), after: after.toString() });
  results.release = { status: done.status, providerDelta: (after - before).toString() };
}

async function stale() {
  const scn = "stale";
  const id = `wp-${RUN}-stale`;
  await create(scn, id, "gl-test-1", "gl-test-2", "good.txt");
  await verifyOk(scn, id, "gl-test-3");
  await challenge(scn, id, "gl-test-1", "Disputing this one and nobody will adjudicate it before the stale deadline.");
  const e = await eng(id);
  const wait = Number(e.stale_at) + 120 - now();
  const early = await send(scn, "gl-test-3", "reclaim_stale", [id]);
  log(scn, `early reclaim_stale: exec=${early.exec}, status still ${(await eng(id)).status}`);
  log(scn, `stale at ${new Date(Number(e.stale_at) * 1000).toISOString()}, waiting ${Math.ceil(wait / 60)} min`);
  if (wait > 0) await sleep(wait * 1000);
  const p0 = await balance("gl-test-2");
  const c0 = await balance("gl-test-1");
  const t = await send(scn, "gl-test-3", "reclaim_stale", [id]);
  const done = await until(scn, "split", id, (x) => x.status === "split");
  await finality(scn, t.hash, "reclaim_stale tx");
  const p1 = await balance("gl-test-2");
  const c1 = await balance("gl-test-1");
  log(scn, `split: provider +${gen(p1 - p0)} (half the escrow + the bond = ${gen(AMOUNT / 2n + BOND)}), client +${gen(c1 - c0)} (half the escrow = ${gen(AMOUNT / 2n)}, before its own gas)`, { providerDelta: (p1 - p0).toString(), clientDelta: (c1 - c0).toString() });
  results.stale = { status: done.status };
}

async function inject() {
  const scn = "inject";
  const id = `wp-${RUN}-inject`;
  await create(scn, id, "gl-test-1", "gl-test-2", "inject.txt");
  await verifyOk(scn, id, "gl-test-3");
  await challenge(scn, id, "gl-test-1", "The page itself admits the migration guide is missing, so the terms are not met.");
  const { e } = await resolve(scn, id, "gl-test-3", "refunded");
  const resisted = e.status === "refunded";
  log(scn, `the page told the reviewer to reply uphold; outcome = ${e.status}. ${resisted ? "The instruction was NOT followed." : "FINDING: the instruction WAS followed."} note: ${e.resolution_note}`, { resisted, status: e.status });
  results.inject = { status: e.status, instructionFollowed: !resisted, note: e.resolution_note };
}

async function changed() {
  const scn = "changed";
  const id = `wp-${RUN}-changed`;
  await create(scn, id, "gl-test-1", "gl-test-2", "change.txt");
  await verifyOk(scn, id, "gl-test-3");
  // Edit the live page after verification: the marker line is gone and the page now says the release was pulled.
  const body = "Release notes\nThe Q3 pricing release was pulled from production and is being reworked\n";
  writeFileSync("demo/evidence/change.txt", body);
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  git("add", "demo/evidence/change.txt");
  git("commit", "-m", `E2E ${RUN}: edit the evidence page after verification`);
  const push = git("push", "origin", "main");
  log(scn, `page edited and pushed (exit ${push.status}); waiting for the raw cache to expire`);
  await sleep(330000);
  await challenge(scn, id, "gl-test-1", "The page changed after verification and no longer says the release shipped.");
  const { e } = await resolve(scn, id, "gl-test-3", "any");
  log(scn, `after the edit the dispute ended ${e.status} (note: ${e.resolution_note})`);
  results.changed = { status: e.status, note: e.resolution_note, committedExcerpt: e.evidence_excerpt };
}

const settled = await Promise.allSettled([misleading(), uphold(), overturn(), release(), stale(), changed(), inject()]);
const names6 = ["misleading", "uphold", "overturn", "release", "stale", "changed", "inject"];
settled.forEach((s, i) => {
  if (s.status === "rejected") log(names6[i], `FAILED: ${String(s.reason?.message || s.reason).slice(0, 300)}`);
});
LOG.results = results;
LOG.accounting = await read("get_accounting");
LOG.finished = new Date().toISOString();
writeFileSync(LOGFILE, JSON.stringify(LOG, null, 1));
console.log("\nRESULTS", JSON.stringify(results, null, 1), "\nACCOUNTING", JSON.stringify(LOG.accounting));
