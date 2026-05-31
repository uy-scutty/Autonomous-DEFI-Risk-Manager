/**
 * index.js — Autonomous DeFi Risk Manager Agent
 * ───────────────────────────────────────────────
 * PATCHES APPLIED vs original:
 *   1. REQUIRED_ENV updated — removed VAULT_MANAGER/RISK_ORACLE, added AAVE_ADAPTER
 *   2. server.js imported and started after DB init
 *   3. Event listener wrapped in try/catch so a bad RPC on boot doesn't
 *      kill the listener silently
 *   4. agentState.totalScans + activePositions updated for /health endpoint
 */

"use strict";

require("dotenv").config();

const cron       = require("node-cron");
const { ethers } = require("ethers");

const scanner        = require("./scanner");
const riskEngine     = require("./riskEngine");
const decisionEngine = require("./decisionEngine");
const executor       = require("./executor");
const explainer      = require("./explainer");
const alerter        = require("./alerter");
const db             = require("./db");
const server         = require("./server");           // ← PATCH 2: added
const { log, error: logError } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// PATCH 1: Updated REQUIRED_ENV — Aave addresses replace VaultManager/RiskOracle
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "ARBITRUM_RPC_URL",
  "AGENT_PRIVATE_KEY",
  "AAVE_ADAPTER_ADDRESS",           // ← was VAULT_MANAGER_ADDRESS
  "AAVE_POOL_ADDRESS",              // ← was RISK_ORACLE_ADDRESS
  "AGENT_REGISTRY_ADDRESS",
  "PROTECTION_ACTIONS_ADDRESS",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logError(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared provider + signer
// ─────────────────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
const signer   = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);

const SCAN_CRON          = process.env.SCAN_CRON          || "*/30 * * * * *";
const EVENT_REPLAY_BLOCKS = parseInt(process.env.EVENT_REPLAY_BLOCKS || "1000");

// ─────────────────────────────────────────────────────────────────────────────
// Core scan cycle
// ─────────────────────────────────────────────────────────────────────────────

async function runScanCycle() {
  const cycleId = Date.now();
  log(`[cycle:${cycleId}] Scan started`);

  let positions;
  try {
    positions = await scanner.fetchAllPositions(provider);
  } catch (err) {
    logError(`[cycle:${cycleId}] Scanner failed: ${err.message}`);
    return;
  }

  if (!positions || positions.length === 0) {
    log(`[cycle:${cycleId}] No active positions found`);
    return;
  }

  // PATCH 4: update server health state
  server.updateState({
    status:          "running",
    lastScanAt:      Date.now(),
    activePositions: positions.length,
    totalScans:      (server.agentState?.totalScans || 0) + 1,
  });

  log(`[cycle:${cycleId}] Processing ${positions.length} position(s)`);

  const CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "10");
  const chunks = chunkArray(positions, CONCURRENCY);

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map((position) => processPosition(position, cycleId))
    );
  }

  log(`[cycle:${cycleId}] Scan complete`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user processing pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processPosition(position, cycleId) {
  const { user } = position;

  try {
    const riskReport = await riskEngine.assess(position, provider);
    const decision   = await decisionEngine.evaluate(riskReport, provider);

    // PATCH 2 (from decisionEngine fix): attach riskReport to decision
    // so executor.js can read debtBreakdown for deleverage token selection
    decision.riskReport = riskReport;

    await db.recordScan({
      user,
      cycleId,
      healthFactor:   riskReport.healthFactor,
      band:           riskReport.band,
      projectedHF5:   riskReport.scenarios["-5%"],
      projectedHF10:  riskReport.scenarios["-10%"],
      projectedHF20:  riskReport.scenarios["-20%"],
      volatilityBP:   riskReport.volatilityBP,
      decision:       decision.action,
    });

    if (decision.action === "NONE") return;

    const explanation = await explainer.generate(riskReport, decision);

    if (decision.action !== "NONE") {
      await alerter.send(user, riskReport, decision, explanation);
    }

    if (decision.shouldExecute) {
      const txResult = await executor.execute(decision, signer, provider);

      await db.recordAction({
        user,
        cycleId,
        actionType:   decision.action,
        token:        decision.token,
        amount:       decision.amount?.toString(),
        txHash:       txResult.hash,
        hfBefore:     riskReport.healthFactor,
        hfAfter:      txResult.hfAfter,
        explanation,
        success:      txResult.success,
        errorMessage: txResult.error,
      });

      if (txResult.success) {
        log(`[${user}] ✅ ${decision.action} executed — tx: ${txResult.hash}`);
        await alerter.sendActionConfirmation(user, decision, txResult, explanation);
      } else {
        logError(`[${user}] ❌ Execution failed: ${txResult.error}`);
        await alerter.sendActionFailed(user, decision, txResult.error);
      }
    }
  } catch (err) {
    logError(`[${user}] Pipeline error: ${err.message}`);
    await db.recordError({ user, cycleId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH 3: Event listeners wrapped in try/catch per event
// ─────────────────────────────────────────────────────────────────────────────

async function startEventListeners() {
  log("Starting real-time event listeners...");

  await scanner.startEventListeners(provider, async (event) => {
    log(`[event] ${event.type} for ${event.user} — triggering immediate scan`);

    // PATCH 3: guard each event-triggered scan independently
    try {
      const position = await scanner.fetchPosition(event.user, provider);

      // Skip if position has no debt (Supply event on non-borrowing user)
      if (position.totalDebtUSD === "0") return;

      await processPosition(position, `evt-${Date.now()}`);
    } catch (err) {
      logError(`[event] Failed to process ${event.user}: ${err.message}`);
      // Do NOT rethrow — one bad event must not kill the listener
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup sequence
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════");
  log("  Autonomous DeFi Risk Manager Agent v1.0.0");
  log("  Mode: Aave Guardian");
  log("═══════════════════════════════════════════════");

  // 1. Init database
  await db.init();
  log("✅ Database initialised");

  // 2. PATCH 2: Start HTTP server (Telegram webhook + health + API)
  server.start();

  // 3. Verify RPC connection
  const network = await provider.getNetwork();
  log(`✅ Connected to: ${network.name} (chainId: ${network.chainId})`);

  if (network.chainId !== 42161n && network.chainId !== 421614n) {
    logError(`⚠️  Not on Arbitrum — chainId=${network.chainId}`);
  }

  // 4. Verify keeper wallet
  const keeperAddress = await signer.getAddress();
  const keeperBalance = await provider.getBalance(keeperAddress);
  log(`✅ Keeper wallet: ${keeperAddress}`);
  log(`   ETH balance:   ${ethers.formatEther(keeperBalance)} ETH`);

  if (keeperBalance < ethers.parseEther("0.01")) {
    logError("⚠️  Low keeper ETH balance — top up before going live");
  }

  // 5. Start event listeners
  await startEventListeners();
  log("✅ Event listeners active");

  // 6. Boot scan
  server.updateState({ status: "running" });
  log("Running boot-time scan...");
  await runScanCycle();

  // 7. Schedule recurring scans
  cron.schedule(SCAN_CRON, async () => {
    await runScanCycle();
  });

  log(`✅ Cron scheduled: ${SCAN_CRON}`);
  log("Agent is running. Press Ctrl+C to stop.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

process.on("SIGINT",  () => { log("Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { log("Shutting down..."); process.exit(0); });
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
});

main().catch((err) => {
  logError(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
