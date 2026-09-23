/**
 * TypeScript types for the GenLayer Waypoint contract
 */

export type EngagementStatus =
  | "funded"
  | "submitted"
  | "verified"
  | "disputed"
  | "released"
  | "refunded";

export interface Engagement {
  client: string;
  provider: string;
  deliverable_description: string;
  verification_url: string;
  verification_marker: string;
  amount: string; // wei, as decimal string
  deadline: string; // unix seconds
  status: EngagementStatus;
  created_at: string;
  submitted_at: string;
  verified_at: string;
  dispute_reason: string;
  resolution_note: string;
  challenge_deadline: string;
}

export interface TransactionReceipt {
  status: string;
  hash: string;
  blockNumber?: number;
  [key: string]: any;
}
