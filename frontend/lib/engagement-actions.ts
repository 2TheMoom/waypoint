import type { Engagement } from "./contracts/types.ts";

export type StaleKind = "submitted" | "disputed";

export type EngagementAction =
  | "accept"
  | "submit"
  | "reclaim_timeout"
  | "verify"
  | "release"
  | "challenge"
  | "resolve_dispute"
  | "settle"
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
 * Mirrors reclaim_stale(): a submission is stuck once stale_after seconds
 * have passed since the deadline, a dispute once they have passed since
 * disputed_at. The contract reports that moment as stale_at.
 */
export function staleKind(e: Engagement, now: number): StaleKind | null {
  const staleAt = Number(e.stale_at);
  if (staleAt <= 0 || now < staleAt) return null;
  if (e.status === "submitted") return "submitted";
  if (e.status === "disputed") return "disputed";
  return null;
}

/** The challenge window is inclusive of its last second, exactly as challenge() checks it. */
export function challengeOpen(e: Engagement, now: number): boolean {
  return e.status === "verified" && now <= Number(e.challenge_deadline);
}

/**
 * The actions the connected wallet can usefully trigger, mapped one-to-one
 * from the contract's access rules:
 *  - accept: provider only, while the proposal is open and before the deadline
 *  - submit: provider only, after accepting and before the deadline
 *  - reclaim_timeout: client only; an unaccepted proposal any time, an
 *    accepted engagement once the deadline has passed with no submission
 *  - verify: permissionless
 *  - release: permissionless, once the challenge window has closed
 *  - challenge: client only, inside the challenge window, with a bond
 *  - resolve_dispute: permissionless; only records the verdict (upheld or
 *    overturned) and moves no money
 *  - settle: permissionless; pays a recorded verdict in its own transaction
 *  - reclaim_stale: a stuck dispute is permissionless (it splits the escrow
 *    and returns the bond); a stuck submission is client only (it refunds)
 */
export function availableActions(e: Engagement, ctx: ActionContext): EngagementAction[] {
  const actions: EngagementAction[] = [];
  const connected = !!ctx.address;
  const isClient = sameAddr(ctx.address, e.client);
  const isProvider = sameAddr(ctx.address, e.provider);
  const deadlinePassed = ctx.now >= Number(e.deadline);
  const open = challengeOpen(e, ctx.now);

  if (e.status === "proposed" && isProvider && !deadlinePassed) actions.push("accept");
  if (e.status === "proposed" && isClient) actions.push("reclaim_timeout");
  if (e.status === "funded" && isProvider && !deadlinePassed) actions.push("submit");
  if (e.status === "funded" && isClient && ctx.now > Number(e.deadline)) actions.push("reclaim_timeout");
  if (e.status === "submitted" && connected) actions.push("verify");
  if (e.status === "verified" && !open && connected) actions.push("release");
  if (e.status === "verified" && open && isClient) actions.push("challenge");
  if (e.status === "disputed" && connected) actions.push("resolve_dispute");
  if ((e.status === "upheld" || e.status === "overturned") && connected) actions.push("settle");

  const stale = staleKind(e, ctx.now);
  if (stale === "disputed" && connected) actions.push("reclaim_stale");
  if (stale === "submitted" && isClient) actions.push("reclaim_stale");

  return actions;
}

/** What a stale recovery does, for the button label and a short note. */
export function staleOutcome(kind: StaleKind): { label: string; note: string } {
  return kind === "disputed"
    ? {
        label: "Split Stuck Dispute",
        note: "Nobody could adjudicate this dispute in time. The escrow is split evenly between provider and client, and the client's bond goes to the provider. Anyone can trigger it.",
      }
    : {
        label: "Recover Stuck Submission",
        note: "The evidence was never verified. This refunds the client, and only the client can trigger it.",
      };
}

/** Status the engagement must reach for a write to count as done (read back after every transaction). */
export function expectedStatus(action: EngagementAction | "create", before?: Engagement | null): (e: Engagement) => boolean {
  switch (action) {
    case "create": return (e) => e.status === "proposed";
    case "accept": return (e) => e.status === "funded";
    case "submit": return (e) => e.status === "submitted";
    case "verify": return (e) => e.status === "verified";
    case "challenge": return (e) => e.status === "disputed";
    case "release": return (e) => e.status === "released";
    case "reclaim_timeout": return (e) => e.status === "refunded";
    case "reclaim_stale": return (e) => e.status === "refunded" || e.status === "split";
    // an inconclusive verdict reverts, so a dispute that is still "disputed" means nothing changed
    case "resolve_dispute": return (e) => e.status === "upheld" || e.status === "overturned";
    case "settle": return (e) => e.status === "released" || e.status === "refunded";
    default: return () => true;
  }
}

/**
 * True for actions that move funds: the transfer only lands when the transaction finalizes.
 * resolve_dispute is deliberately not one of them: it runs the model and only records a verdict.
 */
export function movesFunds(action: EngagementAction | "create" | "challenge"): boolean {
  return action === "release" || action === "reclaim_timeout" || action === "reclaim_stale" || action === "settle";
}
