"use client";

import { useEffect, useMemo, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { CairnGlyph } from "@/components/CairnGlyph";
import { useWallet } from "@/lib/genlayer/wallet";
import {
  useEngagement,
  useEngagementList,
  useCreateEngagement,
  useSubmitDeliverable,
  useVerify,
  useChallenge,
  useResolveDispute,
  useRelease,
  useReclaimTimeout,
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

const CHALLENGE_WINDOW_SECONDS = 600;

function shortAddr(hex: string): string {
  if (!hex) return "—";
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

function sameAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function formatGen(wei: string): string {
  const n = Number(wei) / 1e18;
  if (!Number.isFinite(n)) return "0.000";
  return n.toFixed(3);
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
    { key: "funded", label: "Funded", state: "reached", time: formatDate(e.created_at) },
    {
      key: "submitted", label: "Submitted",
      state: Number(e.submitted_at) > 0 ? (e.status === "submitted" ? "current" : "reached") : "pending",
      time: Number(e.submitted_at) > 0 ? formatDate(e.submitted_at) : "—",
    },
    {
      key: "verified", label: "Verified",
      state: Number(e.verified_at) > 0
        ? (e.status === "verified" ? "current" : e.status === "disputed" ? "reached" : "reached")
        : "pending",
      time: Number(e.verified_at) > 0 ? formatDate(e.verified_at) : "—",
    },
  ];

  if (e.status === "disputed") {
    nodes.push({ key: "disputed", label: "Disputed", state: "branch", time: "—" });
  } else if (e.status === "released") {
    nodes.push({ key: "released", label: "Released", state: "current", time: "—" });
  } else if (e.status === "refunded") {
    nodes.push({ key: "refunded", label: "Refunded", state: "branch", time: "—" });
  } else {
    nodes.push({ key: "released", label: "Released", state: "pending", time: "—" });
  }

  return nodes;
}

function statusPillClass(status: string): string {
  if (status === "disputed") return "status-pill disputed";
  if (status === "released") return "status-pill released";
  if (status === "refunded") return "status-pill refunded";
  return "status-pill";
}

function statusLabel(e: Engagement, now: number): string {
  switch (e.status) {
    case "funded": return "Funded · Awaiting Submission";
    case "submitted": return "Submitted · Awaiting Verification";
    case "verified": {
      const closes = Number(e.challenge_deadline);
      return now < closes ? "Verified · Challenge Window" : "Verified · Ready To Release";
    }
    case "disputed": return "Disputed · Awaiting Resolution";
    case "released": return "Released";
    case "refunded": return "Refunded";
    default: return e.status;
  }
}

function CreateEngagementDialog() {
  const { address } = useWallet();
  const create = useCreateEngagement();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    id: "", provider: "", description: "", url: "", marker: "", deadline: "", amount: "",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = () => {
    if (!form.id || !form.provider || !form.description || !form.url || !form.marker || !form.deadline || !form.amount) return;
    const deadlineTs = Math.floor(new Date(form.deadline).getTime() / 1000);
    create.run(
      { id: form.id, provider: form.provider, description: form.description, url: form.url, marker: form.marker, deadline: deadlineTs, amountWei: genToWei(form.amount) },
      { onSuccess: () => { setOpen(false); setForm({ id: "", provider: "", description: "", url: "", marker: "", deadline: "", amount: "" }); } } as any
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="btn-field solid" disabled={!address}>+ New Engagement</button>
      </DialogTrigger>
      <DialogContent className="!rounded-none !bg-card !border-border-bright sm:!max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-head" style={{ letterSpacing: "0.02em" }}>New Engagement</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3.5 mt-1">
          <div>
            <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Engagement ID</Label>
            <Input value={form.id} onChange={set("id")} placeholder="wp-0043" className="mt-1 font-mono" />
          </div>
          <div>
            <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Provider Address</Label>
            <Input value={form.provider} onChange={set("provider")} placeholder="0x…" className="mt-1 font-mono" />
          </div>
          <div>
            <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Deliverable</Label>
            <textarea
              value={form.description} onChange={set("description")}
              placeholder="Deploy the marketing site with the Q3 pricing table live"
              rows={3}
              className="mt-1 w-full px-3 py-2 text-sm bg-transparent border border-input outline-none focus-visible:border-ring"
              style={{ fontFamily: "var(--font-body)", color: "var(--foreground)" }}
            />
          </div>
          <div>
            <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Verification URL</Label>
            <Input value={form.url} onChange={set("url")} placeholder="https://…" className="mt-1 font-mono" />
          </div>
          <div>
            <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Verification Marker</Label>
            <Input value={form.marker} onChange={set("marker")} placeholder="text that must appear once done" className="mt-1 font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Deadline</Label>
              <Input type="datetime-local" value={form.deadline} onChange={set("deadline")} className="mt-1 font-mono" />
            </div>
            <div>
              <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Amount (GEN)</Label>
              <Input value={form.amount} onChange={set("amount")} placeholder="2.5" className="mt-1 font-mono" />
            </div>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <button className="btn-field solid w-full" onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending ? "Escrowing…" : "Fund Escrow"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChallengeDialog({ engagementId }: { engagementId: string }) {
  const challenge = useChallenge();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

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
          <Label className="font-mono text-xs" style={{ color: "var(--ink-faint)" }}>Why doesn't this satisfy the agreement?</Label>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="mt-1 w-full px-3 py-2 text-sm bg-transparent border border-input outline-none focus-visible:border-ring"
            style={{ fontFamily: "var(--font-body)", color: "var(--foreground)" }}
          />
        </div>
        <DialogFooter className="mt-4">
          <button
            className="btn-field danger w-full"
            disabled={!reason || challenge.isPending}
            onClick={() => challenge.run({ id: engagementId, reason }, { onSuccess: () => { setOpen(false); setReason(""); } } as any)}
          >
            {challenge.isPending ? "Filing…" : "File Challenge"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EngagementHero({ id }: { id: string }) {
  const { data: e, isLoading } = useEngagement(id);
  const { address } = useWallet();
  const now = useNow();
  const submitAction = useSubmitDeliverable();
  const verifyAction = useVerify();
  const resolveAction = useResolveDispute();
  const releaseAction = useRelease();
  const reclaimAction = useReclaimTimeout();

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

  const isClient = sameAddr(address, e.client);
  const isProvider = sameAddr(address, e.provider);
  const trail = buildTrail(e);
  const challengeCloses = Number(e.challenge_deadline);
  const challengeOpen = e.status === "verified" && now < challengeCloses;
  const deadlinePassed = now > Number(e.deadline);

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

      <div className="grid gap-6 mt-7" style={{ gridTemplateColumns: "1.3fr 1fr" }}>
        <div>
          <div className="eyebrow mb-2">Verification</div>
          <p className="field-note">
            Validators independently fetch <span style={{ color: "var(--brass-bright)" }}>{e.verification_url}</span> and
            confirm the marker <span style={{ color: "var(--brass-bright)" }}>&quot;{e.verification_marker}&quot;</span> is present —
            not either party&apos;s word for it.
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
          <div className="kv-row"><span className="k">DEADLINE</span><span className="v">{formatDate(e.deadline)}</span></div>
          {challengeOpen && (
            <div className="kv-row"><span className="k">CHALLENGE CLOSES</span><span className="v brass tabular">T−{formatCountdown(challengeCloses - now)}</span></div>
          )}
        </div>
      </div>

      <div className="flex gap-3 flex-wrap mt-6 pt-5" style={{ borderTop: "1px solid var(--border)" }}>
        {e.status === "funded" && isProvider && !deadlinePassed && (
          <button className="btn-field solid" disabled={submitAction.isPending} onClick={() => submitAction.run({ id })}>
            {submitAction.isPending ? "Submitting…" : "Mark As Submitted"}
          </button>
        )}
        {e.status === "funded" && isClient && deadlinePassed && (
          <button className="btn-field danger" disabled={reclaimAction.isPending} onClick={() => reclaimAction.run({ id })}>
            {reclaimAction.isPending ? "Reclaiming…" : "Reclaim Escrow"}
          </button>
        )}
        {e.status === "submitted" && (
          <button className="btn-field solid" disabled={verifyAction.isPending} onClick={() => verifyAction.run({ id })}>
            {verifyAction.isPending ? "Verifying…" : "Verify Now"}
          </button>
        )}
        {e.status === "verified" && !challengeOpen && (
          <button className="btn-field solid" disabled={releaseAction.isPending} onClick={() => releaseAction.run({ id })}>
            {releaseAction.isPending ? "Releasing…" : "Release Now"}
          </button>
        )}
        {e.status === "verified" && challengeOpen && isClient && <ChallengeDialog engagementId={id} />}
        {e.status === "disputed" && isProvider && (
          <button className="btn-field danger" disabled={resolveAction.isPending} onClick={() => resolveAction.run({ id })}>
            {resolveAction.isPending ? "Resolving…" : "Resolve Dispute"}
          </button>
        )}
        {!address && <span className="font-mono text-xs self-center" style={{ color: "var(--ink-faint)" }}>Register your instrument above to act on this engagement.</span>}
      </div>

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
    <div className="max-w-[1040px] mx-auto px-5 pb-16 pt-7">
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
        <CreateEngagementDialog />
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
