/**
 * TypeScript types for the GenLayer Waypoint contract (v3)
 */

export type EngagementStatus =
  | "proposed"
  | "funded"
  | "submitted"
  | "verified"
  | "disputed"
  | "upheld"
  | "overturned"
  | "released"
  | "refunded"
  | "split";

export interface Engagement {
  client: string;
  provider: string;
  deliverable_description: string;
  verification_url: string;
  verification_marker: string; // the whole line the page must contain
  reject_marker: string; // a whole line that makes the evidence contradictory, "" if none
  amount: string; // wei, as decimal string
  bond: string; // wei posted by the client when challenging, "0" until then
  required_bond: string; // wei a challenge must post (10% of the escrow, at least 1)
  deadline: string; // unix seconds
  challenge_window: string; // seconds the client may challenge after verification
  stale_after: string; // seconds before a stuck submission or dispute can be recovered
  status: EngagementStatus;
  submitted_at: string;
  verified_at: string;
  disputed_at: string; // unix seconds, "0" until challenged
  evidence_excerpt: string; // the lines validators agreed on at verification
  evidence_digest: string; // sha256 of that excerpt
  dispute_reason: string;
  resolution_note: string;
  challenge_deadline: string; // unix seconds, "0" until verified
  stale_at: string; // unix seconds a stuck submission or dispute becomes recoverable, "0" otherwise
  terms_hash: string; // sha256 of source, markers, description, amount and deadline; the provider's accept() must pass it
}

export interface TransactionReceipt {
  status: string;
  hash: string;
  blockNumber?: number;
  [key: string]: any;
}
