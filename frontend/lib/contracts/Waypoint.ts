import { createClient } from "genlayer-js";
import { getGenLayerChain } from "../genlayer/chains";
import type { Engagement } from "./types";
import { decodeEngagement } from "./decode";
import {
  estimateWriteFeePreset,
  feePresetToTransactionFees,
  type FeePresetEstimate,
  type FeePresetLevel,
} from "../genlayer/fees";

/**
 * Waypoint contract class - a verified milestone escrow. create_engagement
 * is the only payable write (it escrows the agreed amount); every other
 * write only moves an engagement between states.
 */
class Waypoint {
  private contractAddress: `0x${string}`;
  private client: any;
  private rpcUrl?: string;

  constructor(contractAddress: string, address?: string | null, rpcUrl?: string) {
    this.contractAddress = contractAddress as `0x${string}`;
    this.rpcUrl = rpcUrl;

    const config: any = { chain: getGenLayerChain() };
    if (address) config.account = address as `0x${string}`;
    if (rpcUrl) config.endpoint = rpcUrl;

    this.client = createClient(config);
  }

  updateAccount(address: string): void {
    const config: any = { chain: getGenLayerChain(), account: address as `0x${string}` };
    if (this.rpcUrl) config.endpoint = this.rpcUrl;
    this.client = createClient(config);
  }

  private async estimateFees(
    functionName: string,
    args: unknown[],
    level: FeePresetLevel = "standard"
  ): Promise<FeePresetEstimate | undefined> {
    return estimateWriteFeePreset(this.client, { address: this.contractAddress, functionName, args }, level);
  }

  async getEngagement(engagementId: string): Promise<Engagement | null> {
    try {
      const result = await this.client.readContract({
        address: this.contractAddress, functionName: "get_engagement", args: [engagementId],
      });
      return decodeEngagement(result);
    } catch {
      return null;
    }
  }

  async getAllEngagementIds(): Promise<string[]> {
    const result: any = await this.client.readContract({
      address: this.contractAddress, functionName: "get_all_engagement_ids", args: [],
    });
    return Array.isArray(result) ? result.map(String) : [];
  }

  private async submitWrite(
    functionName: string,
    args: unknown[],
    feePreset?: FeePresetEstimate,
    onSubmitted?: (txHash: string) => void,
    value: bigint = BigInt(0)
  ): Promise<string> {
    const fees = feePresetToTransactionFees(feePreset);
    let txHash: string;
    try {
      txHash = await this.client.writeContract({
        address: this.contractAddress,
        functionName,
        args,
        value,
        ...(fees ? { fees } : {}),
      });
    } catch (error) {
      console.error(`Error calling ${functionName}:`, error);
      throw new Error(`Failed to submit the ${functionName} transaction. Please try again.`);
    }

    onSubmitted?.(txHash);

    try {
      await this.client.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" as any, retries: 40, interval: 5000 });
      return txHash;
    } catch (error) {
      console.error(`Error confirming ${functionName} transaction:`, error);
      throw new Error(
        `Transaction ${txHash} was submitted but confirmation timed out. It may still complete - check the explorer.`
      );
    }
  }

  async estimateCreateEngagementFees(
    engagementId: string, provider: string, description: string, url: string, marker: string, deadline: number,
    level: FeePresetLevel = "standard"
  ) {
    return this.estimateFees("create_engagement", [engagementId, provider, description, url, marker, deadline], level);
  }

  async createEngagement(
    engagementId: string, provider: string, description: string, url: string, marker: string,
    deadline: number, amountWei: bigint,
    feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void
  ) {
    return this.submitWrite(
      "create_engagement",
      [engagementId, provider, description, url, marker, deadline],
      feePreset, onSubmitted, amountWei
    );
  }

  async estimateSubmitFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("submit", [engagementId], level);
  }

  async submit(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("submit", [engagementId], feePreset, onSubmitted);
  }

  async estimateVerifyFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("verify", [engagementId], level);
  }

  async verify(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("verify", [engagementId], feePreset, onSubmitted);
  }

  async estimateChallengeFees(engagementId: string, reason: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("challenge", [engagementId, reason], level);
  }

  async challenge(engagementId: string, reason: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("challenge", [engagementId, reason], feePreset, onSubmitted);
  }

  async estimateResolveDisputeFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("resolve_dispute", [engagementId], level);
  }

  async resolveDispute(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("resolve_dispute", [engagementId], feePreset, onSubmitted);
  }

  async estimateReleaseFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("release", [engagementId], level);
  }

  async release(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("release", [engagementId], feePreset, onSubmitted);
  }

  async estimateReclaimTimeoutFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("reclaim_timeout", [engagementId], level);
  }

  async reclaimTimeout(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("reclaim_timeout", [engagementId], feePreset, onSubmitted);
  }

  async estimateReclaimStaleFees(engagementId: string, level: FeePresetLevel = "standard") {
    return this.estimateFees("reclaim_stale", [engagementId], level);
  }

  async reclaimStale(engagementId: string, feePreset?: FeePresetEstimate, onSubmitted?: (txHash: string) => void) {
    return this.submitWrite("reclaim_stale", [engagementId], feePreset, onSubmitted);
  }
}

export default Waypoint;
