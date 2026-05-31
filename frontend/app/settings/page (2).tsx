"use client";

import { useAccount }        from "wagmi";
import { ConnectButton }     from "@rainbow-me/rainbowkit";
import { ThresholdEditor, TelegramConnect } from "@/components";
import { useAgentConfig }    from "@/hooks";

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const {
    config, stats,
    isLoading,
    saveConfig, toggleAgent, initConfig,
    isPending, isSuccess,
    refetch,
  } = useAgentConfig();

  if (!isConnected) {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-4">
        <p className="text-faint">Connect your wallet to configure the agent</p>
        <ConnectButton />
      </div>
    );
  }

  // First-time user — no config initialised yet
  if (!isLoading && !config?.agentEnabled && stats?.lastConfigUpdate === 0) {
    return (
      <div className="max-w-lg mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="font-display font-bold text-2xl">Setup Agent</h1>
          <p className="text-faint text-sm mt-1">
            First time? Initialise your agent configuration with safe defaults.
          </p>
        </div>

        <div className="rounded-2xl bg-panel border border-border p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center mx-auto">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <h2 className="font-display font-semibold text-lg">Activate Protection</h2>
            <p className="text-faint text-sm mt-1">
              This will deploy your configuration on-chain with safe defaults.
              You can customise everything after.
            </p>
          </div>
          <button
            onClick={initConfig}
            disabled={isPending}
            className="w-full py-4 rounded-xl bg-cyan text-void font-display font-bold text-sm tracking-wider hover:bg-cyan-dim glow-cyan transition-all disabled:opacity-50"
          >
            {isPending ? "Initialising…" : "Initialise Agent"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl">Settings</h1>
          <p className="text-faint text-sm mt-1">Configure how the agent protects your position</p>
        </div>
        {stats && stats.totalActions > 0 && (
          <div className="text-right">
            <div className="text-xs font-mono text-faint">Protected</div>
            <div className="text-sm font-display font-semibold text-cyan">
              {stats.totalActions} action{stats.totalActions !== 1 ? "s" : ""}
            </div>
          </div>
        )}
      </div>

      {/* Config form */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 rounded-2xl bg-panel border border-border animate-pulse" />
          ))}
        </div>
      ) : (
        <ThresholdEditor
          config={config}
          onSave={saveConfig}
          onToggle={toggleAgent}
          isPending={isPending}
          isSuccess={isSuccess}
        />
      )}

      {/* Telegram */}
      <TelegramConnect />

    </div>
  );
}
