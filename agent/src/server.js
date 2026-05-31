/**
 * server.js — HTTP Server for Telegram Webhook + Agent Health API
 * ────────────────────────────────────────────────────────────────
 * Runs alongside the main agent process.
 * Called from index.js after the agent boots.
 *
 * Endpoints:
 *   POST /webhook/telegram   — receives Telegram bot updates
 *                              (users send /start 0xWallet to register)
 *   GET  /health             — returns agent status + last scan time
 *                              (frontend polls this to show "Agent Online")
 *   GET  /api/positions/:addr — returns latest position data from DB
 *   GET  /api/activity/:addr  — returns agent action history from DB
 *   GET  /api/stats/:addr     — returns lifetime stats for a user
 *
 * Telegram webhook setup (run once after deploying):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://yourserver.com/webhook/telegram"
 *
 * For local development use ngrok:
 *   ngrok http 3001
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://xxxx.ngrok.io/webhook/telegram"
 */

"use strict";

const http    = require("http");
const { log, error: logError } = require("./logger");
const alerter = require("./alerter");
const db      = require("./db");

const PORT = parseInt(process.env.SERVER_PORT || "3001");

// ─────────────────────────────────────────────────────────────────────────────
// Agent state (updated by index.js)
// ─────────────────────────────────────────────────────────────────────────────

const agentState = {
  status:          "starting",   // "starting" | "running" | "error"
  lastScanAt:      null,
  totalScans:      0,
  totalActions:    0,
  activePositions: 0,
  startedAt:       Date.now(),
};

function updateState(patch) {
  Object.assign(agentState, patch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Request router
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  // CORS headers — frontend needs these
  res.setHeader("Access-Control-Allow-Origin",  process.env.FRONTEND_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ── POST /webhook/telegram ─────────────────────────────────────────────
    if (method === "POST" && path === "/webhook/telegram") {
      const body = await readBody(req);
      let update;
      try {
        update = JSON.parse(body);
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      await alerter.processWebhookUpdate(update);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ── GET /health ────────────────────────────────────────────────────────
    if (method === "GET" && path === "/health") {
      sendJSON(res, 200, {
        ...agentState,
        uptimeSeconds: Math.floor((Date.now() - agentState.startedAt) / 1000),
        timestamp:     Date.now(),
      });
      return;
    }

    // ── GET /api/positions/:address ────────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/positions/")) {
      const address = path.split("/")[3]?.toLowerCase();
      if (!isValidAddress(address)) {
        sendJSON(res, 400, { error: "Invalid address" });
        return;
      }
      const scans = db.getRecentScans(address, 1);
      const stats = db.getUserStats(address);
      sendJSON(res, 200, {
        address,
        latest:  scans[0] || null,
        stats:   stats    || null,
      });
      return;
    }

    // ── GET /api/activity/:address ─────────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/activity/")) {
      const address = path.split("/")[3]?.toLowerCase();
      const limit   = parseInt(url.searchParams.get("limit") || "50");
      if (!isValidAddress(address)) {
        sendJSON(res, 400, { error: "Invalid address" });
        return;
      }
      const actions = db.getActionHistory(address, Math.min(limit, 200));
      sendJSON(res, 200, { address, actions });
      return;
    }

    // ── GET /api/hf-history/:address ───────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/hf-history/")) {
      const address = path.split("/")[3]?.toLowerCase();
      const hours   = parseInt(url.searchParams.get("hours") || "24");
      if (!isValidAddress(address)) {
        sendJSON(res, 400, { error: "Invalid address" });
        return;
      }
      const history = db.getHFHistory(address, Math.min(hours, 168)); // max 7 days
      sendJSON(res, 200, { address, history });
      return;
    }

    // ── GET /api/stats/:address ────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/api/stats/")) {
      const address = path.split("/")[3]?.toLowerCase();
      if (!isValidAddress(address)) {
        sendJSON(res, 400, { error: "Invalid address" });
        return;
      }
      const stats = db.getUserStats(address);
      sendJSON(res, 200, { address, stats: stats || null });
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    sendJSON(res, 404, { error: "Not found" });

  } catch (err) {
    logError(`[server] Request error: ${err.message}`);
    sendJSON(res, 500, { error: "Internal server error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

function start() {
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    log(`✅ HTTP server listening on port ${PORT}`);
    log(`   Health:   http://localhost:${PORT}/health`);
    log(`   Webhook:  http://localhost:${PORT}/webhook/telegram`);
    log(`   Activity: http://localhost:${PORT}/api/activity/<address>`);
  });

  server.on("error", (err) => {
    logError(`Server error: ${err.message}`);
  });

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end",  ()  => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function isValidAddress(addr) {
  return typeof addr === "string" &&
         addr.startsWith("0x") &&
         addr.length === 42;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { start, updateState };
