// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Full test suite for VaultManager.sol
 *
 * Coverage
 * ────────
 * Unit tests
 *   ✓ Token configuration (owner only, validation)
 *   ✓ depositCollateral   — happy path, zero amount, unsupported token
 *   ✓ borrow              — happy path, exceeds liquidity, under-collateralised
 *   ✓ repay               — full repay, partial repay, over-repay cap
 *   ✓ withdrawCollateral  — happy path, would liquidate, exact boundary
 *   ✓ Health factor math  — single token, multi-token, no debt edge case
 *   ✓ simulateHealthFactor — price shock scenarios
 *   ✓ agentPartialRepay   — authorised, consent missing, exceeds limit
 *   ✓ agentEmergencyDeleverage — happy path, consent check
 *   ✓ AgentConfig defaults and updates
 *   ✓ Events emitted correctly
 *   ✓ Pause / unpause
 *
 * Fuzz tests
 *   ✓ depositCollateral then withdrawCollateral — balance invariant
 *   ✓ borrow → HF always >= 1.0 after valid borrow
 *   ✓ repay → HF always improves or stays same
 */

import "forge-std/Test.sol";
import "test/TestHelpers.sol";

// import { VaultManager } from "src/VaultManager.sol";
// import { PositionUpdated } from "src/VaultManager.sol";
// import { AgentConfigUpdated } from "src/VaultManager.sol";
// import { ProtectionTriggered } from "src/VaultManager.sol";

contract VaultManagerTest is BaseTest {
    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────
    event PositionUpdated(
        address indexed user,
        address indexed token,
        string action,
        uint256 amount,
        uint256 healthFactor
    );

    event AgentConfigUpdated(
        address indexed user,
        uint256 warningHF,
        uint256 actionHF,
        bool autoRepay,
        bool autoDeleverage
    );

    event ProtectionTriggered(
        address indexed user,
        address indexed keeper,
        string actionType,
        address token,
        uint256 amount,
        uint256 beforeHF,
        uint256 afterHF
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Token configuration
    // ─────────────────────────────────────────────────────────────────────────

    function test_ConfigureToken_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.configureToken(address(weth), address(ethFeed), 8000, 500, true, true);
    }

    function test_ConfigureToken_StoredCorrectly() public {
        vm.startPrank(deployer);
        MockERC20 newToken = new MockERC20("Test", "TST", 18);
        MockChainlinkFeed newFeed = new MockChainlinkFeed(100e8);
        vault.configureToken(address(newToken), address(newFeed), 7500, 600, true, true);
        vm.stopPrank();
        VaultManager.TokenConfig memory cfg = vault.getTokenConfig(address(newToken));
        assertEq(address(cfg.priceFeed), address(newFeed));
        assertEq(cfg.liquidationThreshold, 7500);
        assertTrue(cfg.isActive);
    }

    function test_ConfigureToken_InvalidThreshold_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert("threshold > 100%");
        vault.configureToken(address(weth), address(ethFeed), 10_001, 500, true, true);
    }

    function test_ConfigureToken_ZeroFeed_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert("zero feed");
        vault.configureToken(address(weth), address(0), 8000, 500, true, true);
    }

    function test_DeactivateToken_BlocksDeposit() public {
        vm.prank(deployer);
        vault.deactivateToken(address(wbtc));

        vm.startPrank(alice);
        wbtc.approve(address(vault), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(VaultManager.TokenNotSupported.selector, address(wbtc))
        );
        vault.depositCollateral(address(wbtc), 1e8);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // depositCollateral
    // ─────────────────────────────────────────────────────────────────────────

    function test_DepositCollateral_HappyPath() public {
        uint256 amount = 5e18;
        vm.startPrank(alice);
        weth.approve(address(vault), amount);
        vault.depositCollateral(address(weth), amount);
        vm.stopPrank();

        assertEq(vault.getCollateral(alice, address(weth)), amount);
        assertEq(vault.getHealthFactor(alice), type(uint256).max);
    }

    function test_DepositCollateral_ZeroAmount_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vault.depositCollateral(address(weth), 0);
    }

    function test_DepositCollateral_UnsupportedToken_Reverts() public {
        MockERC20 unknown = new MockERC20("X", "X", 18);
        vm.startPrank(alice);
        unknown.mint(alice, 1e18);
        unknown.approve(address(vault), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(VaultManager.TokenNotSupported.selector, address(unknown))
        );
        vault.depositCollateral(address(unknown), 1e18);
        vm.stopPrank();
    }

    function test_DepositCollateral_TransfersTokens() public {
        uint256 amount = 10e18;
        uint256 aliceBefore = weth.balanceOf(alice);

        vm.startPrank(alice);
        weth.approve(address(vault), amount);
        vault.depositCollateral(address(weth), amount);
        vm.stopPrank();

        assertEq(weth.balanceOf(alice), aliceBefore - amount);
        assertGe(weth.balanceOf(address(vault)), amount);
    }

    function test_DepositCollateral_MultipleDeposits_Accumulate() public {
        vm.startPrank(alice);
        weth.approve(address(vault), type(uint256).max);
        vault.depositCollateral(address(weth), 2e18);
        vault.depositCollateral(address(weth), 3e18);
        vm.stopPrank();
        assertEq(vault.getCollateral(alice, address(weth)), 5e18);
    }

    function test_DepositCollateral_WhenPaused_Reverts() public {
        vm.prank(deployer);
        vault.pause();

        vm.startPrank(alice);
        weth.approve(address(vault), 1e18);
        vm.expectRevert();
        vault.depositCollateral(address(weth), 1e18);
        vm.stopPrank();
    }

    function test_DepositCollateral_EmitsEvent() public {
        vm.startPrank(alice);
        weth.approve(address(vault), 5e18);
        vm.expectEmit(true, true, false, false);
        emit PositionUpdated(alice, address(weth), "deposit", 5e18, 0);
        vault.depositCollateral(address(weth), 5e18);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // borrow
    // ─────────────────────────────────────────────────────────────────────────

    function test_Borrow_HappyPath() public {
        // 10 ETH @ $2000 = $20,000, adj = $16,000
        // Borrow $8,000 USDC → HF = 16000/8000 = 2.0
        _openPosition(alice, 10e18, 0);
        vm.prank(alice);
        vault.borrow(address(usdc), 8000e6);

        assertEq(vault.getBorrowed(alice, address(usdc)), 8000e6);
        _assertHFClose(alice, 2.0e18, 50);
    }

    function test_Borrow_ExceedsLiquidity_Reverts() public {
        _openPosition(alice, 100e18, 0); // lots of collateral
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultManager.InsufficientBorrowLiquidity.selector, address(usdc), 60_000e6, 50_000e6
            )
        );
        vault.borrow(address(usdc), 60_000e6);
    }

    function test_Borrow_WouldBreachMinHF_Reverts() public {
        // 1 ETH, adj = $1,600, borrow $1,800 → HF = 0.89 < 1.0
        _openPosition(alice, 1e18, 0);
        vm.prank(alice);
        vm.expectRevert();
        vault.borrow(address(usdc), 1800e6);
    }

    function test_Borrow_ExactMaxAmount_Succeeds() public {
        _openPosition(alice, 10e18, 0);
        // adj = $16,000 → borrow $15,999 → HF just above 1.0
        vm.prank(alice);
        vault.borrow(address(usdc), 15_999e6);
        assertGe(vault.getHealthFactor(alice), 1e18);
    }

    function test_Borrow_TokenNotBorrowable_Reverts() public {
        _openPosition(alice, 10e18, 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VaultManager.TokenNotSupported.selector, address(wbtc))
        );
        vault.borrow(address(wbtc), 1e8);
    }

    function test_Borrow_EmitsPositionUpdated() public {
        _openPosition(alice, 10e18, 0);
        vm.prank(alice);
        vm.expectEmit(true, true, false, false);
        emit PositionUpdated(alice, address(usdc), "borrow", 5000e6, 0);
        vault.borrow(address(usdc), 5000e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // repay
    // ─────────────────────────────────────────────────────────────────────────

    function test_Repay_Full() public {
        _openPosition(alice, 10e18, 5000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.repay(address(usdc), 5000e6);
        vm.stopPrank();

        assertEq(vault.getBorrowed(alice, address(usdc)), 0);
        assertEq(vault.getHealthFactor(alice), type(uint256).max);
    }

    function test_Repay_Partial() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.repay(address(usdc), 3000e6);
        vm.stopPrank();
        assertEq(vault.getBorrowed(alice, address(usdc)), 5000e6);
    }

    function test_Repay_OverAmount_CappedAtDebt() public {
        _openPosition(alice, 10e18, 5000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.repay(address(usdc), 9999e6); // only 5000 owed
        vm.stopPrank();

        assertEq(vault.getBorrowed(alice, address(usdc)), 0);
        assertEq(usdc.balanceOf(alice), aliceBefore - 5000e6);
    }

    function test_Repay_ImprovesHF() public {
        _openPosition(alice, 5e18, 6000e6);
        uint256 hfBefore = vault.getHealthFactor(alice);

        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.repay(address(usdc), 2000e6);
        vm.stopPrank();

        assertGt(vault.getHealthFactor(alice), hfBefore);
    }

    function test_Repay_ZeroDebt_Reverts() public {
        _openPosition(alice, 5e18, 0);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VaultManager.RepayExceedsDebt.selector, 100e6, 0));
        vault.repay(address(usdc), 100e6);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // withdrawCollateral
    // ─────────────────────────────────────────────────────────────────────────

    function test_WithdrawCollateral_NoBorrow_Full() public {
        _openPosition(alice, 10e18, 0);
        uint256 before = weth.balanceOf(alice);
        vm.prank(alice);
        vault.withdrawCollateral(address(weth), 10e18);
        assertEq(weth.balanceOf(alice), before + 10e18);
        assertEq(vault.getCollateral(alice, address(weth)), 0);
    }

    function test_WithdrawCollateral_PartialWithDebt_Ok() public {
        // 10 ETH, $5000 borrowed. HF = 3.2. After -3 ETH: 7*2000*0.8/5000 = 2.24 ✓
        _openPosition(alice, 10e18, 5000e6);
        vm.prank(alice);
        vault.withdrawCollateral(address(weth), 3e18);
        assertEq(vault.getCollateral(alice, address(weth)), 7e18);
        assertGt(vault.getHealthFactor(alice), 1e18);
    }

    function test_WithdrawCollateral_WouldLiquidate_Reverts() public {
        // 1 ETH ($2000), $1500 borrowed. Adj = $1600. HF = 1.067
        // Withdraw 0.5 ETH → adj = $800. HF = 0.53 → revert
        _openPosition(alice, 1e18, 1500e6);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdrawCollateral(address(weth), 0.5e18);
    }

    function test_WithdrawCollateral_InsufficientCollateral_Reverts() public {
        _openPosition(alice, 2e18, 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultManager.InsufficientCollateral.selector, address(weth), 5e18, 2e18
            )
        );
        vault.withdrawCollateral(address(weth), 5e18);
    }

    function test_WithdrawCollateral_ZeroAmount_Reverts() public {
        _openPosition(alice, 1e18, 0);
        vm.prank(alice);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vault.withdrawCollateral(address(weth), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Health factor math
    // ─────────────────────────────────────────────────────────────────────────

    function test_HF_NoDebt_ReturnsMaxUint() public {
        _openPosition(alice, 5e18, 0);
        assertEq(vault.getHealthFactor(alice), type(uint256).max);
    }

    function test_HF_SingleToken_Correct() public {
        // 10 ETH @ $2000, borrow $8000 → HF = 16000/8000 = 2.0
        _openPosition(alice, 10e18, 8000e6);
        _assertHFClose(alice, 2.0e18, 10);
    }

    function test_HF_MultiToken_Correct() public {
        // 5 ETH ($10,000) + 1 WBTC ($60,000)
        // Adj = (10000 + 60000) * 0.80 = $56,000. Borrow $20,000 → HF = 2.8
        vm.startPrank(alice);
        weth.approve(address(vault), type(uint256).max);
        wbtc.approve(address(vault), type(uint256).max);
        vault.depositCollateral(address(weth), 5e18);
        vault.depositCollateral(address(wbtc), 1e8);
        vault.borrow(address(usdc), 20_000e6);
        vm.stopPrank();
        _assertHFClose(alice, 2.8e18, 10);
    }

    function test_HF_DropsWhenPriceFalls() public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 hfBefore = vault.getHealthFactor(alice);
        _dropEthPrice(50); // ETH $2000 → $1000
        uint256 hfAfter = vault.getHealthFactor(alice);
        assertLt(hfAfter, hfBefore);
        // adj = 10*1000*0.80 = $8000 = debt → HF ≈ 1.0
        _assertHFClose(alice, 1.0e18, 50);
    }

    function test_HF_ExactLiquidationBoundary() public {
        // 1 ETH adj = $1600, borrow $1600 → HF = 1.0
        _openPosition(alice, 1e18, 0);
        vm.prank(alice);
        vault.borrow(address(usdc), 1600e6);
        assertApproxEqRel(vault.getHealthFactor(alice), 1e18, 0.001e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // simulateHealthFactor
    // ─────────────────────────────────────────────────────────────────────────

    function test_Simulate_PriceDrop_ReducesHF() public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 current = vault.getHealthFactor(alice);
        uint256 simHF = vault.simulateHealthFactor(alice, address(weth), -2000);
        assertLt(simHF, current);
    }

    function test_Simulate_PriceIncrease_RaisesHF() public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 current = vault.getHealthFactor(alice);
        uint256 simHF = vault.simulateHealthFactor(alice, address(weth), 5000);
        assertGt(simHF, current);
    }

    function test_Simulate_100PctDrop_ZeroHF() public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 simHF = vault.simulateHealthFactor(alice, address(weth), -10000);
        assertEq(simHF, 0);
    }

    function test_Simulate_NoDebt_ReturnsMaxUint() public {
        _openPosition(alice, 5e18, 0);
        assertEq(vault.simulateHealthFactor(alice, address(weth), -5000), type(uint256).max);
    }

    function test_Simulate_UnrelatedToken_NoEffect() public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 current = vault.getHealthFactor(alice);
        // Alice has no WBTC collateral, so WBTC shock doesn't change HF
        uint256 simHF = vault.simulateHealthFactor(alice, address(wbtc), -5000);
        assertEq(simHF, current);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AgentConfig
    // ─────────────────────────────────────────────────────────────────────────

    function test_AgentConfig_DefaultsOnFirstDeposit() public {
        _openPosition(alice, 1e18, 0);
        VaultManager.AgentConfig memory cfg = vault.getAgentConfig(alice);
        assertEq(cfg.warningThresholdHF, 1.6e18);
        assertEq(cfg.actionThresholdHF, 1.4e18);
        assertEq(cfg.maxRepayBasisPoints, 2000);
        assertFalse(cfg.autoRepayEnabled);
        assertFalse(cfg.autoDeleverageEnabled);
    }

    function test_AgentConfig_SetByUser() public {
        vm.prank(alice);
        vault.setAgentConfig(1.7e18, 1.5e18, 2500, true, false);
        VaultManager.AgentConfig memory cfg = vault.getAgentConfig(alice);
        assertEq(cfg.warningThresholdHF, 1.7e18);
        assertEq(cfg.actionThresholdHF, 1.5e18);
        assertTrue(cfg.autoRepayEnabled);
        assertFalse(cfg.autoDeleverageEnabled);
    }

    function test_AgentConfig_WarningBelowAction_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(VaultManager.InvalidThreshold.selector);
        vault.setAgentConfig(1.3e18, 1.5e18, 2000, true, false);
    }

    function test_AgentConfig_ActionAtMinHF_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(VaultManager.InvalidThreshold.selector);
        vault.setAgentConfig(1.5e18, 1.0e18, 2000, true, false);
    }

    function test_AgentConfig_EmitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AgentConfigUpdated(alice, 1.7e18, 1.5e18, true, false);
        vault.setAgentConfig(1.7e18, 1.5e18, 2000, true, false);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // agentPartialRepay
    // ─────────────────────────────────────────────────────────────────────────

    function test_AgentPartialRepay_HappyPath() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 3000, true, false);

        vm.startPrank(keeper);
        usdc.approve(address(vault), type(uint256).max);
        vault.agentPartialRepay(alice, address(usdc), 1000e6);
        vm.stopPrank();

        assertEq(vault.getBorrowed(alice, address(usdc)), 7000e6);
    }

    function test_AgentPartialRepay_NotKeeper_Reverts() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 3000, true, false);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VaultManager.Unauthorized.selector, bob));
        vault.agentPartialRepay(alice, address(usdc), 1000e6);
    }

    function test_AgentPartialRepay_ConsentNotGiven_Reverts() public {
        _openPosition(alice, 10e18, 8000e6);
        // autoRepay = false (default)
        vm.startPrank(keeper);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VaultManager.Unauthorized.selector, alice));
        vault.agentPartialRepay(alice, address(usdc), 1000e6);
        vm.stopPrank();
    }

    function test_AgentPartialRepay_ExceedsLimit_Reverts() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 1000, true, false); // 10% = $800

        vm.startPrank(keeper);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(VaultManager.ExceedsAgentRepayLimit.selector, 2000e6, 800e6)
        );
        vault.agentPartialRepay(alice, address(usdc), 2000e6);
        vm.stopPrank();
    }

    function test_AgentPartialRepay_EmitsProtectionTriggered() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 3000, true, false);

        vm.startPrank(keeper);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectEmit(true, true, false, false);
        emit ProtectionTriggered(alice, keeper, "PARTIAL_REPAY", address(usdc), 1000e6, 0, 0);
        vault.agentPartialRepay(alice, address(usdc), 1000e6);
        vm.stopPrank();
    }

    function test_AgentPartialRepay_ZeroDebt_Reverts() public {
        _openPosition(alice, 5e18, 0);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 3000, true, false);

        vm.startPrank(keeper);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VaultManager.RepayExceedsDebt.selector, 100e6, 0));
        vault.agentPartialRepay(alice, address(usdc), 100e6);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // agentEmergencyDeleverage
    // ─────────────────────────────────────────────────────────────────────────

    function test_AgentDeleverage_HappyPath() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 5000, true, true);

        uint256 collBefore = vault.getCollateral(alice, address(weth));

        vm.prank(keeper);
        vault.agentEmergencyDeleverage(alice, address(weth), address(usdc), 1e18, 1600e6);

        assertEq(vault.getCollateral(alice, address(weth)), collBefore - 1e18);
    }

    function test_AgentDeleverage_ConsentNotGiven_Reverts() public {
        _openPosition(alice, 10e18, 8000e6);
        vm.prank(alice);
        vault.setAgentConfig(1.6e18, 1.4e18, 5000, true, false); // deleverage off

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(VaultManager.Unauthorized.selector, alice));
        vault.agentEmergencyDeleverage(alice, address(weth), address(usdc), 1e18, 1600e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stale price feed
    // ─────────────────────────────────────────────────────────────────────────

    function test_StalePrice_Reverts() public {
        _openPosition(alice, 5e18, 2000e6);
        vm.warp(10_000);
        ethFeed.makeStale(7200);
        vm.expectRevert();
        vault.getHealthFactor(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pause / unpause
    // ─────────────────────────────────────────────────────────────────────────

    function test_Pause_BlocksDeposit() public {
        vm.prank(deployer);
        vault.pause();
        vm.startPrank(alice);
        weth.approve(address(vault), 1e18);
        vm.expectRevert();
        vault.depositCollateral(address(weth), 1e18);
        vm.stopPrank();
    }

    function test_Unpause_RestoresActions() public {
        vm.prank(deployer);
        vault.pause();
        vm.prank(deployer);
        vault.unpause();
        vm.startPrank(alice);
        weth.approve(address(vault), 1e18);
        vault.depositCollateral(address(weth), 1e18);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getPositionSummary
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetPositionSummary_ReturnsCorrectValues() public {
        _openPosition(alice, 10e18, 5000e6);
        (uint256 collUSD, uint256 debtUSD, uint256 hf,) = vault.getPositionSummary(alice);
        // adj collateral = 10*2000*0.80 = $16,000
        assertApproxEqRel(collUSD, 16_000e18, 0.001e18);
        assertApproxEqRel(debtUSD, 5_000e18, 0.001e18);
        assertApproxEqRel(hf, 3.2e18, 0.001e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: deposit → withdraw balance invariant
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_DepositWithdraw_BalanceInvariant(uint256 amount) public {
        amount = bound(amount, 1, 50e18);
        weth.mint(alice, amount);
        uint256 before = weth.balanceOf(alice);

        vm.startPrank(alice);
        weth.approve(address(vault), amount);
        vault.depositCollateral(address(weth), amount);
        vault.withdrawCollateral(address(weth), amount);
        vm.stopPrank();

        assertEq(weth.balanceOf(alice), before);
        assertEq(vault.getCollateral(alice, address(weth)), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: valid borrow → HF always >= 1.0
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_Borrow_HFAlwaysAboveMin(uint256 borrowAmt) public {
        // adj collateral = 5*2000*0.8 = $8,000 → safe max borrow
        borrowAmt = bound(borrowAmt, 1e6, 7999e6);
        _openPosition(alice, 5e18, 0);
        vm.prank(alice);
        vault.borrow(address(usdc), borrowAmt);
        assertGe(vault.getHealthFactor(alice), 1e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: repay always improves or maintains HF
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_Repay_HFNeverDecreases(uint256 repayAmt) public {
        _openPosition(alice, 10e18, 8000e6);
        uint256 hfBefore = vault.getHealthFactor(alice);
        repayAmt = bound(repayAmt, 1e6, 8000e6);
        usdc.mint(alice, repayAmt);

        vm.startPrank(alice);
        usdc.approve(address(vault), repayAmt);
        vault.repay(address(usdc), repayAmt);
        vm.stopPrank();

        assertGe(vault.getHealthFactor(alice), hfBefore);
    }
}
