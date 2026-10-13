"use client";

import { useEffect, useMemo, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { CairnGlyph } from "@/components/CairnGlyph";
import { useWallet } from "@/lib/genlayer/wallet";
import {
  useEngagement,
  useEngagementList,
  useCreateEngagement,
  useAccept,
  useSubmitDeliverable,
  useVerify,
  useChallenge,
  useResolveDispute,
  useSettle,
  useRelease,
  useReclaimTimeout,
  useReclaimStale,
} from "@/lib/hooks/useWaypoint";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Engagement } from "@/lib/contracts/types";
import { getTxExplorerUrl } from "@/lib/genlayer/chains";
import { availableActions, challengeOpen as isChallengeOpen, staleKind, staleOutcome } from "@/lib/engagement-actions";
import { formatGen, MIN_WINDOW, MIN_STALE, markerProblem, requiredBond, urlProblem } from "@/lib/limits";
import type { WriteProgress } from "@/lib/hooks/useWaypoint";

const WINDOW_CHOICES = [
  { label: "1 hour", seconds: 3600 },
  { label: "6 hours", seconds: 6 * 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "3 days", seconds: 3 * 86400 },
  { label: "7 days", seconds: 7 * 86400 },
].filter((c) => c.seconds >= MIN_WINDOW);
const STALE_CHOICES = [
  { label: "2 hours", seconds: 7200 },
  { label: "12 hours", seconds: 12 * 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "3 days", seconds: 3 * 86400 },
  { label: "7 days", seconds: 7 * 86400 },
].filter((c) => c.seconds >= MIN_STALE);

function formatSpan(seconds: string): string {
  const n = Number(seconds);
  if (!n) return "—";
  if (n % 86400 === 0) return `${n / 86400} day${n === 86400 ? "" : "s"}`;
  if (n % 3600 === 0) return `${n / 3600} hour${n === 3600 ? "" : "s"}`;
  return `${Math.round(n / 60)} min`;
}

function shortAddr(hex: string): string {
  if (!hex) return "—";
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

function genToWei(input: string): bigint {
  const trimmed = input.trim();
  if (!trimmed) return BigInt(0);
  const neg = trimmed.startsWith("-");
  const body = neg ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ""] = body.split(".");
  const intPart = intPartRaw || "0";
  const fracPart = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return BigInt(0);
  const wei = BigInt(intPart) * BigInt(10) ** BigInt(18) + BigInt(fracPart || "0");
  return neg ? -wei : wei;
}

function formatDate(ts: string): string {
  const n = Number(ts);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function useNow(tickMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type TrailNode = { key: string; label: string; state: "pending" | "reached" | "current" | "branch"; time: string };

function buildTrail(e: Engagement): TrailNode[] {
  const nodes: TrailNode[] = [
    {
      // a refunded engagement that never submitted may have been cancelled before the provider accepted, so say only what is certain
      key: "funded", label: e.status === "proposed" ? "Proposed" : e.status === "refunded" && Number(e.submitted_at) === 0 ? "Funded" : "Accepted",
      state: e.status === "proposed" ? "current" : "reached", time: "—",
    },
    {
      key: "submitted", label: "Submitted",
      state: Number(e.submitted_at) > 0 ? (e.status === "submitted" ? "current" : "reached") : "pending",
      time: Number(e.submitted_at) > 0 ? formatDate(e.submitted_at) : "—",
    },
    {
      key: "verified", label: "Verified",
      state: Number(e.verified_at) > 0
        ? (e.status === "verified" ? "current" : "reached")
        : "pending",
      time: Number(e.verified_at) > 0 ? formatDate(e.verified_at) : "—",
    },
  ];

  if (e.status === "disputed") {
    nodes.push({ key: "disputed", label: "Disputed", state: "branch", time: "—" });
  } else if (e.status === "upheld" || e.status === "overturned") {
    nodes.push({ key: e.status, label: e.status === "upheld" ? "Upheld" : "Overturned", state: "branch", time: "—" });
  } else if (e.status === "released") {
    nodes.push({ key: "released", label: "Released", state: "current", time: "—" });
  } else if (e.status === "refunded") {
    nodes.push({ key: "refunded", label: "Refunded", state: "branch", time: "—" });
  } else if (e.status === "split") {
    nodes.push({ key: "split", label: "Split", state: "branch", time: "—" });
  } else {
    nodes.push({ key: "released", label: "Released", state: "pending", time: "—" });
  }

  return nodes;
}

function statusPillClass(status: string): string {
  if (status === "disputed") return "status-pill disputed";
  if (status === "released") return "status-pill released";
  if (status === "refunded" || status === "split") return "status-pill refunded";
  return "status-pill";
}

function statusLabel(e: Engagement, now: number): string {
  switch (e.status) {
    case "proposed": return "Proposed · Awaiting Provider";
    case "funded": return "Accepted · Awaiting Submission";
    case "submitted": return "Submitted · Awaiting Verification";
    case "verified": {
      return isChallengeOpen(e, now) ? "Verified · Challenge Window" : "Verified · Ready To Release";
    }
    case "disputed": return "Disputed · Awaiting Resolution";
    case "upheld": return "Upheld · Awaiting Settlement";
    case "overturned": return "Overturned · Awaiting Settlement";
    case "released": return "Released";
    case "refunded": return "Refunded";
    case "split": return "Split · Dispute Not Adjudicated";
    default: return e.status;
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>{label}</Label>
      {children}
      {hint && <div className="font-mono text-[0.68rem] mt-1" style={{ color: "var(--ink-faint)" }}>{hint}</div>}
    </div>
  );
}

function SelectField({ id, value, onChange, choices }: { id: string; value: number; onChange: (n: number) => void; choices: { label: string; seconds: number }[] }) {
  return (
    <select
      id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}
      className="mt-1 w-full h-9 px-2 text-sm bg-transparent border border-input outline-none focus-visible:border-ring font-mono"
      style={{ color: "var(--foreground)" }}
    >
      {choices.map((c) => <option key={c.seconds} value={c.seconds} style={{ background: "var(--card)" }}>{c.label}</option>)}
    </select>
  );
}

function CreateEngagementDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const { address } = useWallet();
  const create = useCreateEngagement();
  const [open, setOpen] = useState(false);
  const blank = { id: "", provider: "", description: "", url: "", marker: "", reject: "", deadline: "", amount: "" };
  const [form, setForm] = useState(blank);
  const [windowSeconds, setWindowSeconds] = useState(WINDOW_CHOICES[0].seconds);
  const [staleSeconds, setStaleSeconds] = useState(STALE_CHOICES[0].seconds);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const amountWei = genToWei(form.amount);
  const problems = [
    form.url ? urlProblem(form.url) : null,
    form.marker ? markerProblem(form.marker, "Marker") : null,
    form.reject ? markerProblem(form.reject, "Reject marker") : null,
    form.marker && form.reject && form.marker.trim().toLowerCase() === form.reject.trim().toLowerCase() ? "The reject marker must differ from the marker." : null,
  ].filter(Boolean) as string[];
  const complete = !!(form.id && form.provider && form.description && form.url && form.marker && form.deadline && amountWei > BigInt(0));

  const handleSubmit = () => {
    if (!complete || problems.length > 0) return;
    const deadlineTs = Math.floor(new Date(form.deadline).getTime() / 1000);
    create.run(
      {
        id: form.id, provider: form.provider, description: form.description, url: form.url, marker: form.marker,
        rejectMarker: form.reject, deadline: deadlineTs, challengeWindow: windowSeconds, staleAfter: staleSeconds, amountWei,
      },
      { onSuccess: () => { onCreated(form.id); setOpen(false); setForm(blank); } } as any
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="btn-field solid" disabled={!address}>+ New Engagement</button>
      </DialogTrigger>
      <DialogContent className="!rounded-none !bg-card !border-border-bright sm:!max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-head" style={{ letterSpacing: "0.02em" }}>New Engagement</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3.5 mt-1">
          <Field label="Engagement ID">
            <Input id="wp-id" value={form.id} onChange={set("id")} placeholder="wp-0043" className="mt-1 font-mono" />
          </Field>
          <Field label="Provider Address">
            <Input id="wp-provider" value={form.provider} onChange={set("provider")} placeholder="0x…" className="mt-1 font-mono" />
          </Field>
          <Field label="Deliverable" hint="The disputes judge against exactly this text, so be specific about what counts as done.">
            <textarea
              id="wp-description" value={form.description} onChange={set("description")}
              placeholder="Ship the Q3 pricing release to production together with a published migration guide"
              rows={3}
              className="mt-1 w-full px-3 py-2 text-sm bg-transparent border border-input outline-none focus-visible:border-ring"
              style={{ fontFamily: "var(--font-body)", color: "var(--foreground)" }}
            />
          </Field>
          <Field label="Verification URL" hint="A public https page both sides can see. Validators fetch it themselves.">
            <Input id="wp-url" value={form.url} onChange={set("url")} placeholder="https://…" className="mt-1 font-mono" />
          </Field>
          <Field label="Verification Marker (a whole line)" hint="Must be an entire line of the page, not a phrase inside one. Negated, quoted or partial text never counts. Include something specific such as a date or version.">
            <Input id="wp-marker" value={form.marker} onChange={set("marker")} placeholder="Q3 pricing release shipped to production 2026" className="mt-1 font-mono" />
          </Field>
          <Field label="Reject Marker (optional, a whole line)" hint="If this line appears too, the evidence is contradictory and verification is refused.">
            <Input id="wp-reject" value={form.reject} onChange={set("reject")} placeholder="Q3 pricing release was rolled back from production 2026" className="mt-1 font-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Deadline">
              <Input id="wp-deadline" type="datetime-local" value={form.deadline} onChange={set("deadline")} className="mt-1 font-mono" />
            </Field>
            <Field label="Amount (GEN)" hint={amountWei > BigInt(0) ? `A challenge posts a ${formatGen(requiredBond(amountWei).toString())} GEN bond.` : undefined}>
              <Input id="wp-amount" value={form.amount} onChange={set("amount")} placeholder="2.5" className="mt-1 font-mono" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Challenge Window" hint="Kept above Bradbury's ~30 min finality so a challenge is never cut off.">
              <SelectField id="wp-window" value={windowSeconds} onChange={setWindowSeconds} choices={WINDOW_CHOICES} />
            </Field>
            <Field label="Recover After" hint="How long a stuck submission or dispute waits before it can be recovered.">
              <SelectField id="wp-stale" value={staleSeconds} onChange={setStaleSeconds} choices={STALE_CHOICES} />
            </Field>
          </div>
          {problems.map((p) => (
            <div key={p} className="font-mono text-xs" style={{ color: "var(--rust)" }}>{p}</div>
          ))}
          <div className="font-mono text-[0.68rem]" style={{ color: "var(--ink-faint)" }}>
            The provider must accept before work starts. Until then you can cancel and take the escrow back.
          </div>
        </div>
        <DialogFooter className="mt-4">
          <button className="btn-field solid w-full" onClick={handleSubmit} disabled={create.isPending || !complete || problems.length > 0}>
            {create.isPending ? "Escrowing…" : "Fund Escrow"}
          </button>
        </DialogFooter>
        <TxProgress progress={create.progress} pending={create.isPending} />
      </DialogContent>
    </Dialog>
  );
}

const STAGES: { key: WriteProgress["stage"]; label: string }[] = [
  { key: "signing", label: "Sign in wallet" },
  { key: "submitted", label: "Sent" },
  { key: "accepted", label: "Accepted by validators" },
  { key: "confirmed", label: "State confirmed" },
];

/** Shows how far a write has got. "Accepted" is not "done": done is the contract state read back, and money moves on finalization. */
function TxProgress({ progress, pending }: { progress: WriteProgress | null; pending: boolean }) {
  if (!progress) return null;
  const order = ["signing", "submitted", "accepted", "confirmed", "finalized"];
  const at = order.indexOf(progress.stage);
  return (
    <div className="mt-4 font-mono text-[0.7rem]" style={{ color: "var(--ink-faint)" }}>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {STAGES.map((st) => {
          const i = order.indexOf(st.key);
          const done = at > i || (at === i && st.key === "confirmed");
          const current = at === i && !done;
          return (
            <span key={st.key} style={{ color: done ? "var(--moss)" : current && pending ? "var(--brass-bright)" : "var(--ink-faint)" }}>
              {done ? "✓" : current && pending ? "…" : "·"} {st.label}
            </span>
          );
        })}
        {progress.movesFunds && (
          <span style={{ color: progress.stage === "finalized" ? "var(--moss)" : "var(--brass-bright)" }}>
            {progress.stage === "finalized" ? "✓ Finalized, funds delivered" : "… Waiting for finality (funds move then, about 30 min)"}
          </span>
        )}
      </div>
      {progress.txHash && (
        <a className="break-all underline" style={{ color: "var(--brass-bright)" }} href={getTxExplorerUrl(progress.txHash)} target="_blank" rel="noreferrer">
          {progress.txHash.slice(0, 14)}…
        </a>
      )}
    </div>
  );
}

function ChallengeDialog({ engagement, engagementId }: { engagement: Engagement; engagementId: string }) {
  const challenge = useChallenge();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const bond = BigInt(engagement.required_bond);
  const short = reason.length > 0 && reason.length < 20;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="btn-field danger">Challenge Verification</button>
      </DialogTrigger>
      <DialogContent className="!rounded-none !bg-card !border-border-bright sm:!max-w-md">
        <DialogHeader>
          <DialogTitle className="font-head" style={{ letterSpacing: "0.02em" }}>Challenge This Verification</DialogTitle>
        </DialogHeader>
        <div className="mt-1">
          <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Why doesn&apos;t this satisfy the agreement?</Label>
          <textarea
            id="wp-challenge-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="mt-1 w-full px-3 py-2 text-sm bg-transparent border border-input outline-none focus-visible:border-ring"
            style={{ fontFamily: "var(--font-body)", color: "var(--foreground)" }}
          />
          {short && <div className="font-mono text-xs mt-1" style={{ color: "var(--rust)" }}>At least 20 characters, so the reviewers have something to weigh.</div>}
          <div className="font-mono text-xs mt-3" style={{ color: "var(--ink-faint)" }}>
            Filing posts a bond of exactly <span style={{ color: "var(--brass-bright)" }}>{formatGen(bond.toString())} GEN</span> (10% of the escrow).
            If the objection is upheld you get the escrow and the bond back. If it fails, the provider receives both. If nobody can
            adjudicate it in time, the escrow is split evenly and your bond goes to the provider, so anyone can push a verdict by resolving the dispute.
          </div>
        </div>
        <DialogFooter className="mt-4">
          <button
            className="btn-field danger w-full"
            disabled={reason.length < 20 || challenge.isPending}
            onClick={() => challenge.run({ id: engagementId, reason, bondWei: bond }, { onSuccess: () => { setOpen(false); setReason(""); } } as any)}
          >
            {challenge.isPending ? "Filing…" : `File Challenge (bond ${formatGen(bond.toString())} GEN)`}
          </button>
        </DialogFooter>
        <TxProgress progress={challenge.progress} pending={challenge.isPending} />
      </DialogContent>
    </Dialog>
  );
}

function EngagementHero({ id }: { id: string }) {
  const { data: e, isLoading } = useEngagement(id);
  const { address } = useWallet();
  const now = useNow();
  const acceptAction = useAccept();
  const submitAction = useSubmitDeliverable();
  const verifyAction = useVerify();
  const resolveAction = useResolveDispute();
  const settleAction = useSettle();
  const releaseAction = useRelease();
  const reclaimAction = useReclaimTimeout();
  const staleAction = useReclaimStale();

  if (isLoading) {
    return <div className="p-8 text-center font-mono text-sm" style={{ color: "var(--ink-faint)" }}>Loading engagement…</div>;
  }
  if (!e) {
    return (
      <div className="p-8 text-center font-mono text-sm" style={{ color: "var(--ink-faint)" }}>
        Engagement &quot;{id}&quot; not found.
      </div>
    );
  }

  const actions = availableActions(e, { address, now });
  const stale = staleKind(e, now);
  const trail = buildTrail(e);
  const challengeCloses = Number(e.challenge_deadline);
  const challengeOpen = isChallengeOpen(e, now);
  const staleAt = Number(e.stale_at);
  const all = [acceptAction, submitAction, verifyAction, resolveAction, settleAction, releaseAction, reclaimAction, staleAction];
  // the action that reported progress most recently, not the first hook that ever did
  const active = all.filter((a) => a.progress).sort((x, y) => (y.progress?.at ?? 0) - (x.progress?.at ?? 0))[0];

  return (
    <div className="p-7 sm:p-8" style={{ background: "var(--card)", border: "1px solid var(--border-bright)" }}>
      <div className="flex justify-between items-start gap-5 flex-wrap mb-5.5" style={{ marginBottom: "22px" }}>
        <div>
          <div className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>
            CLIENT {shortAddr(e.client)} → PROVIDER {shortAddr(e.provider)}
          </div>
          <h2 className="font-head mt-1 text-2xl max-w-[40ch]" style={{ textWrap: "balance" }}>
            {e.deliverable_description}
          </h2>
        </div>
        <span className={statusPillClass(e.status)}>
          <span className="dot" /> {statusLabel(e, now)}
        </span>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="flex items-start" style={{ minWidth: 520, paddingTop: 6 }}>
          {trail.map((n) => (
            <div key={n.key} className={`trail-node ${n.state === "reached" || n.state === "current" ? "reached" : ""} ${n.state}`}>
              <div className="trail-line" />
              <div className="disk"><div className="disk-inner" /></div>
              <div className="trail-label">{n.label}</div>
              <div className="trail-time">{n.time}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1.3fr_1fr] gap-6 mt-7">
        <div>
          <div className="eyebrow mb-2">Evidence</div>
          <p className="field-note break-words">
            Validators independently fetch <span className="break-all" style={{ color: "var(--brass-bright)" }}>{e.verification_url}</span> and
            require this exact line:{" "}
            <span style={{ color: "var(--brass-bright)" }}>&quot;{e.verification_marker}&quot;</span>.
            A line that only contains, negates or quotes it does not count.
            {e.reject_marker && (
              <>
                <br />If the page also has the line <span style={{ color: "var(--rust)" }}>&quot;{e.reject_marker}&quot;</span>, verification is refused as contradictory.
              </>
            )}
            {e.evidence_excerpt && (
              <>
                <br /><br />
                <span style={{ color: "var(--moss)" }}>Committed evidence:</span> &quot;{e.evidence_excerpt}&quot;
                <br />
                <span className="break-all" style={{ color: "var(--ink-faint)" }}>sha256 {e.evidence_digest}</span>
                <br />A dispute is judged against this recorded excerpt and the page as it reads now, not the page alone.
              </>
            )}
            {e.dispute_reason && (
              <>
                <br /><br />
                <span style={{ color: "var(--rust)" }}>Dispute:</span> {e.dispute_reason}
              </>
            )}
            {e.resolution_note && (
              <>
                <br /><br />
                <span style={{ color: "var(--moss)" }}>Resolution:</span> {e.resolution_note}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <div className="eyebrow mb-1">Terms</div>
          <div className="kv-row"><span className="k">AMOUNT ESCROWED</span><span className="v amount">{formatGen(e.amount)} GEN</span></div>
          <div className="kv-row"><span className="k">CHALLENGE BOND</span><span className="v">{formatGen(Number(e.bond) > 0 ? e.bond : e.required_bond)} GEN</span></div>
          <div className="kv-row"><span className="k">DEADLINE</span><span className="v">{formatDate(e.deadline)}</span></div>
          <div className="kv-row"><span className="k">CHALLENGE WINDOW</span><span className="v">{formatSpan(e.challenge_window)}</span></div>
          <div className="kv-row"><span className="k">RECOVER AFTER</span><span className="v">{formatSpan(e.stale_after)}</span></div>
          {challengeOpen && (
            <div className="kv-row"><span className="k">CHALLENGE CLOSES</span><span className="v brass tabular">T−{formatCountdown(challengeCloses - now)}</span></div>
          )}
          {staleAt > 0 && !stale && (
            <div className="kv-row"><span className="k">RECOVERABLE</span><span className="v">{formatDate(e.stale_at)}</span></div>
          )}
        </div>
      </div>

      <div className="flex gap-3 flex-wrap mt-6 pt-5" style={{ borderTop: "1px solid var(--border)" }}>
        {actions.includes("accept") && (
          <button className="btn-field solid" disabled={acceptAction.isPending} onClick={() => acceptAction.run({ id })}>
            {acceptAction.isPending ? "Accepting…" : "Accept Terms"}
          </button>
        )}
        {actions.includes("submit") && (
          <button className="btn-field solid" disabled={submitAction.isPending} onClick={() => submitAction.run({ id })}>
            {submitAction.isPending ? "Submitting…" : "Mark As Submitted"}
          </button>
        )}
        {actions.includes("reclaim_timeout") && (
          <button className="btn-field danger" disabled={reclaimAction.isPending} onClick={() => reclaimAction.run({ id })}>
            {reclaimAction.isPending ? "Reclaiming…" : e.status === "proposed" ? "Cancel And Reclaim" : "Reclaim Escrow"}
          </button>
        )}
        {actions.includes("verify") && (
          <button className="btn-field solid" disabled={verifyAction.isPending} onClick={() => verifyAction.run({ id })}>
            {verifyAction.isPending ? "Verifying…" : "Verify Now"}
          </button>
        )}
        {actions.includes("release") && (
          <button className="btn-field solid" disabled={releaseAction.isPending} onClick={() => releaseAction.run({ id })}>
            {releaseAction.isPending ? "Releasing…" : "Release Now"}
          </button>
        )}
        {actions.includes("challenge") && <ChallengeDialog engagement={e} engagementId={id} />}
        {actions.includes("resolve_dispute") && (
          <button className="btn-field danger" disabled={resolveAction.isPending} onClick={() => resolveAction.run({ id })}>
            {resolveAction.isPending ? "Resolving…" : "Resolve Dispute"}
          </button>
        )}
        {actions.includes("settle") && (
          <button className="btn-field solid" disabled={settleAction.isPending} onClick={() => settleAction.run({ id })}>
            {settleAction.isPending ? "Settling…" : e.status === "upheld" ? "Settle: Pay The Provider" : "Settle: Refund The Client"}
          </button>
        )}
        {actions.includes("reclaim_stale") && stale && (
          <button className="btn-field danger" disabled={staleAction.isPending} onClick={() => staleAction.run({ id })}>
            {staleAction.isPending ? "Recovering…" : staleOutcome(stale).label}
          </button>
        )}
        {!address && <span className="font-mono text-xs self-center" style={{ color: "var(--ink-faint)" }}>Register your instrument above to act on this engagement.</span>}
      </div>

      {active && <TxProgress progress={active.progress} pending={active.isPending} />}

      {(e.status === "upheld" || e.status === "overturned") && (
        <div className="mt-4 font-mono text-xs" style={{ color: "var(--ink-faint)" }}>
          The verdict is recorded but no money has moved. Settling is a separate transaction that anyone can send; the funds arrive when it finalizes.
        </div>
      )}

      {e.status === "disputed" && !stale && (
        <div className="mt-4 font-mono text-xs" style={{ color: "var(--ink-faint)" }}>
          Anyone can resolve this dispute. If the reviewers cannot reach a clear verdict nothing changes and it can be retried.
        </div>
      )}

      {stale && (
        <div className="mt-4 flex items-start gap-2 font-mono text-xs" style={{ color: "var(--rust)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rust)", marginTop: 5 }} />
          {staleOutcome(stale).note}
        </div>
      )}

      {challengeOpen && (
        <div className="mt-4 flex items-center gap-2 font-mono text-xs" style={{ color: "var(--rust)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rust)" }} />
          Client can still challenge for {formatCountdown(challengeCloses - now)} before release becomes final.
        </div>
      )}
    </div>
  );
}

function EngagementLogRow({ id, e, onSelect, active }: { id: string; e: Engagement; onSelect: () => void; active: boolean }) {
  const nodes = buildTrail(e);
  return (
    <button
      onClick={onSelect}
      className="w-full text-left grid gap-4 items-center py-4 px-1"
      style={{
        gridTemplateColumns: "90px 1fr auto auto",
        borderBottom: "1px solid var(--border)",
        background: active ? "var(--secondary)" : "transparent",
      }}
    >
      <div className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>{id}</div>
      <div>
        <div className="text-[0.95rem]" style={{ fontFamily: "var(--font-body)", color: "var(--foreground)" }}>
          {e.deliverable_description}
        </div>
        <div className="font-mono text-[0.68rem] mt-0.5" style={{ color: "var(--ink-faint)" }}>
          {shortAddr(e.client)} → {shortAddr(e.provider)}
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-[3px]">
        {nodes.map((n, i) => (
          <span key={n.key}>
            {i > 0 && <span className={`mini-tick ${n.state === "reached" || n.state === "current" ? "reached" : ""}`} />}
            <span className={`mini-disk ${n.state}`} />
          </span>
        ))}
      </div>
      <div className="text-right">
        <div className="font-mono text-sm" style={{ color: "var(--moss)" }}>{formatGen(e.amount)} GEN</div>
        <div className={`font-mono text-[0.65rem] uppercase tracking-wide mt-0.5`} style={{
          color: e.status === "disputed" ? "var(--rust)" : e.status === "released" ? "var(--brass-bright)" : e.status === "refunded" ? "var(--slate)" : "var(--muted-foreground)"
        }}>
          {e.status}
        </div>
      </div>
    </button>
  );
}

export default function HomePage() {
  const { data: list, isLoading } = useEngagementList();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && list && list.length > 0) {
      setSelectedId(list[list.length - 1].id);
    }
  }, [list, selectedId]);

  const others = useMemo(() => (list ?? []).filter((r) => r.id !== selectedId).slice().reverse(), [list, selectedId]);

  return (
    <div className="max-w-[1040px] mx-auto px-5 pb-16 pt-7 overflow-x-hidden">
      <Navbar />

      <div className="flex justify-between items-end gap-4 flex-wrap mb-6">
        <div>
          <h1 className="font-head text-3xl" style={{ textWrap: "balance" }}>
            {selectedId ? `Engagement ${selectedId}` : "No Engagements Yet"}
          </h1>
          <div className="font-mono text-xs mt-1.5 max-w-[46ch]" style={{ color: "var(--ink-faint)" }}>
            Every stage below is a checkpoint validators independently confirm — not a status your counterparty can just claim.
          </div>
        </div>
        <CreateEngagementDialog onCreated={setSelectedId} />
      </div>

      <div className="mb-10">
        {isLoading && (
          <div className="p-8 text-center font-mono text-sm" style={{ color: "var(--ink-faint)" }}>Loading…</div>
        )}
        {!isLoading && !selectedId && (
          <div className="p-10 flex flex-col items-center gap-3 text-center" style={{ background: "var(--card)", border: "1px dashed var(--border-bright)" }}>
            <CairnGlyph size={44} tone="brass" />
            <div className="font-mono text-sm" style={{ color: "var(--ink-faint)" }}>
              No engagements on this contract yet. Fund the first one to see its trail here.
            </div>
          </div>
        )}
        {selectedId && <EngagementHero id={selectedId} />}
      </div>

      {others.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Engagement Log</div>
          <div style={{ borderTop: "1px solid var(--border)" }}>
            {others.map(({ id, engagement }) => (
              <EngagementLogRow key={id} id={id} e={engagement} active={id === selectedId} onSelect={() => setSelectedId(id)} />
            ))}
          </div>
        </div>
      )}

      <footer className="flex justify-between flex-wrap gap-2 mt-14 pt-5 font-mono text-[0.68rem]" style={{ borderTop: "1px solid var(--border)", color: "var(--ink-faint)" }}>
        <div>Waypoint — every checkpoint is independently confirmed by GenLayer validators, not taken on trust.</div>
      </footer>
    </div>
  );
}
