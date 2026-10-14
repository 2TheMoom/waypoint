// Live run of Waypoint v6 on Bradbury for the round-3 changes, with separate client and provider wallets.
//   node scripts/e2e-v6.mjs
//
// Scenarios (each is its own engagement, every write is confirmed by reading state back):
//   named   the marker must name the engagement; the provider must accept the exact terms hash; a line about another engagement does not verify
//   big     an evidence page over 2 MB is refused, never cut short (its reject line sits beyond the old 2 MB cut)
//   grew    the page is swapped for one over 2 MB after verification: a dispute can reach no verdict on part of the evidence
//   uphold  good evidence, client objects without cause: provider is paid escrow + bond (regression of the full money path)
//   overturn page admits the migration guide is missing: client is refunded escrow + bond
// Release and stale recovery are unchanged since v5 and are covered by e2e-log-v5.json and the direct tests.
// Signs with the dedicated testnet wallets in C:/Users/olumi/.genlayer-test-wallets (outside every repo).
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CONTRACT = process.env.WAYPOINT || "0x997faAD18C5d30a9EDec492B58f0cfc6EeC69dbb";
const RAW = "https://raw.githubusercontent.com/2TheMoom/waypoint/main/demo/evidence6/";
const RUN = Date.now().toString(36);
const LOGFILE = process.env.E2E_LOG || "scripts/e2e-log-v6.json";
const AMOUNT = 2000000000000000n; // 0.002 GEN
const BOND = AMOUNT / 10n;
const WINDOW = 3600;
const STALE = 7200;
const SHIP = "Q3 pricing release shipped to production 2026";
const BACK = "Q3 pricing release was rolled back from production 2026";
// the marker line must name the engagement
const marker = (id) => `${id}: ${SHIP}`;
const reject = (id) => `${id}: ${BACK}`;
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

async function create(scn, id, client, provider, page) {
  const deadline = now() + 4 * 3600;
  await send(scn, client, "create_engagement", [id, addr[provider], DESC, RAW + page, marker(id), reject(id), deadline, WINDOW, STALE], AMOUNT);
  const e0 = await until(scn, "proposed", id, (e) => e.status === "proposed");
  // the provider accepts an exact digest of the terms
  await send(scn, provider, "accept", [id, e0.terms_hash]);
  await until(scn, "funded", id, (e) => e.status === "funded");
  await send(scn, provider, "submit", [id]);
  await until(scn, "submitted", id, (e) => e.status === "submitted");
}

// A write the contract must refuse: either it fails before sending or its GenVM execution ends in an error.
async function expectRefused(scn, who, fn, args, value) {
  return serial(who, async () => {
    let hash;
    try {
      hash = await clients[who].writeContract({ address: CONTRACT, functionName: fn, args, ...(value ? { value } : {}) });
    } catch (e) {
      log(scn, `${fn} refused before it was sent: ${String(e.message || e).slice(0, 140)}`, { fn, refused: "before send" });
      return { refused: true };
    }
    const r = await clients[who].waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
    const refused = r.txExecutionResultName !== "FINISHED_WITH_RETURN";
    log(scn, `${fn} ${hash.slice(0, 12)} exec=${r.txExecutionResultName}: ${refused ? "refused, as it must be" : "UNEXPECTEDLY ACCEPTED"}`, { fn, hash, exec: r.txExecutionResultName, refused });
    if (!refused) throw new Error(`${scn}: ${fn} should have been refused`);
    return { refused: true, hash };
  });
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
// It only RECORDS the verdict (upheld / overturned) and moves no money; settle() then pays it in its own transaction.
async function resolve(scn, id, who, want) {
  for (let a = 1; a <= 6; a++) {
    const t = await send(scn, who, "resolve_dispute", [id]);
    await sleep(20000);
    let e = await eng(id);
    if (e.status === "disputed") {
      log(scn, `attempt ${a} left the dispute open (${t.exec}/${t.result})`);
      continue;
    }
    log(scn, `verdict recorded on attempt ${a}: status=${e.status} note="${e.resolution_note}"`, { attempts: a, status: e.status, note: e.resolution_note });
    const early = (await read("get_accounting")).total_scheduled;
    const st = await send(scn, who, "settle", [id]);
    e = await until(scn, "settled", id, (x) => x.status === "released" || x.status === "refunded");
    log(scn, `settled: status=${e.status} (scheduled before settle ${early})`, { settled: e.status });
    return { t: st, e, attempts: a };
  }
  throw new Error(`${scn}: dispute never resolved`);
}

const results = {};

const count = async () => Number(await read("get_engagement_count"));

async function named() {
  const scn = "named";
  // 1. a marker that does not name the engagement is refused at creation
  const before = await count();
  await expectRefused(scn, "gl-test-1", "create_engagement", ["wp6-noid", addr["gl-test-2"], DESC, RAW + "named-good.txt", SHIP, BACK, now() + 4 * 3600, WINDOW, STALE], AMOUNT);
  if ((await count()) !== before) throw new Error(`${scn}: an engagement without the id in its marker was created`);
  // 2. the provider must pass the exact terms hash
  const id = "wp6-named";
  await send(scn, "gl-test-1", "create_engagement", [id, addr["gl-test-2"], DESC, RAW + "named-good.txt", marker(id), reject(id), now() + 4 * 3600, WINDOW, STALE], AMOUNT);
  const e0 = await until(scn, "proposed", id, (e) => e.status === "proposed");
  log(scn, `terms hash on chain: ${e0.terms_hash}`, { termsHash: e0.terms_hash });
  await expectRefused(scn, "gl-test-2", "accept", [id, "0".repeat(64)]);
  if ((await eng(id)).status !== "proposed") throw new Error(`${scn}: accepted with a wrong hash`);
  await send(scn, "gl-test-2", "accept", [id, e0.terms_hash]);
  await until(scn, "funded", id, (e) => e.status === "funded");
  await send(scn, "gl-test-2", "submit", [id]);
  await until(scn, "submitted", id, (e) => e.status === "submitted");
  await verifyOk(scn, id, "gl-test-3");
  // 3. a page whose line is about a DIFFERENT engagement does not verify this one
  const id2 = "wp6-named-x";
  await create(scn, id2, "gl-test-1", "gl-test-2", "named-other.txt");
  const t = await send(scn, "gl-test-3", "verify", [id2]);
  await sleep(20000);
  const e2 = await eng(id2);
  log(scn, `page names another engagement: verify exec=${t.exec}, status after = ${e2.status}, evidence recorded = "${e2.evidence_digest}"`);
  if (e2.status !== "submitted" || e2.evidence_digest !== "") throw new Error(`${scn}: a line about another engagement verified this one`);
  results.named = "no-id marker refused; wrong terms hash refused; right hash accepted; own line verified; another engagement's line refused";
}

async function big() {
  const scn = "big";
  const id = "wp6-big";
  const size = (await (await fetch(RAW + "big.txt")).arrayBuffer()).byteLength;
  log(scn, `evidence page is ${size} bytes (limit 2000000); the reject line is its last line, beyond the old 2 MB cut`, { pageBytes: size });
  await create(scn, id, "gl-test-1", "gl-test-2", "big.txt");
  const t = await send(scn, "gl-test-3", "verify", [id]);
  await sleep(20000);
  const e = await eng(id);
  log(scn, `verify exec=${t.exec}, status after = ${e.status}, evidence recorded = "${e.evidence_digest}"`);
  if (e.status !== "submitted" || e.evidence_digest !== "") throw new Error(`${scn}: an oversized page must not verify`);
  results.big = { pageBytes: size, status: e.status, verifyExec: t.exec };
}

async function grew() {
  const scn = "grew";
  const id = "wp6-grew";
  await create(scn, id, "gl-test-1", "gl-test-2", "grew.txt");
  const { e: v } = await verifyOk(scn, id, "gl-test-3");
  // the page is replaced by one over 2 MB after verification
  const pad = Array.from({ length: 52000 }, (_, i) => `changelog entry ${String(i).padStart(6, "0")} nothing to see here`).join("\n");
  writeFileSync("demo/evidence6/grew.txt", `Release notes\n${marker(id)}\nMigration guide published at docs/migrate\n${pad}\n`);
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  git("add", "demo/evidence6/grew.txt");
  git("commit", "-m", `E2E v6: the evidence page grows past 2 MB after verification`);
  const push = git("push", "origin", "main");
  log(scn, `page grown past 2 MB and pushed (exit ${push.status}); waiting for the raw cache to expire`);
  await sleep(330000);
  const size = (await (await fetch(RAW + "grew.txt")).arrayBuffer()).byteLength;
  log(scn, `evidence page now ${size} bytes`, { pageBytes: size });
  await challenge(scn, id, "gl-test-1", "The page changed after verification and I cannot tell what it says any more.");
  const attempts = [];
  for (let a = 1; a <= 2; a++) {
    const r = await expectRefused(scn, "gl-test-3", "resolve_dispute", [id]);
    attempts.push(r.hash || "before send");
    const e = await eng(id);
    log(scn, `attempt ${a}: no verdict recorded, status ${e.status}, note "${e.resolution_note}"`);
    if (e.status !== "disputed" || e.resolution_note !== "") throw new Error(`${scn}: a verdict was recorded on a page that cannot be read in full`);
  }
  results.grew = { committedExcerpt: v.evidence_excerpt, pageBytesAtDispute: size, status: "disputed", attempts };
}

async function uphold() {
  const scn = "uphold";
  const id = "wp6-uphold";
  await create(scn, id, "gl-test-1", "gl-test-2", "uphold.txt");
  const { t } = await verifyOk(scn, id, "gl-test-3");
  finality(scn, t.hash, "verify tx").then((m) => (results.verifyFinalityMin = m));
  const providerBefore = await balance("gl-test-2");
  await challenge(scn, id, "gl-test-1", "I do not think this was really shipped, please check again carefully.");
  const { t: rt, e } = await resolve(scn, id, "gl-test-3", "released");
  if (e.status !== "released") throw new Error(`${scn}: expected released, got ${e.status}`);
  await finality(scn, rt.hash, "settle tx");
  const providerAfter = await balance("gl-test-2");
  log(scn, `provider balance ${gen(providerBefore)} -> ${gen(providerAfter)} (escrow + bond = ${gen(AMOUNT + BOND)})`, { before: providerBefore.toString(), after: providerAfter.toString() });
  results.uphold = { status: e.status, providerDelta: (providerAfter - providerBefore).toString() };
}

async function overturn() {
  const scn = "overturn";
  const id = "wp6-overturn";
  await create(scn, id, "gl-test-3", "gl-test-2", "overturn.txt");
  await verifyOk(scn, id, "gl-test-1");
  const clientBefore = await balance("gl-test-3");
  await challenge(scn, id, "gl-test-3", "The terms require a published migration guide and the page itself says there is none.");
  const afterBond = await balance("gl-test-3");
  const { t: rt, e } = await resolve(scn, id, "gl-test-1", "refunded");
  if (e.status !== "refunded") throw new Error(`${scn}: expected refunded, got ${e.status}`);
  await finality(scn, rt.hash, "settle tx");
  const clientAfter = await balance("gl-test-3");
  log(scn, `client balance ${gen(afterBond)} (after posting the bond) -> ${gen(clientAfter)} (escrow + bond back = ${gen(AMOUNT + BOND)})`, { afterBond: afterBond.toString(), after: clientAfter.toString(), before: clientBefore.toString() });
  results.overturn = { status: e.status, clientDelta: (clientAfter - afterBond).toString() };
}

const order = ["named", "big", "grew", "uphold", "overturn"];
const settled = await Promise.allSettled([named(), big(), grew(), uphold(), overturn()]);
settled.forEach((s, i) => {
  if (s.status === "rejected") log(order[i], `FAILED: ${String(s.reason?.message || s.reason).slice(0, 300)}`);
});
LOG.results = results;
LOG.accounting = await read("get_accounting");
{
  const a = LOG.accounting;
  const ok = Number(a.shortfall) === 0 && Number(a.in_flight) === 0 && BigInt(a.balance) === BigInt(a.unscheduled);
  LOG.accountingOk = ok;
  log("accounting", ok ? "OK: nothing in flight, nothing short, balance equals what is still owed" : `MISMATCH: ${JSON.stringify(a)}`);
}
LOG.finished = new Date().toISOString();
writeFileSync(LOGFILE, JSON.stringify(LOG, null, 1));
console.log("\nRESULTS", JSON.stringify(results, null, 1), "\nACCOUNTING", JSON.stringify(LOG.accounting));
