/**
 * decisionEngine.js — Decision Engine (Aave Guardian Edition)
 * Reads user's on-chain config from AgentRegistry and makes intelligent decisions.
 */

"use strict";

const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

// ─────────────────────────────────────────────────────────────────────────────
// Contract instance
// ─────────────────────────────────────────────────────────────────────────────

let _registry = null;

function getRegistry(provider) {
  if (!_registry) {
    _registry = new ethers.Contract(
      process.env.AGENT_REGISTRY_ADDRESS,
      ABIS.AgentRegistry,
      provider,
    );
  }
  return _registry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

async function evaluate(riskReport, provider) {
  const {
    user,
    healthFactor,
    band,
    totalDebtUSD,
    collateralBreakdown,
    debtBreakdown,
    dominantCollateralToken,
    scenarios,
  } = riskReport;

  let agentConfig;
  try {
    agentConfig = await getRegistry(provider).getAgentDecisionParams(user);
  } catch (err) {
    logError(`[${user}] Failed to fetch AgentRegistry config: ${err.message}`);
    // Safe fallback
    agentConfig = {
      agentEnabled: true,
      alertOnly: false,
      canRepay: true,
      canDeleverage: true,
      warningHF: BigInt(1500000000000000000), // 1.5
      actionHF: BigInt(1250000000000000000), // 1.25
      maxRepayBP: 5000, // 50%
      maxDelgBP: 3000, // 30%
    };
  }

  const {
    agentEnabled,
    alertOnly,
    canRepay,
    canDeleverage,
    warningHF: warningHFRaw,
    actionHF: actionHFRaw,
    maxRepayBP,
    maxDelgBP,
  } = agentConfig;

  const warningHF = Number(warningHFRaw) / 1e18;
  const actionHF = Number(actionHFRaw) / 1e18;

  // Default decision object
  const decision = {
    user,
    action: "NONE",
    shouldExecute: false,
    token: null,
    amount: null,
    amountHuman: null,
    reasoning: "",
    urgency: "LOW",
    agentConfig,
    decidedAt: Date.now(),
  };

  // 1. Agent disabled by user
  if (!agentEnabled) {
    decision.reasoning = "Agent disabled by user in registry";
    return decision;
  }

  // 2. SAFE zone
  if (healthFactor > warningHF) {
    decision.reasoning = `Position healthy (HF ${healthFactor.toFixed(3)} > ${warningHF.toFixed(2)})`;
    return decision;
  }

  // 3. WARNING zone
  if (healthFactor >= actionHF) {
    decision.action = "ALERT";
    decision.urgency = "MEDIUM";
    decision.reasoning = `HF in WARNING zone (${healthFactor.toFixed(3)})`;
    return decision;
  }

  // 4. ACTION / CRITICAL zone
  const urgency = healthFactor < 1.05 ? "CRITICAL" : "HIGH";
  const projectedHF10 = scenarios["-10%"] || 1.0;

  decision.urgency = urgency;

  if (alertOnly) {
    decision.action = "ALERT";
    decision.reasoning = `High risk (HF ${healthFactor.toFixed(3)}) — Alert only mode enabled`;
    return decision;
  }

  // Prefer Partial Repay if possible
  if (canRepay && debtBreakdown.length > 0) {
    const repayInfo = selectRepayAmount(
      debtBreakdown[0],
      riskReport,
      maxRepayBP,
      warningHF,
    );
    decision.action = "PARTIAL_REPAY";
    decision.token = repayInfo.token;
    decision.amount = repayInfo.amount;
    decision.amountHuman = repayInfo.amountHuman;
    decision.shouldExecute = true;
    decision.reasoning = `HF ${healthFactor.toFixed(3)} below action threshold. Repaying part of debt.`;
    return decision;
  }

  // Fallback to Deleverage
  if (canDeleverage && collateralBreakdown.length > 0) {
    const delInfo = selectDeleverageAmount(collateralBreakdown[0], maxDelgBP);
    decision.action = "DELEVERAGE";
    decision.token = delInfo.token;
    decision.amount = delInfo.amount;
    decision.amountHuman = delInfo.amountHuman;
    decision.shouldExecute = true;
    decision.reasoning = `High risk position. Deleveraging ${delInfo.amountHuman} of collateral.`;
    return decision;
  }

  // Last resort
  decision.action = "ALERT";
  decision.reasoning = "High risk but no authorized action available";
  return decision;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function selectRepayAmount(debtPosition, riskReport, maxRepayBP, targetHF) {
  const maxRepayUSD = (debtPosition.amountUSD * maxRepayBP) / 10000;
  const actualUSD = Math.min(maxRepayUSD, debtPosition.amountUSD * 0.5); // max 50% for safety

  const tokenPrice = debtPosition.amountUSD / debtPosition.amount;
  const tokenAmount = actualUSD / tokenPrice;

  return {
    token: debtPosition.token,
    amount: BigInt(Math.floor(tokenAmount * Math.pow(10, 6))), // assuming 6 decimals for USDC
    amountHuman: tokenAmount.toFixed(4),
  };
}

function selectDeleverageAmount(collateralPosition, maxDelgBP) {
  const releasePct = maxDelgBP / 10000;
  const releaseAmount = collateralPosition.amount * releasePct;

  return {
    token: collateralPosition.token,
    amount: BigInt(Math.floor(releaseAmount * Math.pow(10, 6))),
    amountHuman: releaseAmount.toFixed(4),
  };
}

module.exports = {
  evaluate,
};
