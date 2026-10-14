"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Waypoint, { type CreateArgs, type WriteProgress } from "../contracts/Waypoint";
import { getContractAddress, getStudioUrl } from "../genlayer/client";
import { useWallet } from "../genlayer/wallet";
import { success, error, info, configError } from "../utils/toast";
import type { Engagement } from "../contracts/types";
import { addPendingWrite, settlePendingWrite } from "../finality-store";

export type { WriteProgress };

export function useWaypointContract(): Waypoint | null {
  const { address } = useWallet();
  const contractAddress = getContractAddress();
  const rpcUrl = getStudioUrl();

  const contract = useMemo(() => {
    if (!contractAddress) {
      configError(
        "Setup Required",
        "Contract address not configured. Please set NEXT_PUBLIC_CONTRACT_ADDRESS in your .env file.",
        { label: "Setup Guide", onClick: () => window.open("/docs/setup", "_blank") }
      );
      return null;
    }
    return new Waypoint(contractAddress, address, rpcUrl);
  }, [contractAddress, address, rpcUrl]);

  return contract;
}

export function useEngagement(engagementId: string) {
  const contract = useWaypointContract();

  return useQuery<Engagement | null, Error>({
    queryKey: ["engagement", engagementId],
    queryFn: () => (contract ? contract.getEngagement(engagementId) : Promise.resolve(null)),
    refetchOnWindowFocus: true,
    refetchInterval: 20000,
    staleTime: 2000,
    enabled: !!contract && !!engagementId,
  });
}

/** The newest engagement ids (one page from the end of the list, never the whole history). */
export function useRecentEngagementIds(limit = 20) {
  const contract = useWaypointContract();

  return useQuery<string[], Error>({
    queryKey: ["engagementIds", limit],
    queryFn: () => (contract ? contract.getRecentEngagementIds(limit) : Promise.resolve([])),
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
    staleTime: 2000,
    enabled: !!contract,
  });
}

export function useEngagementList() {
  const contract = useWaypointContract();
  const idsQuery = useRecentEngagementIds();

  const listQuery = useQuery<Array<{ id: string; engagement: Engagement }>, Error>({
    queryKey: ["engagementList", idsQuery.data],
    queryFn: async () => {
      if (!contract || !idsQuery.data) return [];
      const results = await Promise.all(
        idsQuery.data.map(async (id) => ({ id, engagement: await contract.getEngagement(id) }))
      );
      return results.filter((r): r is { id: string; engagement: Engagement } => r.engagement !== null);
    },
    enabled: !!contract && !!idsQuery.data,
    staleTime: 2000,
  });

  return { ...listQuery, isLoading: idsQuery.isLoading || listQuery.isLoading };
}

type Runner<TArgs> = (contract: Waypoint, args: TArgs, onProgress: (p: WriteProgress) => void) => Promise<string>;

function useWriteAction<TArgs>(
  action: Runner<TArgs>,
  messages: { confirmed: { title: string; description: string }; finalized?: { title: string; description: string } },
  errorTitle: string,
  getEngagementId: (args: TArgs) => string
) {
  const contract = useWaypointContract();
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<(WriteProgress & { at: number }) | null>(null);

  const refresh = (id: string) => {
    queryClient.invalidateQueries({ queryKey: ["engagement", id] });
    queryClient.invalidateQueries({ queryKey: ["engagementIds"] });
    queryClient.invalidateQueries({ queryKey: ["engagementList"] });
  };

  const mutation = useMutation({
    mutationFn: async (args: TArgs) => {
      if (!contract) throw new Error("Contract not configured. Please set NEXT_PUBLIC_CONTRACT_ADDRESS in your .env file.");
      if (!address) throw new Error("Wallet not connected. Please connect your wallet first.");
      setIsPending(true);
      setProgress(null);
      const id = getEngagementId(args);
      return action(contract, args, (p) => {
        setProgress({ ...p, at: Date.now() });
        if (p.stage === "confirmed" && p.txHash) addPendingWrite(id, { label: messages.confirmed.title, txHash: p.txHash, since: Date.now() });
        if (p.stage === "finalized" && p.txHash) settlePendingWrite(id, p.txHash);
        if (p.stage === "failed" && p.txHash) settlePendingWrite(id, p.txHash, p.message || "Did not finalize as expected.");
        if (p.stage === "finalized") {
          refresh(id);
          const done = messages.finalized ?? {
            title: `${messages.confirmed.title}, final`,
            description: "The transaction finalized with a successful result and the engagement shows it.",
          };
          success(done.title, { description: done.description });
        } else if (p.stage === "failed") {
          refresh(id);
          error(`${messages.confirmed.title}: not final`, { description: p.message || "The transaction did not finalize as expected." });
        }
      });
    },
    onSuccess: (_data, args) => {
      refresh(getEngagementId(args));
      setIsPending(false);
      // Recorded, not done: the success message comes when the transaction finalizes.
      info(`${messages.confirmed.title}: recorded, waiting for finality`, {
        description: `${messages.confirmed.description} It counts as done once it finalizes (about 30 minutes on Bradbury).`,
        duration: 8000,
      });
    },
    onError: (err: any) => {
      console.error(errorTitle, err);
      setIsPending(false);
      setProgress(null);
      error(errorTitle, { description: err?.message || "Please try again." });
    },
  });

  return {
    ...mutation,
    isPending,
    progress,
    clearProgress: () => setProgress(null),
    run: mutation.mutate,
  };
}

const PAYS = "Funds are delivered when the transaction finalizes (about 30 minutes on Bradbury).";

export function useCreateEngagement() {
  return useWriteAction<CreateArgs>(
    (c, a, onProgress) => c.createEngagement(a, { onProgress }),
    { confirmed: { title: "Proposal funded", description: "The escrow is held. The provider must accept before work starts." } },
    "Failed to create engagement",
    (a) => a.id
  );
}

export function useAccept() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.accept(a.id, { onProgress }),
    { confirmed: { title: "Accepted", description: "The provider agreed to the terms." } },
    "Failed to accept",
    (a) => a.id
  );
}

export function useSubmitDeliverable() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.submit(a.id, { onProgress }),
    { confirmed: { title: "Submitted", description: "Marked ready for verification." } },
    "Failed to submit",
    (a) => a.id
  );
}

export function useVerify() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.verify(a.id, { onProgress }),
    { confirmed: { title: "Verified", description: "Validators agreed the marker is a whole line of the page. The excerpt and its hash are recorded." } },
    "Verification did not go through",
    (a) => a.id
  );
}

export function useChallenge() {
  return useWriteAction<{ id: string; reason: string; bondWei: bigint }>(
    (c, a, onProgress) => c.challenge(a.id, a.reason, a.bondWei, { onProgress }),
    { confirmed: { title: "Challenge filed", description: "Your bond is held until the dispute is resolved." } },
    "Failed to challenge",
    (a) => a.id
  );
}

export function useResolveDispute() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.resolveDispute(a.id, { onProgress }),
    { confirmed: { title: "Verdict recorded", description: "No money has moved yet. Anyone can now settle it to send the funds." } },
    "Failed to resolve dispute",
    (a) => a.id
  );
}

export function useSettle() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.settle(a.id, { onProgress }),
    {
      confirmed: { title: "Settlement recorded", description: PAYS },
      finalized: { title: "Settled", description: "The transaction finalized and the funds were delivered." },
    },
    "Failed to settle",
    (a) => a.id
  );
}

export function useRelease() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.release(a.id, { onProgress }),
    {
      confirmed: { title: "Release recorded", description: PAYS },
      finalized: { title: "Released", description: "The transaction finalized and the provider was paid." },
    },
    "Failed to release",
    (a) => a.id
  );
}

export function useReclaimStale() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.reclaimStale(a.id, { onProgress }),
    {
      confirmed: { title: "Recovery recorded", description: PAYS },
      finalized: { title: "Recovered", description: "The transaction finalized and the funds were delivered." },
    },
    "Failed to recover the engagement",
    (a) => a.id
  );
}

export function useReclaimTimeout() {
  return useWriteAction<{ id: string }>(
    (c, a, onProgress) => c.reclaimTimeout(a.id, { onProgress }),
    {
      confirmed: { title: "Reclaim recorded", description: PAYS },
      finalized: { title: "Refunded", description: "The transaction finalized and the escrow was returned." },
    },
    "Failed to reclaim",
    (a) => a.id
  );
}
