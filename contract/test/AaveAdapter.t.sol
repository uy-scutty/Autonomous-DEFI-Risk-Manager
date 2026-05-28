// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { AaveAdapter } from "src/AaveAdapter.sol";
import {
    MockAavePool,
    MockAaveOracle,
    MockAaveDataProvider,
    MockERC20
} from "test/helpers/MockContracts.sol";
import { TestHelpers } from "test/helpers/TestHelpers.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AaveAdapterTest is TestHelpers {
    AaveAdapter public adapter;
    MockAavePool public mockPool;
    MockAaveOracle public mockOracle;
    MockAaveDataProvider public mockDataProvider;

    // Add these declarations
    MockERC20 public mockWETH;
    MockERC20 public mockUSDC;

    address public protectionActions;

    function setUp() public {
        mockPool = new MockAavePool();
        mockOracle = new MockAaveOracle();
        mockDataProvider = new MockAaveDataProvider();
        protectionActions = makeAddr("protectionActions");

        // Initialize the mock tokens
        mockWETH = new MockERC20("WETH", "WETH", 18);
        mockUSDC = new MockERC20("USDC", "USDC", 6);

        vm.prank(PROTOCOL_OWNER);
        adapter = new AaveAdapter(
            address(mockPool), address(mockDataProvider), address(mockOracle), protectionActions
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor and Initialization Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor() public view {
        assertEq(address(adapter.aavePool()), address(mockPool));
        assertEq(address(adapter.dataProvider()), address(mockDataProvider));
        assertEq(address(adapter.aaveOracle()), address(mockOracle));
        assertEq(adapter.protectionActions(), protectionActions);
        assertEq(adapter.owner(), PROTOCOL_OWNER);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin Functions Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetAavePool() public {
        address newPool = makeAddr("newPool");

        vm.prank(PROTOCOL_OWNER);
        adapter.setAavePool(newPool);

        assertEq(address(adapter.aavePool()), newPool);
    }

    function test_RevertWhen_NonOwnerSetsAavePool() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", USER));
        adapter.setAavePool(makeAddr("newPool"));
    }

    function test_SetDataProvider() public {
        address newProvider = makeAddr("newProvider");

        vm.prank(PROTOCOL_OWNER);
        adapter.setDataProvider(newProvider);

        assertEq(address(adapter.dataProvider()), newProvider);
    }

    function test_SetOracle() public {
        address newOracle = makeAddr("newOracle");

        vm.prank(PROTOCOL_OWNER);
        adapter.setOracle(newOracle);

        assertEq(address(adapter.aaveOracle()), newOracle);
    }

    function test_SetProtectionActions() public {
        address newPA = makeAddr("newPA");

        vm.prank(PROTOCOL_OWNER);
        adapter.setProtectionActions(newPA);

        assertEq(adapter.protectionActions(), newPA);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Read Functions Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetUserPosition() public {
        // Setup mock data
        uint256 collateral = 10000e8; // $10,000
        uint256 debt = 5000e8; // $5,000
        uint256 healthFactor = 1.8e18;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 7000, healthFactor)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);

        assertEq(pos.user, USER);
        assertEq(pos.totalCollateralUSD, collateral);
        assertEq(pos.totalDebtUSD, debt);
        assertEq(pos.healthFactor, healthFactor);
        assertEq(pos.netWorthUSD, collateral - debt);
        assertEq(pos.isAtRisk, healthFactor < 1.6e18 && debt > 0);
    }

    function test_GetUserPosition_WhenNoDebt() public {
        uint256 collateral = 10000e8;
        uint256 debt = 0;
        uint256 healthFactor = type(uint256).max;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 7000, healthFactor)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);

        assertEq(pos.isAtRisk, false);
        assertEq(pos.netWorthUSD, collateral);
    }

    function test_GetHealthFactor() public {
        uint256 healthFactor = 1.5e18;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(0, 0, 0, 0, 0, healthFactor)
        );

        uint256 hf = adapter.getHealthFactor(USER);
        assertEq(hf, healthFactor);
    }

    function test_GetUserDebt() public {
        uint256 variableDebt = 5000e6;
        uint256 stableDebt = 0;

        mockDataProvider.setUserReserve(USDC, USER, 0, variableDebt, true);

        (uint256 variable, uint256 stable) = adapter.getUserDebt(USER, USDC);
        assertEq(variable, variableDebt);
        assertEq(stable, stableDebt);
    }

    function test_GetUserCollateral() public {
        uint256 aTokenBalance = 1e18;
        bool usedAsCollateral = true;

        // Use the setter instead of vm.mockCall
        mockDataProvider.setUserReserve(USDC, USER, aTokenBalance, 0, usedAsCollateral);

        (uint256 balance, bool asCollateral) = adapter.getUserCollateral(USER, USDC);

        assertEq(balance, aTokenBalance);
        assertEq(asCollateral, usedAsCollateral);
    }

    function test_GetAssetPrice() public view {
        uint256 price = adapter.getAssetPrice(WETH);
        assertEq(price, 2000e8);
    }

    function test_GetAssetPrices() public view {
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDC;

        uint256[] memory prices = adapter.getAssetPrices(assets);

        assertEq(prices.length, 2);
        assertEq(prices[0], 2000e8);
        assertEq(prices[1], 1e8);
    }

    function test_SimulateHFAfterRepay() public {
        uint256 collateral = 10000e8;
        uint256 debt = 5000e8;
        uint256 liquidationThreshold = 8000;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, liquidationThreshold, 0, 0)
        );

        uint256 repayUSD = 2000e8;
        uint256 simHF = adapter.simulateHFAfterRepay(USER, repayUSD);

        uint256 expectedAdjCollateral = (collateral * liquidationThreshold) / 10000;
        uint256 newDebt = debt - repayUSD;
        uint256 expectedHF = (expectedAdjCollateral * HF_PRECISION) / newDebt;

        assertEq(simHF, expectedHF);
    }

    function test_SimulateHFAfterRepay_WhenFullRepayment() public {
        uint256 collateral = 10000e8;
        uint256 debt = 5000e8;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 0, 0)
        );

        uint256 repayUSD = 6000e8; // More than total debt
        uint256 simHF = adapter.simulateHFAfterRepay(USER, repayUSD);

        assertEq(simHF, type(uint256).max);
    }

    function test_SimulateHFAfterSupply() public {
        uint256 collateral = 10000e8;
        uint256 debt = 5000e8;
        uint256 liquidationThreshold = 8000;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, liquidationThreshold, 0, 0)
        );

        uint256 addCollateral = 2000e8;
        uint256 simHF = adapter.simulateHFAfterSupply(USER, addCollateral);

        uint256 newCollateral = collateral + addCollateral;
        uint256 expectedAdjCollateral = (newCollateral * liquidationThreshold) / 10000;
        uint256 expectedHF = (expectedAdjCollateral * HF_PRECISION) / debt;

        assertEq(simHF, expectedHF);
    }

    function test_SimulateHFAfterSupply_WhenNoDebt() public {
        uint256 collateral = 10000e8;
        uint256 debt = 0;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 0, 0)
        );

        uint256 simHF = adapter.simulateHFAfterSupply(USER, 1000e8);
        assertEq(simHF, type(uint256).max);
    }

    function test_SimulateHFAfterPriceShock() public {
        uint256 collateral = 10000e8;
        uint256 debt = 5000e8;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 0, 0)
        );

        mockDataProvider.setUserReserve(WETH, USER, 1e18, 0, true);

        int256 priceChangeBP = -1000; // 10% drop
        uint256 simHF = adapter.simulateHFAfterPriceShock(USER, WETH, priceChangeBP);

        assertHealthFactorValid(simHF);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write Functions Tests (Only ProtectionActions)
    // ─────────────────────────────────────────────────────────────────────────

    function test_RepayDebt() public {
        uint256 repayAmount = 1000e6;
        uint256 hfBefore = 1.3e18;
        // uint256 debtBefore = 5000e6;
        // uint256 hfAfter = 1.8e18;

        // Setup mocks
        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(0, 0, 0, 0, 0, hfBefore)
        );

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.repay.selector, USDC, repayAmount, 2, USER),
            abi.encode(repayAmount)
        );

        // Mock ERC20 approval
        vm.mockCall(
            USDC,
            abi.encodeWithSelector(IERC20.approve.selector, address(mockPool), repayAmount),
            abi.encode(true)
        );

        // Call as ProtectionActions
        vm.prank(protectionActions);
        uint256 actualRepaid = adapter.repayDebt(USER, USDC, repayAmount);

        assertEq(actualRepaid, repayAmount);
    }

    function test_RevertWhen_NonProtectionActionsCallsRepay() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSignature("OnlyProtectionActions(address)", USER));
        adapter.repayDebt(USER, USDC, 1000e6);
    }

    function test_RevertWhen_RepayAmountZero() public {
        vm.prank(protectionActions);
        vm.expectRevert(AaveAdapter.ZeroAmount.selector);
        adapter.repayDebt(USER, USDC, 0);
    }

    function test_SupplyCollateral() public {
        uint256 supplyAmount = 1e18;
        uint256 hfBefore = 1.3e18;
        uint256 hfAfter = 1.8e18;

        // Mock health factor calls (called twice: before and after)
        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(10000e8, 5000e8, 0, 8000, 7000, hfBefore)
        );

        // Mock the second health factor call (after supply)
        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(10000e8, 5000e8, 0, 8000, 7000, hfAfter)
        );

        // Mock token approval (forceApprove)
        vm.mockCall(
            address(mockWETH),
            abi.encodeWithSelector(IERC20.approve.selector, address(mockPool), supplyAmount),
            abi.encode(true)
        );

        // Mock the supply call
        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(
                mockPool.supply.selector, address(mockWETH), supplyAmount, USER, 0
            ),
            abi.encode()
        );

        // Mock token transfer from adapter to pool (this happens inside supplyCollateral)
        vm.mockCall(
            address(mockWETH),
            abi.encodeWithSelector(IERC20.transfer.selector, address(mockPool), supplyAmount),
            abi.encode(true)
        );

        // Also mock balanceOf for SafeERC20
        vm.mockCall(
            address(mockWETH),
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(adapter)),
            abi.encode(supplyAmount)
        );

        vm.prank(protectionActions);
        adapter.supplyCollateral(USER, address(mockWETH), supplyAmount);

        // Success if we get here
    }

    function test_RevertWhen_SupplyAmountZero() public {
        vm.prank(protectionActions);
        vm.expectRevert(AaveAdapter.ZeroAmount.selector);
        adapter.supplyCollateral(USER, WETH, 0);
    }

    function test_RescueTokens() public {
        uint256 rescueAmount = 1000e6;

        // Mock the token balance
        vm.mockCall(
            address(mockUSDC),
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(adapter)),
            abi.encode(rescueAmount)
        );

        // Mock the transfer call
        vm.mockCall(
            address(mockUSDC),
            abi.encodeWithSelector(IERC20.transfer.selector, PROTOCOL_OWNER, rescueAmount),
            abi.encode(true)
        );

        vm.prank(PROTOCOL_OWNER);
        adapter.rescueTokens(address(mockUSDC), rescueAmount);

        // Test non-owner cannot call
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", USER));
        adapter.rescueTokens(address(mockUSDC), rescueAmount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edge Cases and Boundary Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_HealthFactorAtRiskBoundary() public {
        uint256 collateral = 10000e8;
        uint256 debt = 6250e8; // HF = 1.28 (collateral * 0.8 / debt)
        uint256 healthFactor = 1.28e18;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 7000, healthFactor)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);
        assertTrue(pos.isAtRisk, "Should be at risk when HF < 1.6");
    }

    function test_HealthFactorNotAtRisk() public {
        uint256 healthFactor = 1.7e18;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(10000e8, 5000e8, 0, 8000, 7000, healthFactor)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);
        assertFalse(pos.isAtRisk, "Should not be at risk when HF >= 1.6");
    }

    function test_NetWorthCalculation() public {
        uint256 collateral = 10000e8;
        uint256 debt = 3000e8;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 7000, 0)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);
        assertEq(pos.netWorthUSD, 7000e8);
    }

    function test_NetWorthWhenDebtExceedsCollateral() public {
        uint256 collateral = 5000e8;
        uint256 debt = 8000e8;

        vm.mockCall(
            address(mockPool),
            abi.encodeWithSelector(mockPool.getUserAccountData.selector, USER),
            abi.encode(collateral, debt, 0, 8000, 7000, 0)
        );

        AaveAdapter.AavePosition memory pos = adapter.getUserPosition(USER);
        assertEq(pos.netWorthUSD, 0);
    }
}
