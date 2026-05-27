/**
 * config/thresholds.js — Global agent configuration
 * ────────────────────────────────────────────────────
 * Protocol-level defaults. Per-user overrides are read from AgentRegistry
 * in decisionEngine.js — these are the fallback values used when a user
 * hasn't configured their registry entry yet.
 */

"use strict";

module.exports = {
  thresholds: {
    // Health factor bands (JS numbers, not BigInt)
    warning: parseFloat(process.env.DEFAULT_WARNING_HF || "1.6"),
    action: parseFloat(process.env.DEFAULT_ACTION_HF || "1.4"),
    critical: parseFloat(process.env.DEFAULT_CRITICAL_HF || "1.1"),

    // Max % of debt the agent repays in a single tx (basis points)
    maxRepayBP: parseInt(process.env.DEFAULT_MAX_REPAY_BP || "2000"), // 20%
    maxDelgBP: parseInt(process.env.DEFAULT_MAX_DELG_BP || "3000"), // 30%
  },

  scan: {
    // Cron expression for the main scan loop
    cron: process.env.SCAN_CRON || "*/30 * * * * *",
    // How many historical blocks to replay on startup
    eventReplayBlocks: parseInt(process.env.EVENT_REPLAY_BLOCKS || "100000"),
    // Max concurrent user scans per cycle
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || "10"),
  },

  risk: {
    // Number of Chainlink rounds to sample for volatility
    volatilityRounds: parseInt(process.env.VOLATILITY_ROUNDS || "24"),
    // Price shock scenarios to simulate (basis points)
    scenariosBP: [-500, -1000, -2000, -3000, -5000],
    scenarioLabels: ["-5%", "-10%", "-20%", "-30%", "-50%"],
  },

  executor: {
    // Extra gas above estimate (%)
    gasBufferPct: parseInt(process.env.GAS_BUFFER_PCT || "20"),
    // Max gas price to pay (gwei) — Arbitrum is cheap
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || "2"),
    // Slippage tolerance for DEX swaps (basis points)
    slippageBP: parseInt(process.env.SLIPPAGE_BP || "50"),
    // Seconds to wait for tx confirmation
    confirmTimeoutMs: parseInt(process.env.CONFIRM_TIMEOUT_MS || "60000"),
  },

  // Known token addresses on Arbitrum One (lowercase)
  tokens: {
    WETH: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    USDC: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    WBTC: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
    ARB: "0x912ce59144191c1204e64559fe8253a0e49e6548",
  },
};
