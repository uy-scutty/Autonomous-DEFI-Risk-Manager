// ─────────────────────────────────────────────────────────────────────────────
// hooks/useAavePosition.ts
// Reads user's Aave position from AaveAdapter.getUserPosition()
// ─────────────────────────────────────────────────────────────────────────────
import { useReadContract }  from "wagmi";
import { useAccount }       from "wagmi";
import { ADDRESSES, AAVE_ADAPTER_ABI } from "@/lib/contracts";
import { parseHF, parseUSD, getHFBand } from "@/lib/formatters";

export function useAavePosition() {
  const { address } = useAccount();

  const { data, isLoading, error, refetch } = useReadContract({
    address: ADDRESSES.AAVE_ADAPTER,
    abi:     AAVE_ADAPTER_ABI,
    functionName: "getUserPosition",
    args:    address ? [address] : undefined,
    query:   {
      enabled:            !!address,
      refetchInterval:    15_000, // re-read every 15s
      staleTime:          10_000,
    },
  });

  if (!data) return { position: null, isLoading, error, refetch };

  const hf  = parseHF(data.healthFactor);
  const band = getHFBand(hf);

  const position = {
    raw:                    data,
    healthFactor:           hf,
    band,
    totalCollateralUSD:     parseUSD(data.totalCollateralUSD),
    totalDebtUSD:           parseUSD(data.totalDebtUSD),
    availableBorrowsUSD:    parseUSD(data.availableBorrowsUSD),
    netWorthUSD:            parseUSD(data.netWorthUSD),
    liquidationThreshold:   Number(data.currentLiquidationThreshold) / 100,
    ltv:                    Number(data.ltv) / 100,
    isAtRisk:               data.isAtRisk,
  };

  return { position, isLoading, error, refetch };
}

// ─────────────────────────────────────────────────────────────────────────────
// hooks/useAgentConfig.ts
// Reads + writes AgentRegistry config for the connected user
// ─────────────────────────────────────────────────────────────────────────────
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { AGENT_REGISTRY_ABI, HF_PRECISION }  from "@/lib/contracts";
import { hfToBigInt }                         from "@/lib/formatters";

export function useAgentConfig() {
  const { address } = useAccount();

  const { data: configRaw, isLoading, refetch } = useReadContract({
    address: ADDRESSES.AGENT_REGISTRY,
    abi:     AGENT_REGISTRY_ABI,
    functionName: "getConfig",
    args:    address ? [address] : undefined,
    query:   { enabled: !!address, refetchInterval: 10_000 },
  });

  const { data: statsRaw } = useReadContract({
    address: ADDRESSES.AGENT_REGISTRY,
    abi:     AGENT_REGISTRY_ABI,
    functionName: "getUserStats",
    args:    address ? [address] : undefined,
    query:   { enabled: !!address, refetchInterval: 30_000 },
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const config = configRaw ? {
    warningHF:    Number(configRaw.warningThresholdHF) / Number(HF_PRECISION),
    actionHF:     Number(configRaw.actionThresholdHF)  / Number(HF_PRECISION),
    autoRepay:    configRaw.autoRepayEnabled,
    autoDelevg:   configRaw.autoDeleverageEnabled,
    alertOnly:    configRaw.alertOnlyMode,
    maxRepayBP:   configRaw.maxRepayBasisPoints,
    maxDelgBP:    configRaw.maxDeleverageBP,
    agentEnabled: configRaw.agentEnabled,
  } : null;

  const stats = statsRaw ? {
    totalActions:           Number(statsRaw[0]),
    totalValueProtectedUSD: Number(statsRaw[1]) / 1e8,
    lastConfigUpdate:       Number(statsRaw[2]),
  } : null;

  function saveConfig(params: {
    warningHF:  number;
    actionHF:   number;
    autoRepay:  boolean;
    autoDelevg: boolean;
    alertOnly:  boolean;
    maxRepayBP: number;
    maxDelgBP:  number;
  }) {
    writeContract({
      address: ADDRESSES.AGENT_REGISTRY,
      abi:     AGENT_REGISTRY_ABI,
      functionName: "setFullConfig",
      args: [
        hfToBigInt(params.warningHF),
        hfToBigInt(params.actionHF),
        params.autoRepay,
        params.autoDelevg,
        params.alertOnly,
        params.maxRepayBP,
        params.maxDelgBP,
      ],
    });
  }

  function toggleAgent(enabled: boolean) {
    writeContract({
      address: ADDRESSES.AGENT_REGISTRY,
      abi:     AGENT_REGISTRY_ABI,
      functionName: "setAgentEnabled",
      args:    [enabled],
    });
  }

  function initConfig() {
    writeContract({
      address: ADDRESSES.AGENT_REGISTRY,
      abi:     AGENT_REGISTRY_ABI,
      functionName: "initialiseConfig",
      args:    [],
    });
  }

  return {
    config, stats,
    isLoading, refetch,
    saveConfig, toggleAgent, initConfig,
    isPending:    isPending || isConfirming,
    isSuccess,
    txHash,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// hooks/useAgentActivity.ts
// Polls agent server /api/activity/:address for action history
// ─────────────────────────────────────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";

const AGENT_SERVER = process.env.NEXT_PUBLIC_AGENT_SERVER_URL || "http://localhost:3001";

export interface AgentAction {
  id:            number;
  user:          string;
  action_type:   string;
  token:         string | null;
  amount:        string | null;
  tx_hash:       string | null;
  hf_before:     number | null;
  hf_after:      number | null;
  explanation:   string | null;
  success:       number;  // 0 or 1
  error_message: string | null;
  executed_at:   number;
}

export function useAgentActivity(address?: string) {
  return useQuery<AgentAction[]>({
    queryKey:    ["agent-activity", address],
    queryFn:     async () => {
      if (!address) return [];
      const res = await fetch(`${AGENT_SERVER}/api/activity/${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.actions ?? [];
    },
    enabled:         !!address,
    refetchInterval: 10_000,
    staleTime:       5_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// hooks/useAgentHealth.ts
// Polls agent server /health to show "Agent Online" status
// ─────────────────────────────────────────────────────────────────────────────
export interface AgentHealth {
  status:          "starting" | "running" | "error";
  lastScanAt:      number | null;
  totalScans:      number;
  activePositions: number;
  uptimeSeconds:   number;
}

export function useAgentHealth() {
  return useQuery<AgentHealth | null>({
    queryKey:    ["agent-health"],
    queryFn:     async () => {
      try {
        const res = await fetch(`${AGENT_SERVER}/health`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    refetchInterval: 15_000,
    staleTime:       10_000,
  });
}
