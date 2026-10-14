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
import { failedReceiptMessage } from "../receipt";
import { expectedStatus, movesFunds, type EngagementAction } from "../engagement-actions";

/** Where a write is in its life. The UI shows these; only "confirmed" means the engagement really changed. */
export type WriteStage = "signing" | "submitted" | "accepted" | "confirmed" | "finalized";

export interface WriteProgress {
  txHash?: string;
  stage: WriteStage;
  /** true when funds only move once the transaction finalizes */
  movesFunds: boolean;
}

export interface WriteOptions {
  action: EngagementAction | "create";
  engagementId: string;
  value?: bigint;
  feePreset?: FeePresetEstimate;
  onProgress?: (p: WriteProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waypoint contract client.
 *
 * Reads use an account-free client. Writes use a second client that carries
 * the injected wallet provider and is connected to the chain before signing,
 * as the GenLayerJS docs prescribe for browser wallets.
 *
 * A write is only reported as done after three checks: the transaction was
 * accepted, its GenVM execution returned (an ACCEPTED transaction can still
 * have reverted), and reading the engagement back shows the expected state.
 * Fund-moving writes then keep watching until FINALIZED, because the
 * transfer is only delivered on finalization.
 */
class Waypoint {
  private contractAddress: `0x${string}`;
  private readClient: any;
  private writeClient: any = null;
  private connectedFor: string | null = null;
  private address?: string | null;
  private rpcUrl?: string;

  constructor(contractAddress: string, address?: string | null, rpcUrl?: string) {
    this.contractAddress = contractAddress as `0x${string}`;
    this.rpcUrl = rpcUrl;
    this.address = address;
    const config: any = { chain: getGenLayerChain() };
    if (rpcUrl) config.endpoint = rpcUrl;
    this.readClient = createClient(config);
  }

  updateAccount(address: string): void {
    this.address = address;
    this.writeClient = null;
    this.connectedFor = null;
  }

  /** The provider-backed client, connected to the chain. Created lazily so reads never need a wallet. */
  private async writer(): Promise<any> {
    if (!this.address) throw new Error("Wallet not connected. Please connect your wallet first.");
    const provider = typeof window !== "undefined" ? (window as any).ethereum : undefined;
    if (!provider) throw new Error("No wallet found. Install MetaMask to sign transactions.");
    if (!this.writeClient || this.connectedFor !== this.address) {
      const config: any = { chain: getGenLayerChain(), account: this.address as `0x${string}`, provider };
      if (this.rpcUrl) config.endpoint = this.rpcUrl;
      const client = createClient(config);
      await client.connect("testnetBradbury");
      this.writeClient = client;
      this.connectedFor = this.address;
    }
    return this.writeClient;
  }

  async getEngagement(engagementId: string): Promise<Engagement | null> {
    try {
      const result = await this.readClient.readContract({
        address: this.contractAddress, functionName: "get_engagement", args: [engagementId],
      });
      return decodeEngagement(result);
    } catch {
      return null;
    }
  }

  async getEngagementCount(): Promise<number> {
    const n: any = await this.readClient.readContract({
      address: this.contractAddress, functionName: "get_engagement_count", args: [],
    });
    return Number(n ?? 0);
  }

  /** One page (at most 50) of ids, oldest first. */
  async getEngagementIds(offset: number, limit: number): Promise<string[]> {
    const result: any = await this.readClient.readContract({
      address: this.contractAddress, functionName: "get_engagement_ids", args: [offset, limit],
    });
    return Array.isArray(result) ? result.map(String) : [];
  }

  /** The newest `limit` ids, oldest first within that page, read from the end so a long history never has to be loaded. */
  async getRecentEngagementIds(limit = 20): Promise<string[]> {
    const count = await this.getEngagementCount();
    if (count === 0) return [];
    const start = Math.max(0, count - limit);
    return this.getEngagementIds(start, count - start);
  }

  private async estimateFees(functionName: string, args: unknown[], level: FeePresetLevel = "standard") {
    const client = await this.writer();
    return estimateWriteFeePreset(client, { address: this.contractAddress, functionName, args }, level);
  }

  /** Read the engagement until `ok` holds. Reads can lag a just-accepted write, so poll briefly. */
  private async confirmState(id: string, ok: (e: Engagement) => boolean, tries = 24): Promise<Engagement> {
    let last: Engagement | null = null;
    for (let i = 0; i < tries; i++) {
      last = await this.getEngagement(id);
      if (last && ok(last)) return last;
      await sleep(5000);
    }
    throw new Error(
      `The transaction was accepted but the engagement is still "${last?.status ?? "unknown"}". ` +
        "It may have been refused by the contract (for example the evidence did not verify). Check the explorer before retrying."
    );
  }

  private async submitWrite(functionName: string, args: unknown[], opts: WriteOptions): Promise<string> {
    const pays = movesFunds(opts.action as any);
    const progress = (stage: WriteStage, txHash?: string) => opts.onProgress?.({ stage, txHash, movesFunds: pays });
    const client = await this.writer();
    const fees = feePresetToTransactionFees(opts.feePreset);

    progress("signing");
    let txHash: string;
    try {
      txHash = await client.writeContract({
        address: this.contractAddress,
        functionName,
        args,
        value: opts.value ?? BigInt(0),
        ...(fees ? { fees } : {}),
      });
    } catch (error: any) {
      console.error(`Error calling ${functionName}:`, error);
      const rejected = error?.code === 4001 || /reject|denied/i.test(String(error?.message ?? ""));
      throw new Error(rejected ? "You rejected the transaction in your wallet." : `Failed to submit the ${functionName} transaction. Please try again.`);
    }
    progress("submitted", txHash);

    let receipt: any;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash, status: "ACCEPTED" as any, retries: 60, interval: 5000 });
    } catch (error) {
      console.error(`Error confirming ${functionName} transaction:`, error);
      throw new Error(`Transaction ${txHash} was submitted but is not accepted yet. It may still complete: check the explorer.`);
    }
    // ACCEPTED only says validators agreed on a result, which can be a revert; a timeout records nothing at all.
    const failure = failedReceiptMessage(receipt, functionName, txHash);
    if (failure) throw new Error(failure);
    progress("accepted", txHash);

    await this.confirmState(opts.engagementId, expectedStatus(opts.action));
    progress("confirmed", txHash);

    if (pays) {
      // The transfer lands when this transaction finalizes; report that moment separately.
      void (async () => {
        for (let i = 0; i < 8; i++) {
          try {
            await this.readClient.waitForTransactionReceipt({ hash: txHash, status: "FINALIZED" as any, retries: 400, interval: 10000 });
            progress("finalized", txHash);
            return;
          } catch {
            await sleep(15000);
          }
        }
      })();
    }
    return txHash;
  }

  async estimateCreateEngagementFees(a: CreateArgs, level: FeePresetLevel = "standard") {
    return this.estimateFees("create_engagement", createArgs(a), level);
  }

  async createEngagement(a: CreateArgs, opts: Omit<WriteOptions, "action" | "engagementId" | "value">) {
    return this.submitWrite("create_engagement", createArgs(a), { ...opts, action: "create", engagementId: a.id, value: a.amountWei });
  }

  async accept(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("accept", [id], { ...opts, action: "accept", engagementId: id });
  }

  async submit(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("submit", [id], { ...opts, action: "submit", engagementId: id });
  }

  async verify(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("verify", [id], { ...opts, action: "verify", engagementId: id });
  }

  /** The bond is sent with the call and must equal the engagement's required_bond exactly. */
  async challenge(id: string, reason: string, bondWei: bigint, opts: Omit<WriteOptions, "action" | "engagementId" | "value"> = {}) {
    return this.submitWrite("challenge", [id, reason], { ...opts, action: "challenge", engagementId: id, value: bondWei });
  }

  async resolveDispute(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("resolve_dispute", [id], { ...opts, action: "resolve_dispute", engagementId: id });
  }

  /** Pays a verdict that resolve_dispute recorded. Permissionless; the transfer lands when this transaction finalizes. */
  async settle(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("settle", [id], { ...opts, action: "settle", engagementId: id });
  }

  async release(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("release", [id], { ...opts, action: "release", engagementId: id });
  }

  async reclaimTimeout(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("reclaim_timeout", [id], { ...opts, action: "reclaim_timeout", engagementId: id });
  }

  async reclaimStale(id: string, opts: Omit<WriteOptions, "action" | "engagementId"> = {}) {
    return this.submitWrite("reclaim_stale", [id], { ...opts, action: "reclaim_stale", engagementId: id });
  }
}

export interface CreateArgs {
  id: string;
  provider: string;
  description: string;
  url: string;
  marker: string;
  rejectMarker: string;
  deadline: number;
  challengeWindow: number;
  staleAfter: number;
  amountWei: bigint;
}

function createArgs(a: CreateArgs): unknown[] {
  return [a.id, a.provider, a.description, a.url, a.marker, a.rejectMarker, a.deadline, a.challengeWindow, a.staleAfter];
}

export default Waypoint;
