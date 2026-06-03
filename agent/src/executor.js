/**
 * executor_aave.js — Transaction Executor (Aave Guardian Edition)
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

const GAS_BUFFER_PCT = 20;
const DEFAULT_SLIPPAGE = 50; // 0.5%
const MAX_GAS_PRICE_GWEI = 2;
const CONFIRM_TIMEOUT_MS = 60_000;
const UNISWAP_FEE_TIERS = [500, 3000, 10000];
const UNISWAP_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

let _protection = null;
let _adapter = null;

function getProtection(signer) {
  if (!_protection) {
    _protection = new ethers.Contract(
      process.env.PROTECTION_ACTIONS_ADDRESS,
      ABIS.ProtectionActions,
      signer,
    );
  }
  return _protection;
}

function getAdapter(provider) {
  if (!_adapter) {
    _adapter = new ethers.Contract(
      process.env.AAVE_ADAPTER_ADDRESS,
      ABIS.AaveAdapter,
      provider,
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
      case "PARTIAL_REPAY":
        return await executePartialRepay(decision, signer, provider);
      case "DELEVERAGE":
        return await executeDeleverage(decision, signer, provider);
      default:
        return { success: false, error: `Unknown action: ${decision.action}` };
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
  const { user, token: debtAsset, amount, agentConfig } = decision;
  const protection = getProtection(signer);
  const adapter = getAdapter(provider);
  const keeperAddr = await signer.getAddress();

  // Pre-flight permission check
  const [permitted, reason] = await protection
    .canExecuteRepay(user, debtAsset, amount)
    .catch(() => [false, "Pre-flight check failed"]);

  if (!permitted) {
    return { success: false, error: `Pre-flight: ${reason}` };
  }

  // Check keeper balance
  const erc20 = new ethers.Contract(
    debtAsset,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    signer,
  );

  const balance = await erc20.balanceOf(keeperAddr);
  if (balance < amount) {
    return {
      success: false,
      error: `Insufficient balance. Have ${ethers.formatUnits(balance, 6)}, need ${ethers.formatUnits(amount, 6)}`,
    };
  }

  // Approve if necessary
  const allowance = await erc20.allowance(
    keeperAddr,
    process.env.PROTECTION_ACTIONS_ADDRESS,
  );
  if (allowance < amount) {
    const tx = await erc20.approve(
      process.env.PROTECTION_ACTIONS_ADDRESS,
      ethers.MaxUint256,
    );
    await tx.wait(1);
    log(`[${user}] Approved debt token for ProtectionActions`);
  }

  const params = { user, debtAsset, repayAmount: amount };

  const gasEst = await protection.executePartialRepay.estimateGas(params);
  const gasLimit = (gasEst * BigInt(100 + GAS_BUFFER_PCT)) / BigInt(100);

  const feeData = await provider.getFeeData();
  const gasPrice = _minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei"),
  );

  log(`[${user}] Sending PARTIAL_REPAY...`);
  const tx = await protection.executePartialRepay(params, {
    gasLimit,
    gasPrice,
  });
  const receipt = await _withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);

  if (!receipt || receipt.status !== 1) {
    return { success: false, hash: tx.hash, error: "Transaction reverted" };
  }

  const hfAfter = Number(await adapter.getHealthFactor(user)) / 1e18;
  log(`[${user}] ✅ PARTIAL_REPAY successful — HF improved | tx: ${tx.hash}`);

  return {
    success: true,
    hash: tx.hash,
    hfAfter,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELEVERAGE
// ─────────────────────────────────────────────────────────────────────────────

async function executeDeleverage(decision, signer, provider) {
  const { user, token: collateralAsset, amount } = decision;
  const protection = getProtection(signer);
  const adapter = getAdapter(provider);

  // Use correct USDC on Sepolia for testnet
  const debtAsset = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

  const poolFee = await _selectPoolFee(
    collateralAsset,
    debtAsset,
    amount,
    provider,
  );

  let minDebtRepaid;
  try {
    const quoted = await _quoteUniswap(
      collateralAsset,
      debtAsset,
      amount,
      poolFee,
      provider,
    );
    minDebtRepaid = (quoted * BigInt(10000 - DEFAULT_SLIPPAGE)) / BigInt(10000);
  } catch {
    minDebtRepaid = (amount * BigInt(9500)) / BigInt(10000);
  }

  const params = {
    user,
    collateralAsset,
    debtAsset,
    collateralAmount: amount,
    minDebtRepaid,
    poolFee,
  };

  const gasEst = await protection.executeFlashDeleverage.estimateGas(params);
  const gasLimit = (gasEst * BigInt(100 + GAS_BUFFER_PCT)) / BigInt(100);

  const feeData = await provider.getFeeData();
  const gasPrice = _minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei"),
  );

  log(`[${user}] Sending DELEVERAGE...`);
  const tx = await protection.executeFlashDeleverage(params, {
    gasLimit,
    gasPrice,
  });
  const receipt = await _withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);

  if (!receipt || receipt.status !== 1) {
    return { success: false, hash: tx.hash, error: "Deleverage reverted" };
  }

  const hfAfter = Number(await adapter.getHealthFactor(user)) / 1e18;
  log(`[${user}] ✅ DELEVERAGE successful — tx: ${tx.hash}`);

  return {
    success: true,
    hash: tx.hash,
    hfAfter,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _quoteUniswap(tokenIn, tokenOut, amountIn, fee, provider) {
  const quoter = new ethers.Contract(
    UNISWAP_QUOTER,
    [
      "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)",
    ],
    provider,
  );
  return quoter.quoteExactInputSingle.staticCall(
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    0,
  );
}

async function _selectPoolFee(tokenIn, tokenOut, amountIn, provider) {
  return 3000; // 0.3% fee - good default for testnet
}

function _minBigInt(a, b) {
  return a < b ? a : b;
}

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms),
    ),
  ]);
}

module.exports = { execute };
