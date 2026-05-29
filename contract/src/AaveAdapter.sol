// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  AaveAdapter
 * @author Oyedokun Oluwatominiyi John
 * @notice The bridge between this protocol and Aave v3.
 *
 *         Two responsibilities:
 *         1. READ  — fetch a user's Aave position in one call, returning
 *                    a clean struct the agent and frontend can consume.
 *         2. WRITE — execute protective actions (repay debt, supply extra
 *                    collateral) on behalf of users who have granted consent
 *                    via AgentRegistry.
 *
 *         Why a separate adapter instead of calling Aave directly?
 *         ──────────────────────────────────────────────────────────
 *         • Single upgrade point if Aave changes their interface.
 *         • Lets us add flash-loan deleverage later without touching
 *           ProtectionActions.
 *         • Clean separation: ProtectionActions owns the business logic,
 *           AaveAdapter owns the Aave integration.
 *         • Testable in isolation with a mock Aave pool.
 *
 *         Aave v3 on Arbitrum One
 *         ────────────────────────
 *         Pool:           0x794a61358D6845594F94dc1DB02A252b5b4814aD
 *         PoolDataProvider:0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654
 *         Oracle:         0xb56c2F0B653173f1EB93B11A756EEAe4e26e7E54
 *
 *         Interest rate mode
 *         ──────────────────
 *         1 = stable rate (largely deprecated in v3)
 *         2 = variable rate (what users almost always have)
 */

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAavePool } from "interfaces/IAavePool.sol";
import { IAaveOracle } from "interfaces/IAaveOracle.sol";
import { IAavePoolDataProvider } from "interfaces/IAavePoolDataProvider.sol";

contract AaveAdapter is Ownable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Custom errors
    // ─────────────────────────────────────────────────────────────────────────────

    error OnlyProtectionActions(address caller);
    error ZeroAmount();
    error RepayFailed(address asset, uint256 requested, uint256 actual);
    error InsufficientKeeperBalance(address asset, uint256 required, uint256 available);

    // ─────────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Complete Aave position snapshot for a user
    /// @dev    All USD values use 8 decimals (Aave standard).
    ///         healthFactor uses 18 decimals (Aave standard).
    struct AavePosition {
        address user;
        uint256 totalCollateralUSD; // 8-dec USD
        uint256 totalDebtUSD; // 8-dec USD
        uint256 availableBorrowsUSD; // 8-dec USD
        uint256 currentLiquidationThreshold; // 4-dec, e.g. 8250 = 82.50%
        uint256 ltv; // 4-dec
        uint256 healthFactor; // 18-dec. max uint = no debt
        uint256 netWorthUSD; // collateral - debt, 8-dec
        bool isAtRisk; // true if HF < 1.6 (default warning)
    }

    /// @notice Per-token balance breakdown for the frontend
    struct TokenPosition {
        address token;
        string symbol;
        uint256 collateralAmount; // token units
        uint256 debtAmount; // token units (variable rate)
        uint256 collateralUSD; // 8-dec USD
        uint256 debtUSD; // 8-dec USD
        bool usedAsCollateral;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event RepayExecuted(
        address indexed user,
        address indexed asset,
        uint256 requestedAmount,
        uint256 actualAmount,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );

    event CollateralSupplied(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );

    event AavePoolUpdated(address newPool);
    event DataProviderUpdated(address newProvider);
    event OracleUpdated(address newOracle);
    event ProtectionActionsUpdated(address newProtectionActions);

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    // /// @dev Aave v3 Pool on Arbitrum One
    // address constant AAVE_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    // /// @dev Aave v3 PoolDataProvider on Arbitrum One
    // address constant AAVE_DATA_PROVIDER_ARBITRUM = 0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654;
    // /// @dev Aave v3 Oracle on Arbitrum One
    // address constant AAVE_ORACLE_ARBITRUM = 0xb56c2f0B653173F1eB93B11a756EEae4e26e7E54;

    /// @dev Variable rate mode (what almost all users have)
    uint256 constant VARIABLE_RATE = 2;
    /// @dev Aave HF precision
    uint256 constant HF_PRECISION = 1e18;
    /// @dev Default warning HF (used by isAtRisk flag)
    uint256 constant WARNING_HF = 1.6e18;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    IAavePool public aavePool;
    IAavePoolDataProvider public dataProvider;
    IAaveOracle public aaveOracle;

    /// @notice Only ProtectionActions can call the write functions
    address public protectionActions;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _pool            Aave v3 Pool address
     * @param _dataProvider    Aave v3 PoolDataProvider address
     * @param _oracle          Aave v3 Oracle address
     * @param _protectionActions  ProtectionActions contract 
     */
    constructor(address _pool, address _dataProvider, address _oracle, address _protectionActions)
        Ownable(msg.sender)
    {
        aavePool = IAavePool(_pool);
        dataProvider = IAavePoolDataProvider(_dataProvider);
        aaveOracle = IAaveOracle(_oracle);
        protectionActions = _protectionActions;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Modifier
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyProtectionActions() {
        if (msg.sender != protectionActions) {
            revert OnlyProtectionActions(msg.sender);
        }
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setAavePool(address _pool) external onlyOwner {
        aavePool = IAavePool(_pool);
        emit AavePoolUpdated(_pool);
    }

    function setDataProvider(address _provider) external onlyOwner {
        dataProvider = IAavePoolDataProvider(_provider);
        emit DataProviderUpdated(_provider);
    }

    function setOracle(address _oracle) external onlyOwner {
        aaveOracle = IAaveOracle(_oracle);
        emit OracleUpdated(_oracle);
    }

    function setProtectionActions(address _pa) external onlyOwner {
        protectionActions = _pa;
        emit ProtectionActionsUpdated(_pa);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // READ: Position data
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Get a user's complete Aave position in one call.
     *         This is the primary function the agent scanner calls.
     *
     * @param user  Wallet address to check
     * @return pos  AavePosition struct with all relevant data
     */
    function getUserPosition(address user) external view returns (AavePosition memory pos) {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) = aavePool.getUserAccountData(user);

        uint256 netWorth =
            totalCollateralBase > totalDebtBase ? totalCollateralBase - totalDebtBase : 0;

        pos = AavePosition({
            user: user,
            totalCollateralUSD: totalCollateralBase,
            totalDebtUSD: totalDebtBase,
            availableBorrowsUSD: availableBorrowsBase,
            currentLiquidationThreshold: currentLiquidationThreshold,
            ltv: ltv,
            healthFactor: healthFactor,
            netWorthUSD: netWorth,
            isAtRisk: healthFactor < WARNING_HF && totalDebtBase > 0
        });
    }

    /**
     * @notice Get the health factor for a user directly.
     *         Used by ProtectionActions for pre/post-action checks.
     */
    function getHealthFactor(address user) external view returns (uint256 healthFactor) {
        (,,,,, healthFactor) = aavePool.getUserAccountData(user);
    }

    /**
     * @notice Get the variable debt balance for a specific asset.
     *         Used by ProtectionActions to calculate repay amounts.
     */
    function getUserDebt(address user, address asset)
        external
        view
        returns (uint256 variableDebt, uint256 stableDebt)
    {
        (, uint256 stable, uint256 variable,,,,,,) = dataProvider.getUserReserveData(asset, user);
        return (variable, stable);
    }

    /**
     * @notice Get the collateral (aToken) balance for a specific asset.
     */
    function getUserCollateral(address user, address asset)
        external
        view
        returns (uint256 aTokenBalance, bool usedAsCollateral)
    {
        (uint256 bal,,,,,,,, bool asCollateral) = dataProvider.getUserReserveData(asset, user);
        return (bal, asCollateral);
    }

    /**
     * @notice Get the USD price of an asset from Aave's oracle.
     *         Returns 8-decimal USD price (same as Chainlink).
     */
    function getAssetPrice(address asset) external view returns (uint256) {
        return aaveOracle.getAssetPrice(asset);
    }

    /**
     * @notice Batch fetch prices for multiple assets.
     */
    function getAssetPrices(address[] calldata assets) external view returns (uint256[] memory) {
        return aaveOracle.getAssetsPrices(assets);
    }

    /**
     * @notice Simulate the health factor after repaying a specific amount of debt.
     *         Used by the frontend What-If slider and the agent decision engine.
     *
     * @param user         Position owner
     * @param repayUSD     Amount to repay in USD (8 decimals)
     * @return simHF       Projected health factor after repay (18 decimals)
     */
    function simulateHFAfterRepay(address user, uint256 repayUSD)
        external
        view
        returns (uint256 simHF)
    {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,,
            uint256 currentLiquidationThreshold,,
        ) = aavePool.getUserAccountData(user);

        if (totalDebtBase <= repayUSD) return type(uint256).max; // no debt left

        uint256 newDebt = totalDebtBase - repayUSD;
        // Adjusted collateral = collateral * liquidationThreshold / 10000
        uint256 adjCollateral = (totalCollateralBase * currentLiquidationThreshold) / 10_000;

        simHF = (adjCollateral * HF_PRECISION) / newDebt;
    }

    /**
     * @notice Simulate the health factor after adding collateral.
     *
     * @param user           Position owner
     * @param addCollateralUSD  Extra collateral in USD (8 decimals)
     * @return simHF         Projected health factor (18 decimals)
     */
    function simulateHFAfterSupply(address user, uint256 addCollateralUSD)
        external
        view
        returns (uint256 simHF)
    {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,,
            uint256 currentLiquidationThreshold,,
        ) = aavePool.getUserAccountData(user);

        if (totalDebtBase == 0) return type(uint256).max;

        uint256 newCollateral = totalCollateralBase + addCollateralUSD;
        uint256 adjCollateral = (newCollateral * currentLiquidationThreshold) / 10_000;

        simHF = (adjCollateral * HF_PRECISION) / totalDebtBase;
    }

    /**
     * @notice Simulate HF after a price shock to a specific asset.
     *         The agent's riskEngine calls this for scenario analysis.
     *
     * @param user          Position owner
     * @param asset         Asset whose price is being shocked
     * @param priceChangeBP Price change in basis points (negative = drop)
     * @return simHF        Projected health factor (18 decimals)
     */
    function simulateHFAfterPriceShock(address user, address asset, int256 priceChangeBP)
        external
        view
        returns (uint256 simHF)
    {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,,
            uint256 currentLiquidationThreshold,,
        ) = aavePool.getUserAccountData(user);

        if (totalDebtBase == 0) return type(uint256).max;

        // Get current asset price and user's balance of this asset
        uint256 currentPrice = aaveOracle.getAssetPrice(asset);
        (uint256 aTokenBal,,,,,,,,) = dataProvider.getUserReserveData(asset, user);

        // Current USD value of this asset as collateral
        // Note: aToken balance has the same decimals as the underlying
        // We use 8-dec prices and need to normalise
        // Simplified: use proportional impact on total collateral
        uint256 assetUSD = (aTokenBal * currentPrice) / 1e18; // rough — exact in agent
        uint256 otherUSD = totalCollateralBase > assetUSD ? totalCollateralBase - assetUSD : 0;

        // Apply price shock
        int256 shockedAssetUSD = int256(assetUSD) + (int256(assetUSD) * priceChangeBP) / 10_000;
        uint256 newAssetUSD = shockedAssetUSD > 0 ? uint256(shockedAssetUSD) : 0;
        uint256 newCollateral = otherUSD + newAssetUSD;

        uint256 adjCollateral = (newCollateral * currentLiquidationThreshold) / 10_000;
        simHF = (adjCollateral * HF_PRECISION) / totalDebtBase;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Protection actions (only callable by ProtectionActions contract)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Repay a user's Aave variable-rate debt on their behalf.
     *         The caller (ProtectionActions) must have already transferred
     *         the repay tokens to this contract before calling.
     *
     * @param user    Position owner whose debt to repay
     * @param asset   The debt asset (e.g. USDC)
     * @param amount  Amount to repay in token units
     * @return actualRepaid  How much was actually repaid (may differ if capped at full debt)
     */
    function repayDebt(address user, address asset, uint256 amount)
        external
        onlyProtectionActions
        returns (uint256 actualRepaid)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 hfBefore = _getHF(user);

        // Approve Aave pool to pull the tokens from this contract
        IERC20(asset).forceApprove(address(aavePool), amount);

        // repay() returns the actual amount repaid (capped at full debt)
        actualRepaid = aavePool.repay(asset, amount, VARIABLE_RATE, user);

        uint256 hfAfter = _getHF(user);

        emit RepayExecuted(user, asset, amount, actualRepaid, hfBefore, hfAfter);
    }

    /**
     * @notice Supply extra collateral to a user's Aave position.
     *         The caller (ProtectionActions) must have already transferred
     *         the supply tokens to this contract before calling.
     *
     * @param user    Position owner to supply collateral for
     * @param asset   Collateral token (e.g. WETH)
     * @param amount  Amount to supply
     */
    function supplyCollateral(address user, address asset, uint256 amount)
        external
        onlyProtectionActions
    {
        if (amount == 0) revert ZeroAmount();

        uint256 hfBefore = _getHF(user);

        // Approve Aave pool to pull tokens from this contract
        IERC20(asset).forceApprove(address(aavePool), amount);

        // Supply on behalf of user — they receive the aTokens
        aavePool.supply(asset, amount, user, 0);

        uint256 hfAfter = _getHF(user);

        emit CollateralSupplied(user, asset, amount, hfBefore, hfAfter);
    }

    /**
     * @notice Rescue tokens accidentally sent to this contract.
     */
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _getHF(address user) internal view returns (uint256 hf) {
        (,,,,, hf) = aavePool.getUserAccountData(user);
    }
}
