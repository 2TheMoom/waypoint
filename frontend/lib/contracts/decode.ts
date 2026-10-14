import type { Engagement } from "./types.ts";

/**
 * genlayer-js decodes Python dicts (and dataclasses) as JS Map instances,
 * keyed by field name. This flattens one level of the Map into a plain
 * object.
 */
function toPlainObject(raw: any): Record<string, any> {
  const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw ?? {});
  const obj: Record<string, any> = {};
  for (const [key, value] of entries) {
    obj[key] = value;
  }
  return obj;
}

const s = (v: unknown, fallback = "0") => String(v ?? fallback);

export function decodeEngagement(raw: any): Engagement {
  const obj = toPlainObject(raw);
  return {
    client: s(obj.client, ""),
    provider: s(obj.provider, ""),
    deliverable_description: s(obj.deliverable_description, ""),
    verification_url: s(obj.verification_url, ""),
    verification_marker: s(obj.verification_marker, ""),
    reject_marker: s(obj.reject_marker, ""),
    amount: s(obj.amount),
    bond: s(obj.bond),
    required_bond: s(obj.required_bond),
    deadline: s(obj.deadline),
    challenge_window: s(obj.challenge_window),
    stale_after: s(obj.stale_after),
    status: s(obj.status, "proposed") as Engagement["status"],
    submitted_at: s(obj.submitted_at),
    verified_at: s(obj.verified_at),
    disputed_at: s(obj.disputed_at),
    evidence_excerpt: s(obj.evidence_excerpt, ""),
    evidence_digest: s(obj.evidence_digest, ""),
    dispute_reason: s(obj.dispute_reason, ""),
    resolution_note: s(obj.resolution_note, ""),
    challenge_deadline: s(obj.challenge_deadline),
    stale_at: s(obj.stale_at),
    terms_hash: s(obj.terms_hash, ""),
  };
}
