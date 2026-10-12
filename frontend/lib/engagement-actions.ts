import type { Engagement } from "./contracts/types.ts";

/** Mirrors RECOVERY_TIMEOUT_SECONDS in contracts/waypoint.py. */
export const RECOVERY_TIMEOUT_SECONDS = 86400;

export type StaleKind = "submitted" | "disputed";

export type EngagementAction =
  | "submit"
  | "reclaim_timeout"
  | "verify"
  | "release"
  | "challenge"
  | "resolve_dispute"
  | "reclaim_stale";

export interface ActionContext {
  /** The connected wallet, or null when nobody is connected. */
  address: string | null | undefined;
  /** Current unix time in seconds. */
  now: number;
}

function sameAddr(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Which kind of stale recovery the contract would accept right now, if any.
 * Mirrors reclaim_stale(): a submission is stuck once RECOVERY_TIMEOUT_SECONDS
 * have passed since the deadline, a dispute once they have passed since
 * disputed_at. A dispute with no recorded disputed_at is never stale, since
 * the contract measures from that timestamp.
 */
export function staleKind(e: Engagement, now: number): StaleKind | null {
  if (e.status === "submitted" && now >= Number(e.deadline) + RECOVERY_TIMEOUT_SECONDS) {
    return "submitted";
  }
  const disputedAt = Number(e.disputed_at);
  if (e.status === "disputed" && disputedAt > 0 && now >= disputedAt + RECOVERY_TIMEOUT_SECONDS) {
    return "disputed";
  }
  return null;
}

/**
 * The actions the connected wallet can usefully trigger, mapped one-to-one
 * from the contract's access rules:
 *  - submit: provider only, before the deadline
 *  - reclaim_timeout: client only, after the deadline, still funded
 *  - verify, release: permissionless
 *  - challenge: client only, inside the challenge window
 *  - resolve_dispute: permissionless, any connected account
 *  - reclaim_stale: a stuck dispute is permissionless (it releases to the
 *    provider); a stuck submission is client only (it refunds the client)
 */
export function availableActions(e: Engagement, ctx: ActionContext): EngagementAction[] {
  const actions: EngagementAction[] = [];
  const connected = !!ctx.address;
  const isClient = sameAddr(ctx.address, e.client);
  const isProvider = sameAddr(ctx.address, e.provider);
  const deadlinePassed = ctx.now > Number(e.deadline);
  const challengeOpen = e.status === "verified" && ctx.now < Number(e.challenge_deadline);

  if (e.status === "funded" && isProvider && !deadlinePassed) actions.push("submit");
  if (e.status === "funded" && isClient && deadlinePassed) actions.push("reclaim_timeout");
  if (e.status === "submitted" && connected) actions.push("verify");
  if (e.status === "verified" && !challengeOpen && connected) actions.push("release");
  if (e.status === "verified" && challengeOpen && isClient) actions.push("challenge");
  if (e.status === "disputed" && connected) actions.push("resolve_dispute");

  const stale = staleKind(e, ctx.now);
  if (stale === "disputed" && connected) actions.push("reclaim_stale");
  if (stale === "submitted" && isClient) actions.push("reclaim_stale");

  return actions;
}

/** What a stale recovery does, for the button label and a short note. */
export function staleOutcome(kind: StaleKind): { label: string; note: string } {
  return kind === "disputed"
    ? {
        label: "Recover Stuck Dispute",
        note: "Adjudication never reached a verdict in 24 hours. This falls back to the verified result and releases to the provider. Anyone can trigger it.",
      }
    : {
        label: "Recover Stuck Submission",
        note: "The marker never appeared within 24 hours of the deadline. This refunds the client, and only the client can trigger it.",
      };
}
