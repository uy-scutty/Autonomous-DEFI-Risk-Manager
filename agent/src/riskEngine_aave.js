/**
 * riskEngine.js — Risk Assessment Engine (Aave Guardian Edition)
 * ────────────────────────────────────────────────────────────────
 * CHANGES FROM v1:
 *   - Gets prices from AaveAdapter.getAssetPrices() (Aave's oracle)
 *     instead of RiskOracle.batchGetPrices()
 *   - Gets scenario HFs from AaveAdapter.simulateHFAfterPriceShock()
 *     instead of VaultManager.simulateHealthFactor()
 *   - Debt breakdown uses AaveAdapter.getUserDebt() per token
 *   - Collateral breakdown uses AaveAdapter.getUserCollateral() per token
 *   - Volatility: still computed from Chainlink rounds directly
 *     (Aave uses Chainlink feeds — we call them directly for vol)
 *
 * Everything else (band classification, risk scoring, TTL estimate) unchanged.
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS   = require("./abis");
const config = require("../config/thresholds");

// ── Known Aave v3 reserve tokens on Arbitrum One ─────────────────────────────
// Agent needs these to build breakdowns. In production, fetch dynamically
// from dataProvider.getAllReservesTokens().
const ARBITRUM_RESERVES = [
  { address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", symbol: "WETH",  decimals: 18 },
  { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", symbol: "USDC",  decimals: 6  },
  { address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", symbol: "WBTC",  decimals: 8  },
  { address: "0x912ce59144191c1204e64559fe8253a0e49e6548", symbol: "ARB",   decimals: 18 },
  { address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", symbol: "USDT",  decimals: 6  },
  { address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", symbol: "DAI",   decimals: 18 },
];

const HF_PRECISION    = 1e18;
const PRICE_PRECISION = 1e8;  // Aave oracle returns 8-dec USD prices

let _adapter = null;

function getAdapter(provider) {
  if (!_adapter) {
    _adapter = new ethers.Contract(
      process.env.AAVE_ADAPTER_ADDRESS,
      ABIS.AaveAdapter,
      provider
    );
  }
  return _adapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main assessment function
// ─────────────────────────────────────────────────────────────────────────────

async function assess(position, provider) {
  const { user, healthFactor: rawHF,
          totalCollateralUSD: rawCollUSD,
          totalDebtUSD: rawDebtUSD,
          liquidationThreshold } = position;

  const adapter = getAdapter(provider);

  // ── 1. Parse values (Aave uses 8-dec USD, HF is 18-dec) ──────────────────
  const healthFactor       = Number(BigInt(rawHF)) / HF_PRECISION;
  const totalCollateralUSD = Number(BigInt(rawCollUSD)) / PRICE_PRECISION;
  const totalDebtUSD       = Number(BigInt(rawDebtUSD)) / PRICE_PRECISION;

  // ── 2. Get prices for all reserve tokens from Aave's oracle ───────────────
  const tokenAddresses = ARBITRUM_RESERVES.map((r) => r.address);
  let prices = {};

  try {
    const rawPrices = await adapter.getAssetPrices(tokenAddresses);
    for (let i = 0; i < tokenAddresses.length; i++) {
      // Aave oracle returns 8-dec USD — convert to plain number
      prices[tokenAddresses[i]] = Number(rawPrices[i]) / PRICE_PRECISION;
    }
  } catch (err) {
    logError(`riskEngine: getAssetPrices failed — ${err.message}`);
  }

  // ── 3. Build collateral + debt breakdowns per token ───────────────────────
  const collateralBreakdown = [];
  const debtBreakdown       = [];
  let dominantCollateralToken = null;
  let maxCollateralUSD        = 0;

  await Promise.all(
    ARBITRUM_RESERVES.map(async (reserve) => {
      try {
        const [aTokenBal, usedAsCollateral] =
          await adapter.getUserCollateral(user, reserve.address);
        const [variableDebt] =
          await adapter.getUserDebt(user, reserve.address);

        const price       = prices[reserve.address] || 0;
        const collAmount  = Number(aTokenBal)     / Math.pow(10, reserve.decimals);
        const debtAmount  = Number(variableDebt)  / Math.pow(10, reserve.decimals);
        const collUSD     = collAmount * price;
        const debtUSD     = debtAmount * price;

        if (collUSD > 0 && usedAsCollateral) {
          const pct = totalCollateralUSD > 0
            ? (collUSD / totalCollateralUSD) * 100 : 0;
          collateralBreakdown.push({
            token: reserve.address, symbol: reserve.symbol,
            amount: collAmount, amountUSD: collUSD,
            pct: Math.round(pct * 10) / 10,
          });
          if (collUSD > maxCollateralUSD) {
            maxCollateralUSD        = collUSD;
            dominantCollateralToken = reserve.address;
          }
        }

        if (debtUSD > 0) {
          const pct = totalDebtUSD > 0
            ? (debtUSD / totalDebtUSD) * 100 : 0;
          debtBreakdown.push({
            token: reserve.address, symbol: reserve.symbol,
            amount: debtAmount, amountUSD: debtUSD,
            pct: Math.round(pct * 10) / 10,
          });
        }
      } catch { /* token not in user's position — skip */ }
    })
  );

  // ── 4. Price shock scenarios via AaveAdapter ──────────────────────────────
  const scenariosBP     = [-500, -1000, -2000, -3000, -5000];
  const scenarioLabels  = ["-5%", "-10%", "-20%", "-30%", "-50%"];
  const scenarios       = {};

  if (dominantCollateralToken && totalDebtUSD > 0) {
    await Promise.all(
      scenariosBP.map(async (bp, i) => {
        try {
          const simHF = await adapter.simulateHFAfterPriceShock(
            user, dominantCollateralToken, bp
          );
          const simHFNum = simHF.toString() ===
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            ? Infinity
            : Number(simHF) / HF_PRECISION;
          scenarios[scenarioLabels[i]] = Math.round(simHFNum * 1000) / 1000;
        } catch {
          // Linear approximation fallback
          const drop = Math.abs(bp) / 10000;
          scenarios[scenarioLabels[i]] =
            Math.round(healthFactor * (1 - drop) * 1000) / 1000;
        }
      })
    );
  } else {
    for (const l of scenarioLabels) scenarios[l] = Infinity;
  }

  // ── 5. Volatility (unchanged — Chainlink rounds) ──────────────────────────
  // Aave uses Chainlink under the hood. For volatility we call the Chainlink
  // feed directly. For the agent this is already in the existing logic.
  // For Aave guardian we skip on-chain volatility and use a simplified estimate.
  const volatilityBP = await _estimateVolatility(dominantCollateralToken, provider);

  // ── 6. Band, score, TTL (logic unchanged from v1) ─────────────────────────
  const band              = classifyBand(healthFactor, config.thresholds.warning, config.thresholds.action);
  const riskScore         = computeRiskScore(healthFactor, volatilityBP, collateralBreakdown);
  const timeToLiquidation = estimateTimeToLiquidation(healthFactor, volatilityBP);

  const report = {
    user,
    healthFactor:           Math.round(healthFactor * 10000) / 10000,
    band,
    totalCollateralUSD:     Math.round(totalCollateralUSD * 100) / 100,
    totalDebtUSD:           Math.round(totalDebtUSD * 100) / 100,
    liquidationThreshold:   liquidationThreshold / 100, // convert to pct
    collateralBreakdown,
    debtBreakdown,
    scenarios,
    volatilityBP,
    riskScore,
    dominantCollateralToken,
    timeToLiquidation,
    assessedAt: Date.now(),
    source: "aave_v3", // tag so frontend knows which protocol
  };

  log(`[${user}] HF=${healthFactor.toFixed(4)} band=${band} score=${riskScore} (Aave)`);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simplified volatility estimate without on-chain Chainlink calls
// (full implementation: call Chainlink feed directly as in v1 RiskOracle)
// ─────────────────────────────────────────────────────────────────────────────

const CHAINLINK_FEEDS = {
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // ETH/USD
  "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": "0x6ce185539ad4fdABF2b548De13A3b9AbFD576B11", // BTC/USD
  "0x912ce59144191c1204e64559fe8253a0e49e6548": "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6", // ARB/USD
};

const CHAINLINK_ABI = [
  "function getRoundData(uint80) external view returns (uint80,int256,uint256,uint256,uint80)",
  "function latestRoundData() external view returns (uint80,int256,uint256,uint256,uint80)",
];

async function _estimateVolatility(tokenAddress, provider) {
  if (!tokenAddress) return 0;
  const feedAddress = CHAINLINK_FEEDS[tokenAddress.toLowerCase()];
  if (!feedAddress)  return 0;

  try {
    const feed = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
    const [latestRoundId, latestAnswer] = await feed.latestRoundData();

    const NUM_ROUNDS = 12; // ~12 hours if 1hr heartbeat
    const prices = [Number(latestAnswer)];

    for (let i = 1; i < NUM_ROUNDS; i++) {
      try {
        const roundId = BigInt(latestRoundId) - BigInt(i);
        const [,ans] = await feed.getRoundData(roundId);
        if (Number(ans) > 0) prices.push(Number(ans));
      } catch { break; }
    }

    if (prices.length < 2) return 0;

    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => {
      const diffBP = Math.abs(p - mean) / mean * 10000;
      return sum + diffBP * diffBP;
    }, 0) / prices.length;

    return Math.round(Math.sqrt(variance));
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unchanged from v1
// ─────────────────────────────────────────────────────────────────────────────

function classifyBand(hf, warningHF, actionHF) {
  if (hf === Infinity || hf > warningHF) return "SAFE";
  if (hf >= actionHF)                    return "WARNING";
  if (hf >= 1.0)                         return "ACTION";
  return "CRITICAL";
}

function computeRiskScore(hf, volatilityBP, collateralBreakdown) {
  const hfClamped = Math.min(Math.max(hf, 1.0), 3.0);
  const hfScore   = ((3.0 - hfClamped) / 2.0) * 100;
  const volScore  = Math.min((volatilityBP / 1000) * 100, 100);
  const dominant  = collateralBreakdown.length > 0
    ? Math.max(...collateralBreakdown.map((c) => c.pct)) : 100;
  return Math.min(Math.round(0.60 * hfScore + 0.25 * volScore + 0.15 * dominant), 100);
}

function estimateTimeToLiquidation(hf, volatilityBP) {
  if (hf === Infinity || hf > 3.0) return "Not at risk";
  if (hf <= 1.0)                   return "At risk NOW";
  const buffer        = hf - 1.0;
  const dailyVolPct   = (volatilityBP / 10000) * Math.sqrt(24);
  if (dailyVolPct === 0) return "Stable (low volatility)";
  const daysEstimate  = buffer / (hf * dailyVolPct);
  if (daysEstimate < 0.25) return "< 6 hours at current volatility";
  if (daysEstimate < 1)    return `~${Math.round(daysEstimate * 24)} hours at current volatility`;
  if (daysEstimate < 7)    return `~${Math.round(daysEstimate)} day(s) at current volatility`;
  return "> 1 week at current volatility";
}

module.exports = {
  assess,
  classifyBand,
  computeRiskScore,
  estimateTimeToLiquidation,
};
