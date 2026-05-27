/**
 * explainer.js — Natural Language Explainer
 * ───────────────────────────────────────────
 * Calls the Anthropic Claude API to generate a plain-English explanation
 * of what the agent observed and why it acted.
 *
 * The explanation is:
 *   • Shown in the frontend Agent Activity feed
 *   • Included in Telegram alerts
 *   • Stored in the DB for audit history
 *
 * Prompt strategy:
 *   We pass structured JSON context (risk report + decision) and ask Claude
 *   to write a concise, friendly, 2–3 sentence explanation. No jargon.
 *   Output is plain text (no markdown in the alert context).
 *
 * Fallback:
 *   If the API is unavailable or over quota, a deterministic template
 *   explanation is generated locally — the app never crashes.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { log, error: logError } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic client
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      logError(
        "ANTHROPIC_API_KEY not set — explainer will use template fallback",
      );
      return null;
    }
    _client = new Anthropic.Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache: avoid re-generating explanations for identical states
// ─────────────────────────────────────────────────────────────────────────────

const _cache = new Map(); // key → { explanation, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(riskReport, decision) {
  return `${riskReport.user}:${Math.round(riskReport.healthFactor * 100)}:${decision.action}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main generate function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generate(riskReport, decision) → string
 *
 * Returns a 2–3 sentence plain-English explanation of the agent's action.
 */
async function generate(riskReport, decision) {
  const cacheKey = getCacheKey(riskReport, decision);
  const cached = _cache.get(cacheKey);

  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.explanation;
  }

  const client = getClient();

  let explanation;
  if (client) {
    try {
      explanation = await generateWithClaude(client, riskReport, decision);
    } catch (err) {
      logError(`Claude API error: ${err.message} — using template fallback`);
      explanation = generateTemplate(riskReport, decision);
    }
  } else {
    explanation = generateTemplate(riskReport, decision);
  }

  _cache.set(cacheKey, { explanation, ts: Date.now() });
  return explanation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude API call
// ─────────────────────────────────────────────────────────────────────────────

async function generateWithClaude(client, riskReport, decision) {
  const {
    user,
    healthFactor,
    band,
    totalCollateralUSD,
    totalDebtUSD,
    collateralBreakdown,
    debtBreakdown,
    scenarios,
    volatilityBP,
    timeToLiquidation,
    riskScore,
  } = riskReport;

  const { action, urgency, amountHuman, agentConfig } = decision;

  // Build a concise context payload for the prompt
  const context = {
    healthFactor: healthFactor.toFixed(3),
    band,
    urgency,
    totalCollateralUSD: `$${totalCollateralUSD.toFixed(0)}`,
    totalDebtUSD: `$${totalDebtUSD.toFixed(0)}`,
    collateral: collateralBreakdown
      .map((c) => `${c.symbol}: $${c.amountUSD.toFixed(0)} (${c.pct}%)`)
      .join(", "),
    debt: debtBreakdown
      .map((d) => `${d.symbol}: $${d.amountUSD.toFixed(0)} (${d.pct}%)`)
      .join(", "),
    priceScenarios: Object.entries(scenarios)
      .map(([k, v]) => `${k}: HF ${v}`)
      .join(", "),
    volatility: `${(volatilityBP / 100).toFixed(1)}% 24h stddev`,
    timeToLiquidation,
    riskScore: `${riskScore}/100`,
    actionTaken: action,
    amountActed: amountHuman ? `${amountHuman} tokens` : "N/A",
  };

  const systemPrompt = `You are the AI agent inside a DeFi risk management tool called "Autonomous DeFi Risk Manager". 
Your job is to explain what you observed about a user's lending position and what action you took (or are recommending), in plain English.

Rules:
- Write exactly 2-3 sentences.
- Be direct and informative. Lead with the key risk fact.
- Do NOT use markdown, asterisks, bullet points, or headers.
- Do NOT say "I" — write in third person ("The agent detected...", "Your position...").
- Do NOT use technical jargon like "liquidationThreshold" or "basis points". Use plain language.
- Keep dollar amounts and percentages. They help users understand impact.
- End with what action was taken or recommended.`;

  const userPrompt = `Explain this DeFi risk event in 2-3 plain sentences:

Position data:
${JSON.stringify(context, null, 2)}

Write the explanation now:`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  log(
    `[explainer] Generated ${text.split(" ").length} word explanation for ${user}`,
  );
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template fallback (no API needed)
// ─────────────────────────────────────────────────────────────────────────────

function generateTemplate(riskReport, decision) {
  const {
    healthFactor,
    band,
    totalCollateralUSD,
    totalDebtUSD,
    collateralBreakdown,
    volatilityBP,
    timeToLiquidation,
  } = riskReport;

  const { action, urgency, amountHuman } = decision;

  const dominant = collateralBreakdown[0];
  const domStr = dominant
    ? `${dominant.pct}% of collateral is ${dominant.symbol}`
    : "the position";
  const volStr =
    volatilityBP > 0
      ? `with ${(volatilityBP / 100).toFixed(1)}% realised 24h volatility`
      : "";

  switch (action) {
    case "PARTIAL_REPAY":
      return (
        `Your position's health factor dropped to ${healthFactor.toFixed(2)}, below the action threshold. ` +
        `${domStr} ($${totalCollateralUSD.toFixed(0)} total collateral against $${totalDebtUSD.toFixed(0)} debt) ${volStr}. ` +
        `The agent automatically repaid ${amountHuman} tokens to raise your health factor and protect you from liquidation.`
      );

    case "DELEVERAGE":
      return (
        `Your health factor reached ${healthFactor.toFixed(2)}, indicating high liquidation risk. ` +
        `${domStr} ${volStr}, with estimated time to liquidation: ${timeToLiquidation}. ` +
        `The agent deleveraged your position by selling ${amountHuman} of your collateral to repay debt.`
      );

    case "ALERT":
      if (band === "WARNING") {
        return (
          `Your health factor is ${healthFactor.toFixed(2)}, entering the warning zone. ` +
          `${domStr} ${volStr}. ` +
          `No action has been taken yet, but the agent is monitoring closely and will act if conditions worsen.`
        );
      }
      return (
        `Your health factor dropped to ${healthFactor.toFixed(2)} — immediate attention required. ` +
        `Estimated time to liquidation: ${timeToLiquidation}. ` +
        `The agent is in alert-only mode. Please repay debt or add collateral now.`
      );

    default:
      return `Position health factor is ${healthFactor.toFixed(2)}. No action required at this time.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { generate };
