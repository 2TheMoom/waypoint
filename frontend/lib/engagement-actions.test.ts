import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeEngagement } from "./contracts/decode.ts";
import type { Engagement } from "./contracts/types.ts";
import { availableActions, challengeOpen, expectedStatus, movesFunds, staleKind, staleOutcome } from "./engagement-actions.ts";
import { BOND_BPS, MAX_MARKER, MAX_STALE, MAX_WINDOW, MIN_MARKER, MIN_STALE, MIN_WINDOW, markerProblem, normalizeLine, requiredBond, urlProblem } from "./limits.ts";

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
    ...over,
  };
}

describe("limits match the contract", () => {
  const source = readFileSync(new URL("../../contracts/waypoint.py", import.meta.url), "utf8");
  const constant = (name: string) => {
    const m = source.match(new RegExp(`^${name}\\s*=\\s*([0-9 *]+)`, "m"));
    assert.ok(m, `${name} not found in the contract`);
    return m[1].split("*").reduce((a, b) => a * Number(b.trim()), 1);
  };
  it("every constant the form validates against is the contract's", () => {
    assert.equal(MIN_WINDOW, constant("MIN_WINDOW"));
    assert.equal(MAX_WINDOW, constant("MAX_WINDOW"));
    assert.equal(MIN_STALE, constant("MIN_STALE"));
    assert.equal(MAX_STALE, constant("MAX_STALE"));
    assert.equal(BOND_BPS, constant("BOND_BPS"));
    assert.equal(MIN_MARKER, constant("MIN_MARKER"));
    assert.equal(MAX_MARKER, constant("MAX_MARKER"));
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
  it("falls back to safe defaults", () => {
    const e = decodeEngagement(new Map());
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
    assert.match(staleOutcome("disputed").note, /bond is returned/);
    assert.doesNotMatch(staleOutcome("disputed").note, /releases to the provider/);
  });
});

describe("write confirmation", () => {
  it("each write has the status it must read back", () => {
    assert.ok(expectedStatus("accept")(engagement({ status: "funded" })));
    assert.ok(!expectedStatus("accept")(engagement({ status: "proposed" })));
    assert.ok(expectedStatus("challenge")(engagement({ status: "disputed" })));
    assert.ok(!expectedStatus("resolve_dispute")(engagement({ status: "disputed" })));
    assert.ok(expectedStatus("resolve_dispute")(engagement({ status: "refunded" })));
    assert.ok(expectedStatus("reclaim_stale")(engagement({ status: "split" })));
  });
  it("only fund-moving actions wait for finality", () => {
    assert.ok(movesFunds("release") && movesFunds("resolve_dispute") && movesFunds("reclaim_stale") && movesFunds("reclaim_timeout"));
    assert.ok(!movesFunds("verify") && !movesFunds("accept") && !movesFunds("create"));
  });
});
