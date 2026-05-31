/**
 * scanner.js — Position Scanner (Aave Guardian Edition)
 * ───────────────────────────────────────────────────────
 *   - Reads positions from AaveAdapter.getUserPosition()
 *   - User discovery: watches for Aave Supply/Borrow events instead of PositionUpdated
 *   - Position shape is now driven by Aave's getUserAccountData output
 *
 * Position shape returned:
 * {
 *   user:            "0x...",
 *   healthFactor:    "1800000000000000000",   // 18-dec
 *   totalCollateralUSD: "16000000000",        // 8-dec USD (Aave standard)
 *   totalDebtUSD:       "8000000000",         // 8-dec USD
 *   availableBorrowsUSD:"1000000000",
 *   liquidationThreshold: 8250,              // basis points
 *   isAtRisk:        false,
 * }
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

// ── Aave v3 Pool on Arbitrum Sepolia (for event listening — we watch Aave directly) ──
const AAVE_POOL_ADDRESS =
  process.env.AAVE_POOL_ADDRESS || "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff";

// Minimal Aave Pool ABI — only the events and view functions we need
const AAVE_POOL_ABI = [
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
];

let _adapter = null;
let _aavePool = null;
let _userSet = new Set();
let _lastScannedBlock = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helper (caching functions)
// ─────────────────────────────────────────────────────────────────────────────

function getAdapter(provider) {
  if (!_adapter) {
    _adapter = new ethers.Contract(
      process.env.AAVE_ADAPTER_ADDRESS,
      ABIS.AaveAdapter,
      provider,
    );
  }
  return _adapter;
}

function getAavePool(provider) {
  if (!_aavePool) {
    _aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
  }
  return _aavePool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discover users by replaying Aave Supply + Borrow events
// ─────────────────────────────────────────────────────────────────────────────

async function discoverUsers(provider) {
  const pool = getAavePool(provider);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock =
    _lastScannedBlock > 0
      ? _lastScannedBlock + 1
      : Math.max(
          0,
          latestBlock - parseInt(process.env.EVENT_REPLAY_BLOCKS || "100000"),
        );

  try {
    // Watch for anyone who has ever borrowed (those are the at-risk users)
    const borrowFilter = pool.filters.Borrow();
    const events = await pool.queryFilter(borrowFilter, fromBlock, latestBlock);

    for (const evt of events) {
      // onBehalfOf is who actually owns the debt position
      _userSet.add(evt.args.onBehalfOf.toLowerCase());
    }
    _lastScannedBlock = latestBlock;
    log(`discoverUsers: ${_userSet.size} unique borrowers found`);
  } catch (err) {
    logError(`discoverUsers: ${err.message}`);
  }

  return [..._userSet];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a single user's Aave position via AaveAdapter
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPosition(user, provider) {
  const adapter = getAdapter(provider);

  // Single call returns everything from Aave's getUserAccountData
  const pos = await adapter.getUserPosition(user);

  return {
    user: user.toLowerCase(),
    healthFactor: pos.healthFactor.toString(),
    totalCollateralUSD: pos.totalCollateralUSD.toString(), // 8-dec
    totalDebtUSD: pos.totalDebtUSD.toString(), // 8-dec
    availableBorrowsUSD: pos.availableBorrowsUSD.toString(),
    liquidationThreshold: Number(pos.currentLiquidationThreshold),
    ltv: Number(pos.ltv),
    netWorthUSD: pos.netWorthUSD.toString(),
    isAtRisk: pos.isAtRisk,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch all positions
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllPositions(provider) {
  const users = await discoverUsers(provider);
  if (users.length === 0) return [];

  log(`Fetching Aave positions for ${users.length} user(s)...`);

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
        // Skip users with no debt (no liquidation risk)
        if (pos.totalDebtUSD !== "0") {
          results.push(pos);
        }
      } else {
        logError(`fetchAllPositions: ${result.reason?.message}`);
      }
    }
  }

  log(`${results.length} active Aave borrowing position(s) found`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time Aave event listeners
// ─────────────────────────────────────────────────────────────────────────────

async function startEventListeners(provider, onEvent) {
  const pool = getAavePool(provider);
  const adapter = getAdapter(provider);

  // Watch Aave Borrow → new user or increased risk
  pool.on("Borrow", (reserve, user, onBehalfOf, amount) => {
    _userSet.add(onBehalfOf.toLowerCase());
    log(`[event:Borrow] user=${onBehalfOf} asset=${reserve}`);
    onEvent({ type: "Borrow", user: onBehalfOf });
  });

  // Watch Aave Supply → HF improved (may be our own action)
  pool.on("Supply", (reserve, user, onBehalfOf) => {
    log(`[event:Supply] user=${onBehalfOf} asset=${reserve}`);
    onEvent({ type: "Supply", user: onBehalfOf });
  });

  // Watch Aave Repay → HF improved
  pool.on("Repay", (reserve, user, repayer, amount) => {
    log(`[event:Repay] user=${user} repayer=${repayer}`);
    onEvent({ type: "Repay", user });
  });

  // Watch for LiquidationCall — if this fires, we failed to protect in time
  pool.on("LiquidationCall", (collateralAsset, debtAsset, user) => {
    logError(
      `[event:LiquidationCall] LIQUIDATION OCCURRED for ${user} — agent failed to protect`,
    );
    onEvent({ type: "LiquidationCall", user });
  });

  // Watch our own ProtectionActions events
  const protection = new ethers.Contract(
    process.env.PROTECTION_ACTIONS_ADDRESS,
    ABIS.ProtectionActions,
    provider,
  );

  protection.on("ProtectionExecuted", (user, keeper, actionType) => {
    log(`[event:ProtectionExecuted] user=${user} action=${actionType}`);
    onEvent({ type: "ProtectionExecuted", user, actionType });
  });

  log(
    "Event listeners active: Aave Borrow/Supply/Repay/Liquidation + ProtectionActions",
  );
}

module.exports = {
  fetchAllPositions,
  fetchPosition,
  startEventListeners,
};
