/**
 * decisionEngine.js — Decision Engine
 * ──────────────────────────────────────
 * Reads a RiskReport + the user's on-chain AgentConfig and decides
 * what action (if any) the agent should take.
 *
 * Decision shape:
 * {
 *   user:           "0x...",
 *   action:         "NONE" | "ALERT" | "PARTIAL_REPAY" | "DELEVERAGE",
 *   shouldExecute:  false,   // true = submit tx, false = alert only
 *   token:          "0xUSDC",
 *   amount:         BigInt("1000000000"), // repay amount in token units
 *   amountHuman:    "1000.00",
 *   reasoning:      "HF dropped to 1.38, below your action threshold of 1.4",
 *   urgency:        "HIGH",   // LOW | MEDIUM | HIGH | CRITICAL
 *   agentConfig:    { ... },  // raw on-chain config for explainer
 * }
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS   = require("./abis");
const config = require("../config/thresholds");

// ─────────────────────────────────────────────────────────────────────────────
// Contract instance
// ─────────────────────────────────────────────────────────────────────────────

let _registry = null;

function getRegistry(provider) {
  if (!_registry) {
    _registry = new ethers.Contract(
      process.env.AGENT_REGISTRY_ADDRESS,
      ABIS.AgentRegistry,
      provider
    );
  }
  return _registry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main evaluate function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * evaluate(riskReport, provider) → Decision
 *
 * @param {object} riskReport  Output from riskEngine.assess()
 * @param {object} provider    ethers.js provider
 */
async function evaluate(riskReport, provider) {
  const { user, healthFactor, band, debtBreakdown,
          collateralBreakdown, scenarios } = riskReport;

  // ── 1. Fetch user's on-chain agent config ─────────────────────────────────
  let agentConfig;
  try {
    agentConfig = await getRegistry(provider).getAgentDecisionParams(user);
  } catch (err) {
    logError(`[${user}] Failed to fetch agent config: ${err.message}`);
    // Safe fallback: alert-only, use default thresholds
    agentConfig = {
      agentEnabled:  false,
      alertOnly:     true,
      canRepay:      false,
      canDeleverage: false,
      warningHF:     BigInt(Math.round(config.thresholds.warning * 1e18)),
      actionHF:      BigInt(Math.round(config.thresholds.action  * 1e18)),
      maxRepayBP:    2000,
      maxDelgBP:     3000,
    };
  }

  const {
    agentEnabled,
    alertOnly,
    canRepay,
    canDeleverage,
    warningHF: warningHFRaw,
    actionHF:  actionHFRaw,
    maxRepayBP,
    maxDelgBP,
  } = agentConfig;

  const warningHF = Number(warningHFRaw) / 1e18;
  const actionHF  = Number(actionHFRaw)  / 1e18;

  // ── 2. Agent disabled — do nothing ───────────────────────────────────────
  if (!agentEnabled) {
    return makeDecision(user, "NONE", false, null, null, "Agent disabled by user", "LOW", agentConfig);
  }

  // ── 3. SAFE band — no action needed ──────────────────────────────────────
  if (healthFactor > warningHF) {
    return makeDecision(user, "NONE", false, null, null, "Position is healthy", "LOW", agentConfig);
  }

  // ── 4. WARNING band ───────────────────────────────────────────────────────
  if (healthFactor >= actionHF) {
    const reasoning = buildWarningReasoning(riskReport, warningHF, actionHF);
    return makeDecision(user, "ALERT", false, null, null, reasoning, "MEDIUM", agentConfig);
  }

  // ── 5. ACTION / CRITICAL band — decide what to do ─────────────────────────
  const urgency  = healthFactor < 1.0 ? "CRITICAL" : "HIGH";

  // Alert-only mode — never execute, just send urgent alert
  if (alertOnly) {
    const reasoning = buildActionReasoning(riskReport, actionHF, "alert-only mode");
    return makeDecision(user, "ALERT", false, null, null, reasoning, urgency, agentConfig);
  }

  // ── 6. Choose protection action ──────────────────────────────────────────

  // Prefer PARTIAL_REPAY if user has consent + there's debt to repay
  if (canRepay && debtBreakdown.length > 0) {
    const { token, amount, amountHuman } = selectRepayAction(
      debtBreakdown, riskReport, maxRepayBP, provider
    );
    const reasoning = buildActionReasoning(riskReport, actionHF, "partial repay");
    return makeDecision(user, "PARTIAL_REPAY", true, token, amount, reasoning, urgency, agentConfig, amountHuman);
  }

  // Fall back to DELEVERAGE if user consented
  if (canDeleverage && collateralBreakdown.length > 0) {
    const { token, amount, amountHuman } = selectDeleverageAction(
      collateralBreakdown, riskReport, maxDelgBP
    );
    const reasoning = buildActionReasoning(riskReport, actionHF, "emergency deleverage");
    return makeDecision(user, "DELEVERAGE", true, token, amount, reasoning, urgency, agentConfig, amountHuman);
  }

  // No executable action available — fall back to urgent alert
  const reasoning = buildActionReasoning(
    riskReport, actionHF,
    "no action available (check consent settings)"
  );
  return makeDecision(user, "ALERT", false, null, null, reasoning, urgency, agentConfig);
}

// ─────────────────────────────────────────────────────────────────────────────
// Action selection helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the best token to repay and the amount.
 * Strategy: repay the largest debt position, up to maxRepayBP of that debt.
 * Target: bring HF up to the warning threshold + a 10% buffer.
 */
function selectRepayAction(debtBreakdown, riskReport, maxRepayBP) {
  // Sort by USD value descending — repay the biggest debt first
  const sorted = [...debtBreakdown].sort((a, b) => b.amountUSD - a.amountUSD);
  const target  = sorted[0];

  // Calculate repay amount to reach warningHF + 10% buffer
  const { healthFactor, totalDebtUSD, totalCollateralUSD } = riskReport;
  const targetHF     = config.thresholds.warning * 1.1; // e.g. 1.76
  // Required debt after repay: adjCollateral / targetHF
  // Amount to repay: current debt - required debt
  const adjCollateral    = totalCollateralUSD; // already adjusted in vault
  const requiredDebtUSD  = adjCollateral / targetHF;
  const repayUSD         = Math.max(0, totalDebtUSD - requiredDebtUSD);

  // Cap at user's maxRepayBP
  const maxRepayUSD = (target.amountUSD * maxRepayBP) / 10000;
  const actualUSD   = Math.min(repayUSD, maxRepayUSD);

  // Convert USD to token units (rough — executor will re-calculate precisely)
  const tokenPrice  = target.amountUSD / target.amount;
  const tokenAmount = actualUSD / tokenPrice;

  // Return as BigInt with token decimals — executor refines this
  const DECIMALS    = getKnownDecimals(target.token);
  const amountBig   = BigInt(Math.floor(tokenAmount * Math.pow(10, DECIMALS)));

  return {
    token:       target.token,
    amount:      amountBig,
    amountHuman: tokenAmount.toFixed(4),
  };
}

/**
 * Select the best collateral token to deleverage.
 * Strategy: use the dominant (largest USD) collateral position.
 */
function selectDeleverageAction(collateralBreakdown, riskReport, maxDelgBP) {
  const sorted  = [...collateralBreakdown].sort((a, b) => b.amountUSD - a.amountUSD);
  const target  = sorted[0];

  // Release maxDelgBP of this collateral
  const releasePct    = maxDelgBP / 10000;
  const releaseAmount = target.amount * releasePct;
  const DECIMALS      = getKnownDecimals(target.token);
  const amountBig     = BigInt(Math.floor(releaseAmount * Math.pow(10, DECIMALS)));

  return {
    token:       target.token,
    amount:      amountBig,
    amountHuman: releaseAmount.toFixed(6),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning builders (used by explainer.js as structured context)
// ─────────────────────────────────────────────────────────────────────────────

function buildWarningReasoning(report, warningHF, actionHF) {
  const { healthFactor, dominantCollateralToken, volatilityBP,
          collateralBreakdown, scenarios } = report;

  const dominant = collateralBreakdown.find(
    (c) => c.token === dominantCollateralToken
  );
  const domSymbol = dominant?.symbol || "collateral";
  const domPct    = dominant?.pct    || 0;

  const projected20 = scenarios["-20%"] ?? "?";

  return (
    `HF is ${healthFactor.toFixed(3)}, below warning level of ${warningHF.toFixed(2)}. ` +
    `${domPct}% of collateral is ${domSymbol}. ` +
    `Current 24h volatility: ${(volatilityBP / 100).toFixed(1)}%. ` +
    `A -20% price drop would bring HF to ${projected20}. ` +
    `Action threshold: ${actionHF.toFixed(2)}.`
  );
}

function buildActionReasoning(report, actionHF, actionType) {
  const { healthFactor, totalCollateralUSD, totalDebtUSD,
          volatilityBP, timeToLiquidation, collateralBreakdown } = report;

  const dominant = collateralBreakdown[0];
  const domStr   = dominant
    ? `${dominant.pct}% of collateral is ${dominant.symbol} worth $${dominant.amountUSD.toFixed(0)}.`
    : "";

  return (
    `HF dropped to ${healthFactor.toFixed(3)}, below action threshold of ${actionHF.toFixed(2)}. ` +
    `Total collateral: $${totalCollateralUSD.toFixed(0)}, ` +
    `total debt: $${totalDebtUSD.toFixed(0)}. ` +
    `${domStr} ` +
    `Volatility: ${(volatilityBP / 100).toFixed(1)}%. ` +
    `Estimated time to liquidation: ${timeToLiquidation}. ` +
    `Selected action: ${actionType}.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDecision(user, action, shouldExecute, token, amount, reasoning, urgency, agentConfig, amountHuman = null) {
  const decision = {
    user,
    action,
    shouldExecute,
    token,
    amount,
    amountHuman,
    reasoning,
    urgency,
    agentConfig,
    decidedAt: Date.now(),
  };
  log(`[${user}] Decision: ${action} urgency=${urgency} execute=${shouldExecute}`);
  return decision;
}

// Known decimals for common Arbitrum tokens
// (avoids async calls in the hot path — executor validates precisely on-chain)
function getKnownDecimals(tokenAddress) {
  const KNOWN = {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831":  6, // USDC
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f":  8, // WBTC
    "0x912ce59144191c1204e64559fe8253a0e49e6548": 18, // ARB
  };
  return KNOWN[tokenAddress.toLowerCase()] ?? 18;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { evaluate };
