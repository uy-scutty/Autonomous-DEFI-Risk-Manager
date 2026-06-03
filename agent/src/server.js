/**
 * server.js — HTTP Server for Telegram Webhook + Agent Health API
 */

"use strict";

const http = require("http");
const { log, error: logError } = require("./logger");
const alerter = require("./alerter");
const db = require("./db");

const PORT = parseInt(process.env.SERVER_PORT || "3001");

// Agent state (updated from index.js)
const agentState = {
  status: "starting",
  lastScanAt: null,
  totalScans: 0,
  activePositions: 0,
  startedAt: Date.now(),
};

function updateState(patch) {
  Object.assign(agentState, patch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle all incoming requests
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Telegram Webhook
    if (req.method === "POST" && path === "/webhook/telegram") {
      const body = await readBody(req);
      const update = JSON.parse(body);
      await alerter.processWebhookUpdate(update);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // Health Check
    if (req.method === "GET" && path === "/health") {
      sendJSON(res, 200, {
        ...agentState,
        uptimeSeconds: Math.floor((Date.now() - agentState.startedAt) / 1000),
      });
      return;
    }

    // User Position
    if (req.method === "GET" && path.startsWith("/api/positions/")) {
      const address = path.split("/")[3]?.toLowerCase();
      if (!address || !address.startsWith("0x")) {
        sendJSON(res, 400, { error: "Invalid address" });
        return;
      }
      const scans = db.getRecentScans(address, 5);
      sendJSON(res, 200, { address, latestScan: scans[0] || null });
      return;
    }

    // Activity History
    if (req.method === "GET" && path.startsWith("/api/activity/")) {
      const address = path.split("/")[3]?.toLowerCase();
      const actions = db.getActionHistory(address, 50);
      sendJSON(res, 200, { address, actions });
      return;
    }

    // 404
    sendJSON(res, 404, { error: "Not found" });
  } catch (err) {
    logError(`[server] Error handling ${req.method} ${path}: ${err.message}`);
    sendJSON(res, 500, { error: "Internal server error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────

function start() {
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    log(`✅ HTTP Server running on port ${PORT}`);
    log(`   → Health:     http://localhost:${PORT}/health`);
    log(`   → Webhook:    http://localhost:${PORT}/webhook/telegram`);
  });

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

module.exports = { start, updateState };
