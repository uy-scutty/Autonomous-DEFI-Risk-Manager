/**
 * alerter.js — Telegram Alert System
 * ─────────────────────────────────────
 * Sends formatted Telegram messages to users when the agent detects risk
 * or executes a protection action.
 *
 * Message types:
 *   • Warning alert     — HF in WARNING band
 *   • Action alert      — HF in ACTION/CRITICAL band, about to execute
 *   • Confirmation      — action executed successfully
 *   • Failure           — action attempted but failed
 *
 * Setup:
 *   1. Create a bot via @BotFather on Telegram → get TELEGRAM_BOT_TOKEN
 *   2. Each user must /start the bot to get their chat_id
 *   3. Store user → chat_id mapping in the DB (users self-register)
 *
 * User registration flow:
 *   Frontend settings page has a "Connect Telegram" button that shows the
 *   user their unique /start code. When they send it to the bot, alerter
 *   maps their wallet address → telegram chat_id.
 */

"use strict";

const https = require("https");
const { log, error: logError } = require("./logger");
const db = require("./db");

// ─────────────────────────────────────────────────────────────────────────────
// Telegram API client (no library dependency — plain HTTPS)
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * sendTelegramMessage(chatId, text, parseMode)
 * parseMode: "HTML" | "MarkdownV2" | undefined
 */
async function sendTelegramMessage(chatId, text, parseMode = "HTML") {
  if (!BOT_TOKEN) {
    log(
      `[alerter] No Telegram token — would send to ${chatId}: ${text.slice(0, 60)}...`,
    );
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
// Look up a user's Telegram chat_id
// ─────────────────────────────────────────────────────────────────────────────

async function getChatId(userAddress) {
  try {
    return await db.getTelegramChatId(userAddress);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message formatters
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
// Warning alert (HF in WARNING band)
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
  const s10 = scenarios["-10%"];
  const s20 = scenarios["-20%"];

  return `${emoji} <b>Position Warning</b> — ${shortenAddr(user)}

<b>Health Factor:</b> ${formatHF(healthFactor)} (WARNING zone)
<b>Collateral:</b> $${totalCollateralUSD.toFixed(0)}
<b>Debt:</b> $${totalDebtUSD.toFixed(0)}${domLine}

<b>Scenario analysis:</b>
  -10% price drop → HF ${s10}
  -20% price drop → HF ${s20}

<b>24h Volatility:</b> ${(volatilityBP / 100).toFixed(1)}%
<b>Est. time to liquidation:</b> ${timeToLiquidation}

<i>${explanation}</i>

→ Open dashboard to add collateral or repay debt.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action alert (HF in ACTION/CRITICAL band, agent about to act)
// ─────────────────────────────────────────────────────────────────────────────

function buildActionAlertMessage(user, riskReport, decision, explanation) {
  const {
    healthFactor,
    band,
    totalCollateralUSD,
    totalDebtUSD,
    timeToLiquidation,
  } = riskReport;
  const { action, urgency, amountHuman } = decision;
  const emoji = formatUrgencyEmoji(urgency);

  const actionLine = decision.shouldExecute
    ? `\n${emoji} <b>Agent is executing:</b> ${action} (${amountHuman || ""} tokens)`
    : `\n⚠️ <b>Action required:</b> ${action} needed but agent is in alert-only mode.`;

  return `🔴 <b>RISK ALERT</b> — ${shortenAddr(user)}

<b>Health Factor:</b> ${formatHF(healthFactor)} (${band})
<b>Collateral:</b> $${totalCollateralUSD.toFixed(0)}
<b>Debt:</b> $${totalDebtUSD.toFixed(0)}
<b>Est. liquidation:</b> ${timeToLiquidation}
${actionLine}

<i>${explanation}</i>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation (action succeeded)
// ─────────────────────────────────────────────────────────────────────────────

function buildConfirmationMessage(user, decision, txResult, explanation) {
  const { action, amountHuman } = decision;
  const { hash, hfAfter, gasUsed } = txResult;
  const arbscanUrl = `https://arbiscan.io/tx/${hash}`;

  return `✅ <b>Protection Executed</b> — ${shortenAddr(user)}

<b>Action:</b> ${action}
<b>Amount:</b> ${amountHuman || "N/A"}
<b>New Health Factor:</b> ${formatHF(hfAfter)}
<b>Gas used:</b> ${Number(gasUsed).toLocaleString()}

<i>${explanation}</i>

<a href="${arbscanUrl}">View on Arbiscan →</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure message
// ─────────────────────────────────────────────────────────────────────────────

function buildFailureMessage(user, decision, errorMsg) {
  const { action } = decision;
  return `❌ <b>Protection Failed</b> — ${shortenAddr(user)}

<b>Attempted action:</b> ${action}
<b>Error:</b> ${errorMsg}

Please check your position immediately — manual action may be required.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a risk alert (warning or action).
 */
async function send(user, riskReport, decision, explanation) {
  const chatId = await getChatId(user);
  if (!chatId) {
    log(`[alerter:${user}] No Telegram chat_id registered — skipping alert`);
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
    if (result.ok) {
      log(`[alerter:${user}] Alert sent ✓`);
    } else {
      logError(`[alerter:${user}] Telegram error: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    logError(`[alerter:${user}] Failed to send alert: ${err.message}`);
  }
}

/**
 * Send a confirmation after successful execution.
 */
async function sendActionConfirmation(user, decision, txResult, explanation) {
  const chatId = await getChatId(user);
  if (!chatId) return;

  const text = buildConfirmationMessage(user, decision, txResult, explanation);
  try {
    await sendTelegramMessage(chatId, text);
    log(`[alerter:${user}] Confirmation sent ✓`);
  } catch (err) {
    logError(`[alerter:${user}] Confirmation send failed: ${err.message}`);
  }
}

/**
 * Send a failure notification.
 */
async function sendActionFailed(user, decision, errorMsg) {
  const chatId = await getChatId(user);
  if (!chatId) return;

  const text = buildFailureMessage(user, decision, errorMsg);
  try {
    await sendTelegramMessage(chatId, text);
  } catch (err) {
    logError(`[alerter:${user}] Failure alert send failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram bot webhook handler (for user registration via /start)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * processWebhookUpdate(update)
 * Called by the Express webhook endpoint (set up in index.js or a separate server).
 * Handles the /start <wallet_address> command to register users.
 */
async function processWebhookUpdate(update) {
  const message = update?.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  // /start 0x1234...abcd
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const address = parts[1]?.toLowerCase();

    if (address && address.startsWith("0x") && address.length === 42) {
      await db.setTelegramChatId(address, chatId.toString());
      await sendTelegramMessage(
        chatId,
        `✅ <b>Wallet connected!</b>\n\nYou'll now receive alerts for:\n<code>${address}</code>\n\nThe agent is monitoring your position.`,
      );
      log(`[alerter] Registered Telegram for ${address} → chat_id ${chatId}`);
    } else {
      await sendTelegramMessage(
        chatId,
        "⚠️ Please start with your wallet address:\n<code>/start 0xYourWalletAddress</code>",
      );
    }
    return;
  }

  // /status command
  if (text === "/status") {
    await sendTelegramMessage(
      chatId,
      "ℹ️ Agent is running. Open the dashboard for your current health factor.",
    );
    return;
  }

  // Unknown command
  await sendTelegramMessage(
    chatId,
    "Commands:\n/start &lt;wallet_address&gt; — Register for alerts\n/status — Agent status",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  send,
  sendActionConfirmation,
  sendActionFailed,
  processWebhookUpdate,
};
