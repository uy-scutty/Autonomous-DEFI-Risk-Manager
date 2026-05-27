/**
 * riskEngine.js — Risk Assessment Engine
 * ────────────────────────────────────────
 * Takes a raw position from the scanner and produces a RiskReport:
 *
 * RiskReport {
 *   user:           "0x...",
 *   healthFactor:   2.0,          // current HF (JS number, not BigInt)
 *   band:           "SAFE",       // SAFE | WARNING | ACTION | CRITICAL
 *   totalCollateralUSD: 16000,    // USD (JS number)
 *   totalDebtUSD:       8000,
 *   collateralBreakdown: [{ token, symbol, amountUSD, pct }],
 *   debtBreakdown:       [{ token, symbol, amountUSD, pct }],
 *   scenarios: {
 *     "-5%":  1.90,
 *     "-10%": 1.80,
 *     "-20%": 1.60,
 *     "-30%": 1.40,
 *     "-50%": 1.00,
 *   },
 *   volatilityBP:  150,           // realised stddev as basis points (from RiskOracle)
 *   riskScore:     72,            // 0–100 composite score (higher = riskier)
 *   dominantCollateralToken: "0xWETH",
 *   timeToLiquidation: "~4 hours at current volatility", // human string
 * }
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");
const config = require("../config/thresholds");

// ─────────────────────────────────────────────────────────────────────────────
// Contract instances
// ─────────────────────────────────────────────────────────────────────────────

let _vaultManager = null;
let _riskOracle = null;

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

function getRiskOracle(provider) {
  if (!_riskOracle) {
    _riskOracle = new ethers.Contract(
      process.env.RISK_ORACLE_ADDRESS,
      ABIS.RiskOracle,
      provider,
    );
  }
  return _riskOracle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token metadata cache (symbol + decimals)
// ─────────────────────────────────────────────────────────────────────────────

const _tokenMeta = {};

async function getTokenMeta(tokenAddress, provider) {
  const addr = tokenAddress.toLowerCase();
  if (_tokenMeta[addr]) return _tokenMeta[addr];

  // Minimal ERC-20 ABI
  const erc20 = new ethers.Contract(
    tokenAddress,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    provider,
  );

  try {
    const [symbol, decimals] = await Promise.all([
      erc20.symbol(),
      erc20.decimals(),
    ]);
    _tokenMeta[addr] = { symbol, decimals: Number(decimals) };
  } catch {
    _tokenMeta[addr] = { symbol: "???", decimals: 18 };
  }

  return _tokenMeta[addr];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main assessment function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * assess(position, provider) → RiskReport
 *
 * @param {object} position  Output from scanner.fetchPosition()
 * @param {object} provider  ethers.js provider
 */
async function assess(position, provider) {
  const {
    user,
    tokens,
    collateral,
    borrowed,
    healthFactor: rawHF,
    totalCollateralUSD: rawCollUSD,
    totalDebtUSD: rawDebtUSD,
  } = position;

  const vault = getVaultManager(provider);
  const oracle = getRiskOracle(provider);

  // ── 1. Parse on-chain values to JS numbers ────────────────────────────────
  const HF_PRECISION = 1e18;
  const PRICE_PRECISION = 1e18;

  const healthFactor = Number(BigInt(rawHF)) / HF_PRECISION;
  const totalCollateralUSD = Number(BigInt(rawCollUSD)) / PRICE_PRECISION;
  const totalDebtUSD = Number(BigInt(rawDebtUSD)) / PRICE_PRECISION;

  // ── 2. Token metadata ─────────────────────────────────────────────────────
  const metaMap = {};
  await Promise.all(
    tokens.map(async (t) => {
      metaMap[t] = await getTokenMeta(t, provider);
    }),
  );

  // ── 3. Collateral + debt breakdowns ──────────────────────────────────────
  // Fetch current prices for all tokens via batchGetPrices
  let prices = {};
  try {
    const snapshots = await oracle.batchGetPrices(tokens);
    for (const snap of snapshots) {
      prices[snap.token.toLowerCase()] =
        Number(BigInt(snap.priceUSD18)) / PRICE_PRECISION;
    }
  } catch (err) {
    logError(`riskEngine: batchGetPrices failed — ${err.message}`);
    // Fall back to on-chain HF (already computed) — breakdowns will be empty
  }

  const collateralBreakdown = [];
  const debtBreakdown = [];
  let dominantCollateralToken = null;
  let maxCollateralUSD = 0;

  for (const token of tokens) {
    const meta = metaMap[token];
    const collRaw = BigInt(collateral[token] || "0");
    const debtRaw = BigInt(borrowed[token] || "0");
    const price = prices[token] || 0;

    // Normalise token amount to a JS number in "whole tokens"
    const collAmount = Number(collRaw) / Math.pow(10, meta.decimals);
    const debtAmount = Number(debtRaw) / Math.pow(10, meta.decimals);

    const collAmountUSD = collAmount * price;
    const debtAmountUSD = debtAmount * price;

    if (collAmountUSD > 0) {
      const pct =
        totalCollateralUSD > 0 ? (collAmountUSD / totalCollateralUSD) * 100 : 0;

      collateralBreakdown.push({
        token,
        symbol: meta.symbol,
        amount: collAmount,
        amountUSD: collAmountUSD,
        pct: Math.round(pct * 10) / 10,
      });

      if (collAmountUSD > maxCollateralUSD) {
        maxCollateralUSD = collAmountUSD;
        dominantCollateralToken = token;
      }
    }

    if (debtAmountUSD > 0) {
      const pct = totalDebtUSD > 0 ? (debtAmountUSD / totalDebtUSD) * 100 : 0;

      debtBreakdown.push({
        token,
        symbol: meta.symbol,
        amount: debtAmount,
        amountUSD: debtAmountUSD,
        pct: Math.round(pct * 10) / 10,
      });
    }
  }

  // ── 4. Price scenarios ────────────────────────────────────────────────────
  // Use VaultManager.simulateHealthFactor for the dominant collateral token.
  // Scenarios: -5%, -10%, -20%, -30%, -50%
  const scenariosBP = [-500, -1000, -2000, -3000, -5000];
  const scenarioLabels = ["-5%", "-10%", "-20%", "-30%", "-50%"];
  const scenarios = {};

  if (dominantCollateralToken && totalDebtUSD > 0) {
    try {
      await Promise.all(
        scenariosBP.map(async (bp, i) => {
          const simHF = await vault.simulateHealthFactor(
            user,
            dominantCollateralToken,
            bp,
          );
          const simHFNum =
            simHF ===
            BigInt(
              "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            )
              ? Infinity
              : Number(simHF) / HF_PRECISION;
          scenarios[scenarioLabels[i]] = Math.round(simHFNum * 1000) / 1000;
        }),
      );
    } catch (err) {
      logError(`riskEngine: simulateHealthFactor failed — ${err.message}`);
      // Approximate scenarios using linear scaling
      for (let i = 0; i < scenariosBP.length; i++) {
        const priceDrop = Math.abs(scenariosBP[i]) / 10000;
        // Simplified: HF scales linearly with collateral value
        scenarios[scenarioLabels[i]] =
          Math.round(healthFactor * (1 - priceDrop) * 1000) / 1000;
      }
    }
  } else {
    for (const label of scenarioLabels) scenarios[label] = Infinity;
  }

  // ── 5. Volatility ─────────────────────────────────────────────────────────
  let volatilityBP = 0;

  if (dominantCollateralToken) {
    try {
      const volResult = await oracle.computeVolatility(
        dominantCollateralToken,
        24,
      );
      volatilityBP = Number(volResult.stdDevBP);
    } catch (err) {
      // Volatility is non-critical — use 0 as fallback
      logError(`riskEngine: computeVolatility failed — ${err.message}`);
    }
  }

  // ── 6. Band classification ────────────────────────────────────────────────
  const band = classifyBand(
    healthFactor,
    config.thresholds.warning,
    config.thresholds.action,
  );

  // ── 7. Composite risk score (0–100) ───────────────────────────────────────
  const riskScore = computeRiskScore(
    healthFactor,
    volatilityBP,
    collateralBreakdown,
  );

  // ── 8. Time-to-liquidation estimate ──────────────────────────────────────
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
    collateralBreakdown,
    debtBreakdown,
    scenarios,
    volatilityBP,
    riskScore,
    dominantCollateralToken,
    timeToLiquidation,
    assessedAt: Date.now(),
  };

  log(
    `[${user}] HF=${healthFactor.toFixed(4)} band=${band} score=${riskScore} vol=${volatilityBP}bp`,
  );
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Band classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a health factor into a risk band.
 * Uses the default thresholds unless overridden by user config
 * (DecisionEngine applies per-user overrides on top of this).
 */
function classifyBand(hf, warningHF, actionHF) {
  if (hf === Infinity || hf > warningHF) return "SAFE";
  if (hf >= actionHF) return "WARNING";
  if (hf >= 1.0) return "ACTION";
  return "CRITICAL";
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite risk score (0 = safest, 100 = liquidating now)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weights:
 *   60% — health factor (normalised between 1.0 and 3.0)
 *   25% — realised volatility (higher vol = riskier)
 *   15% — collateral concentration (single-asset risk)
 */
function computeRiskScore(hf, volatilityBP, collateralBreakdown) {
  // HF component: HF=1.0 → 100, HF=3.0 → 0
  const HF_MIN = 1.0;
  const HF_SAFE = 3.0;
  const hfClamped = Math.min(Math.max(hf, HF_MIN), HF_SAFE);
  const hfScore = ((HF_SAFE - hfClamped) / (HF_SAFE - HF_MIN)) * 100;

  // Volatility component: 0 bp = 0, 1000 bp (10%) = 100
  const volScore = Math.min((volatilityBP / 1000) * 100, 100);

  // Concentration component: dominant asset % / 100 * 100
  const dominant =
    collateralBreakdown.length > 0
      ? Math.max(...collateralBreakdown.map((c) => c.pct))
      : 100;
  const concScore = dominant; // already 0–100

  const score = 0.6 * hfScore + 0.25 * volScore + 0.15 * concScore;
  return Math.min(Math.round(score), 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-to-liquidation estimate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Very rough estimate: given current HF and 24h realised volatility,
 * how long before HF hits 1.0 under continuous price drift?
 * Returns a human-readable string.
 */
function estimateTimeToLiquidation(hf, volatilityBP) {
  if (hf === Infinity || hf > 3.0) return "Not at risk";
  if (hf <= 1.0) return "At risk NOW";

  // HF buffer before liquidation (1.0)
  const buffer = hf - 1.0;

  // Volatility as daily drift (stddev per round converted to per-day)
  // volatilityBP is stddev as % of mean across ~24 rounds
  // Treat each round ≈ 1 hour → daily vol ≈ volatilityBP * sqrt(24)
  const dailyVolPct = (volatilityBP / 10000) * Math.sqrt(24);

  if (dailyVolPct === 0) return "Stable (low volatility)";

  // Days until liquidation assuming 1-sigma daily move against position
  // HF drops proportionally to collateral price: ΔHF ≈ HF * Δprice%
  // Days until buffer exhausted: buffer / (hf * dailyVolPct)
  const daysEstimate = buffer / (hf * dailyVolPct);

  if (daysEstimate < 0.25) return "< 6 hours at current volatility";
  if (daysEstimate < 1)
    return `~${Math.round(daysEstimate * 24)} hours at current volatility`;
  if (daysEstimate < 7)
    return `~${Math.round(daysEstimate)} day(s) at current volatility`;
  return "> 1 week at current volatility";
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  assess,
  classifyBand,
  computeRiskScore,
  estimateTimeToLiquidation,
};
