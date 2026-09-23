"use client";

import { useState } from "react";
import { useWallet } from "@/lib/genlayer/wallet";
import { GENLAYER_NETWORK } from "@/lib/genlayer/client";
import { error, userRejected } from "@/lib/utils/toast";
import { CairnGlyph } from "./CairnGlyph";

const METAMASK_INSTALL_URL = "https://metamask.io/download/";

function SeqRow({ k, v, tone = "moss" }: { k: string; v: string; tone?: "moss" | "rust" | "faint" }) {
  const color = tone === "moss" ? "var(--moss)" : tone === "rust" ? "var(--rust)" : "var(--ink-faint)";
  return (
    <div className="grid gap-2.5 items-baseline" style={{ gridTemplateColumns: "68px 1fr" }}>
      <span className="font-mono text-[0.64rem] tracking-[0.08em]" style={{ color: "var(--ink-faint)" }}>{k}</span>
      <span
        className="font-mono text-[0.72rem] pb-2"
        style={{ color, borderBottom: "1px dotted var(--border)" }}
      >
        {v}
      </span>
    </div>
  );
}

export function AccountPanel() {
  const {
    address, isConnected, isMetaMaskInstalled, isOnCorrectNetwork, isLoading,
    connectWallet, disconnectWallet, switchWalletAccount,
  } = useWallet();

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  const handleConnect = async () => {
    if (!isMetaMaskInstalled) return;
    try {
      setIsConnecting(true);
      await connectWallet();
    } catch (err: any) {
      if (err.message?.includes("rejected")) {
        userRejected("Registration cancelled");
      } else {
        error("Failed to register instrument", { description: err.message || "Check your MetaMask and try again." });
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSwitchAccount = async () => {
    try {
      setIsSwitching(true);
      await switchWalletAccount();
    } catch (err: any) {
      if (!err.message?.includes("rejected")) {
        error("Failed to switch bearing", { description: err.message || "Please try again." });
      } else {
        userRejected("Bearing switch cancelled");
      }
    } finally {
      setIsSwitching(false);
    }
  };

  const instrumentLabel = isMetaMaskInstalled ? "MetaMask · detected" : "Not found";
  const instrumentTone = isMetaMaskInstalled ? "moss" : "rust";
  const datumLabel = !isConnected
    ? "Pending"
    : isOnCorrectNetwork
      ? `${GENLAYER_NETWORK.chainName.replace(/^GenLayer\s+/i, "")} ✓`
      : "Wrong network";
  const datumTone = !isConnected ? "faint" : isOnCorrectNetwork ? "moss" : "rust";
  const sightLabel = isConnected ? "Taken" : isConnecting ? "In progress" : "Not started";
  const sightTone = isConnected ? "moss" : isConnecting ? "faint" : "faint";
  const markLabel = isConnected && address ? `Set at 0x${address.slice(2, 6)}…${address.slice(-4)}` : "—";
  const markTone = isConnected ? "moss" : "faint";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsPanelOpen((v) => !v)}
        disabled={isLoading}
        className="wallet-chip"
      >
        <span className={`mark-dot ${isConnected ? "" : "off"}`} />
        {isConnected && address ? `0x${address.slice(2, 6)}…${address.slice(-4)}` : "Register Instrument"}
      </button>

      {isPanelOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsPanelOpen(false)} />
          <div
            className="fixed left-4 right-4 sm:left-auto sm:right-5 top-[86px] z-50 sm:w-[300px] p-5"
            style={{ background: "var(--card)", border: "1px solid var(--border-bright)" }}
          >
            <div className="eyebrow mb-4">Field Registration</div>
            <div className="flex justify-center mb-4.5" style={{ marginBottom: "18px" }}>
              <CairnGlyph size={64} tone={isConnected ? "moss" : "brass"} />
            </div>

            <div className="flex flex-col gap-2.5 mb-5">
              <SeqRow k="INSTRUMENT" v={instrumentLabel} tone={instrumentTone as any} />
              <SeqRow k="DATUM" v={datumLabel} tone={datumTone as any} />
              <SeqRow k="SIGHT" v={sightLabel} tone={sightTone as any} />
              <SeqRow k="MARK" v={markLabel} tone={markTone as any} />
            </div>

            <div className="flex flex-col gap-2">
              {!isMetaMaskInstalled && (
                <button type="button" onClick={() => window.open(METAMASK_INSTALL_URL, "_blank")} className="btn-field solid w-full">
                  Install MetaMask
                </button>
              )}
              {isMetaMaskInstalled && !isConnected && (
                <button type="button" onClick={handleConnect} disabled={isConnecting} className="btn-field solid w-full">
                  {isConnecting ? "Taking Sight…" : "Take Sight →"}
                </button>
              )}
              {isConnected && (
                <>
                  <button type="button" onClick={handleSwitchAccount} disabled={isSwitching} className="btn-field ghost w-full">
                    {isSwitching ? "Switching…" : "Switch Bearing"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { disconnectWallet(); setIsPanelOpen(false); }}
                    className="btn-field danger w-full"
                  >
                    Release Instrument
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
