// Live proof that a Waypoint payout is delivered exactly once.
//
// Creates a 0.01 GEN engagement with a short deadline, lets it lapse, and
// reclaims it (the client is paid). Then tries to reclaim the same
// engagement again, which must fail, and prints get_accounting(): right
// after the payout, in_flight equals the payout (scheduled, waiting for the
// transaction to finalize). Once the reclaim transaction finalizes the
// transfer lands and in_flight returns to 0; watch that with
//   genlayer call <CONTRACT> get_accounting
//
// Usage: node verify-payee-live.mjs
// Signs with the dedicated testnet wallets in
// C:/Users/olumi/.genlayer-test-wallets/wallets.json (outside every repo).

import { readFileSync } from "fs";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CONTRACT = "0x1d30EDaf43d1f044A638a0ED2fD6AD3783b3AA37";
const PROVIDER = "0x0e298b9e366f3d58f5389d7297de1b9fdf6e9374";
const ENGAGEMENT_ID = "wp-once-" + Date.now();
const VALUE = 10000000000000000n; // 0.01 GEN
const URL = "https://raw.githubusercontent.com/genlayerlabs/genlayer-project-boilerplate/main/README.md";

const WALLETS = JSON.parse(readFileSync("C:/Users/olumi/.genlayer-test-wallets/wallets.json", "utf8"));

function wallet(name) {
  const w = WALLETS[name];
  if (!w) throw new Error(`No test wallet named ${name}`);
  return createAccount(w.privateKey);
}

async function send(client, functionName, args, value) {
  const hash = await client.writeContract({ address: CONTRACT, functionName, args, ...(value ? { value } : {}) });
  console.log(`  ${functionName}: ${hash}`);
  let receipt;
  for (let attempt = 1; ; attempt++) {
    try {
      receipt = await client.waitForTransactionReceipt({ hash, retries: 200 });
      break;
    } catch (e) {
      // A dropped RPC connection while polling doesn't mean the transaction failed.
      if (attempt >= 10) throw e;
      console.log(`  (receipt poll failed, retrying: ${String(e.message || e).slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  console.log(`  exec=${receipt.txExecutionResultName}`);
  return receipt;
}

async function accounting(client) {
  const a = await client.readContract({ address: CONTRACT, functionName: "get_accounting", args: [] });
  console.log("  get_accounting:", Object.fromEntries(a instanceof Map ? a : Object.entries(a)));
}

async function main() {
  const client = createClient({ chain: testnetBradbury, account: wallet("gl-test-1") });
  const deadline = Math.floor(Date.now() / 1000) + 150;

  console.log(`\n1. create_engagement ${ENGAGEMENT_ID} (0.01 GEN escrowed)...`);
  await send(client, "create_engagement", [ENGAGEMENT_ID, PROVIDER, "Exactly-once payout check", URL, "football bets", deadline], VALUE);
  await accounting(client);

  console.log("\nWaiting for the deadline to pass...");
  const waitMs = (deadline - Math.floor(Date.now() / 1000) + 20) * 1000;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  console.log("\n2. reclaim_timeout (pays the client once)...");
  await send(client, "reclaim_timeout", [ENGAGEMENT_ID]);
  await accounting(client);

  console.log("\n3. reclaim_timeout again (must fail, nothing sent)...");
  try {
    await send(client, "reclaim_timeout", [ENGAGEMENT_ID]);
  } catch (e) {
    console.log("  refused:", String(e.message || e).slice(0, 200));
  }
  await accounting(client);
  console.log(`\nDone. Engagement: ${ENGAGEMENT_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
