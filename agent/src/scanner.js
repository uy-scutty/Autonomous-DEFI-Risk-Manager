/**
 * scanner.js — Position Scanner
 * ──────────────────────────────
 * Fetches all registered user positions from VaultManager.
 * Two modes:
 *   1. fetchAllPositions() — periodic full scan via multicall
 *   2. startEventListeners() — real-time reaction to on-chain events
 *
 * Position shape returned:
 * {
 *   user:        "0x...",
 *   collateral:  { "0xWETH": "10000000000000000000", "0xUSDC": "0" },
 *   borrowed:    { "0xUSDC": "8000000000", "0xWETH": "0" },
 *   healthFactor: "2000000000000000000",   // 18-dec, on-chain value
 *   lastUpdate:  1712345678,
 *   totalCollateralUSD: "16000000000000000000000",
 *   totalDebtUSD:       "8000000000000000000000",
 * }
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

// ─────────────────────────────────────────────────────────────────────────────
// Contract instances (lazy-initialised)
// ─────────────────────────────────────────────────────────────────────────────

let _vaultManager = null;
let _userSet = new Set(); // local cache of known users

function getVaultManager(provider) {
  if (!_vaultManager) {
    _vaultManager = new ethers.Contract(
      process.env.VAULT_MANAGER_ADDRESS,
      ABIS.VaultManager,
      provider,
    );
  }
  return _vaultManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discover all users who have ever deposited
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replay PositionUpdated events from the last N blocks to build the user set.
 * On subsequent calls we only look at new blocks since last seen.
 */
let _lastScannedBlock = 0;

async function discoverUsers(provider) {
  const vault = getVaultManager(provider);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock =
    _lastScannedBlock > 0
      ? _lastScannedBlock + 1
      : Math.max(
          0,
          latestBlock - parseInt(process.env.EVENT_REPLAY_BLOCKS || "100000"),
        );

  try {
    // PositionUpdated(address indexed user, address indexed token, string action, uint256 amount, uint256 newHF)
    const filter = vault.filters.PositionUpdated();
    const events = await vault.queryFilter(filter, fromBlock, latestBlock);

    for (const evt of events) {
      _userSet.add(evt.args.user.toLowerCase());
    }
    _lastScannedBlock = latestBlock;
  } catch (err) {
    logError(`discoverUsers: event query failed — ${err.message}`);
    // Non-fatal: continue with existing user set
  }

  return [..._userSet];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a single user's position
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPosition(user, provider) {
  const vault = getVaultManager(provider);
  const tokens = await vault.getSupportedTokens();

  // Fetch collateral + borrowed for each token in parallel
  const [collateralAmts, borrowedAmts, summary] = await Promise.all([
    Promise.all(tokens.map((t) => vault.getCollateral(user, t))),
    Promise.all(tokens.map((t) => vault.getBorrowed(user, t))),
    vault.getPositionSummary(user),
  ]);

  const collateral = {};
  const borrowed = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].toLowerCase();
    collateral[token] = collateralAmts[i].toString();
    borrowed[token] = borrowedAmts[i].toString();
  }

  return {
    user: user.toLowerCase(),
    collateral,
    borrowed,
    healthFactor: summary.healthFactor.toString(),
    totalCollateralUSD: summary.totalCollateralUSD.toString(),
    totalDebtUSD: summary.totalDebtUSD.toString(),
    lastUpdate: Number(summary.lastUpdate),
    tokens: tokens.map((t) => t.toLowerCase()),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch all positions (full scan)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllPositions(provider) {
  const users = await discoverUsers(provider);

  if (users.length === 0) return [];

  log(`Fetching positions for ${users.length} user(s)...`);

  // Batch RPC calls — 20 users at a time to avoid timeouts
  const BATCH = 20;
  const results = [];

  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map((user) => fetchPosition(user, provider)),
    );

    for (const result of settled) {
      if (result.status === "fulfilled") {
        const pos = result.value;
        // Skip positions with zero total collateral (empty/closed)
        if (pos.totalCollateralUSD !== "0") {
          results.push(pos);
        }
      } else {
        logError(
          `fetchAllPositions: failed for a user — ${result.reason?.message}`,
        );
      }
    }
  }

  log(`Fetched ${results.length} active position(s)`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time event listeners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to on-chain events that indicate a position has changed.
 * Calls `onEvent({ type, user })` so the main loop can immediately
 * re-assess the affected user without waiting for the next cron tick.
 */
async function startEventListeners(provider, onEvent) {
  const vault = getVaultManager(provider);

  // PositionUpdated fires on deposit/borrow/repay/withdraw
  vault.on("PositionUpdated", (user, token, action, amount, newHF, evt) => {
    _userSet.add(user.toLowerCase());
    log(`[event:PositionUpdated] user=${user} action=${action}`);
    onEvent({ type: "PositionUpdated", user, action, token });
  });

  // HealthFactorChanged fires when the band changes (SAFE→WARNING etc.)
  vault.on("HealthFactorChanged", (user, oldHF, newHF, band, evt) => {
    log(
      `[event:HealthFactorChanged] user=${user} band=${band} HF=${ethers.formatUnits(newHF, 18)}`,
    );
    onEvent({ type: "HealthFactorChanged", user, band, oldHF, newHF });
  });

  // ProtectionTriggered — another keeper may have already acted
  vault.on(
    "ProtectionTriggered",
    (user, keeper, actionType, token, amount, hfBefore, hfAfter) => {
      log(
        `[event:ProtectionTriggered] user=${user} action=${actionType} by=${keeper}`,
      );
      onEvent({ type: "ProtectionTriggered", user, actionType, keeper });
    },
  );

  log(
    "Event listeners registered: PositionUpdated, HealthFactorChanged, ProtectionTriggered",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  fetchAllPositions,
  fetchPosition,
  startEventListeners,
};
