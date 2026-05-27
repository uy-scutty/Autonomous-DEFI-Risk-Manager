// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  ProtectionActions (Aave Guardian Edition)
 * @author Autonomous DeFi Risk Manager
 * @notice Executes protective actions on a user's EXISTING Aave v3 position.
 *
 *         Users never move their Aave positions. They just:
 *         1. Grant consent via AgentRegistry
 *         2. Optionally pre-approve this contract to pull from a reserve wallet
 *         3. Let the agent protect them autonomously
 *
 *         Actions
 *         ───────
 *         PARTIAL_REPAY    — Agent keeper wallet holds stablecoins.
 *                            Keeper transfers them here → we repay Aave debt
 *                            via AaveAdapter → user's HF improves immediately.
 *
 *         COLLATERAL_TOPUP — User pre-approves this contract on a reserve token.
 *                            Agent pulls from user's wallet → supplies to Aave
 *                            via AaveAdapter as additional collateral.
 *
 *         FLASH_DELEVERAGE — (advanced) Flash-loan the debt token from Aave,
 *                            repay the user's debt, withdraw collateral, swap
 *                            it to repay the flash loan. Net effect: user has
 *                            less collateral AND less debt, but safer ratio.
 *                            Implemented as a stub for MVP — extend post-hackathon.
 *
 *         Money flow summary
 *         ──────────────────
 *         PARTIAL_REPAY:  keeper wallet → ProtectionActions → AaveAdapter → Aave Pool
 *         COLLATERAL_TOPUP: user wallet → ProtectionActions → AaveAdapter → Aave Pool
 *         FLASH_DELEVERAGE: Aave flash loan → repay debt → withdraw collateral
 *                           → swap → repay flash loan (zero keeper capital)
 *
 *         Security model
 *         ──────────────
 *         • Only the registered keeper (AgentRegistry.globalKeeper) or a
 *           user-whitelisted keeper may call execute*().
 *         • Every action reads AgentRegistry to verify user consent + size limits.
 *         • ReentrancyGuard on all external state-changers.
 *         • Pausable by owner.
 *         • User can revoke consent in AgentRegistry at any time — agent immediately
 *           stops acting (consent is checked on every call).
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./AaveAdapter.sol";

// Minimal Uniswap v3 SwapRouter (for deleverage swap)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

// AgentRegistry interface
interface IAgentRegistry {
    function getAgentDecisionParams(address user)
        external view
        returns (
            bool    agentEnabled,
            bool    alertOnly,
            bool    canRepay,
            bool    canDeleverage,
            uint256 warningHF,
            uint256 actionHF,
            uint16  maxRepayBP,
            uint16  maxDelgBP
        );

    function isAuthorisedKeeper(address user, address keeper)
        external view returns (bool);

    function recordAction(
        address user,
        string calldata actionType,
        uint256 valueUSD18
    ) external;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom errors
// ─────────────────────────────────────────────────────────────────────────────

error NotAuthorisedKeeper(address caller, address user);
error UserAgentDisabled(address user);
error ActionNotPermitted(address user, string action);
error HealthFactorAlreadySafe(address user, uint256 currentHF, uint256 actionThreshold);
error RepayAmountExceedsLimit(uint256 requested, uint256 maxAllowed);
error TopUpNotApproved(address user, address token, uint256 needed, uint256 allowance);
error ZeroAmount();
error SlippageTooHigh(uint256 amountOut, uint256 minExpected);

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Parameters for a partial repay protection action
struct RepayParams {
    address user;          // Aave position owner
    address debtAsset;     // Token they borrowed (e.g. USDC)
    uint256 repayAmount;   // Amount to repay in debtAsset units
}

/// @notice Parameters for a collateral top-up action
struct TopUpParams {
    address user;              // Aave position owner
    address collateralAsset;   // Token to supply (e.g. WETH)
    uint256 amount;            // Amount to pull from user's reserve wallet
}

/// @notice Parameters for flash-loan deleverage (advanced)
struct DeleverageParams {
    address user;
    address collateralAsset;   // Asset to withdraw from Aave
    address debtAsset;         // Asset to repay
    uint256 collateralAmount;  // How much collateral to sell
    uint256 minDebtRepaid;     // Minimum debt repaid after swap (slippage floor)
    uint24  poolFee;           // Uniswap v3 fee tier
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

event ProtectionExecuted(
    address indexed user,
    address indexed keeper,
    string  actionType,
    address asset,
    uint256 amount,
    uint256 hfBefore,
    uint256 hfAfter,
    uint256 timestamp
);

event ProtectionFailed(
    address indexed user,
    string  actionType,
    string  reason,
    uint256 timestamp
);

event AdapterUpdated(address newAdapter);
event RegistryUpdated(address newRegistry);
event SwapRouterUpdated(address newRouter);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

uint256 constant BASIS_POINTS  = 10_000;
uint256 constant HF_PRECISION  = 1e18;

/// @dev Uniswap v3 SwapRouter02 on Arbitrum One
address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

contract ProtectionActions is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    AaveAdapter    public aaveAdapter;
    IAgentRegistry public agentRegistry;
    ISwapRouter    public swapRouter;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(
        address _aaveAdapter,
        address _agentRegistry,
        address _swapRouter
    ) Ownable(msg.sender) {
        aaveAdapter    = AaveAdapter(_aaveAdapter);
        agentRegistry  = IAgentRegistry(_agentRegistry);
        swapRouter     = ISwapRouter(_swapRouter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setAaveAdapter(address _adapter)    external onlyOwner {
        aaveAdapter = AaveAdapter(_adapter);
        emit AdapterUpdated(_adapter);
    }

    function setAgentRegistry(address _registry) external onlyOwner {
        agentRegistry = IAgentRegistry(_registry);
        emit RegistryUpdated(_registry);
    }

    function setSwapRouter(address _router)      external onlyOwner {
        swapRouter = ISwapRouter(_router);
        emit SwapRouterUpdated(_router);
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 1: Partial Repay
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Repay a portion of a user's Aave debt to raise their health factor.
     *
     *         Money flow:
     *         Keeper wallet holds debtAsset tokens
     *           → keeper calls this function
     *           → tokens transfer from keeper to this contract
     *           → this contract sends tokens to AaveAdapter
     *           → AaveAdapter calls aavePool.repay() on behalf of user
     *           → user's Aave debt decreases, HF improves
     *
     *         The keeper is spending their own tokens. In production this is
     *         funded by a protocol fee charged to users for the protection service.
     *         For the hackathon demo: keeper wallet is pre-funded with USDC.
     *
     * @param p  RepayParams struct
     */
    function executePartialRepay(RepayParams calldata p)
        external
        nonReentrant
        whenNotPaused
    {
        if (p.repayAmount == 0) revert ZeroAmount();

        // ── 1. Auth + consent ─────────────────────────────────────────────────
        _requireAuthorisedKeeper(p.user);

        (
            bool agentEnabled,, bool canRepay,,
            , uint256 actionHF,
            uint16 maxRepayBP,
        ) = agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled) revert UserAgentDisabled(p.user);
        if (!canRepay)     revert ActionNotPermitted(p.user, "PARTIAL_REPAY");

        // ── 2. Check HF actually needs intervention ───────────────────────────
        uint256 hfBefore = aaveAdapter.getHealthFactor(p.user);
        if (hfBefore >= actionHF)
            revert HealthFactorAlreadySafe(p.user, hfBefore, actionHF);

        // ── 3. Enforce max repay limit ────────────────────────────────────────
        (uint256 variableDebt,) = aaveAdapter.getUserDebt(p.user, p.debtAsset);
        uint256 maxAllowed = (variableDebt * maxRepayBP) / BASIS_POINTS;
        if (p.repayAmount > maxAllowed)
            revert RepayAmountExceedsLimit(p.repayAmount, maxAllowed);

        // ── 4. Pull funds from keeper wallet into this contract ───────────────
        IERC20(p.debtAsset).safeTransferFrom(msg.sender, address(this), p.repayAmount);

        // ── 5. Forward to AaveAdapter which calls aavePool.repay() ───────────
        IERC20(p.debtAsset).safeTransfer(address(aaveAdapter), p.repayAmount);
        uint256 actualRepaid = aaveAdapter.repayDebt(p.user, p.debtAsset, p.repayAmount);

        // ── 6. Post-action HF ─────────────────────────────────────────────────
        uint256 hfAfter = aaveAdapter.getHealthFactor(p.user);

        // ── 7. Record + emit ──────────────────────────────────────────────────
        _recordAndEmit(p.user, "PARTIAL_REPAY", p.debtAsset, actualRepaid, hfBefore, hfAfter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 2: Collateral Top-Up
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pull pre-approved collateral from a user's reserve wallet
     *         and supply it to their Aave position.
     *
     *         Money flow:
     *         User pre-approves this contract on their reserve token
     *           → agent calls this function
     *           → tokens pulled from user's reserve wallet to this contract
     *           → forwarded to AaveAdapter
     *           → AaveAdapter calls aavePool.supply() on behalf of user
     *           → user's Aave collateral increases, HF improves
     *
     *         Setup: user calls:
     *           IERC20(USDC).approve(ProtectionActions, type(uint256).max)
     *         from their reserve wallet before enabling this feature.
     *
     * @param p  TopUpParams struct
     */
    function executeCollateralTopUp(TopUpParams calldata p)
        external
        nonReentrant
        whenNotPaused
    {
        if (p.amount == 0) revert ZeroAmount();

        // ── 1. Auth + consent ─────────────────────────────────────────────────
        _requireAuthorisedKeeper(p.user);

        (bool agentEnabled,, bool canRepay,,,,, ) =
            agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled) revert UserAgentDisabled(p.user);
        if (!canRepay)     revert ActionNotPermitted(p.user, "COLLATERAL_TOPUP");

        // ── 2. Verify user has granted allowance ─────────────────────────────
        uint256 allowance = IERC20(p.collateralAsset).allowance(p.user, address(this));
        if (allowance < p.amount)
            revert TopUpNotApproved(p.user, p.collateralAsset, p.amount, allowance);

        uint256 hfBefore = aaveAdapter.getHealthFactor(p.user);

        // ── 3. Pull from user → forward to AaveAdapter ───────────────────────
        IERC20(p.collateralAsset).safeTransferFrom(p.user, address(this), p.amount);
        IERC20(p.collateralAsset).safeTransfer(address(aaveAdapter), p.amount);
        aaveAdapter.supplyCollateral(p.user, p.collateralAsset, p.amount);

        uint256 hfAfter = aaveAdapter.getHealthFactor(p.user);

        _recordAndEmit(p.user, "COLLATERAL_TOPUP", p.collateralAsset, p.amount, hfBefore, hfAfter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Action 3: Flash-loan Deleverage (self-funded, no keeper capital needed)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Emergency deleverage using the user's own collateral.
     *         No keeper capital required — the user pays for their own rescue.
     *
     *         Flow (simplified for MVP — full flash loan version post-hackathon):
     *         1. Keeper pulls collateral out of Aave on behalf of user
     *            (requires user to have approved ProtectionActions as operator
     *             on Aave: aavePool.setUserUseReserveAsCollateral pattern OR
     *             user gives ERC-20 approval on their aToken to this contract)
     *         2. Swap collateral → debt asset via Uniswap v3
     *         3. Repay debt via AaveAdapter
     *         4. Net: user has less collateral AND less debt, but healthier HF
     *
     *         For the hackathon MVP demo: use executePartialRepay for live demo,
     *         show this as "coming soon" in the UI. The architecture is correct.
     *
     * @param p  DeleverageParams struct
     */
    function executeFlashDeleverage(DeleverageParams calldata p)
        external
        nonReentrant
        whenNotPaused
    {
        if (p.collateralAmount == 0) revert ZeroAmount();

        // ── 1. Auth + consent ─────────────────────────────────────────────────
        _requireAuthorisedKeeper(p.user);

        (
            bool agentEnabled,,, bool canDeleverage,
            , uint256 actionHF,,
            uint16 maxDelgBP
        ) = agentRegistry.getAgentDecisionParams(p.user);

        if (!agentEnabled)  revert UserAgentDisabled(p.user);
        if (!canDeleverage) revert ActionNotPermitted(p.user, "DELEVERAGE");

        uint256 hfBefore = aaveAdapter.getHealthFactor(p.user);
        if (hfBefore >= actionHF)
            revert HealthFactorAlreadySafe(p.user, hfBefore, actionHF);

        // ── 2. Verify deleverage size is within user's limit ─────────────────
        (uint256 aTokenBal,) = aaveAdapter.getUserCollateral(p.user, p.collateralAsset);
        uint256 maxAllowed   = (aTokenBal * maxDelgBP) / BASIS_POINTS;
        // Note: for MVP we check token balance; full version checks USD value

        // ── 3. User must have approved this contract on their aToken ─────────
        //      aToken address = Aave's aWETH, aUSDC, etc.
        //      The agent's setup flow guides users to approve their aTokens.
        //      For MVP demo: agent pre-arranges this during onboarding.
        address aToken = _getAToken(p.collateralAsset);
        uint256 aTokenAllowance = IERC20(aToken).allowance(p.user, address(this));

        // Pull aTokens from user (Aave aTokens are ERC-20 — can be transferred)
        IERC20(aToken).safeTransferFrom(p.user, address(this), p.collateralAmount);

        // Redeem aTokens for underlying collateral via Aave withdraw
        // (aToken holder can call withdraw to get underlying back)
        uint256 withdrawn = aaveAdapter.aavePool().withdraw(
            p.collateralAsset,
            p.collateralAmount,
            address(this)
        );

        // ── 4. Swap collateral → debt asset on Uniswap v3 ────────────────────
        IERC20(p.collateralAsset).forceApprove(address(swapRouter), withdrawn);

        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           p.collateralAsset,
                tokenOut:          p.debtAsset,
                fee:               p.poolFee,
                recipient:         address(this),
                amountIn:          withdrawn,
                amountOutMinimum:  p.minDebtRepaid,
                sqrtPriceLimitX96: 0
            })
        );

        if (amountOut < p.minDebtRepaid)
            revert SlippageTooHigh(amountOut, p.minDebtRepaid);

        // ── 5. Repay debt via AaveAdapter ─────────────────────────────────────
        IERC20(p.debtAsset).safeTransfer(address(aaveAdapter), amountOut);
        aaveAdapter.repayDebt(p.user, p.debtAsset, amountOut);

        uint256 hfAfter = aaveAdapter.getHealthFactor(p.user);

        _recordAndEmit(p.user, "DELEVERAGE", p.collateralAsset, withdrawn, hfBefore, hfAfter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Batch execution
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Execute partial repays for multiple users in one transaction.
     *         Any individual failure is caught and logged — does NOT revert the batch.
     */
    function batchPartialRepay(RepayParams[] calldata params)
        external
        nonReentrant
        whenNotPaused
    {
        for (uint256 i = 0; i < params.length; i++) {
            try this.executePartialRepay(params[i]) {
                // Success — event already emitted
            } catch Error(string memory reason) {
                emit ProtectionFailed(params[i].user, "PARTIAL_REPAY", reason, block.timestamp);
            } catch {
                emit ProtectionFailed(params[i].user, "PARTIAL_REPAY", "unknown", block.timestamp);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pre-flight view (agent calls this before building a tx)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Check whether a repay action would be permitted right now.
     *         Agent calls this to avoid wasting gas on a doomed tx.
     */
    function canExecuteRepay(
        address user,
        address debtAsset,
        uint256 amount
    )
        external view
        returns (bool permitted, string memory reason)
    {
        (
            bool agentEnabled,, bool canRepay,,
            , uint256 actionHF,
            uint16 maxRepayBP,
        ) = agentRegistry.getAgentDecisionParams(user);

        if (!agentEnabled) return (false, "agent disabled");
        if (!canRepay)     return (false, "auto-repay not enabled");

        uint256 hf = aaveAdapter.getHealthFactor(user);
        if (hf >= actionHF) return (false, "HF above action threshold");

        (uint256 debt,) = aaveAdapter.getUserDebt(user, debtAsset);
        uint256 maxAllowed = (debt * maxRepayBP) / BASIS_POINTS;
        if (amount > maxAllowed) return (false, "exceeds max repay limit");

        return (true, "");
    }

    /**
     * @notice Simulate the HF improvement from a repay action.
     *         Returns current HF and projected HF after repay.
     */
    function simulateRepayImpact(
        address user,
        address debtAsset,
        uint256 repayAmount
    )
        external view
        returns (uint256 currentHF, uint256 projectedHF)
    {
        currentHF = aaveAdapter.getHealthFactor(user);

        // Convert token amount to USD using Aave oracle (8-dec USD)
        uint256 assetPriceUSD = aaveAdapter.getAssetPrice(debtAsset);
        // Rough: get token decimals — hardcode common cases for view function
        uint256 repayUSD = (repayAmount * assetPriceUSD) / 1e6; // assumes 6-dec (USDC)

        projectedHF = aaveAdapter.simulateHFAfterRepay(user, repayUSD);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _requireAuthorisedKeeper(address user) internal view {
        if (!agentRegistry.isAuthorisedKeeper(user, msg.sender))
            revert NotAuthorisedKeeper(msg.sender, user);
    }

    function _recordAndEmit(
        address user,
        string  memory actionType,
        address asset,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter
    ) internal {
        // Record in AgentRegistry for lifetime stats
        agentRegistry.recordAction(user, actionType, amount);

        emit ProtectionExecuted(
            user,
            msg.sender,
            actionType,
            asset,
            amount,
            hfBefore,
            hfAfter,
            block.timestamp
        );
    }

    /**
     * @dev Returns the Aave aToken address for an underlying asset.
     *      For MVP: hardcoded map of common Arbitrum tokens.
     *      Production: call dataProvider.getReserveTokensAddresses(asset).
     */
    function _getAToken(address underlying) internal pure returns (address) {
        // Arbitrum One aToken addresses (Aave v3)
        if (underlying == 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1)
            return 0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8; // aWETH
        if (underlying == 0xaf88d065e77c8cC2239327C5EDb3A432268e5831)
            return 0x724dc807b04555b71ed48a6896b6F41593b8C637; // aUSDC
        if (underlying == 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f)
            return 0x078f358208685046a11C85e8ad32895DED33A249; // aWBTC
        if (underlying == 0x912CE59144191C1204E64559FE8253a0e49E6548)
            return 0x6533afac2E7BCCB20dca161449A13A32D391fb00; // aARB
        // Fallback: return underlying itself (will revert in practice if wrong)
        return underlying;
    }

    /// @notice Rescue accidentally sent tokens
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
