"use client";

import { useAccount }       from "wagmi";
import { ConnectButton }    from "@rainbow-me/rainbowkit";
import RiskMeter            from "@/components/RiskMeter";
import { PositionCard, AgentStatusBadge, PriceSlider } from "@/components";
import { useAavePosition, useAgentHealth } from "@/hooks";

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const { position, isLoading }  = useAavePosition();
  const { data: health }         = useAgentHealth();

  if (!isConnected) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="font-display font-bold text-4xl text-ink">
            Protect Your Aave Position
          </h1>
          <p className="text-faint max-w-md">
            Connect your wallet to let the AI agent monitor and automatically protect your Aave lending positions on Arbitrum from liquidation.
          </p>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap gap-2 justify-center text-xs font-mono">
          {["Real-time monitoring", "Auto repay", "AI explanations", "Telegram alerts"].map((f) => (
            <span key={f} className="px-3 py-1.5 rounded-full border border-cyan/20 bg-cyan/5 text-cyan/80">
              {f}
            </span>
          ))}
        </div>

        <ConnectButton label="Connect Wallet to Start" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-48 rounded-2xl bg-panel border border-border" />
        ))}
      </div>
    );
  }

  if (!position || position.totalDebtUSD === 0) {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-4 text-center">
        <div className="w-16 h-16 rounded-2xl bg-panel border border-border flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6b6b8a" strokeWidth="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div>
          <h2 className="font-display font-semibold text-xl">No active Aave position</h2>
          <p className="text-faint text-sm mt-1">
            You need an active borrowing position on Aave v3 (Arbitrum) to use this service.
          </p>
        </div>
        <a
          href="https://app.aave.com"
          target="_blank"
          rel="noopener noreferrer"
          className="px-5 py-2.5 rounded-xl bg-cyan/10 border border-cyan/20 text-cyan text-sm font-display font-semibold hover:bg-cyan/20 transition-colors"
        >
          Open Aave →
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Page title */}
      <div className="flex items-center justify-between">
        <h1 className="font-display font-bold text-2xl">Dashboard</h1>
        <span className="text-xs font-mono text-faint">
          {address?.slice(0, 6)}…{address?.slice(-4)}
        </span>
      </div>

      {/* Top row: Risk Meter + Position Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Risk Meter — hero element */}
        <div className="rounded-2xl bg-panel border border-border p-6 flex flex-col items-center justify-center scan-overlay">
          <div className="text-xs font-mono text-faint uppercase tracking-widest mb-4">
            Live Health Factor
          </div>
          <RiskMeter healthFactor={position.healthFactor} size={240} />
        </div>

        {/* Position summary */}
        <PositionCard position={position} />
      </div>

      {/* Bottom row: Price Simulator + Agent Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PriceSlider currentHF={position.healthFactor} />
        <AgentStatusBadge health={health ?? null} />
      </div>

    </div>
  );
}
