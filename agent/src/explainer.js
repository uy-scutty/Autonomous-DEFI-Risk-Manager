/**
 * explainer.js — Natural Language Explainer (Free Groq Version)
 */

"use strict";

const { log, error: logError } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// Groq Client (Free & Fast)
// ─────────────────────────────────────────────────────────────────────────────

let _groq = null;

function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) {
      logError("GROQ_API_KEY not set — using template fallback only");
      return null;
    }
    _groq = new (require("groq-sdk").Groq)({
      apiKey: process.env.GROQ_API_KEY,
    });
  }
  return _groq;
}

const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function generate(riskReport, decision) {
  const cacheKey = `${riskReport.user}:${Math.round(riskReport.healthFactor * 100)}:${decision.action}`;
  const cached = _cache.get(cacheKey);

  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.explanation;
  }

  let explanation = null;
  const groq = getGroq();

  if (groq) {
    try {
      explanation = await generateWithGroq(groq, riskReport, decision);
    } catch (err) {
      logError(`Groq error: ${err.message} — using template`);
    }
  }

  if (!explanation) {
    explanation = generateTemplate(riskReport, decision);
  }

  _cache.set(cacheKey, { explanation, ts: Date.now() });
  return explanation;
}

async function generateWithGroq(groq, riskReport, decision) {
  const context = {
    healthFactor: riskReport.healthFactor.toFixed(3),
    band: riskReport.band,
    collateral: riskReport.collateralBreakdown
      .map((c) => `${c.symbol} $${c.amountUSD.toFixed(0)} (${c.pct}%)`)
      .join(", "),
    debt: riskReport.debtBreakdown
      .map((d) => `${d.symbol} $${d.amountUSD.toFixed(0)} (${d.pct}%)`)
      .join(", "),
    action: decision.action,
    amount: decision.amountHuman || "some",
  };

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-70b-versatile", // Very good free model
    messages: [
      {
        role: "system",
        content:
          "You are a helpful DeFi risk management agent. Explain in 2-3 short, clear sentences. No markdown. Use simple language.",
      },
      {
        role: "user",
        content: `Explain what happened with this Aave position:\n${JSON.stringify(context, null, 2)}`,
      },
    ],
    max_tokens: 180,
    temperature: 0.7,
  });

  const text = completion.choices[0].message.content.trim();
  log(`[explainer] Groq generated explanation for ${riskReport.user}`);
  return text;
}

function generateTemplate(riskReport, decision) {
  // ... (same template as before - keep your current one)
  const { healthFactor, band, totalCollateralUSD, totalDebtUSD } = riskReport;
  const { action, amountHuman } = decision;

  switch (action) {
    case "PARTIAL_REPAY":
      return `Your Aave position's health factor dropped. The agent automatically repaid ${amountHuman} tokens to protect you from liquidation.`;
    case "DELEVERAGE":
      return `Your health factor is low. The agent deleveraged your position to reduce risk.`;
    case "ALERT":
      return `Your Aave health factor is ${healthFactor.toFixed(2)} (${band}). The agent is monitoring closely.`;
    default:
      return `Your Aave position is currently at HF ${healthFactor.toFixed(2)}.`;
  }
}

module.exports = { generate };
