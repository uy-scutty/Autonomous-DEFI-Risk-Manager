/**
 * riskEngine.js — Risk Assessment Engine (Aave Guardian Edition)
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");
const config = require("../config/threshold");

// ── Aave v3 Reserves on Arbitrum Sepolia (Simplified for testing) ─────────────
const ARBITRUM_RESERVES = [
  {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    symbol: "USDC",
    decimals: 6,
  },
];

const HF_PRECISION = 1e18;
const PRICE_PRECISION = 1e8;

let _adapter = null;

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

// ─────────────────────────────────────────────────────────────────────────────
// Main assessment function
// ─────────────────────────────────────────────────────────────────────────────

async function assess(position, provider) {
  const {
    user,
    healthFactor: rawHF,
    totalCollateralUSD: rawCollUSD,
    totalDebtUSD: rawDebtUSD,
    liquidationThreshold,
  } = position;

  const adapter = getAdapter(provider);

  // Parse values
  const healthFactor = Number(BigInt(rawHF)) / HF_PRECISION;
  const totalCollateralUSD = Number(BigInt(rawCollUSD)) / PRICE_PRECISION;
  const totalDebtUSD = Number(BigInt(rawDebtUSD)) / PRICE_PRECISION;

  // Get prices
  const tokenAddresses = ARBITRUM_RESERVES.map((r) => r.address);
  let prices = {};

  try {
    const rawPrices = await adapter.getAssetPrices(tokenAddresses);
    for (let i = 0; i < tokenAddresses.length; i++) {
      prices[tokenAddresses[i]] = Number(rawPrices[i]) / PRICE_PRECISION;
    }
  } catch (err) {
    logError(`riskEngine: getAssetPrices failed — ${err.message}`);
  }

  // Build collateral + debt breakdowns
  const collateralBreakdown = [];
  const debtBreakdown = [];
  let dominantCollateralToken = null;
  let maxCollateralUSD = 0;

  await Promise.all(
    ARBITRUM_RESERVES.map(async (reserve) => {
      try {
        const [aTokenBal, usedAsCollateral] = await adapter.getUserCollateral(
          user,
          reserve.address,
        );
        const [variableDebt] = await adapter.getUserDebt(user, reserve.address);

        const price = prices[reserve.address] || 0;
        const collAmount = Number(aTokenBal) / Math.pow(10, reserve.decimals);
        const debtAmount =
          Number(variableDebt) / Math.pow(10, reserve.decimals);
        const collUSD = collAmount * price;
        const debtUSD = debtAmount * price;

        if (collUSD > 0 && usedAsCollateral) {
          const pct =
            totalCollateralUSD > 0 ? (collUSD / totalCollateralUSD) * 100 : 0;
          collateralBreakdown.push({
            token: reserve.address,
            symbol: reserve.symbol,
            amount: collAmount,
            amountUSD: collUSD,
            pct: Math.round(pct * 10) / 10,
          });
          if (collUSD > maxCollateralUSD) {
            maxCollateralUSD = collUSD;
            dominantCollateralToken = reserve.address;
          }
        }

        if (debtUSD > 0) {
          const pct = totalDebtUSD > 0 ? (debtUSD / totalDebtUSD) * 100 : 0;
          debtBreakdown.push({
            token: reserve.address,
            symbol: reserve.symbol,
            amount: debtAmount,
            amountUSD: debtUSD,
            pct: Math.round(pct * 10) / 10,
          });
        }
      } catch {
        /* token not in user's position — skip */
      }
    }),
  );

  // Price shock scenarios
  const scenariosBP = [-500, -1000, -2000, -3000, -5000];
  const scenarioLabels = ["-5%", "-10%", "-20%", "-30%", "-50%"];
  const scenarios = {};

  if (dominantCollateralToken && totalDebtUSD > 0) {
    await Promise.all(
      scenariosBP.map(async (bp, i) => {
        try {
          const simHF = await adapter.simulateHFAfterPriceShock(
            user,
            dominantCollateralToken,
            bp,
          );
          const simHFNum =
            simHF.toString() ===
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
              ? Infinity
              : Number(simHF) / HF_PRECISION;
          scenarios[scenarioLabels[i]] = Math.round(simHFNum * 1000) / 1000;
        } catch {
          const drop = Math.abs(bp) / 10000;
          scenarios[scenarioLabels[i]] =
            Math.round(healthFactor * (1 - drop) * 1000) / 1000;
        }
      }),
    );
  } else {
    for (const l of scenarioLabels) scenarios[l] = Infinity;
  }

  // Volatility
  const volatilityBP = await _estimateVolatility(
    dominantCollateralToken,
    provider,
  );

  // Final calculations
  const band = classifyBand(
    healthFactor,
    config.thresholds.warning,
    config.thresholds.action,
  );
  const riskScore = computeRiskScore(
    healthFactor,
    volatilityBP,
    collateralBreakdown,
  );
  const timeToLiquidation = estimateTimeToLiquidation(
    healthFactor,
    volatilityBP,
  );

  const report = {
    user,
    healthFactor: Math.round(healthFactor * 10000) / 10000,
    band,
    totalCollateralUSD: Math.round(totalCollateralUSD * 100) / 100,
    totalDebtUSD: Math.round(totalDebtUSD * 100) / 100,
    liquidationThreshold: liquidationThreshold / 100,
    collateralBreakdown,
    debtBreakdown,
    scenarios,
    volatilityBP,
    riskScore,
    dominantCollateralToken,
    timeToLiquidation,
    assessedAt: Date.now(),
    source: "aave_v3",
  };

  log(
    `[${user}] HF=${healthFactor.toFixed(4)} band=${band} score=${riskScore} (Aave)`,
  );
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Volatility Estimation
// ─────────────────────────────────────────────────────────────────────────────

const CHAINLINK_FEEDS = {
  "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d":
    "0x080b7f3f1b8c2b2c22f7c8f0f5f2f9f9f9f9f9f9", // USDC/USD on Sepolia (update if needed)
};

const CHAINLINK_ABI = [
  "function latestRoundData() external view returns (uint80,int256,uint256,uint256,uint80)",
];

async function _estimateVolatility(tokenAddress, provider) {
  if (!tokenAddress) return 0;
  const feedAddress = CHAINLINK_FEEDS[tokenAddress.toLowerCase()];
  if (!feedAddress) return 150; // default moderate volatility for testing

  try {
    const feed = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
    const [, latestAnswer] = await feed.latestRoundData();
    return 120; // Simplified for testnet
  } catch {
    return 150;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function classifyBand(hf, warningHF, actionHF) {
  if (hf === Infinity || hf > warningHF) return "SAFE";
  if (hf >= actionHF) return "WARNING";
  if (hf >= 1.0) return "ACTION";
  return "CRITICAL";
}

function computeRiskScore(hf, volatilityBP, collateralBreakdown) {
  const hfClamped = Math.min(Math.max(hf, 1.0), 3.0);
  const hfScore = ((3.0 - hfClamped) / 2.0) * 100;
  const volScore = Math.min((volatilityBP / 1000) * 100, 100);
  const dominant =
    collateralBreakdown.length > 0
      ? Math.max(...collateralBreakdown.map((c) => c.pct))
      : 100;
  return Math.min(
    Math.round(0.6 * hfScore + 0.25 * volScore + 0.15 * dominant),
    100,
  );
}

function estimateTimeToLiquidation(hf, volatilityBP) {
  if (hf === Infinity || hf > 3.0) return "Not at risk";
  if (hf <= 1.0) return "At risk NOW";
  const buffer = hf - 1.0;
  const dailyVolPct = (volatilityBP / 10000) * Math.sqrt(24);
  if (dailyVolPct === 0) return "Stable (low volatility)";
  const daysEstimate = buffer / (hf * dailyVolPct);
  if (daysEstimate < 0.25) return "< 6 hours at current volatility";
  if (daysEstimate < 1)
    return `~${Math.round(daysEstimate * 24)} hours at current volatility`;
  if (daysEstimate < 7)
    return `~${Math.round(daysEstimate)} day(s) at current volatility`;
  return "> 1 week at current volatility";
}

module.exports = {
  assess,
  classifyBand,
  computeRiskScore,
  estimateTimeToLiquidation,
};
