// ─────────────────────────────────────────────────────────────────────────────
// PositionCard.tsx
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { formatUSD, formatHF, getBandColor, getHFBand } from "@/lib/formatters";
import { clsx } from "clsx";

interface Position {
  healthFactor:       number;
  band:               string;
  totalCollateralUSD: number;
  totalDebtUSD:       number;
  netWorthUSD:        number;
  liquidationThreshold: number;
}

export function PositionCard({ position }: { position: Position }) {
  const ltv = position.totalDebtUSD / position.totalCollateralUSD * 100;

  return (
    <div className="rounded-2xl bg-panel border border-border p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Aave Position
        </h2>
        <span className={clsx(
          "text-xs font-mono px-2.5 py-1 rounded-full border",
          position.band === "SAFE"     && "text-safe     border-safe/30     bg-safe/10",
          position.band === "WARNING"  && "text-warning  border-warning/30  bg-warning/10",
          position.band === "ACTION"   && "text-action   border-action/30   bg-action/10",
          position.band === "CRITICAL" && "text-critical border-critical/30 bg-critical/10",
        )}>
          {position.band}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Stat label="Collateral"  value={formatUSD(position.totalCollateralUSD)} />
        <Stat label="Debt"        value={formatUSD(position.totalDebtUSD)} />
        <Stat label="Net Worth"   value={formatUSD(position.netWorthUSD)} />
        <Stat label="Liq. Threshold" value={`${position.liquidationThreshold.toFixed(0)}%`} />
      </div>

      {/* LTV bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-faint font-mono">
          <span>Loan-to-Value</span>
          <span>{isNaN(ltv) ? "0" : ltv.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(isNaN(ltv) ? 0 : ltv, 100)}%`,
              background: ltv > 80 ? "#ff1744" : ltv > 60 ? "#ff6d00" : "#00e5ff",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-faint font-mono">{label}</div>
      <div className="text-lg font-display font-semibold text-ink">{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentStatusBadge.tsx
// ─────────────────────────────────────────────────────────────────────────────
"use client";

interface AgentHealth {
  status:          string;
  lastScanAt:      number | null;
  activePositions: number;
  totalScans:      number;
  uptimeSeconds:   number;
}

export function AgentStatusBadge({ health }: { health: AgentHealth | null }) {
  const online  = health?.status === "running";
  const lastScan = health?.lastScanAt
    ? Math.floor((Date.now() - health.lastScanAt) / 1000)
    : null;

  return (
    <div className="rounded-2xl bg-panel border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Agent Status
        </h2>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${online ? "bg-safe animate-pulse-slow" : "bg-faint"}`} />
          <span className={`text-xs font-mono ${online ? "text-safe" : "text-faint"}`}>
            {online ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs font-mono">
        <div>
          <div className="text-faint">Last scan</div>
          <div className="text-ink mt-0.5">
            {lastScan != null ? `${lastScan}s ago` : "—"}
          </div>
        </div>
        <div>
          <div className="text-faint">Positions watched</div>
          <div className="text-ink mt-0.5">{health?.activePositions ?? "—"}</div>
        </div>
        <div>
          <div className="text-faint">Total scans</div>
          <div className="text-ink mt-0.5">{health?.totalScans ?? "—"}</div>
        </div>
        <div>
          <div className="text-faint">Uptime</div>
          <div className="text-ink mt-0.5">
            {health?.uptimeSeconds != null
              ? `${Math.floor(health.uptimeSeconds / 60)}m`
              : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PriceSlider.tsx — What-if price shock embedded in dashboard
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState, useEffect }     from "react";
import { useReadContract }          from "wagmi";
import { useAccount }               from "wagmi";
import { ADDRESSES, AAVE_ADAPTER_ABI } from "@/lib/contracts";
import { parseHF, formatHF, getBandHex, getHFBand } from "@/lib/formatters";

// Arbitrum WETH — used as the "dominant collateral" for shock simulation
const WETH_ARB = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as `0x${string}`;

export function PriceSlider({ currentHF }: { currentHF: number }) {
  const { address } = useAccount();
  const [shockPct, setShockPct] = useState(0); // -50 to +50

  const shockBP = shockPct * 100; // pct → basis points

  const { data: simHFRaw } = useReadContract({
    address: ADDRESSES.AAVE_ADAPTER,
    abi:     AAVE_ADAPTER_ABI,
    functionName: "simulateHFAfterPriceShock",
    args:    address
      ? [address, WETH_ARB, BigInt(shockBP)]
      : undefined,
    query: {
      enabled:   !!address && shockBP !== 0,
      staleTime: 30_000,
    },
  });

  const simHF   = shockBP === 0 ? currentHF : (simHFRaw ? parseHF(simHFRaw) : currentHF);
  const simBand = getHFBand(simHF);
  const simColor = getBandHex(simBand);

  return (
    <div className="rounded-2xl bg-panel border border-border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Price Simulator
        </h2>
        <span className="text-xs font-mono text-faint">ETH collateral shock</span>
      </div>

      {/* Slider */}
      <div className="space-y-3">
        <input
          type="range"
          min={-50}
          max={50}
          step={5}
          value={shockPct}
          onChange={(e) => setShockPct(Number(e.target.value))}
          className="w-full accent-cyan cursor-pointer"
        />
        <div className="flex justify-between text-xs font-mono text-faint">
          <span>-50%</span>
          <span className={`font-semibold ${shockPct < 0 ? "text-critical" : shockPct > 0 ? "text-safe" : "text-ink"}`}>
            {shockPct > 0 ? "+" : ""}{shockPct}%
          </span>
          <span>+50%</span>
        </div>
      </div>

      {/* Before / After */}
      <div className="grid grid-cols-2 gap-4 pt-2">
        <div className="bg-muted/30 rounded-xl p-4 text-center">
          <div className="text-xs font-mono text-faint mb-1">Current HF</div>
          <div className="text-2xl font-display font-bold text-cyan">
            {formatHF(currentHF)}
          </div>
        </div>
        <div className="bg-muted/30 rounded-xl p-4 text-center">
          <div className="text-xs font-mono text-faint mb-1">Projected HF</div>
          <div className="text-2xl font-display font-bold" style={{ color: simColor }}>
            {formatHF(simHF)}
          </div>
        </div>
      </div>

      {simHF < 1.4 && shockPct !== 0 && (
        <div className="text-xs text-critical font-mono bg-critical/10 border border-critical/20 rounded-lg px-3 py-2">
          ⚠ Agent would trigger protection at this price level
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionCard.tsx — single agent action in the activity feed
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { timeAgo, formatHF, arbiscanTx } from "@/lib/formatters";
import { clsx } from "clsx";

interface Action {
  id:            number;
  action_type:   string;
  tx_hash:       string | null;
  hf_before:     number | null;
  hf_after:      number | null;
  explanation:   string | null;
  success:       number;
  error_message: string | null;
  executed_at:   number;
}

const ACTION_COLORS: Record<string, string> = {
  PARTIAL_REPAY:    "text-safe   border-safe/20   bg-safe/10",
  DELEVERAGE:       "text-action border-action/20 bg-action/10",
  COLLATERAL_TOPUP: "text-cyan   border-cyan/20   bg-cyan/10",
  ALERT:            "text-warning border-warning/20 bg-warning/10",
};

const ACTION_LABELS: Record<string, string> = {
  PARTIAL_REPAY:    "Partial Repay",
  DELEVERAGE:       "Deleverage",
  COLLATERAL_TOPUP: "Collateral Top-Up",
  ALERT:            "Alert Sent",
};

export function ActionCard({ action }: { action: Action }) {
  const colorClass  = ACTION_COLORS[action.action_type]  ?? "text-ink border-border bg-muted/20";
  const label       = ACTION_LABELS[action.action_type]  ?? action.action_type;
  const hfImproved  = action.hf_after && action.hf_before
    ? action.hf_after > action.hf_before : false;

  return (
    <div className={clsx(
      "rounded-xl border p-4 space-y-3 transition-all hover:border-opacity-60",
      action.success ? "border-border" : "border-critical/20 bg-critical/5"
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={clsx("text-xs font-mono px-2 py-0.5 rounded-full border", colorClass)}>
            {label}
          </span>
          {!action.success && (
            <span className="text-xs font-mono text-critical">FAILED</span>
          )}
        </div>
        <span className="text-xs font-mono text-faint shrink-0">
          {timeAgo(action.executed_at)}
        </span>
      </div>

      {/* HF change */}
      {action.hf_before != null && action.hf_after != null && (
        <div className="flex items-center gap-2 text-sm font-mono">
          <span className="text-faint">HF</span>
          <span className="text-ink">{formatHF(action.hf_before)}</span>
          <span className="text-faint">→</span>
          <span className={hfImproved ? "text-safe" : "text-critical"}>
            {formatHF(action.hf_after)}
          </span>
          {hfImproved && (
            <span className="text-safe text-xs">
              (+{(action.hf_after - action.hf_before).toFixed(2)})
            </span>
          )}
        </div>
      )}

      {/* AI explanation */}
      {action.explanation && (
        <p className="text-xs text-faint leading-relaxed border-l-2 border-cyan/20 pl-3">
          {action.explanation}
        </p>
      )}

      {/* Tx link */}
      {action.tx_hash && (
        <a
          href={arbiscanTx(action.tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-cyan/70 hover:text-cyan flex items-center gap-1 transition-colors"
        >
          {action.tx_hash.slice(0, 18)}…
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1 9L9 1M9 1H4M9 1V6"/>
          </svg>
        </a>
      )}

      {/* Error */}
      {!action.success && action.error_message && (
        <p className="text-xs text-critical font-mono">{action.error_message}</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentFeed.tsx — scrolling list of ActionCards
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { ActionCard } from "./ActionCard";
import type { AgentAction } from "@/hooks";

export function AgentFeed({ actions, isLoading }: { actions: AgentAction[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-panel border border-border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!actions || actions.length === 0) {
    return (
      <div className="rounded-xl bg-panel border border-border p-8 text-center">
        <div className="text-faint font-mono text-sm">No agent activity yet</div>
        <div className="text-faint/60 text-xs mt-1">
          The agent will log actions here as it monitors your position
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {actions.map((action) => (
        <ActionCard key={action.id} action={action} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ThresholdEditor.tsx — settings sliders writing to AgentRegistry
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState, useEffect } from "react";
import { clsx }                 from "clsx";

interface Config {
  warningHF:  number;
  actionHF:   number;
  autoRepay:  boolean;
  autoDelevg: boolean;
  alertOnly:  boolean;
  maxRepayBP: number;
  maxDelgBP:  number;
  agentEnabled: boolean;
}

interface Props {
  config:     Config | null;
  onSave:     (config: Omit<Config, "agentEnabled">) => void;
  onToggle:   (enabled: boolean) => void;
  isPending:  boolean;
  isSuccess:  boolean;
}

export function ThresholdEditor({ config, onSave, onToggle, isPending, isSuccess }: Props) {
  const [local, setLocal] = useState({
    warningHF:  config?.warningHF  ?? 1.6,
    actionHF:   config?.actionHF   ?? 1.4,
    autoRepay:  config?.autoRepay  ?? false,
    autoDelevg: config?.autoDelevg ?? false,
    alertOnly:  config?.alertOnly  ?? true,
    maxRepayBP: config?.maxRepayBP ?? 2000,
    maxDelgBP:  config?.maxDelgBP  ?? 3000,
  });

  useEffect(() => {
    if (config) setLocal({
      warningHF:  config.warningHF,
      actionHF:   config.actionHF,
      autoRepay:  config.autoRepay,
      autoDelevg: config.autoDelevg,
      alertOnly:  config.alertOnly,
      maxRepayBP: config.maxRepayBP,
      maxDelgBP:  config.maxDelgBP,
    });
  }, [config]);

  const isDirty = config && (
    local.warningHF !== config.warningHF ||
    local.actionHF  !== config.actionHF  ||
    local.autoRepay  !== config.autoRepay  ||
    local.autoDelevg !== config.autoDelevg ||
    local.alertOnly  !== config.alertOnly  ||
    local.maxRepayBP !== config.maxRepayBP ||
    local.maxDelgBP  !== config.maxDelgBP
  );

  return (
    <div className="space-y-6">

      {/* Kill switch */}
      <div className="rounded-2xl bg-panel border border-border p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-display font-semibold text-sm">Agent Enabled</div>
            <div className="text-xs text-faint mt-0.5">
              Master switch — disables all autonomous actions immediately
            </div>
          </div>
          <button
            onClick={() => onToggle(!(config?.agentEnabled ?? false))}
            className={clsx(
              "relative w-12 h-6 rounded-full border transition-all duration-300",
              config?.agentEnabled
                ? "bg-safe/20 border-safe/40"
                : "bg-muted border-border"
            )}
          >
            <span className={clsx(
              "absolute top-0.5 w-5 h-5 rounded-full transition-all duration-300",
              config?.agentEnabled
                ? "left-6 bg-safe"
                : "left-0.5 bg-faint"
            )} />
          </button>
        </div>
      </div>

      {/* Thresholds */}
      <div className="rounded-2xl bg-panel border border-border p-6 space-y-5">
        <h3 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Risk Thresholds
        </h3>

        <SliderField
          label="Warning threshold"
          hint="Agent sends an alert when HF falls below this"
          value={local.warningHF}
          min={1.5} max={3.0} step={0.1}
          color="#ffea00"
          onChange={(v) => setLocal((p) => ({ ...p, warningHF: v }))}
          format={(v) => v.toFixed(1)}
        />

        <SliderField
          label="Action threshold"
          hint="Agent executes protection when HF falls below this"
          value={local.actionHF}
          min={1.01} max={1.59} step={0.05}
          color="#ff6d00"
          onChange={(v) => setLocal((p) => ({ ...p, actionHF: v }))}
          format={(v) => v.toFixed(2)}
        />
      </div>

      {/* Permissions */}
      <div className="rounded-2xl bg-panel border border-border p-6 space-y-4">
        <h3 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Permitted Actions
        </h3>

        <Toggle
          label="Alert only"
          hint="Agent monitors and alerts but never executes transactions"
          checked={local.alertOnly}
          onChange={(v) => setLocal((p) => ({ ...p, alertOnly: v }))}
        />
        <Toggle
          label="Auto repay"
          hint="Agent may repay up to the max % of your debt automatically"
          checked={local.autoRepay}
          disabled={local.alertOnly}
          onChange={(v) => setLocal((p) => ({ ...p, autoRepay: v }))}
        />
        <Toggle
          label="Auto deleverage"
          hint="Agent may sell collateral to repay debt in an emergency"
          checked={local.autoDelevg}
          disabled={local.alertOnly}
          onChange={(v) => setLocal((p) => ({ ...p, autoDelevg: v }))}
        />
      </div>

      {/* Size limits */}
      <div className="rounded-2xl bg-panel border border-border p-6 space-y-5">
        <h3 className="font-display font-semibold text-sm tracking-widest text-faint uppercase">
          Action Size Limits
        </h3>

        <SliderField
          label="Max repay per action"
          hint="Maximum % of your total debt the agent may repay in a single tx"
          value={local.maxRepayBP / 100}
          min={5} max={50} step={5}
          color="#00e5ff"
          onChange={(v) => setLocal((p) => ({ ...p, maxRepayBP: v * 100 }))}
          format={(v) => `${v}%`}
        />

        <SliderField
          label="Max deleverage per action"
          hint="Maximum % of your collateral the agent may sell in a single tx"
          value={local.maxDelgBP / 100}
          min={5} max={50} step={5}
          color="#00e5ff"
          onChange={(v) => setLocal((p) => ({ ...p, maxDelgBP: v * 100 }))}
          format={(v) => `${v}%`}
        />
      </div>

      {/* Save button */}
      <button
        onClick={() => onSave(local)}
        disabled={!isDirty || isPending}
        className={clsx(
          "w-full py-4 rounded-xl font-display font-bold text-sm tracking-wider transition-all",
          isDirty && !isPending
            ? "bg-cyan text-void hover:bg-cyan-dim glow-cyan"
            : "bg-muted text-faint cursor-not-allowed"
        )}
      >
        {isPending ? "Saving to chain…" : isSuccess ? "✓ Saved" : "Save Configuration"}
      </button>
    </div>
  );
}

function SliderField({
  label, hint, value, min, max, step, color, onChange, format,
}: {
  label: string; hint: string; value: number;
  min: number; max: number; step: number;
  color: string; onChange: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-ink">{label}</div>
          <div className="text-xs text-faint">{hint}</div>
        </div>
        <span className="font-mono font-semibold text-sm" style={{ color }}>
          {format(value)}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer"
        style={{ accentColor: color }}
      />
    </div>
  );
}

function Toggle({
  label, hint, checked, disabled = false, onChange,
}: {
  label: string; hint: string; checked: boolean;
  disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className={clsx("flex items-center justify-between", disabled && "opacity-40")}>
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="text-xs text-faint">{hint}</div>
      </div>
      <button
        onClick={() => !disabled && onChange(!checked)}
        className={clsx(
          "relative w-12 h-6 rounded-full border transition-all duration-300",
          checked && !disabled
            ? "bg-cyan/20 border-cyan/40"
            : "bg-muted border-border"
        )}
      >
        <span className={clsx(
          "absolute top-0.5 w-5 h-5 rounded-full transition-all duration-300",
          checked && !disabled ? "left-6 bg-cyan" : "left-0.5 bg-faint"
        )} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TelegramConnect.tsx
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

export function TelegramConnect() {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);

  const command = address ? `/start ${address}` : "/start 0xYourAddress";

  function copyCommand() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "DefiRiskManagerBot";

  return (
    <div className="rounded-2xl bg-panel border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-cyan/10 border border-cyan/20 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#00e5ff">
            <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.19l-2.02 9.52c-.14.66-.54.82-1.09.51l-3-2.21-1.45 1.39c-.16.16-.3.3-.61.3l.21-3.01 5.45-4.92c.24-.21-.05-.33-.36-.12L6.52 14.4l-2.96-.92c-.64-.2-.65-.64.14-.95l11.57-4.46c.53-.19 1 .13.67.12z"/>
          </svg>
        </div>
        <div>
          <div className="font-display font-semibold text-sm">Telegram Alerts</div>
          <div className="text-xs text-faint">Receive real-time risk notifications</div>
        </div>
      </div>

      <ol className="space-y-3 text-sm">
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-cyan/20 border border-cyan/30 text-cyan text-xs font-mono flex items-center justify-center shrink-0">1</span>
          <span className="text-faint">
            Open Telegram and search for{" "}
            <a
              href={`https://t.me/${botUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan hover:underline"
            >
              @{botUsername}
            </a>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="w-5 h-5 rounded-full bg-cyan/20 border border-cyan/30 text-cyan text-xs font-mono flex items-center justify-center shrink-0">2</span>
          <span className="text-faint">Send this command to the bot:</span>
        </li>
      </ol>

      <div className="rounded-xl bg-void border border-border p-4 flex items-center justify-between gap-3">
        <code className="font-mono text-xs text-cyan break-all">{command}</code>
        <button
          onClick={copyCommand}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-cyan/10 border border-cyan/20 text-cyan text-xs font-mono hover:bg-cyan/20 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <p className="text-xs text-faint">
        Once you send the command, the bot will confirm registration and you'll receive alerts whenever the agent detects risk or takes an action.
      </p>
    </div>
  );
}
