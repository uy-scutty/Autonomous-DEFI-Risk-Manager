// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { AgentRegistry } from "src/AgentRegistry.sol";
import { TestHelpers } from "test/helpers/TestHelpers.sol";

contract AgentRegistryTest is TestHelpers {
    AgentRegistry public registry;

    function setUp() public {
        vm.prank(PROTOCOL_OWNER);
        registry = new AgentRegistry(KEEPER);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor() public view {
        assertEq(registry.globalKeeper(), KEEPER);
        assertEq(registry.owner(), PROTOCOL_OWNER);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner Administration Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetGlobalKeeper() public {
        address newKeeper = makeAddr("newKeeper");

        vm.prank(PROTOCOL_OWNER);
        registry.setGlobalKeeper(newKeeper);

        assertEq(registry.globalKeeper(), newKeeper);
    }

    function test_RevertWhen_NonOwnerSetsGlobalKeeper() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", USER));
        registry.setGlobalKeeper(makeAddr("newKeeper"));
    }

    function test_SetAuthorisedRecorder() public {
        address recorder = makeAddr("recorder");

        vm.prank(PROTOCOL_OWNER);
        registry.setAuthorisedRecorder(recorder, true);

        assertTrue(registry.authorisedRecorders(recorder));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User Config Initialization Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_InitialiseConfig() public {
        vm.prank(USER);
        registry.initialiseConfig();

        assertTrue(registry.hasConfig(USER));

        AgentRegistry.UserAgentConfig memory config = registry.getConfig(USER);
        assertEq(config.warningThresholdHF, DEFAULT_WARNING_HF);
        assertEq(config.actionThresholdHF, DEFAULT_ACTION_HF);
        assertFalse(config.autoRepayEnabled);
        assertFalse(config.autoDeleverageEnabled);
        assertTrue(config.alertOnlyMode);
        assertEq(config.maxRepayBasisPoints, 2000);
        assertEq(config.maxDeleverageBP, 3000);
        assertTrue(config.agentEnabled);
        assertEq(config.lastConfigUpdate, block.timestamp);
    }

    function test_InitialiseConfig_Idempotent() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        uint256 lastUpdate = registry.getConfig(USER).lastConfigUpdate;

        skipTime(100);
        registry.initialiseConfig();

        assertEq(registry.getConfig(USER).lastConfigUpdate, lastUpdate);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Full Config Update Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetFullConfig() public {
        uint256 warningHF = 1.8e18;
        uint256 actionHF = 1.5e18;
        bool autoRepay = true;
        bool autoDelevg = true;
        bool alertOnly = false;
        uint16 maxRepayBP = 3000;
        uint16 maxDelgBP = 4000;

        vm.prank(USER);
        registry.setFullConfig(
            warningHF, actionHF, autoRepay, autoDelevg, alertOnly, maxRepayBP, maxDelgBP
        );

        AgentRegistry.UserAgentConfig memory config = registry.getConfig(USER);
        assertEq(config.warningThresholdHF, warningHF);
        assertEq(config.actionThresholdHF, actionHF);
        assertTrue(config.autoRepayEnabled);
        assertTrue(config.autoDeleverageEnabled);
        assertFalse(config.alertOnlyMode);
        assertEq(config.maxRepayBasisPoints, maxRepayBP);
        assertEq(config.maxDeleverageBP, maxDelgBP);
    }

    function test_RevertWhen_InvalidThresholds_WarningLessThanAction() public {
        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidThresholds.selector, 1.4e18, 1.6e18)
        );
        registry.setFullConfig(1.4e18, 1.6e18, false, false, true, 2000, 3000);
    }

    function test_RevertWhen_InvalidThresholds_ActionBelowMin() public {
        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidThresholds.selector, 1.2e18, 0.9e18)
        );
        registry.setFullConfig(1.2e18, 0.9e18, false, false, true, 2000, 3000);
    }

    function test_RevertWhen_InvalidThresholds_WarningAboveMax() public {
        vm.prank(USER);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidThresholds.selector, 3.5e18, 1.5e18)
        );
        registry.setFullConfig(3.5e18, 1.5e18, false, false, true, 2000, 3000);
    }

    function test_RevertWhen_MaxRepayExceedsBasisPoints() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.InvalidRepayLimit.selector, 15000));
        registry.setFullConfig(1.6e18, 1.4e18, false, false, true, 15000, 3000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Targeted Update Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetThresholds() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        uint256 newWarning = 1.7e18;
        uint256 newAction = 1.3e18;

        registry.setThresholds(newWarning, newAction);

        AgentRegistry.UserAgentConfig memory config = registry.getConfig(USER);
        assertEq(config.warningThresholdHF, newWarning);
        assertEq(config.actionThresholdHF, newAction);
        vm.stopPrank();
    }

    function test_RevertWhen_SetThresholdsWithoutConfig() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ConfigNotInitialised.selector, USER));
        registry.setThresholds(1.7e18, 1.3e18);
    }

    function test_SetAgentEnabled() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        assertTrue(registry.getConfig(USER).agentEnabled);

        registry.setAgentEnabled(false);
        assertFalse(registry.getConfig(USER).agentEnabled);

        registry.setAgentEnabled(true);
        assertTrue(registry.getConfig(USER).agentEnabled);
        vm.stopPrank();
    }

    function test_SetAlertOnly() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        assertTrue(registry.getConfig(USER).alertOnlyMode);

        registry.setAlertOnly(false);
        assertFalse(registry.getConfig(USER).alertOnlyMode);
        vm.stopPrank();
    }

    function test_SetActionConsent() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        assertFalse(registry.getConfig(USER).autoRepayEnabled);
        assertFalse(registry.getConfig(USER).autoDeleverageEnabled);

        registry.setActionConsent(true, true);

        assertTrue(registry.getConfig(USER).autoRepayEnabled);
        assertTrue(registry.getConfig(USER).autoDeleverageEnabled);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Keeper Whitelist Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_AddKeeper() public {
        address newKeeper = makeAddr("newKeeper");

        vm.prank(USER);
        registry.addKeeper(newKeeper);

        assertTrue(registry.isKeeperWhitelisted(USER, newKeeper));

        address[] memory keepers = registry.getUserKeepers(USER);
        assertEq(keepers.length, 1);
        assertEq(keepers[0], newKeeper);
    }

    function test_RevertWhen_AddingDuplicateKeeper() public {
        address newKeeper = makeAddr("newKeeper");

        vm.startPrank(USER);
        registry.addKeeper(newKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.KeeperAlreadyWhitelisted.selector, newKeeper)
        );
        registry.addKeeper(newKeeper);
        vm.stopPrank();
    }

    function test_RevertWhen_AddingMoreThanMaxKeepers() public {
        vm.startPrank(USER);

        for (uint256 i = 0; i < 5; i++) {
            registry.addKeeper(makeAddr(string(abi.encodePacked("keeper", i))));
        }

        vm.expectRevert(AgentRegistry.MaxKeepersReached.selector);
        registry.addKeeper(makeAddr("keeper6"));

        vm.stopPrank();
    }

    function test_RemoveKeeper() public {
        address newKeeper = makeAddr("newKeeper");

        vm.startPrank(USER);
        registry.addKeeper(newKeeper);
        assertTrue(registry.isKeeperWhitelisted(USER, newKeeper));

        registry.removeKeeper(newKeeper);
        assertFalse(registry.isKeeperWhitelisted(USER, newKeeper));

        address[] memory keepers = registry.getUserKeepers(USER);
        assertEq(keepers.length, 0);
        vm.stopPrank();
    }

    function test_RevertWhen_RemovingNonWhitelistedKeeper() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.KeeperNotWhitelisted.selector, KEEPER));
        registry.removeKeeper(KEEPER);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Record Action Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_RecordAction() public {
        address recorder = makeAddr("recorder");

        vm.prank(PROTOCOL_OWNER);
        registry.setAuthorisedRecorder(recorder, true);

        vm.prank(USER);
        registry.initialiseConfig();

        vm.prank(recorder);
        registry.recordAction(USER, "PARTIAL_REPAY", 1000e18);

        (uint256 totalActions, uint256 totalValue,) = registry.getUserStats(USER);
        assertEq(totalActions, 1);
        assertEq(totalValue, 1000e18);
    }

    function test_RevertWhen_UnauthorisedRecorderRecordsAction() public {
        address recorder = makeAddr("recorder");

        vm.prank(recorder);
        vm.expectRevert("not authorised recorder");
        registry.recordAction(USER, "PARTIAL_REPAY", 1000e18);
    }

    function test_RecordActionAutoInitialisesUser() public {
        address recorder = makeAddr("recorder");

        vm.prank(PROTOCOL_OWNER);
        registry.setAuthorisedRecorder(recorder, true);

        assertFalse(registry.hasConfig(USER));

        vm.prank(recorder);
        registry.recordAction(USER, "PARTIAL_REPAY", 1000e18);

        assertTrue(registry.hasConfig(USER));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Functions Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetConfig_ForUninitialisedUser() public view {
        AgentRegistry.UserAgentConfig memory config = registry.getConfig(USER);

        assertEq(config.warningThresholdHF, DEFAULT_WARNING_HF);
        assertEq(config.actionThresholdHF, DEFAULT_ACTION_HF);
        assertFalse(config.autoRepayEnabled);
        assertFalse(config.autoDeleverageEnabled);
        assertTrue(config.alertOnlyMode);
        assertEq(config.maxRepayBasisPoints, 2000);
        assertEq(config.maxDeleverageBP, 3000);
        assertFalse(config.agentEnabled);
        assertEq(config.lastConfigUpdate, 0);
        assertEq(config.totalActionsExecuted, 0);
        assertEq(config.totalValueProtectedUSD, 0);
    }

    function test_GetAgentDecisionParams_ForUninitialisedUser() public view {
        (
            bool agentEnabled,
            bool alertOnly,
            bool canRepay,
            bool canDeleverage,
            uint256 warningHF,
            uint256 actionHF,
            uint16 maxRepayBP,
            uint16 maxDelgBP
        ) = registry.getAgentDecisionParams(USER);

        assertFalse(agentEnabled);
        assertTrue(alertOnly);
        assertFalse(canRepay);
        assertFalse(canDeleverage);
        assertEq(warningHF, DEFAULT_WARNING_HF);
        assertEq(actionHF, DEFAULT_ACTION_HF);
        assertEq(maxRepayBP, 2000);
        assertEq(maxDelgBP, 3000);
    }

    function test_GetAgentDecisionParams_ForInitialisedUser() public {
        vm.startPrank(USER);
        registry.initialiseConfig();
        registry.setActionConsent(true, true);
        registry.setAlertOnly(false);
        vm.stopPrank();

        (bool agentEnabled, bool alertOnly, bool canRepay, bool canDeleverage,,,,) =
            registry.getAgentDecisionParams(USER);

        assertTrue(agentEnabled);
        assertFalse(alertOnly);
        assertTrue(canRepay);
        assertTrue(canDeleverage);
    }

    function test_IsAuthorisedKeeper() public {
        // Global keeper is always authorised
        assertTrue(registry.isAuthorisedKeeper(USER, KEEPER));

        // Whitelisted keeper is authorised
        address whitelisted = makeAddr("whitelisted");
        vm.prank(USER);
        registry.addKeeper(whitelisted);

        assertTrue(registry.isAuthorisedKeeper(USER, whitelisted));

        // Random keeper is not authorised
        assertFalse(registry.isAuthorisedKeeper(USER, makeAddr("random")));
    }

    function test_GetUserKeepers() public {
        address[] memory keepers = registry.getUserKeepers(USER);
        assertEq(keepers.length, 0);

        address keeper1 = makeAddr("keeper1");
        address keeper2 = makeAddr("keeper2");

        vm.startPrank(USER);
        registry.addKeeper(keeper1);
        registry.addKeeper(keeper2);
        vm.stopPrank();

        keepers = registry.getUserKeepers(USER);
        assertEq(keepers.length, 2);
        assertTrue(keepers[0] == keeper1 || keepers[0] == keeper2);
    }

    function test_GetUserStats() public {
        vm.prank(USER);
        registry.initialiseConfig();

        (uint256 totalActions, uint256 totalValue, uint256 lastUpdate) = registry.getUserStats(USER);

        assertEq(totalActions, 0);
        assertEq(totalValue, 0);
        assertEq(lastUpdate, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edge Cases and Boundary Tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_ThresholdBoundaries() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        // Minimum valid thresholds
        registry.setThresholds(1.1e18, 1.01e18);

        AgentRegistry.UserAgentConfig memory config = registry.getConfig(USER);
        assertEq(config.warningThresholdHF, 1.1e18);
        assertEq(config.actionThresholdHF, 1.01e18);

        // Maximum valid thresholds
        registry.setThresholds(3e18, 2.9e18);

        config = registry.getConfig(USER);
        assertEq(config.warningThresholdHF, 3e18);
        assertEq(config.actionThresholdHF, 2.9e18);
        vm.stopPrank();
    }

    function test_ConfigUpdateTimestamp() public {
        vm.startPrank(USER);
        registry.initialiseConfig();

        uint256 initialTimestamp = registry.getConfig(USER).lastConfigUpdate;

        skipTime(100);
        registry.setAlertOnly(false);

        assertTrue(registry.getConfig(USER).lastConfigUpdate > initialTimestamp);
        vm.stopPrank();
    }
}

