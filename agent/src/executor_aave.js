/**
 * executor.js — Transaction Executor (Aave Guardian Edition)
 * ────────────────────────────────────────────────────────────
 * CHANGES FROM v1:
 *   - RepayParams struct now has `debtAsset` instead of `debtToken`
 *   - Pre-flight view reads health factor from AaveAdapter not VaultManager
 *   - Deleverage uses executeFlashDeleverage() instead of agentEmergencyDeleverage()
 *   - All HF reads go through AaveAdapter.getHealthFactor()
 *   - Everything else (gas estimation, slippage, timeout, retry) unchanged
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

const GAS_BUFFER_PCT     = 20;
const DEFAULT_SLIPPAGE   = 50;    // 0.5%
const MAX_GAS_PRICE_GWEI = 2;
const CONFIRM_TIMEOUT_MS = 60_000;
const UNISWAP_FEE_TIERS  = [500, 3000, 10000];
const UNISWAP_QUOTER     = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

let _protection = null;
let _adapter    = null;

function getProtection(signer) {
  if (!_protection) {
    _protection = new ethers.Contract(
      process.env.PROTECTION_ACTIONS_ADDRESS,
      ABIS.ProtectionActions,
      signer
    );
  }
  return _protection;
}

function getAdapter(provider) {
  if (!_adapter) {
    _adapter = new ethers.Contract(
      process.env.AAVE_ADAPTER_ADDRESS,
      ABIS.AaveAdapter,
      provider
    );
  }
  return _adapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function execute(decision, signer, provider) {
  try {
    switch (decision.action) {
      case "PARTIAL_REPAY": return await executePartialRepay(decision, signer, provider);
      case "DELEVERAGE":    return await executeDeleverage(decision, signer, provider);
      default: return { success: false, error: `Unknown action: ${decision.action}` };
    }
  } catch (err) {
    logError(`[executor:${decision.user}] ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL_REPAY
// ─────────────────────────────────────────────────────────────────────────────

async function executePartialRepay(decision, signer, provider) {
  const { user, token: debtAsset, amount } = decision;
  const protection  = getProtection(signer);
  const adapter     = getAdapter(provider);
  const keeperAddr  = await signer.getAddress();

  // Pre-flight: view check
  const [permitted, reason] = await protection.canExecuteRepay(user, debtAsset, amount);
  if (!permitted) return { success: false, error: `Pre-flight: ${reason}` };

  // Pre-flight: keeper balance
  const erc20 = new ethers.Contract(debtAsset,
    ["function balanceOf(address) view returns (uint256)",
     "function allowance(address,address) view returns (uint256)",
     "function approve(address,uint256) returns (bool)"],
    signer
  );
  const balance = await erc20.balanceOf(keeperAddr);
  if (balance < amount)
    return { success: false, error: `Keeper balance: have ${balance}, need ${amount}` };

  // Re-check HF hasn't recovered
  const currentHF     = Number(await adapter.getHealthFactor(user)) / 1e18;
  const agentActionHF = Number(decision.agentConfig.actionHF) / 1e18;
  if (currentHF > agentActionHF) {
    log(`[${user}] Position recovered (HF=${currentHF.toFixed(3)}) — skipping`);
    return { success: false, error: "Position recovered" };
  }

  // Approve ProtectionActions to pull debt tokens from keeper
  const allowance = await erc20.allowance(keeperAddr, process.env.PROTECTION_ACTIONS_ADDRESS);
  if (allowance < amount) {
    const tx = await erc20.approve(process.env.PROTECTION_ACTIONS_ADDRESS, ethers.MaxUint256);
    await tx.wait(1);
  }

  // Build params (new struct shape for Aave edition)
  const params = { user, debtAsset, repayAmount: amount };

  const gasEst   = await protection.executePartialRepay.estimateGas(params);
  const gasLimit = gasEst * BigInt(100 + GAS_BUFFER_PCT) / BigInt(100);
  const feeData  = await provider.getFeeData();
  const gasPrice = _minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei")
  );

  log(`[${user}] Sending PARTIAL_REPAY — gas=${gasLimit}`);
  const tx      = await protection.executePartialRepay(params, { gasLimit, gasPrice });
  const receipt = await _withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);

  if (!receipt || receipt.status !== 1)
    return { success: false, hash: tx.hash, error: "Transaction reverted" };

  const hfAfter = Number(await adapter.getHealthFactor(user)) / 1e18;
  log(`[${user}] ✅ Repay confirmed — HF: ${currentHF.toFixed(3)} → ${hfAfter.toFixed(3)}`);

  return { success: true, hash: tx.hash, hfAfter, gasUsed: receipt.gasUsed.toString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELEVERAGE
// ─────────────────────────────────────────────────────────────────────────────

async function executeDeleverage(decision, signer, provider) {
  const { user, token: collateralAsset } = decision;
  const protection = getProtection(signer);
  const adapter    = getAdapter(provider);

  const debtAsset = decision.riskReport?.debtBreakdown?.[0]?.token
    || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC fallback

  const poolFee = await _selectPoolFee(collateralAsset, debtAsset, decision.amount, provider);

  let minDebtRepaid;
  try {
    const quoted  = await _quoteUniswap(collateralAsset, debtAsset, decision.amount, poolFee, provider);
    minDebtRepaid = quoted * BigInt(10000 - DEFAULT_SLIPPAGE) / BigInt(10000);
  } catch {
    minDebtRepaid = decision.amount * BigInt(9500) / BigInt(10000);
  }

  const currentHF     = Number(await adapter.getHealthFactor(user)) / 1e18;
  const agentActionHF = Number(decision.agentConfig.actionHF) / 1e18;
  if (currentHF > agentActionHF)
    return { success: false, error: "Position recovered before deleverage" };

  const params = {
    user,
    collateralAsset,
    debtAsset,
    collateralAmount: decision.amount,
    minDebtRepaid,
    poolFee,
  };

  const gasEst   = await protection.executeFlashDeleverage.estimateGas(params);
  const gasLimit = gasEst * BigInt(100 + GAS_BUFFER_PCT) / BigInt(100);
  const feeData  = await provider.getFeeData();
  const gasPrice = _minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei")
  );

  log(`[${user}] Sending DELEVERAGE — poolFee=${poolFee}`);
  const tx      = await protection.executeFlashDeleverage(params, { gasLimit, gasPrice });
  const receipt = await _withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);

  if (!receipt || receipt.status !== 1)
    return { success: false, hash: tx.hash, error: "Deleverage reverted" };

  const hfAfter = Number(await adapter.getHealthFactor(user)) / 1e18;
  log(`[${user}] ✅ Deleverage confirmed — HF: ${currentHF.toFixed(3)} → ${hfAfter.toFixed(3)}`);

  return { success: true, hash: tx.hash, hfAfter, gasUsed: receipt.gasUsed.toString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────────────

async function _quoteUniswap(tokenIn, tokenOut, amountIn, fee, provider) {
  const quoter = new ethers.Contract(UNISWAP_QUOTER,
    ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
    provider
  );
  return quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0);
}

async function _selectPoolFee(tokenIn, tokenOut, amountIn, provider) {
  let bestFee = 3000, bestOut = BigInt(0);
  await Promise.allSettled(UNISWAP_FEE_TIERS.map(async (fee) => {
    try {
      const out = await _quoteUniswap(tokenIn, tokenOut, amountIn, fee, provider);
      if (out > bestOut) { bestOut = out; bestFee = fee; }
    } catch {}
  }));
  return bestFee;
}

function _minBigInt(a, b) { return a < b ? a : b; }

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)
    ),
  ]);
}

module.exports = { execute };
