/**
 * alerter.js — Telegram Alert System
 * Sends nice messages to users via Telegram.
 */

"use strict";

const https = require("https");
const { log, error: logError } = require("./logger"); // Fixed path
const db = require("./db"); // Fixed path

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Setup
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to Telegram
 */
async function sendTelegramMessage(chatId, text, parseMode = "HTML") {
  if (!BOT_TOKEN) {
    log(`[alerter] No BOT_TOKEN — would send: ${text.slice(0, 80)}...`);
    return { ok: true, simulated: true };
  }

  const body = JSON.stringify({
    chat_id: chatId,
    text: text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${API_BASE}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Get user's Telegram chat ID from database
// ─────────────────────────────────────────────────────────────────────────────

async function getChatId(userAddress) {
  try {
    return await db.getTelegramChatId(userAddress);
  } catch (err) {
    logError(`[alerter] Failed to get chatId for ${userAddress}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions for Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatBandEmoji(band) {
  const map = { SAFE: "🟢", WARNING: "🟡", ACTION: "🟠", CRITICAL: "🔴" };
  return map[band] || "⚪";
}

function formatUrgencyEmoji(urgency) {
  const map = { LOW: "ℹ️", MEDIUM: "⚠️", HIGH: "🚨", CRITICAL: "🆘" };
  return map[urgency] || "⚠️";
}

function shortenAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatHF(hf) {
  return typeof hf === "number" ? hf.toFixed(3) : hf;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Builders
// ─────────────────────────────────────────────────────────────────────────────

function buildWarningMessage(user, riskReport, explanation) {
  const {
    healthFactor,
    band,
    totalCollateralUSD,
    totalDebtUSD,
    collateralBreakdown,
    scenarios,
    volatilityBP,
    timeToLiquidation,
  } = riskReport;

  const emoji = formatBandEmoji(band);
  const dominant = collateralBreakdown[0];
  const domLine = dominant
    ? `\n<b>Top collateral:</b> ${dominant.symbol} $${dominant.amountUSD.toFixed(0)} (${dominant.pct}%)`
    : "";

  return `${emoji} <b>Position Warning</b> — ${shortenAddr(user)}

<b>Health Factor:</b> ${formatHF(healthFactor)} (WARNING zone)
<b>Collateral:</b> $${totalCollateralUSD.toFixed(0)}
<b>Debt:</b> $${totalDebtUSD.toFixed(0)}${domLine}

<b>Scenario analysis:</b>
  -10% drop → HF ${scenarios["-10%"] || "?"}
  -20% drop → HF ${scenarios["-20%"] || "?"}

<b>Volatility:</b> ${(volatilityBP / 100).toFixed(1)}%
<b>Time to liquidation:</b> ${timeToLiquidation}

<i>${explanation}</i>

→ Open dashboard to add collateral or repay.`;
}

function buildActionAlertMessage(user, riskReport, decision, explanation) {
  const {
    healthFactor,
    band,
    totalCollateralUSD,
    totalDebtUSD,
    timeToLiquidation,
  } = riskReport;
  const { action, urgency, amountHuman, shouldExecute } = decision;
  const emoji = formatUrgencyEmoji(urgency);

  const actionLine = shouldExecute
    ? `\n${emoji} <b>Agent is executing:</b> ${action} (${amountHuman || "N/A"} tokens)`
    : `\n⚠️ <b>Action required:</b> ${action} needed (alert-only mode)`;

  return `🔴 <b>RISK ALERT</b> — ${shortenAddr(user)}

<b>Health Factor:</b> ${formatHF(healthFactor)} (${band})
<b>Collateral:</b> $${totalCollateralUSD.toFixed(0)}
<b>Debt:</b> $${totalDebtUSD.toFixed(0)}
<b>Est. liquidation:</b> ${timeToLiquidation}
${actionLine}

<i>${explanation}</i>`;
}

function buildConfirmationMessage(user, decision, txResult, explanation) {
  const { action, amountHuman } = decision;
  const { hash, hfAfter, gasUsed } = txResult;
  const arbscanUrl = `https://arbiscan.io/tx/${hash}`;

  return `✅ <b>Protection Executed</b> — ${shortenAddr(user)}

<b>Action:</b> ${action}
<b>Amount:</b> ${amountHuman || "N/A"}
<b>New HF:</b> ${formatHF(hfAfter)}
<b>Gas used:</b> ${Number(gasUsed).toLocaleString()}

<i>${explanation}</i>

<a href="${arbscanUrl}">View on Arbiscan →</a>`;
}

function buildFailureMessage(user, decision, errorMsg) {
  return `❌ <b>Protection Failed</b> — ${shortenAddr(user)}

<b>Action:</b> ${decision.action}
<b>Error:</b> ${errorMsg}

Please check your position immediately.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Functions
// ─────────────────────────────────────────────────────────────────────────────

async function send(user, riskReport, decision, explanation) {
  const chatId = await getChatId(user);
  if (!chatId) {
    log(`[alerter:${user}] No Telegram chat_id registered — skipping`);
    return;
  }

  let text;
  if (decision.action === "ALERT" && riskReport.band === "WARNING") {
    text = buildWarningMessage(user, riskReport, explanation);
  } else {
    text = buildActionAlertMessage(user, riskReport, decision, explanation);
  }

  try {
    const result = await sendTelegramMessage(chatId, text);
    if (result.ok) log(`[alerter:${user}] Alert sent successfully`);
    else logError(`[alerter:${user}] Telegram API error`);
  } catch (err) {
    logError(`[alerter:${user}] Failed to send message: ${err.message}`);
  }
}

async function sendActionConfirmation(user, decision, txResult, explanation) {
  const chatId = await getChatId(user);
  if (!chatId) return;

  const text = buildConfirmationMessage(user, decision, txResult, explanation);
  await sendTelegramMessage(chatId, text).catch((err) =>
    logError(`[alerter] Confirmation failed: ${err.message}`),
  );
}

async function sendActionFailed(user, decision, errorMsg) {
  const chatId = await getChatId(user);
  if (!chatId) return;

  const text = buildFailureMessage(user, decision, errorMsg);
  await sendTelegramMessage(chatId, text).catch((err) =>
    logError(`[alerter] Failure message failed: ${err.message}`),
  );
}

// Webhook handler for /start command
async function processWebhookUpdate(update) {
  const message = update?.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const address = parts[1]?.toLowerCase();

    if (address && address.startsWith("0x") && address.length === 42) {
      await db.setTelegramChatId(address, chatId.toString());
      await sendTelegramMessage(
        chatId,
        `✅ <b>Wallet connected!</b>\n\nYou'll receive alerts for:\n<code>${address}</code>`,
      );
      log(`[alerter] Registered ${address} → chat_id ${chatId}`);
    } else {
      await sendTelegramMessage(
        chatId,
        "⚠️ Use: <code>/start 0xYourWalletAddress</code>",
      );
    }
  }
}

module.exports = {
  send,
  sendActionConfirmation,
  sendActionFailed,
  processWebhookUpdate,
};
