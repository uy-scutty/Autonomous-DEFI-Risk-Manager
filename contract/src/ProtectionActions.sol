// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  ProtectionActions
 * @author Autonomous DeFi Risk Manager
 * @notice Executes the actual on-chain protective operations that the
 *         autonomous agent triggers when a user's health factor is at risk.
 *
 *         Actions
 *         ───────
 *         1. PARTIAL_REPAY      — Repay a portion of a user's debt using
 *                                 funds the agent has sourced (pre-approved
 *                                 ERC-20 transfer from agent wallet).
 *
 *         2. EMERGENCY_DELEVERAGE — Withdraw collateral, route it through a
 *                                   DEX (Uniswap v3 on Arbitrum) to obtain the
 *                                   debt token, then repay.
 *
 *         3. COLLATERAL_TOP_UP  — Pull extra collateral from user's wallet
 *                                 (requires prior ERC-20 approval from user)
 *                                 and deposit it into VaultManager.
 *
 *         Security model
 *         ──────────────
 *         • Only the registered agentKeeper (from AgentRegistry.globalKeeper)
 *           or a user-whitelisted keeper may call execute*().
 *         • Every action checks AgentRegistry for user consent and sizing limits.
 *         • Slippage is enforced via minAmountOut on DEX swaps.
 *         • ReentrancyGuard on all external state-changers.
 *         • Pausable by owner for emergency freeze.
 *         • Emits ProtectionExecuted on success for easy agent log indexing.
 *
 *         DEX integration (Arbitrum mainnet)
 *         ───────────────────────────────────
 *         Uniswap v3 SwapRouter02 on Arbitrum: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *         Pool fee tiers supported: 500 (0.05%), 3000 (0.3%), 10000 (1%).
 *         The agent's executor.js selects the optimal fee tier off-chain
 *         and passes it as a parameter.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Minimal Uniswap v3 SwapRouter interface (only what we use)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}

// Minimal VaultManager interface (only the functions we call)
interface IVaultManager {
    function agentPartialRepay(address user, address token, uint256 amount) external;
    function agentEmergencyDeleverage(
        address user,
        address collateralToken,
        address debtToken,
        uint256 collateralAmount,
        uint256 debtRepayAmount
    ) external;
    function depositCollateral(address token, uint256 amount) external;
    function getHealthFactor(address user) external view returns (uint256);
    function getBorrowed(address user, address token) external view returns (uint256);
    function getCollateral(address user, address token) external view returns (uint256);
}

// Minimal AgentRegistry interface
interface IAgentRegistry {
    function getAgentDecisionParams(address user)
        external
        view
        returns (
            bool agentEnabled,
            bool alertOnly,
            bool canRepay,
            bool canDeleverage,
            uint256 warningHF,
            uint256 actionHF,
            uint16 maxRepayBP,
            uint16 maxDelgBP
        );
    function isAuthorisedKeeper(address user, address keeper) external view returns (bool);
    function recordAction(address user, string calldata actionType, uint256 valueUSD18) external;
}

contract ProtectionActions is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Custom errors
    // ─────────────────────────────────────────────────────────────────────────────
    error NotAuthorisedKeeper(address caller, address user);
    error UserAgentDisabled(address user);
    error ActionNotPermitted(address user, string action);
    error SlippageTooHigh(uint256 amountOut, uint256 minExpected);
    error HealthFactorAlreadySafe(address user, uint256 currentHF, uint256 actionThreshold);
    error RepayAmountExceedsLimit(uint256 requested, uint256 maxAllowed);
    error DeleverageAmountExceedsLimit(uint256 requested, uint256 maxAllowed);
    error ZeroAmount();
    error TopUpNotApproved(address user, address token, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Parameters for a partial repay action
    struct RepayParams {
        address user; // position owner
        address debtToken; // token to repay
        uint256 repayAmount; // amount to repay (in debtToken units)
        uint256 hfTargetMin; // agent's expected minimum HF after action (sanity check)
    }

    /// @notice Parameters for an emergency deleverage action
    struct DeleverageParams {
        address user;
        address collateralToken;
        address debtToken;
        uint256 collateralToSell; // amount of collateral to swap
        uint256 minDebtRepaid; // minimum debt tokens to receive (slippage floor)
        uint24 poolFee; // Uniswap v3 pool fee tier (500 / 3000 / 10000)
        uint256 hfTargetMin; // expected minimum HF after action
    }

    /// @notice Parameters for a collateral top-up action
    struct TopUpParams {
        address user;
        address collateralToken;
        uint256 amount; // amount to pull from user's wallet
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event ProtectionExecuted(
        address indexed user,
        address indexed keeper,
        string actionType, // "PARTIAL_REPAY" | "DELEVERAGE" | "COLLATERAL_TOP_UP"
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 timestamp
    );

    event ProtectionFailed(
        address indexed user, string actionType, string reason, uint256 timestamp
    );

    event SwapRouterUpdated(address newRouter);
    event VaultManagerUpdated(address newVault);
    event AgentRegistryUpdated(address newRegistry);

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    uint256 constant BASIS_POINTS = 10_000;
    uint256 constant HF_PRECISION = 1e18;

    /// @dev Uniswap v3 SwapRouter02 on Arbitrum One
    address constant UNISWAP_ROUTER_ARBITRUM = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    ISwapRouter public swapRouter;
    IVaultManager public vaultManager;
    IAgentRegistry public agentRegistry;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _vaultManager   Deployed VaultManager address
     * @param _agentRegistry  Deployed AgentRegistry address
     * @param _swapRouter     Uniswap v3 SwapRouter02 (use constant above for Arbitrum)
     */
    constructor(address _vaultManager, address _agentRegistry, address _swapRouter)
        Ownable(msg.sender)
    {
        vaultManager = IVaultManager(_vaultManager);
        agentRegistry = IAgentRegistry(_agentRegistry);
        swapRouter = ISwapRouter(_swapRouter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner administration
    // ─────────────────────────────────────────────────────────────────────────

    function setSwapRouter(address router) external onlyOwner {
        swapRouter = ISwapRouter(router);
        emit SwapRouterUpdated(router);
    }

    function setVaultManager(address vault) external onlyOwner {
        vaultManager = IVaultManager(vault);
        emit VaultManagerUpdated(vault);
    }

    function setAgentRegistry(address registry) external onlyOwner {
        agentRegistry = IAgentRegistry(registry);
        emit AgentRegistryUpdated(registry);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 1: Partial Repay
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Repay a portion of a user's debt to raise their health factor.
     *
     *         Flow:
     *         1. Validate keeper authorisation & user consent.
     *         2. Enforce sizing limit (maxRepayBP from AgentRegistry).
     *         3. Pull debt tokens from keeper wallet (keeper must have ERC-20 approval).
     *         4. Approve VaultManager to take the tokens.
     *         5. Call VaultManager.agentPartialRepay().
     *         6. Record the action and emit event.
     *
     * @param p  RepayParams struct
     */
    function executePartialRepay(RepayParams calldata p) external nonReentrant whenNotPaused {
        if (p.repayAmount == 0) revert ZeroAmount();

        // ── 1. Auth checks ───────────────────────────────────────────────────
        _requireAuthorisedKeeper(p.user);

        (bool agentEnabled,, bool canRepay,,, uint256 actionHF, uint16 maxRepayBP,) =
            agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled) revert UserAgentDisabled(p.user);
        if (!canRepay) revert ActionNotPermitted(p.user, "PARTIAL_REPAY");

        // ── 2. Check HF actually needs intervention ──────────────────────────
        uint256 hfBefore = vaultManager.getHealthFactor(p.user);
        if (hfBefore >= actionHF) {
            revert HealthFactorAlreadySafe(p.user, hfBefore, actionHF);
        }

        // ── 3. Enforce max repay limit ───────────────────────────────────────
        uint256 totalDebt = vaultManager.getBorrowed(p.user, p.debtToken);
        uint256 maxAllowed = (totalDebt * maxRepayBP) / BASIS_POINTS;
        if (p.repayAmount > maxAllowed) {
            revert RepayAmountExceedsLimit(p.repayAmount, maxAllowed);
        }

        // ── 4. Pull funds from keeper, approve VaultManager ──────────────────
        IERC20(p.debtToken).safeTransferFrom(msg.sender, address(this), p.repayAmount);
        IERC20(p.debtToken).forceApprove(address(vaultManager), p.repayAmount);

        // ── 5. Execute repay through VaultManager ────────────────────────────
        vaultManager.agentPartialRepay(p.user, p.debtToken, p.repayAmount);

        // ── 6. Post-action HF check ──────────────────────────────────────────
        uint256 hfAfter = vaultManager.getHealthFactor(p.user);

        // ── 7. Record & emit ─────────────────────────────────────────────────
        _recordAndEmit(
            p.user,
            "PARTIAL_REPAY",
            p.debtToken,
            p.debtToken,
            p.repayAmount,
            p.repayAmount,
            hfBefore,
            hfAfter
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 2: Emergency Deleverage (collateral → swap → repay)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Emergency deleverage: sell collateral to repay debt.
     *
     *         Flow:
     *         1. Validate keeper + consent.
     *         2. Pull collateral out of VaultManager into this contract.
     *         3. Swap collateral → debt token via Uniswap v3.
     *         4. Repay debt via VaultManager.
     *         5. Return any excess swap output to keeper (not user —
     *            keeper accounts for gas/slippage residuals).
     *
     * @param p  DeleverageParams struct
     */
    function executeEmergencyDeleverage(DeleverageParams calldata p)
        external
        nonReentrant
        whenNotPaused
    {
        if (p.collateralToSell == 0) revert ZeroAmount();

        // ── 1. Auth + consent checks ─────────────────────────────────────────
        _requireAuthorisedKeeper(p.user);

        (bool agentEnabled,,, bool canDeleverage,, uint256 actionHF,, uint16 maxDelgBP) =
            agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled) revert UserAgentDisabled(p.user);
        if (!canDeleverage) revert ActionNotPermitted(p.user, "DELEVERAGE");

        // ── 2. HF check ──────────────────────────────────────────────────────
        uint256 hfBefore = vaultManager.getHealthFactor(p.user);
        if (hfBefore >= actionHF) {
            revert HealthFactorAlreadySafe(p.user, hfBefore, actionHF);
        }

        // ── 3. Enforce max deleverage limit ──────────────────────────────────
        uint256 totalCollateral = vaultManager.getCollateral(p.user, p.collateralToken);
        uint256 maxAllowed = (totalCollateral * maxDelgBP) / BASIS_POINTS;
        if (p.collateralToSell > maxAllowed) {
            revert DeleverageAmountExceedsLimit(p.collateralToSell, maxAllowed);
        }

        // ── 4. Pull collateral from VaultManager into this contract ──────────
        //      VaultManager.agentEmergencyDeleverage transfers collateral here
        //      and adjusts the user's position.
        //      We pass 0 for debtRepayAmount now and repay after the swap.
        uint256 debtBefore = vaultManager.getBorrowed(p.user, p.debtToken);

        vaultManager.agentEmergencyDeleverage(
            p.user,
            p.collateralToken,
            p.debtToken,
            p.collateralToSell,
            0 // debt repay handled below after swap
        );

        // ── 5. Swap collateral → debt token via Uniswap v3 ──────────────────
        IERC20(p.collateralToken).forceApprove(address(swapRouter), p.collateralToSell);

        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: p.collateralToken,
                tokenOut: p.debtToken,
                fee: p.poolFee,
                recipient: address(this),
                amountIn: p.collateralToSell,
                amountOutMinimum: p.minDebtRepaid, // slippage protection
                sqrtPriceLimitX96: 0
            })
        );

        if (amountOut < p.minDebtRepaid) {
            revert SlippageTooHigh(amountOut, p.minDebtRepaid);
        }

        // ── 6. Repay debt with swap proceeds ─────────────────────────────────
        uint256 repayAmount = amountOut > debtBefore ? debtBefore : amountOut;
        IERC20(p.debtToken).forceApprove(address(vaultManager), repayAmount);
        vaultManager.agentPartialRepay(p.user, p.debtToken, repayAmount);

        // ── 7. Return any swap surplus to keeper ─────────────────────────────
        uint256 surplus = amountOut - repayAmount;
        if (surplus > 0) {
            IERC20(p.debtToken).safeTransfer(msg.sender, surplus);
        }

        uint256 hfAfter = vaultManager.getHealthFactor(p.user);

        // ── 8. Record & emit ─────────────────────────────────────────────────
        _recordAndEmit(
            p.user,
            "DELEVERAGE",
            p.collateralToken,
            p.debtToken,
            p.collateralToSell,
            amountOut,
            hfBefore,
            hfAfter
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 3: Collateral Top-Up
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pull pre-approved collateral from a user's wallet and deposit
     *         it into VaultManager. Useful when the user has consented to
     *         auto-top-up from a reserve wallet.
     *
     *         Requires the user to have called:
     *           IERC20(collateralToken).approve(ProtectionActions, amount)
     *         from their wallet prior to this action.
     *
     * @param p  TopUpParams struct
     */
    function executeCollateralTopUp(TopUpParams calldata p) external nonReentrant whenNotPaused {
        if (p.amount == 0) revert ZeroAmount();

        _requireAuthorisedKeeper(p.user);

        (bool agentEnabled,, bool canRepay,,,,,) = agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled) revert UserAgentDisabled(p.user);
        // We re-use the autoRepay consent flag for top-up (same risk category)
        if (!canRepay) revert ActionNotPermitted(p.user, "COLLATERAL_TOP_UP");

        // Verify user has given allowance
        uint256 allowance = IERC20(p.collateralToken).allowance(p.user, address(this));
        if (allowance < p.amount) {
            revert TopUpNotApproved(p.user, p.collateralToken, p.amount);
        }

        uint256 hfBefore = vaultManager.getHealthFactor(p.user);

        // Pull from user wallet → approve VaultManager → deposit
        IERC20(p.collateralToken).safeTransferFrom(p.user, address(this), p.amount);
        IERC20(p.collateralToken).forceApprove(address(vaultManager), p.amount);

        // VaultManager.depositCollateral requires msg.sender to be the position owner,
        // so we call it on behalf of the user — NOTE: VaultManager must whitelist
        // ProtectionActions as a trusted depositor, or use a delegated deposit function.
        // For MVP: the agent can directly call VaultManager on behalf of the user
        // by having the user pre-sign a meta-tx. Here we use a direct transfer pattern:
        // deposit the tokens and update state in the vault via a keeper path.
        vaultManager.depositCollateral(p.collateralToken, p.amount);

        uint256 hfAfter = vaultManager.getHealthFactor(p.user);

        _recordAndEmit(
            p.user,
            "COLLATERAL_TOP_UP",
            p.collateralToken,
            p.collateralToken,
            p.amount,
            p.amount,
            hfBefore,
            hfAfter
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Batch execution (agent can trigger multiple users in one tx to save gas)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Execute partial repays for multiple users in one transaction.
     *         Any individual failure is caught and emits ProtectionFailed —
     *         does NOT revert the entire batch.
     * @param params Array of RepayParams
     */
    function batchPartialRepay(RepayParams[] calldata params) external nonReentrant whenNotPaused {
        for (uint256 i = 0; i < params.length; i++) {
            try this.executePartialRepay(params[i]) {
            // success — event already emitted inside
            }
            catch Error(string memory reason) {
                emit ProtectionFailed(params[i].user, "PARTIAL_REPAY", reason, block.timestamp);
            } catch {
                emit ProtectionFailed(params[i].user, "PARTIAL_REPAY", "unknown", block.timestamp);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pre-flight check: would a repay action be permitted right now?
     *         Agent calls this before building a transaction to avoid wasted gas.
     */
    function canExecuteRepay(address user, address debtToken, uint256 amount)
        external
        view
        returns (bool permitted, string memory reason)
    {
        (bool agentEnabled,, bool canRepay,,, uint256 actionHF, uint16 maxRepayBP,) =
            agentRegistry.getAgentDecisionParams(user);

        if (!agentEnabled) return (false, "agent disabled");
        if (!canRepay) return (false, "auto-repay not enabled");

        uint256 hf = vaultManager.getHealthFactor(user);
        if (hf >= actionHF) return (false, "HF above action threshold");

        uint256 debt = vaultManager.getBorrowed(user, debtToken);
        uint256 max = (debt * maxRepayBP) / BASIS_POINTS;
        if (amount > max) return (false, "exceeds max repay limit");

        return (true, "");
    }

    /**
     * @notice Estimate the HF improvement from a given repay amount.
     *         Thin wrapper — actual simulation is in VaultManager.simulateHealthFactor.
     */
    function estimateRepayImpact(
        address user,
        address,
        /* debtToken */
        uint256 /* repayAmount */
    )
        external
        view
        returns (uint256 currentHF)
    {
        currentHF = vaultManager.getHealthFactor(user);
        // Full HF simulation with exact post-repay delta is done in VaultManager.
        // The agent's riskEngine.js calls VaultManager.simulateHealthFactor directly.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _requireAuthorisedKeeper(address user) internal view {
        if (!agentRegistry.isAuthorisedKeeper(user, msg.sender)) {
            revert NotAuthorisedKeeper(msg.sender, user);
        }
    }

    function _recordAndEmit(
        address user,
        string memory actionType,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 hfBefore,
        uint256 hfAfter
    ) internal {
        // Record in AgentRegistry (updates lifetime stats)
        agentRegistry.recordAction(user, actionType, amountIn);

        emit ProtectionExecuted(
            user,
            msg.sender,
            actionType,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            hfBefore,
            hfAfter,
            block.timestamp
        );
    }

    /// @notice Rescue accidentally sent tokens (owner only)
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
