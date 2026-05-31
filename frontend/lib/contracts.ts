// ─────────────────────────────────────────────────────────────────────────────
// Deployed addresses — update after each deploy
// ─────────────────────────────────────────────────────────────────────────────

export const ADDRESSES = {
  // Your deployed contracts
  AAVE_ADAPTER:        process.env.NEXT_PUBLIC_AAVE_ADAPTER_ADDRESS        as `0x${string}`,
  AGENT_REGISTRY:      process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS      as `0x${string}`,
  PROTECTION_ACTIONS:  process.env.NEXT_PUBLIC_PROTECTION_ACTIONS_ADDRESS  as `0x${string}`,

  // Aave v3 Arbitrum Sepolia
  AAVE_POOL:           "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff" as `0x${string}`,

  // Aave v3 Arbitrum One (mainnet)
  AAVE_POOL_MAINNET:   "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as `0x${string}`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// AaveAdapter ABI
// ─────────────────────────────────────────────────────────────────────────────

export const AAVE_ADAPTER_ABI = [
  {
    name: "getUserPosition",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "user",                        type: "address" },
        { name: "totalCollateralUSD",          type: "uint256" },
        { name: "totalDebtUSD",                type: "uint256" },
        { name: "availableBorrowsUSD",         type: "uint256" },
        { name: "currentLiquidationThreshold", type: "uint256" },
        { name: "ltv",                         type: "uint256" },
        { name: "healthFactor",                type: "uint256" },
        { name: "netWorthUSD",                 type: "uint256" },
        { name: "isAtRisk",                    type: "bool"    },
      ],
    }],
  },
  {
    name: "getHealthFactor",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getUserDebt",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "asset", type: "address" }],
    outputs: [{ name: "variableDebt", type: "uint256" }, { name: "stableDebt", type: "uint256" }],
  },
  {
    name: "getUserCollateral",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "asset", type: "address" }],
    outputs: [{ name: "aTokenBalance", type: "uint256" }, { name: "usedAsCollateral", type: "bool" }],
  },
  {
    name: "getAssetPrice",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "simulateHFAfterRepay",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "repayUSD", type: "uint256" }],
    outputs: [{ name: "simHF", type: "uint256" }],
  },
  {
    name: "simulateHFAfterSupply",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }, { name: "addCollateralUSD", type: "uint256" }],
    outputs: [{ name: "simHF", type: "uint256" }],
  },
  {
    name: "simulateHFAfterPriceShock",
    type: "function",
    stateMutability: "view",
    inputs:  [
      { name: "user",          type: "address" },
      { name: "asset",         type: "address" },
      { name: "priceChangeBP", type: "int256"  },
    ],
    outputs: [{ name: "simHF", type: "uint256" }],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// AgentRegistry ABI
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_REGISTRY_ABI = [
  {
    name: "getConfig",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "warningThresholdHF",    type: "uint256" },
        { name: "actionThresholdHF",     type: "uint256" },
        { name: "autoRepayEnabled",      type: "bool"    },
        { name: "autoDeleverageEnabled", type: "bool"    },
        { name: "alertOnlyMode",         type: "bool"    },
        { name: "maxRepayBasisPoints",   type: "uint16"  },
        { name: "maxDeleverageBP",       type: "uint16"  },
        { name: "agentEnabled",          type: "bool"    },
        { name: "lastConfigUpdate",      type: "uint256" },
        { name: "totalActionsExecuted",  type: "uint256" },
        { name: "totalValueProtectedUSD",type: "uint256" },
      ],
    }],
  },
  {
    name: "hasConfig",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getUserStats",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalActions",            type: "uint256" },
      { name: "totalValueProtectedUSD",  type: "uint256" },
      { name: "lastConfigUpdate",        type: "uint256" },
    ],
  },
  {
    name: "setFullConfig",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "warningHF",    type: "uint256" },
      { name: "actionHF",     type: "uint256" },
      { name: "autoRepay",    type: "bool"    },
      { name: "autoDelevg",   type: "bool"    },
      { name: "alertOnly",    type: "bool"    },
      { name: "maxRepayBP",   type: "uint16"  },
      { name: "maxDelgBP",    type: "uint16"  },
    ],
    outputs: [],
  },
  {
    name: "setAgentEnabled",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "enabled", type: "bool" }],
    outputs: [],
  },
  {
    name: "initialiseConfig",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [],
    outputs: [],
  },
  {
    name: "AgentConfigUpdated",
    type: "event",
    inputs: [
      { name: "user",               type: "address", indexed: true  },
      { name: "warningThresholdHF", type: "uint256", indexed: false },
      { name: "actionThresholdHF",  type: "uint256", indexed: false },
      { name: "autoRepayEnabled",   type: "bool",    indexed: false },
      { name: "autoDeleverageEnabled", type: "bool", indexed: false },
      { name: "alertOnlyMode",      type: "bool",    indexed: false },
      { name: "agentEnabled",       type: "bool",    indexed: false },
    ],
  },
  {
    name: "AgentKillSwitchToggled",
    type: "event",
    inputs: [
      { name: "user",    type: "address", indexed: true  },
      { name: "enabled", type: "bool",    indexed: false },
    ],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const HF_PRECISION    = BigInt("1000000000000000000"); // 1e18
export const PRICE_PRECISION = BigInt("100000000");           // 1e8 (Aave oracle)
