/**
 * index.js — Main Entry Point for Aave Guardian Agent
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
// Required Environment Variables
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "ARBITRUM_RPC_URL",
  "AGENT_PRIVATE_KEY",
  "AAVE_ADAPTER_ADDRESS",
  "AAVE_POOL_ADDRESS",
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
// Blockchain Connection
// ─────────────────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
const signer = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);

const SCAN_CRON = process.env.SCAN_CRON || "*/30 * * * * *";

// ─────────────────────────────────────────────────────────────────────────────
// Core Scan Cycle
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
    log(`[cycle:${cycleId}] No active borrowing positions found`);
    return;
  }

  log(`[cycle:${cycleId}] Processing ${positions.length} position(s)`);

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
// Per Position Processing Pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processPosition(position, cycleId) {
  const { user } = position;

  try {
    const riskReport = await riskEngine.assess(position, provider);
    const decision = await decisionEngine.evaluate(riskReport, provider);

    // Attach riskReport so executor can use debt/collateral data
    decision.riskReport = riskReport;

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

    if (decision.action === "NONE") return;

    const explanation = await explainer.generate(riskReport, decision);

    await alerter.send(user, riskReport, decision, explanation);

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
// Real-time Event Listeners
// ─────────────────────────────────────────────────────────────────────────────

async function startEventListeners() {
  log("Starting real-time event listeners...");

  await scanner.startEventListeners(provider, async (event) => {
    log(`[event] ${event.type} for ${event.user} — triggering scan`);

    try {
      const position = await scanner.fetchPosition(event.user, provider);
      if (position.totalDebtUSD === "0") return; // Skip if no debt

      await processPosition(position, `evt-${Date.now()}`);
    } catch (err) {
      logError(`[event] Failed to process ${event.user}: ${err.message}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("═══════════════════════════════════════════════");
  log("  Autonomous DeFi Risk Manager Agent");
  log("  Aave Guardian Mode");
  log("═══════════════════════════════════════════════");

  await db.init();
  log("✅ Database initialized");

  const network = await provider.getNetwork();
  log(`✅ Connected to ${network.name} (Chain ID: ${network.chainId})`);

  const keeperAddress = await signer.getAddress();
  const balance = await provider.getBalance(keeperAddress);
  log(`✅ Agent wallet: ${keeperAddress}`);
  log(`   Balance: ${ethers.formatEther(balance)} ETH`);

  await startEventListeners();
  log("✅ Event listeners started");

  log("Running initial scan...");
  await runScanCycle();

  cron.schedule(SCAN_CRON, runScanCycle);
  log(`✅ Cron scan scheduled (${SCAN_CRON})`);

  log("🚀 Agent is running!");
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("Shutting down...");
  process.exit(0);
});

main().catch((err) => {
  logError(`Fatal startup error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
