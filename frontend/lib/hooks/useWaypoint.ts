"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Waypoint from "../contracts/Waypoint";
import { getContractAddress, getStudioUrl } from "../genlayer/client";
import { useWallet } from "../genlayer/wallet";
import { success, error, configError } from "../utils/toast";
import type { Engagement } from "../contracts/types";

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
    staleTime: 2000,
    enabled: !!contract && !!engagementId,
  });
}

export function useAllEngagementIds() {
  const contract = useWaypointContract();

  return useQuery<string[], Error>({
    queryKey: ["engagementIds"],
    queryFn: () => (contract ? contract.getAllEngagementIds() : Promise.resolve([])),
    refetchOnWindowFocus: true,
    staleTime: 2000,
    enabled: !!contract,
  });
}

export function useEngagementList() {
  const contract = useWaypointContract();
  const idsQuery = useAllEngagementIds();

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

function useWriteAction<TArgs>(
  action: (contract: Waypoint, args: TArgs, feePreset: any, onSubmitted: (h: string) => void) => Promise<string>,
  successMessage: { title: string; description: string },
  errorTitle: string,
  getEngagementId: (args: TArgs) => string
) {
  const contract = useWaypointContract();
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: TArgs) => {
      if (!contract) throw new Error("Contract not configured. Please set NEXT_PUBLIC_CONTRACT_ADDRESS in your .env file.");
      if (!address) throw new Error("Wallet not connected. Please connect your wallet first.");
      setIsPending(true);
      setPendingTxHash(null);
      return action(contract, args, undefined, setPendingTxHash);
    },
    onSuccess: (_data, args) => {
      const engagementId = getEngagementId(args);
      queryClient.invalidateQueries({ queryKey: ["engagement", engagementId] });
      queryClient.invalidateQueries({ queryKey: ["engagementIds"] });
      queryClient.invalidateQueries({ queryKey: ["engagementList"] });
      setIsPending(false);
      success(successMessage.title, { description: successMessage.description });
    },
    onError: (err: any) => {
      console.error(errorTitle, err);
      setIsPending(false);
      error(errorTitle, { description: err?.message || "Please try again." });
    },
  });

  return {
    ...mutation,
    isPending,
    pendingTxHash,
    clearPendingTx: () => setPendingTxHash(null),
    run: mutation.mutate,
  };
}

export interface CreateEngagementArgs {
  id: string;
  provider: string;
  description: string;
  url: string;
  marker: string;
  deadline: number;
  amountWei: bigint;
}

export function useCreateEngagement() {
  return useWriteAction<CreateEngagementArgs>(
    (c, a, fee, cb) => c.createEngagement(a.id, a.provider, a.description, a.url, a.marker, a.deadline, a.amountWei, fee, cb),
    { title: "Engagement funded", description: "The escrow is live on-chain." },
    "Failed to create engagement",
    (a) => a.id
  );
}

export function useSubmitDeliverable() {
  return useWriteAction<{ id: string }>(
    (c, a, fee, cb) => c.submit(a.id, fee, cb),
    { title: "Submitted", description: "Marked ready for verification." },
    "Failed to submit",
    (a) => a.id
  );
}

export function useVerify() {
  return useWriteAction<{ id: string }>(
    (c, a, fee, cb) => c.verify(a.id, fee, cb),
    { title: "Verified", description: "Validators confirmed the marker is live." },
    "Verification failed",
    (a) => a.id
  );
}

export function useChallenge() {
  return useWriteAction<{ id: string; reason: string }>(
    (c, a, fee, cb) => c.challenge(a.id, a.reason, fee, cb),
    { title: "Challenge filed", description: "Escalated for reasoned review." },
    "Failed to challenge",
    (a) => a.id
  );
}

export function useResolveDispute() {
  return useWriteAction<{ id: string }>(
    (c, a, fee, cb) => c.resolveDispute(a.id, fee, cb),
    { title: "Dispute resolved", description: "Validators reached a verdict." },
    "Failed to resolve dispute",
    (a) => a.id
  );
}

export function useRelease() {
  return useWriteAction<{ id: string }>(
    (c, a, fee, cb) => c.release(a.id, fee, cb),
    { title: "Released", description: "Marked released to the provider." },
    "Failed to release",
    (a) => a.id
  );
}

export function useReclaimTimeout() {
  return useWriteAction<{ id: string }>(
    (c, a, fee, cb) => c.reclaimTimeout(a.id, fee, cb),
    { title: "Reclaimed", description: "Marked refunded to the client." },
    "Failed to reclaim",
    (a) => a.id
  );
}
