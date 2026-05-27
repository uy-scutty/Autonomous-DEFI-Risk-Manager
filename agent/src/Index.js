/**
 * index.js — Autonomous DeFi Risk Manager Agent
 * ───────────────────────────────────────────────
 * Entry point. Boots all modules, registers event listeners,
 * and starts the cron-based scan loop.
 *
 * Architecture:
 *   Scanner      → fetches all registered user positions
 *   RiskEngine   → computes HF, projects scenarios, scores risk
 *   DecisionEngine → evaluates thresholds, picks action
 *   Executor     → builds + broadcasts on-chain tx
 *   Explainer    → generates plain-English rationale via Claude API
 *   Alerter      → sends Telegram notifications
 *   DB           → persists events to SQLite
 *
 * Run:
 *   node index.js
 *   OR
 *   npm start   (uses nodemon for dev)
 */

"use strict";

require("dotenv").config();

const cron = require("node-cron");
const { ethers } = require("ethers");

const scanner = require("./scanner");
const riskEngine = require("./riskEngine");
const decisionEngine = require("./decisionEngine");
const executor = require("./executor");
const explainer = require("./explainer");
const alerter = require("./alerter");
const db = require("./db");
const { log, error: logError } = require("./logger");

// ─────────────────────────────────────────────────────────────────────────────
// Validate environment
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "ARBITRUM_RPC_URL",
  "AGENT_PRIVATE_KEY",
  "VAULT_MANAGER_ADDRESS",
  "AGENT_REGISTRY_ADDRESS",
  "PROTECTION_ACTIONS_ADDRESS",
  "RISK_ORACLE_ADDRESS",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logError(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared provider + signer (single instance, reused across modules)
// ─────────────────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
const signer = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);

// ─────────────────────────────────────────────────────────────────────────────
// Scan interval config
// ─────────────────────────────────────────────────────────────────────────────

// Full position scan every 30 seconds
const SCAN_CRON = process.env.SCAN_CRON || "*/30 * * * * *";

// How many blocks to look back when replaying missed events on startup
const EVENT_REPLAY_BLOCKS = parseInt(process.env.EVENT_REPLAY_BLOCKS || "1000");

// ─────────────────────────────────────────────────────────────────────────────
// Core scan cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runScanCycle
 * ────────────
 * Called every SCAN_CRON tick. For each registered user:
 *   1. Fetch current position
 *   2. Assess risk
 *   3. Make a decision
 *   4. Execute if needed
 *   5. Explain + notify
 */
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

  log(`[cycle:${cycleId}] Processing ${positions.length} position(s)`);

  // Process users concurrently, cap at 10 parallel to avoid RPC rate limits
  const CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "10");
  const chunks = chunkArray(positions, CONCURRENCY);

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map((position) => processPosition(position, cycleId)),
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
    // ── Step 1: Risk assessment ──────────────────────────────────────────
    const riskReport = await riskEngine.assess(position, provider);

    // ── Step 2: Decision ─────────────────────────────────────────────────
    const decision = await decisionEngine.evaluate(riskReport, provider);

    // Persist the scan result regardless of action
    await db.recordScan({
      user,
      cycleId,
      healthFactor: riskReport.healthFactor,
      band: riskReport.band,
      projectedHF5: riskReport.scenarios["-5%"],
      projectedHF10: riskReport.scenarios["-10%"],
      projectedHF20: riskReport.scenarios["-20%"],
      volatilityBP: riskReport.volatilityBP,
      decision: decision.action,
    });

    // No action needed — green or decision engine said stand-down
    if (decision.action === "NONE") return;

    // ── Step 3: Generate natural language explanation ─────────────────────
    const explanation = await explainer.generate(riskReport, decision);

    // ── Step 4: Alert (always, for WARNING and above) ─────────────────────
    if (decision.action !== "NONE") {
      await alerter.send(user, riskReport, decision, explanation);
    }

    // ── Step 5: Execute on-chain action (only if agent is authorised) ─────
    if (decision.shouldExecute) {
      const txResult = await executor.execute(decision, signer, provider);

      await db.recordAction({
        user,
        cycleId,
        actionType: decision.action,
        token: decision.token,
        amount: decision.amount?.toString(),
        txHash: txResult.hash,
        hfBefore: riskReport.healthFactor,
        hfAfter: txResult.hfAfter,
        explanation,
        success: txResult.success,
        errorMessage: txResult.error,
      });

      if (txResult.success) {
        log(`[${user}] ✅ ${decision.action} executed — tx: ${txResult.hash}`);
        await alerter.sendActionConfirmation(
          user,
          decision,
          txResult,
          explanation,
        );
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
// Real-time event listeners (complement the cron scan)
// ─────────────────────────────────────────────────────────────────────────────

async function startEventListeners() {
  log("Starting real-time event listeners...");
  await scanner.startEventListeners(provider, async (event) => {
    log(`[event] ${event.type} for ${event.user} — triggering immediate scan`);
    try {
      const position = await scanner.fetchPosition(event.user, provider);
      await processPosition(position, `evt-${Date.now()}`);
    } catch (err) {
      logError(
        `[event] Failed to process event for ${event.user}: ${err.message}`,
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup sequence
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════");
  log("  Autonomous DeFi Risk Manager Agent v1.0.0");
  log("═══════════════════════════════════════════════");

  // 1. Init database
  await db.init();
  log("✅ Database initialised");

  // 2. Verify RPC connection
  const network = await provider.getNetwork();
  log(`✅ Connected to chain: ${network.name} (${network.chainId})`);

  // Warn if not on Arbitrum
  if (network.chainId !== 42161n && network.chainId !== 421614n) {
    logError(
      `⚠️  Warning: expected Arbitrum (42161 or 421614), got ${network.chainId}`,
    );
  }

  // 3. Verify keeper wallet
  const keeperAddress = await signer.getAddress();
  const keeperBalance = await provider.getBalance(keeperAddress);
  log(`✅ Agent wallet: ${keeperAddress}`);
  log(`   ETH balance:  ${ethers.formatEther(keeperBalance)} ETH`);

  if (keeperBalance < ethers.parseEther("0.01")) {
    logError("⚠️  Low keeper balance — may not have enough ETH for gas");
  }

  // 4. Start real-time event listeners
  await startEventListeners();
  log("✅ Event listeners active");

  // 5. Run an immediate scan on boot (catch up on missed events)
  log("Running boot-time scan...");
  await runScanCycle();

  // 6. Schedule recurring scans
  cron.schedule(SCAN_CRON, async () => {
    await runScanCycle();
  });
  log(`✅ Cron scan scheduled: ${SCAN_CRON}`);

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

process.on("SIGINT", () => {
  log("Shutting down (SIGINT)...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("Shutting down (SIGTERM)...");
  process.exit(0);
});
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
});

main().catch((err) => {
  logError(`Fatal startup error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
