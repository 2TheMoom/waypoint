// Proves the Payee (gl.evm.contract_interface) EOA-transfer fix actually
// delivers value, where the old gl.get_contract_at().emit_transfer() path
// silently lost it. Runs Waypoint's full unchallenged happy path for real:
// create_engagement -> submit -> verify -> release, then reads the
// provider's on-chain balance before and after to confirm it actually rose
// by the escrowed amount.
//
// Usage (PowerShell):
//   $env:PK = "0x<64-hex-char private key of the CLIENT account>"
//   node verify-payee-live.mjs
//
// The PROVIDER is a separate, already-funded-with-nothing test account
// (emit-transfer-tester, 0xf0c5d1ffc5f9659e85d5fba6c6c058c8a99657b1) - you
// don't need its key, only its address, since anyone can call submit()...
// actually submit() is provider-only, so this script needs the PROVIDER's
// key too. Set PK2 for that:
//   $env:PK2 = "0x<64-hex-char private key of emit-transfer-tester>"
//
// Get both via: genlayer account export --name <account-name>
// (exports a keystore file; decrypt it yourself, this script never sees
// your password)

import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CONTRACT = "0xC8B46819875aF8c66eCc6cBc407B32C73826061d";
const PROVIDER_ADDRESS = "0xf0c5d1ffc5f9659e85d5fba6c6c058c8a99657b1";
const ENGAGEMENT_ID = "wp-live-fix-" + Date.now();
const VALUE = 1000000000000000n; // 0.001 GEN

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Set $env:${name} first`);
  return v.startsWith("0x") ? v : "0x" + v;
}

async function waitAccepted(client, hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, retries: 200 });
  console.log(`  status=${receipt.statusName} result=${receipt.resultName} exec=${receipt.txExecutionResultName}`);
  if (receipt.statusName !== "ACCEPTED" && receipt.statusName !== "FINALIZED") {
    throw new Error(`Transaction not accepted: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

async function main() {
  const clientAccount = createAccount(need("PK"));
  const providerAccount = createAccount(need("PK2"));

  const clientClient = createClient({ chain: testnetBradbury, account: clientAccount });
  const providerClient = createClient({ chain: testnetBradbury, account: providerAccount });

  const balanceBefore = await clientClient.getBalance({ address: PROVIDER_ADDRESS });
  console.log(`Provider balance before: ${balanceBefore} wei`);

  const deadline = Math.floor(Date.now() / 1000) + 3600;

  console.log("\n1. create_engagement (funding 0.001 GEN)...");
  let hash = await clientClient.writeContract({
    address: CONTRACT,
    functionName: "create_engagement",
    args: [
      ENGAGEMENT_ID,
      PROVIDER_ADDRESS,
      "Prove the Payee EOA transfer primitive genuinely delivers value",
      "https://raw.githubusercontent.com/genlayerlabs/genlayer-project-boilerplate/main/README.md",
      "football bets",
      deadline,
    ],
    value: VALUE,
  });
  await waitAccepted(clientClient, hash);

  console.log("\n2. submit (as provider)...");
  hash = await providerClient.writeContract({
    address: CONTRACT,
    functionName: "submit",
    args: [ENGAGEMENT_ID],
  });
  await waitAccepted(providerClient, hash);

  console.log("\n3. verify...");
  hash = await clientClient.writeContract({
    address: CONTRACT,
    functionName: "verify",
    args: [ENGAGEMENT_ID],
  });
  await waitAccepted(clientClient, hash);

  console.log("\nWaiting 11 minutes for the challenge window to close...");
  await new Promise((r) => setTimeout(r, 11 * 60 * 1000));

  console.log("\n4. release...");
  hash = await clientClient.writeContract({
    address: CONTRACT,
    functionName: "release",
    args: [ENGAGEMENT_ID],
  });
  await waitAccepted(clientClient, hash);

  const balanceAfter = await clientClient.getBalance({ address: PROVIDER_ADDRESS });
  console.log(`\nProvider balance after: ${balanceAfter} wei`);
  console.log(`Delta: ${balanceAfter - balanceBefore} wei (expected ${VALUE} wei)`);
  console.log(balanceAfter - balanceBefore === VALUE ? "\n✔ CONFIRMED: Payee delivered the exact escrowed amount." : "\n✖ Delta did not match - investigate.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
