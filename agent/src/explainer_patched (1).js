/**
 * explainer.js — Natural Language Explainer
 * ───────────────────────────────────────────
 * PATCH vs original:
 *   - Model string corrected: "claude-sonnet-4-5" (was "claude-sonnet-4-20250514")
 *   - No other changes
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { log, error: logError } = require("./logger");

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      logError("ANTHROPIC_API_KEY not set — explainer will use template fallback");
      return null;
    }
    _client = new Anthropic.Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _client;
}

const _cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(riskReport, decision) {
  return `${riskReport.user}:${Math.round(riskReport.healthFactor * 100)}:${decision.action}`;
}

async function generate(riskReport, decision) {
  const cacheKey = getCacheKey(riskReport, decision);
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.explanation;

  const client = getClient();
  let explanation;

  if (client) {
    try {
      explanation = await generateWithClaude(client, riskReport, decision);
    } catch (err) {
      logError(`Claude API error: ${err.message} — using template`);
      explanation = generateTemplate(riskReport, decision);
    }
  } else {
    explanation = generateTemplate(riskReport, decision);
  }

  _cache.set(cacheKey, { explanation, ts: Date.now() });
  return explanation;
}

async function generateWithClaude(client, riskReport, decision) {
  const {
    user, healthFactor, band, totalCollateralUSD, totalDebtUSD,
    collateralBreakdown, debtBreakdown, scenarios, volatilityBP,
    timeToLiquidation, riskScore,
  } = riskReport;

  const context = {
    healthFactor:        healthFactor.toFixed(3),
    band,
    urgency:             decision.urgency,
    totalCollateralUSD:  `$${totalCollateralUSD.toFixed(0)}`,
    totalDebtUSD:        `$${totalDebtUSD.toFixed(0)}`,
    collateral:          collateralBreakdown.map(
      (c) => `${c.symbol}: $${c.amountUSD.toFixed(0)} (${c.pct}%)`
    ).join(", "),
    debt:                debtBreakdown.map(
      (d) => `${d.symbol}: $${d.amountUSD.toFixed(0)} (${d.pct}%)`
    ).join(", "),
    priceScenarios:      Object.entries(scenarios)
      .map(([k, v]) => `${k}: HF ${v}`)
      .join(", "),
    volatility:          `${(volatilityBP / 100).toFixed(1)}% 24h stddev`,
    timeToLiquidation,
    riskScore:           `${riskScore}/100`,
    actionTaken:         decision.action,
    amountActed:         decision.amountHuman ? `${decision.amountHuman} tokens` : "N/A",
  };

  const systemPrompt = `You are the AI agent inside a DeFi risk management tool called "Autonomous DeFi Risk Manager".
Your job is to explain what you observed about a user's Aave lending position and what action you took (or are recommending), in plain English.

Rules:
- Write exactly 2-3 sentences.
- Be direct and informative. Lead with the key risk fact.
- Do NOT use markdown, asterisks, bullet points, or headers.
- Do NOT say "I" — write in third person ("The agent detected...", "Your position...").
- Do NOT use technical jargon like "liquidationThreshold" or "basis points". Use plain language.
- Keep dollar amounts and percentages. They help users understand impact.
- End with what action was taken or recommended.`;

  const userPrompt = `Explain this DeFi risk event in 2-3 plain sentences:\n\n${JSON.stringify(context, null, 2)}\n\nWrite the explanation now:`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-5",     // ← PATCH: corrected model string
    max_tokens: 200,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b)  => b.text)
    .join("")
    .trim();

  log(`[explainer] ${text.split(" ").length} word explanation for ${user}`);
  return text;
}

function generateTemplate(riskReport, decision) {
  const {
    healthFactor, band, totalCollateralUSD, totalDebtUSD,
    collateralBreakdown, volatilityBP, timeToLiquidation,
  } = riskReport;

  const { action, amountHuman } = decision;
  const dominant = collateralBreakdown[0];
  const domStr   = dominant
    ? `${dominant.pct}% of collateral is ${dominant.symbol}`
    : "the position";
  const volStr   = volatilityBP > 0
    ? `with ${(volatilityBP / 100).toFixed(1)}% realised 24h volatility`
    : "";

  switch (action) {
    case "PARTIAL_REPAY":
      return (
        `Your Aave position's health factor dropped to ${healthFactor.toFixed(2)}, below the action threshold. ` +
        `${domStr} ($${totalCollateralUSD.toFixed(0)} total collateral against $${totalDebtUSD.toFixed(0)} debt) ${volStr}. ` +
        `The agent automatically repaid ${amountHuman} tokens to raise your health factor and protect you from liquidation.`
      );
    case "DELEVERAGE":
      return (
        `Your health factor reached ${healthFactor.toFixed(2)}, indicating high liquidation risk on Aave. ` +
        `${domStr} ${volStr}, with estimated time to liquidation: ${timeToLiquidation}. ` +
        `The agent deleveraged your position by selling ${amountHuman} of your collateral to repay debt.`
      );
    case "ALERT":
      if (band === "WARNING") {
        return (
          `Your Aave health factor is ${healthFactor.toFixed(2)}, entering the warning zone. ` +
          `${domStr} ${volStr}. ` +
          `No action has been taken yet — the agent will act automatically if conditions worsen.`
        );
      }
      return (
        `Your Aave health factor dropped to ${healthFactor.toFixed(2)} — immediate attention required. ` +
        `Estimated time to liquidation: ${timeToLiquidation}. ` +
        `The agent is in alert-only mode. Please repay debt or add collateral now to avoid liquidation.`
      );
    default:
      return `Position health factor is ${healthFactor.toFixed(2)}. No action required at this time.`;
  }
}

module.exports = { generate };
