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

export function decodeEngagement(raw: any): Engagement {
  const obj = toPlainObject(raw);
  return {
    client: String(obj.client ?? ""),
    provider: String(obj.provider ?? ""),
    deliverable_description: String(obj.deliverable_description ?? ""),
    verification_url: String(obj.verification_url ?? ""),
    verification_marker: String(obj.verification_marker ?? ""),
    amount: String(obj.amount ?? "0"),
    deadline: String(obj.deadline ?? "0"),
    status: String(obj.status ?? "funded") as Engagement["status"],
    created_at: String(obj.created_at ?? "0"),
    submitted_at: String(obj.submitted_at ?? "0"),
    verified_at: String(obj.verified_at ?? "0"),
    disputed_at: String(obj.disputed_at ?? "0"),
    dispute_reason: String(obj.dispute_reason ?? ""),
    resolution_note: String(obj.resolution_note ?? ""),
    challenge_deadline: String(obj.challenge_deadline ?? "0"),
  };
}
