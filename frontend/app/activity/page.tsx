"use client";

import { useAccount }           from "wagmi";
import { ConnectButton }        from "@rainbow-me/rainbowkit";
import { AgentFeed }            from "@/components";
import { useAgentActivity }     from "@/hooks";
import { formatUSD }            from "@/lib/formatters";

export default function ActivityPage() {
  const { address, isConnected } = useAccount();
  const { data: actions = [], isLoading } = useAgentActivity(address);

  if (!isConnected) {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-4">
        <p className="text-faint">Connect your wallet to view agent activity</p>
        <ConnectButton />
      </div>
    );
  }

  // Summary stats from action list
  const successful   = actions.filter((a) => a.success === 1);
  const totalActions = successful.length;
  const repays       = successful.filter((a) => a.action_type === "PARTIAL_REPAY").length;
  const deleverages  = successful.filter((a) => a.action_type === "DELEVERAGE").length;

  // Biggest HF improvement
  const bestImprovement = successful.reduce((best, a) => {
    if (a.hf_before && a.hf_after) {
      const diff = a.hf_after - a.hf_before;
      return diff > best ? diff : best;
    }
    return best;
  }, 0);

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Header */}
      <div>
        <h1 className="font-display font-bold text-2xl">Agent Activity</h1>
        <p className="text-faint text-sm mt-1">
          Everything the agent has done to protect your position
        </p>
      </div>

      {/* Stats row */}
      {totalActions > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Actions taken"    value={String(totalActions)} />
          <StatCard label="Repays"           value={String(repays)} />
          <StatCard label="Deleverages"      value={String(deleverages)} />
          <StatCard
            label="Best HF improvement"
            value={bestImprovement > 0 ? `+${bestImprovement.toFixed(2)}` : "—"}
            accent
          />
        </div>
      )}

      {/* Feed */}
      <AgentFeed actions={actions} isLoading={isLoading} />

    </div>
  );
}

function StatCard({
  label, value, accent = false,
}: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-panel border border-border p-4">
      <div className="text-xs font-mono text-faint">{label}</div>
      <div className={`text-2xl font-display font-bold mt-1 ${accent ? "text-cyan" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}
