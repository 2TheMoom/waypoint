import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeEngagement } from "./contracts/decode.ts";
import type { Engagement } from "./contracts/types.ts";
import { availableActions, challengeOpen, expectedStatus, finalStatus, movesFunds, staleKind, staleOutcome } from "./engagement-actions.ts";
import { failedReceiptMessage } from "./receipt.ts";
import { formatGen, BOND_BPS, MAX_MARKER, MAX_PAGE_BYTES, MAX_STALE, MAX_WINDOW, MIN_MARKER, MIN_STALE, MIN_WINDOW, markerNamesEngagement, markerProblem, normalizeLine, requiredBond, urlProblem } from "./limits.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const T = 1_800_000_000;
const HOUR = 3600;

function engagement(over: Partial<Engagement>): Engagement {
  return {
    client: CLIENT,
    provider: PROVIDER,
    deliverable_description: "d",
    verification_url: "https://example.com/x",
    verification_marker: "release 1 shipped",
    reject_marker: "",
    amount: "1000",
    bond: "0",
    required_bond: "100",
    deadline: String(T + 3600),
    challenge_window: String(HOUR),
    stale_after: String(2 * HOUR),
    status: "funded",
    submitted_at: "0",
    verified_at: "0",
    disputed_at: "0",
    evidence_excerpt: "",
    evidence_digest: "",
    dispute_reason: "",
    resolution_note: "",
    challenge_deadline: "0",
    stale_at: "0",
    terms_hash: "ab".repeat(32),
    ...over,
  };
}

describe("limits match the contract", () => {
  const source = readFileSync(new URL("../../contracts/waypoint.py", import.meta.url), "utf8");
  const constant = (name: string) => {
    const m = source.match(new RegExp(`^${name}\\s*=\\s*([0-9_ *]+)`, "m"));
    assert.ok(m, `${name} not found in the contract`);
    return m[1].replace(/_/g, "").split("*").reduce((a, b) => a * Number(b.trim()), 1);
  };
  it("every constant the form validates against is the contract's", () => {
    assert.equal(MIN_WINDOW, constant("MIN_WINDOW"));
    assert.equal(MAX_WINDOW, constant("MAX_WINDOW"));
    assert.equal(MIN_STALE, constant("MIN_STALE"));
    assert.equal(MAX_STALE, constant("MAX_STALE"));
    assert.equal(BOND_BPS, constant("BOND_BPS"));
    assert.equal(MIN_MARKER, constant("MIN_MARKER"));
    assert.equal(MAX_MARKER, constant("MAX_MARKER"));
    assert.equal(MAX_PAGE_BYTES, constant("MAX_BODY"));
  });
  it("the challenge window is longer than the ~30 minute finality measured on Bradbury", () => {
    assert.ok(MIN_WINDOW >= 2 * 30 * 60);
  });
});

describe("validation mirrors the contract", () => {
  it("normalizes like the contract", () => {
    assert.equal(normalizeLine("  It’s   Done Now "), "it's done now");
  });
  it("refuses short, digit-less and letter-less markers", () => {
    assert.ok(markerProblem("done 1"));
    assert.ok(markerProblem("shipped to production now"));
    assert.ok(markerProblem("123456789012"));
    assert.ok(markerProblem("x1".repeat(101)));
    assert.equal(markerProblem("Release 4.2 shipped"), null);
  });
  it("the marker line must name the engagement, the way the contract compares it", () => {
    assert.ok(markerNamesEngagement("Release 4.2 shipped for wp-0043", "wp-0043"));
    assert.ok(markerNamesEngagement("release 4.2 shipped for WP-0043", "Wp-0043"));
    assert.ok(markerNamesEngagement("release 4.2 shipped for wp   q3", "WP  Q3"));
    assert.ok(!markerNamesEngagement("Release 4.2 shipped", "wp-0043"));
    assert.ok(!markerNamesEngagement("Release 4.2 shipped for wp-0044", "wp-0043"));
  });
  it("refuses the urls the contract refuses", () => {
    for (const u of ["http://a.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://a.com:8080/x", "https://u:p@a.com/x", "https://printer.local/x", "https://nodots/x"]) {
      assert.ok(urlProblem(u), u);
    }
    assert.equal(urlProblem("https://raw.githubusercontent.com/o/r/main/status.txt"), null);
  });
  it("the bond is 10% of the escrow, at least 1", () => {
    assert.equal(requiredBond(BigInt(1000)), BigInt(100));
    assert.equal(requiredBond(BigInt(5)), BigInt(1));
    assert.equal(requiredBond(BigInt("2000000000000000")), BigInt("200000000000000"));
  });
});

describe("decodeEngagement", () => {
  it("decodes the v3 fields from the Map genlayer-js returns", () => {
    const e = decodeEngagement(
      new Map<string, unknown>([["status", "split"], ["bond", 100n], ["stale_at", 1_799_999_000n], ["evidence_digest", "ab12"]]),
    );
    assert.equal(e.status, "split");
    assert.equal(e.bond, "100");
    assert.equal(e.stale_at, "1799999000");
    assert.equal(e.evidence_digest, "ab12");
  });
  it("decodes the terms hash the provider's accept() must pass", () => {
    assert.equal(decodeEngagement(new Map<string, unknown>([["terms_hash", "cd".repeat(32)]])).terms_hash, "cd".repeat(32));
  });
  it("falls back to safe defaults", () => {
    const e = decodeEngagement(new Map());
    assert.equal(e.terms_hash, "");
    assert.equal(e.challenge_window, "0");
    assert.equal(e.reject_marker, "");
  });
});

describe("availableActions follows the contract's access rules", () => {
  const act = (e: Engagement, address: string | null, now: number) => availableActions(e, { address, now });

  it("proposed: the provider accepts, the client may cancel, nobody else can act", () => {
    const e = engagement({ status: "proposed" });
    assert.deepEqual(act(e, PROVIDER, T), ["accept"]);
    assert.deepEqual(act(e, CLIENT, T), ["reclaim_timeout"]);
    assert.deepEqual(act(e, STRANGER, T), []);
    assert.deepEqual(act(e, PROVIDER, T + 3600), []); // deadline reached: accept() refuses
    assert.deepEqual(act(e, CLIENT, T + 99999), ["reclaim_timeout"]);
  });

  it("funded: only the provider submits, before the deadline; the client reclaims after it", () => {
    const e = engagement({ status: "funded" });
    assert.deepEqual(act(e, PROVIDER, T), ["submit"]);
    assert.deepEqual(act(e, CLIENT, T), []);
    assert.deepEqual(act(e, PROVIDER, T + 3600), []);
    assert.deepEqual(act(e, CLIENT, T + 3600), []); // reclaim needs strictly after the deadline
    assert.deepEqual(act(e, CLIENT, T + 3601), ["reclaim_timeout"]);
    assert.deepEqual(act(e, STRANGER, T + 3601), []);
  });

  it("submitted: anyone connected can verify, nobody when disconnected", () => {
    const e = engagement({ status: "submitted" });
    assert.deepEqual(act(e, STRANGER, T), ["verify"]);
    assert.deepEqual(act(e, null, T), []);
  });

  it("verified: only the client challenges inside the window, anyone releases after it (boundary is inclusive)", () => {
    const e = engagement({ status: "verified", verified_at: String(T), challenge_deadline: String(T + HOUR) });
    assert.deepEqual(act(e, CLIENT, T + HOUR), ["challenge"]);
    assert.deepEqual(act(e, PROVIDER, T + HOUR), []);
    assert.deepEqual(act(e, STRANGER, T + HOUR), []);
    assert.deepEqual(act(e, STRANGER, T + HOUR + 1), ["release"]);
    assert.deepEqual(act(e, CLIENT, T + HOUR + 1), ["release"]);
    assert.equal(challengeOpen(e, T + HOUR), true);
    assert.equal(challengeOpen(e, T + HOUR + 1), false);
  });

  it("disputed: anyone connected can resolve; recovery appears only when stale", () => {
    const e = engagement({ status: "disputed", disputed_at: String(T), stale_at: String(T + 2 * HOUR) });
    assert.deepEqual(act(e, STRANGER, T + 1), ["resolve_dispute"]);
    assert.deepEqual(act(e, STRANGER, T + 2 * HOUR - 1), ["resolve_dispute"]);
    assert.deepEqual(act(e, STRANGER, T + 2 * HOUR), ["resolve_dispute", "reclaim_stale"]);
    assert.deepEqual(act(e, null, T + 2 * HOUR), []);
  });

  it("a recorded verdict can only be settled, by anyone connected", () => {
    for (const status of ["upheld", "overturned"] as const) {
      const e = engagement({ status });
      assert.deepEqual(act(e, STRANGER, T), ["settle"]);
      assert.deepEqual(act(e, CLIENT, T), ["settle"]);
      assert.deepEqual(act(e, null, T), []);
      assert.deepEqual(availableActions(e, { address: CLIENT, now: T + 1e9 }), ["settle"]); // no timeout path out of a verdict
    }
  });

  it("stuck submission: only the client can recover it", () => {
    const e = engagement({ status: "submitted", stale_at: String(T + 3600 + 2 * HOUR) });
    const stale = T + 3600 + 2 * HOUR;
    assert.deepEqual(act(e, CLIENT, stale), ["verify", "reclaim_stale"]);
    assert.deepEqual(act(e, STRANGER, stale), ["verify"]);
    assert.deepEqual(act(e, CLIENT, stale - 1), ["verify"]);
  });

  it("settled engagements offer nothing", () => {
    for (const status of ["released", "refunded", "split"] as const) {
      assert.deepEqual(availableActions(engagement({ status }), { address: CLIENT, now: T + 10_000_000 }), []);
    }
  });
});

describe("staleKind and wording", () => {
  it("is null without a stale_at, before it, and in other states", () => {
    assert.equal(staleKind(engagement({ status: "submitted", stale_at: "0" }), T + 1e9), null);
    assert.equal(staleKind(engagement({ status: "disputed", stale_at: String(T + 10) }), T + 9), null);
    assert.equal(staleKind(engagement({ status: "verified", stale_at: String(T) }), T + 10), null);
  });
  it("names the split, not a release, for a stuck dispute", () => {
    assert.match(staleOutcome("disputed").note, /split evenly/);
    assert.match(staleOutcome("disputed").note, /bond goes to the provider/);
    assert.doesNotMatch(staleOutcome("disputed").note, /bond is returned/);
  });
});

describe("write confirmation", () => {
  it("each write has the status it must read back", () => {
    assert.ok(expectedStatus("accept")(engagement({ status: "funded" })));
    assert.ok(!expectedStatus("accept")(engagement({ status: "proposed" })));
    assert.ok(expectedStatus("challenge")(engagement({ status: "disputed" })));
    assert.ok(!expectedStatus("resolve_dispute")(engagement({ status: "disputed" })));
    assert.ok(expectedStatus("resolve_dispute")(engagement({ status: "upheld" })));
    assert.ok(expectedStatus("resolve_dispute")(engagement({ status: "overturned" })));
    assert.ok(!expectedStatus("resolve_dispute")(engagement({ status: "released" })));
    assert.ok(expectedStatus("settle")(engagement({ status: "released" })));
    assert.ok(expectedStatus("settle")(engagement({ status: "refunded" })));
    assert.ok(!expectedStatus("settle")(engagement({ status: "upheld" })));
    assert.ok(expectedStatus("reclaim_stale")(engagement({ status: "split" })));
  });
  it("after finality the engagement must be at least as far along as the write made it", () => {
    // the write stuck, or someone else moved it further on: fine
    assert.ok(finalStatus("verify")(engagement({ status: "verified" })));
    assert.ok(finalStatus("verify")(engagement({ status: "released" })));
    assert.ok(finalStatus("challenge")(engagement({ status: "overturned" })));
    assert.ok(finalStatus("resolve_dispute")(engagement({ status: "refunded" })));
    // an earlier state means the write did not stick
    assert.ok(!finalStatus("verify")(engagement({ status: "submitted" })));
    assert.ok(!finalStatus("accept")(engagement({ status: "proposed" })));
    assert.ok(!finalStatus("challenge")(engagement({ status: "verified" })));
    assert.ok(!finalStatus("resolve_dispute")(engagement({ status: "disputed" })));
    for (const a of ["settle", "release", "reclaim_timeout", "reclaim_stale"] as const) {
      assert.ok(!finalStatus(a)(engagement({ status: "upheld" })), a);
      assert.ok(finalStatus(a)(engagement({ status: "refunded" })), a);
    }
  });
  it("only fund-moving actions say funds move on finalization", () => {
    assert.ok(movesFunds("release") && movesFunds("settle") && movesFunds("reclaim_stale") && movesFunds("reclaim_timeout"));
    // resolve_dispute runs the model and only records a verdict: no transfer may share its transaction
    assert.ok(!movesFunds("resolve_dispute") && !movesFunds("verify") && !movesFunds("accept") && !movesFunds("create"));
  });
});

describe("formatGen", () => {
  it("keeps precision for small amounts instead of rounding to zero", () => {
    assert.equal(formatGen("200000000000000"), "0.0002");
    assert.equal(formatGen("2000000000000000"), "0.002");
    assert.equal(formatGen("1100000000000000"), "0.0011");
    assert.equal(formatGen("1000000000"), "0.000000001");
  });
  it("shows at least three decimals and rounds large amounts", () => {
    assert.equal(formatGen("0"), "0.000");
    assert.equal(formatGen("500000000000000000"), "0.500");
    assert.equal(formatGen("2500000000000000000"), "2.500");
    assert.equal(formatGen("not a number"), "0.000");
  });
});

describe("failedReceiptMessage", () => {
  it("explains a validator timeout as nothing recorded, even if the wallet shows confirmed", () => {
    for (const statusName of ["LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "UNDETERMINED", "CANCELED"]) {
      const m = failedReceiptMessage({ statusName }, "resolve_dispute", "0xabc");
      assert.match(m ?? "", /Nothing was recorded/);
      assert.match(m ?? "", /try again/);
      assert.match(m ?? "", new RegExp(statusName));
    }
    assert.match(failedReceiptMessage({ txExecutionResultName: "NOT_VOTED" }, "settle", "0x1") ?? "", /Nothing was recorded/);
  });
  it("reports a contract refusal separately", () => {
    const m = failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR" }, "verify", "0x2");
    assert.match(m ?? "", /The contract refused verify/);
    assert.doesNotMatch(m ?? "", /Validators did not complete/);
  });
  it("says nothing when the contract ran and returned", () => {
    assert.equal(failedReceiptMessage({ statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN" }, "accept", "0x3"), null);
    assert.equal(failedReceiptMessage({ statusName: "FINALIZED" }, "accept", "0x3"), null);
    assert.equal(failedReceiptMessage(undefined, "accept", "0x3"), null);
  });
});
