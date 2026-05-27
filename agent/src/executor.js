/**
 * executor.js — Transaction Executor
 * ────────────────────────────────────
 * Builds, simulates, and broadcasts the on-chain protection transaction
 * that the decision engine has selected.
 *
 * Supports:
 *   PARTIAL_REPAY   → ProtectionActions.executePartialRepay()
 *   DELEVERAGE      → ProtectionActions.executeEmergencyDeleverage()
 *
 * Safety checks before sending:
 *   • Pre-flight canExecuteRepay() view call
 *   • Gas estimation with 20% buffer
 *   • Slippage calculation for deleverage swaps (Uniswap v3 quoter)
 *   • Re-check HF is still below threshold (avoids wasted gas on recovered positions)
 *
 * Returns:
 * {
 *   success:   true,
 *   hash:      "0x...",
 *   hfAfter:   1.72,
 *   gasUsed:   "142500",
 * }
 * OR
 * {
 *   success:   false,
 *   error:     "Pre-flight check failed: HF recovered",
 * }
 */

"use strict";

const { ethers } = require("ethers");
const { log, error: logError } = require("./logger");
const ABIS = require("./abis");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GAS_BUFFER_PCT = 20; // add 20% to estimated gas
const DEFAULT_SLIPPAGE = 50; // 0.5% slippage tolerance (in basis points)
const MAX_GAS_PRICE_GWEI = 2; // Arbitrum is typically < 0.1 gwei, but cap at 2
const CONFIRM_TIMEOUT_MS = 60_000; // 60s to wait for tx confirmation
const UNISWAP_FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// Uniswap v3 Quoter on Arbitrum One
const UNISWAP_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// ─────────────────────────────────────────────────────────────────────────────
// Contract instances
// ─────────────────────────────────────────────────────────────────────────────

let _protection = null;
let _vaultManager = null;

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

function getVaultManager(provider) {
  if (!_vaultManager) {
    _vaultManager = new ethers.Contract(
      process.env.VAULT_MANAGER_ADDRESS,
      ABIS.VaultManager,
      provider,
    );
  }
  return _vaultManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main execute function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * execute(decision, signer, provider) → ExecutionResult
 */
async function execute(decision, signer, provider) {
  const { user, action, token, amount } = decision;

  try {
    switch (action) {
      case "PARTIAL_REPAY":
        return await executePartialRepay(decision, signer, provider);
      case "DELEVERAGE":
        return await executeDeleverage(decision, signer, provider);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    logError(`[executor:${user}] ${action} failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL_REPAY
// ─────────────────────────────────────────────────────────────────────────────

async function executePartialRepay(decision, signer, provider) {
  const { user, token, amount } = decision;
  const protection = getProtection(signer);
  const vault = getVaultManager(provider);
  const keeperAddr = await signer.getAddress();

  // ── Pre-flight 1: View check ──────────────────────────────────────────────
  const [permitted, reason] = await protection.canExecuteRepay(
    user,
    token,
    amount,
  );
  if (!permitted) {
    return { success: false, error: `Pre-flight rejected: ${reason}` };
  }

  // ── Pre-flight 2: Keeper has enough token balance ─────────────────────────
  const erc20 = new ethers.Contract(
    token,
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
      error: `Keeper balance insufficient: have ${balance}, need ${amount}`,
    };
  }

  // ── Pre-flight 3: Re-check HF is still below threshold ───────────────────
  const currentHFRaw = await vault.getHealthFactor(user);
  const currentHF = Number(currentHFRaw) / 1e18;
  const agentActionHF = Number(decision.agentConfig.actionHF) / 1e18;

  if (currentHF > agentActionHF) {
    log(
      `[${user}] Position recovered (HF=${currentHF.toFixed(3)}) — skipping repay`,
    );
    return { success: false, error: "Position recovered before execution" };
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  const allowance = await erc20.allowance(
    keeperAddr,
    process.env.PROTECTION_ACTIONS_ADDRESS,
  );
  if (allowance < amount) {
    log(
      `[${user}] Approving ${process.env.PROTECTION_ACTIONS_ADDRESS} for repay token`,
    );
    const approveTx = await erc20.approve(
      process.env.PROTECTION_ACTIONS_ADDRESS,
      ethers.MaxUint256,
    );
    await approveTx.wait(1);
  }

  // ── Build tx params ───────────────────────────────────────────────────────
  const repayParams = {
    user,
    debtToken: token,
    repayAmount: amount,
    hfTargetMin: BigInt(Math.round(1.05 * 1e18)), // sanity: expect at least HF 1.05 after
  };

  // ── Gas estimation ────────────────────────────────────────────────────────
  const gasEstimate =
    await protection.executePartialRepay.estimateGas(repayParams);
  const gasLimit = (gasEstimate * BigInt(100 + GAS_BUFFER_PCT)) / BigInt(100);

  const feeData = await provider.getFeeData();
  const gasPrice = minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(MAX_GAS_PRICE_GWEI.toString(), "gwei"),
  );

  log(
    `[${user}] Sending PARTIAL_REPAY tx — gas=${gasLimit} price=${ethers.formatUnits(gasPrice, "gwei")}gwei`,
  );

  // ── Send tx ───────────────────────────────────────────────────────────────
  const tx = await protection.executePartialRepay(repayParams, {
    gasLimit,
    gasPrice,
  });
  log(`[${user}] Tx submitted: ${tx.hash}`);

  // ── Wait for confirmation ─────────────────────────────────────────────────
  const receipt = await withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);
  if (!receipt || receipt.status !== 1) {
    return {
      success: false,
      hash: tx.hash,
      error: "Transaction reverted on-chain",
    };
  }

  // ── Post-execution HF ────────────────────────────────────────────────────
  const hfAfterRaw = await vault.getHealthFactor(user);
  const hfAfter = Number(hfAfterRaw) / 1e18;

  log(
    `[${user}] ✅ PARTIAL_REPAY confirmed — HF: ${currentHF.toFixed(3)} → ${hfAfter.toFixed(3)}`,
  );

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
  const {
    user,
    token: collateralToken,
    amount: collateralAmount,
    debtBreakdown,
  } = decision;

  // For deleverage we also need the debt token to repay
  // Pick the largest debt position
  const debtToken =
    decision.riskReport?.debtBreakdown?.[0]?.token ||
    process.env.DEFAULT_DEBT_TOKEN ||
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC fallback

  const protection = getProtection(signer);
  const vault = getVaultManager(provider);

  // ── Select Uniswap pool fee tier ──────────────────────────────────────────
  const poolFee = await selectPoolFee(
    collateralToken,
    debtToken,
    collateralAmount,
    provider,
  );

  // ── Quote expected output (debt tokens received from swap) ────────────────
  let minDebtRepaid;
  try {
    const quotedOut = await quoteUniswapV3(
      collateralToken,
      debtToken,
      collateralAmount,
      poolFee,
      provider,
    );
    // Apply slippage tolerance
    minDebtRepaid =
      (quotedOut * BigInt(10000 - DEFAULT_SLIPPAGE)) / BigInt(10000);
    log(
      `[${user}] Uniswap quote: ${collateralAmount} collateral → ${quotedOut} debt (min: ${minDebtRepaid})`,
    );
  } catch (err) {
    logError(`[${user}] Quoter failed: ${err.message} — using 95% estimate`);
    // Very conservative fallback: assume 5% slippage
    minDebtRepaid = (collateralAmount * BigInt(9500)) / BigInt(10000);
  }

  // ── Re-check HF ───────────────────────────────────────────────────────────
  const currentHFRaw = await vault.getHealthFactor(user);
  const currentHF = Number(currentHFRaw) / 1e18;
  const agentActionHF = Number(decision.agentConfig.actionHF) / 1e18;

  if (currentHF > agentActionHF) {
    return { success: false, error: "Position recovered before deleverage" };
  }

  // ── Build params ──────────────────────────────────────────────────────────
  const delgParams = {
    user,
    collateralToken,
    debtToken,
    collateralToSell: collateralAmount,
    minDebtRepaid,
    poolFee,
    hfTargetMin: BigInt(Math.round(1.05 * 1e18)),
  };

  // ── Gas estimation ────────────────────────────────────────────────────────
  const gasEstimate =
    await protection.executeEmergencyDeleverage.estimateGas(delgParams);
  const gasLimit = (gasEstimate * BigInt(100 + GAS_BUFFER_PCT)) / BigInt(100);

  const feeData = await provider.getFeeData();
  const gasPrice = minBigInt(
    feeData.gasPrice || ethers.parseUnits("0.1", "gwei"),
    ethers.parseUnits(MAX_GAS_PRICE_GWEI.toString(), "gwei"),
  );

  log(
    `[${user}] Sending DELEVERAGE tx — poolFee=${poolFee} gasLimit=${gasLimit}`,
  );

  // ── Send tx ───────────────────────────────────────────────────────────────
  const tx = await protection.executeEmergencyDeleverage(delgParams, {
    gasLimit,
    gasPrice,
  });
  log(`[${user}] Deleverage tx submitted: ${tx.hash}`);

  const receipt = await withTimeout(tx.wait(1), CONFIRM_TIMEOUT_MS);
  if (!receipt || receipt.status !== 1) {
    return {
      success: false,
      hash: tx.hash,
      error: "Deleverage reverted on-chain",
    };
  }

  const hfAfterRaw = await vault.getHealthFactor(user);
  const hfAfter = Number(hfAfterRaw) / 1e18;

  log(
    `[${user}] ✅ DELEVERAGE confirmed — HF: ${currentHF.toFixed(3)} → ${hfAfter.toFixed(3)}`,
  );

  return {
    success: true,
    hash: tx.hash,
    hfAfter,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Uniswap v3 helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quote the expected output for a single-hop swap via Uniswap v3 Quoter.
 */
async function quoteUniswapV3(tokenIn, tokenOut, amountIn, fee, provider) {
  const quoter = new ethers.Contract(
    UNISWAP_QUOTER,
    [
      "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)",
    ],
    provider,
  );

  const amountOut = await quoter.quoteExactInputSingle.staticCall(
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    0,
  );
  return amountOut;
}

/**
 * Try fee tiers and return the one with the best output quote.
 */
async function selectPoolFee(tokenIn, tokenOut, amountIn, provider) {
  let bestFee = UNISWAP_FEE_TIERS[1]; // default 0.3%
  let bestOutput = BigInt(0);

  await Promise.allSettled(
    UNISWAP_FEE_TIERS.map(async (fee) => {
      try {
        const out = await quoteUniswapV3(
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          provider,
        );
        if (out > bestOutput) {
          bestOutput = out;
          bestFee = fee;
        }
      } catch {
        /* pool may not exist for this fee tier */
      }
    }),
  );

  log(`Best Uniswap fee tier: ${bestFee / 10000}% (output=${bestOutput})`);
  return bestFee;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function minBigInt(a, b) {
  return a < b ? a : b;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { execute };
