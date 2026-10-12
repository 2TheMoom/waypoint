import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeEngagement } from "./contracts/decode.ts";
import type { Engagement } from "./contracts/types.ts";
import { RECOVERY_TIMEOUT_SECONDS, availableActions, staleKind, staleOutcome } from "./engagement-actions.ts";

const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const T = 1_800_000_000;
// Hard-coded on purpose: this is the contract's 24 hours, not whatever the app module says.
const DAY = 86400;

function engagement(over: Partial<Engagement>): Engagement {
  return {
    client: CLIENT,
    provider: PROVIDER,
    deliverable_description: "d",
    verification_url: "https://example.com",
    verification_marker: "m",
    amount: "1000",
    deadline: String(T + 3600),
    status: "funded",
    created_at: String(T),
    submitted_at: "0",
    verified_at: "0",
    disputed_at: "0",
    dispute_reason: "",
    resolution_note: "",
    challenge_deadline: "0",
    ...over,
  };
}

describe("recovery window matches the contract", () => {
  it("the app constant equals RECOVERY_TIMEOUT_SECONDS in contracts/waypoint.py", () => {
    const source = readFileSync(new URL("../../contracts/waypoint.py", import.meta.url), "utf8");
    const match = source.match(/^RECOVERY_TIMEOUT_SECONDS\s*=\s*(\d+)/m);
    assert.ok(match, "constant not found in the contract");
    assert.equal(RECOVERY_TIMEOUT_SECONDS, Number(match[1]));
    assert.equal(RECOVERY_TIMEOUT_SECONDS, DAY);
  });
});

describe("decodeEngagement", () => {
  it("decodes disputed_at from the Map genlayer-js returns", () => {
    const e = decodeEngagement(new Map<string, unknown>([["status", "disputed"], ["disputed_at", 1_799_999_000n]]));
    assert.equal(e.disputed_at, "1799999000");
    assert.equal(e.status, "disputed");
  });

  it("decodes disputed_at from a plain object", () => {
    assert.equal(decodeEngagement({ disputed_at: 42 }).disputed_at, "42");
  });

  it('defaults disputed_at to "0" when the contract has not set it', () => {
    assert.equal(decodeEngagement({}).disputed_at, "0");
  });
});

describe("staleKind mirrors reclaim_stale eligibility", () => {
  it("a submission is stale exactly at deadline + 24h, not a second before", () => {
    const e = engagement({ status: "submitted", deadline: String(T) });
    assert.equal(staleKind(e, T + DAY - 1), null);
    assert.equal(staleKind(e, T + DAY), "submitted");
  });

  it("a dispute is stale exactly at disputed_at + 24h, not a second before", () => {
    const e = engagement({ status: "disputed", disputed_at: String(T) });
    assert.equal(staleKind(e, T + DAY - 1), null);
    assert.equal(staleKind(e, T + DAY), "disputed");
  });

  it("measures a dispute from disputed_at, not from the deadline", () => {
    const e = engagement({ status: "disputed", deadline: String(T - 10 * DAY), disputed_at: String(T) });
    assert.equal(staleKind(e, T + 60), null);
  });

  it("never treats a dispute with no disputed_at as stale", () => {
    const e = engagement({ status: "disputed", disputed_at: "0" });
    assert.equal(staleKind(e, T + 100 * DAY), null);
  });

  for (const status of ["funded", "verified", "released", "refunded"] as const) {
    it(`${status} is never stale`, () => {
      const e = engagement({ status, deadline: String(T - 100 * DAY), disputed_at: String(T - 100 * DAY) });
      assert.equal(staleKind(e, T), null);
    });
  }
});

describe("availableActions maps the contract's access rules", () => {
  it("lets any connected account resolve a dispute, and nobody when disconnected", () => {
    const e = engagement({ status: "disputed", disputed_at: String(T) });
    for (const who of [CLIENT, PROVIDER, STRANGER]) {
      assert.ok(availableActions(e, { address: who, now: T + 5 }).includes("resolve_dispute"), who);
    }
    assert.ok(!availableActions(e, { address: null, now: T + 5 }).includes("resolve_dispute"));
  });

  it("offers a stuck dispute recovery to any connected account", () => {
    const e = engagement({ status: "disputed", disputed_at: String(T) });
    const now = T + DAY;
    for (const who of [CLIENT, PROVIDER, STRANGER]) {
      assert.ok(availableActions(e, { address: who, now }).includes("reclaim_stale"), who);
    }
    assert.ok(!availableActions(e, { address: null, now }).includes("reclaim_stale"));
  });

  it("offers a stuck submission recovery to the client only", () => {
    const e = engagement({ status: "submitted", deadline: String(T) });
    const now = T + DAY;
    assert.ok(availableActions(e, { address: CLIENT, now }).includes("reclaim_stale"));
    assert.ok(!availableActions(e, { address: PROVIDER, now }).includes("reclaim_stale"));
    assert.ok(!availableActions(e, { address: STRANGER, now }).includes("reclaim_stale"));
  });

  it("offers no recovery before the 24h window", () => {
    const submitted = engagement({ status: "submitted", deadline: String(T) });
    const disputed = engagement({ status: "disputed", disputed_at: String(T) });
    assert.ok(!availableActions(submitted, { address: CLIENT, now: T + DAY - 1 }).includes("reclaim_stale"));
    assert.ok(!availableActions(disputed, { address: CLIENT, now: T + DAY - 1 }).includes("reclaim_stale"));
  });

  it("keeps submit provider-only and before the deadline", () => {
    const e = engagement({ status: "funded" });
    assert.ok(availableActions(e, { address: PROVIDER, now: T }).includes("submit"));
    assert.ok(!availableActions(e, { address: CLIENT, now: T }).includes("submit"));
    assert.ok(!availableActions(e, { address: PROVIDER, now: T + 7200 }).includes("submit"));
  });

  it("keeps reclaim_timeout client-only and after the deadline", () => {
    const e = engagement({ status: "funded" });
    assert.ok(availableActions(e, { address: CLIENT, now: T + 7200 }).includes("reclaim_timeout"));
    assert.ok(!availableActions(e, { address: CLIENT, now: T }).includes("reclaim_timeout"));
    assert.ok(!availableActions(e, { address: PROVIDER, now: T + 7200 }).includes("reclaim_timeout"));
  });

  it("keeps challenge client-only inside the window, and release after it", () => {
    const e = engagement({ status: "verified", verified_at: String(T), challenge_deadline: String(T + 600) });
    assert.deepEqual(availableActions(e, { address: CLIENT, now: T + 10 }), ["challenge"]);
    assert.deepEqual(availableActions(e, { address: PROVIDER, now: T + 10 }), []);
    assert.deepEqual(availableActions(e, { address: STRANGER, now: T + 601 }), ["release"]);
  });

  it("offers nothing on a settled engagement", () => {
    for (const status of ["released", "refunded"] as const) {
      assert.deepEqual(availableActions(engagement({ status }), { address: CLIENT, now: T + 100 * DAY }), []);
    }
  });
});

describe("staleOutcome describes what the contract really does", () => {
  it("says a stuck dispute releases to the provider and anyone can trigger it", () => {
    const o = staleOutcome("disputed");
    assert.match(o.note, /releases to the provider/i);
    assert.match(o.note, /anyone/i);
  });

  it("says a stuck submission refunds the client and only the client can trigger it", () => {
    const o = staleOutcome("submitted");
    assert.match(o.note, /refunds the client/i);
    assert.match(o.note, /only the client/i);
  });
});
