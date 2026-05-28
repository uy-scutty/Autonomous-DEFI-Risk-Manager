// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  AgentRegistry
 * @author Oyedokun Oluwatominyi John
 * @notice Single source of truth for every user's AI agent configuration.
 *
 *         Why a separate contract?
 *         ─────────────────────────
 *         Keeping agent config here (rather than inside VaultManager) means:
 *         • VaultManager stays lean and upgradeable independently.
 *         • The frontend has one canonical address to read/write agent prefs.
 *         • Future agent versions just point at the same registry.
 *         • Config changes emit their own events, giving the agent a clean
 *           event stream to watch for real-time threshold updates.
 *
 *         What is stored per user
 *         ────────────────────────
 *         • Risk thresholds (warning / action HF levels)
 *         • Permitted actions (repay, deleverage, or alert-only)
 *         • Per-action size limits (max % of debt)
 *         • Whitelisted keeper addresses (beyond the global agentKeeper)
 *         • Global kill-switch (pause all agent actions for this user)
 *         • Execution history counter (for dashboard analytics)
 */

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import {
    AggregatorV3Interface
} from "@chainlink-brownie-contracts/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract AgentRegistry is Ownable {
    // ─────────────────────────────────────────────────────────────────────────────
    // Custom errors
    // ─────────────────────────────────────────────────────────────────────────────
    error ConfigNotInitialised(address user);
    error InvalidThresholds(uint256 warning, uint256 action);
    error InvalidRepayLimit(uint16 basisPoints);
    error KeeperAlreadyWhitelisted(address keeper);
    error KeeperNotWhitelisted(address keeper);
    error MaxKeepersReached();

    // ─────────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Full agent configuration record for one user
    struct UserAgentConfig {
        // ── Risk thresholds (18-decimal fixed point, 1e18 = HF of 1.0) ──
        uint256 warningThresholdHF; // e.g. 1.6e18 → send Telegram alert
        uint256 actionThresholdHF; // e.g. 1.4e18 → execute protection

        // ── Permitted actions ────────────────────────────────────────────
        bool autoRepayEnabled; // agent may call partial repay
        bool autoDeleverageEnabled; // agent may call emergency deleverage
        bool alertOnlyMode; // override: never execute, only notify

        // ── Sizing limits ────────────────────────────────────────────────
        uint16 maxRepayBasisPoints; // max % of debt repaid per tx (e.g. 2000 = 20%)
        uint16 maxDeleverageBP; // max % of collateral released per deleverage

        // ── Control ──────────────────────────────────────────────────────
        bool agentEnabled; // global kill-switch for this user
        uint256 lastConfigUpdate; // timestamp of last change

        // ── Stats (written by protocol, useful for dashboard) ────────────
        uint256 totalActionsExecuted;
        uint256 totalValueProtectedUSD; // 18-decimal running total
    }

    /// @notice Emitted on every config change — agent watches this event stream
    struct ConfigDiff {
        bool warningHFChanged;
        bool actionHFChanged;
        bool autoRepayChanged;
        bool autoDeleverageChanged;
        bool alertOnlyChanged;
        bool enabledChanged;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    event AgentConfigInitialised(address indexed user);

    event AgentConfigUpdated(
        address indexed user,
        uint256 warningThresholdHF,
        uint256 actionThresholdHF,
        bool autoRepayEnabled,
        bool autoDeleverageEnabled,
        bool alertOnlyMode,
        bool agentEnabled
    );

    event AgentThresholdsUpdated(
        address indexed user,
        uint256 oldWarningHF,
        uint256 newWarningHF,
        uint256 oldActionHF,
        uint256 newActionHF
    );

    event AgentKillSwitchToggled(address indexed user, bool enabled);

    event KeeperWhitelisted(address indexed user, address indexed keeper);
    event KeeperRemoved(address indexed user, address indexed keeper);

    event ActionRecorded(address indexed user, string actionType, uint256 valueUSD18);

    //─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    uint256 constant HF_PRECISION = 1e18;
    uint256 constant MIN_HF = 1e18; // HF floor = 1.0
    uint256 constant MAX_WARNING_HF = 3e18; // sanity cap at 3.0
    uint256 constant DEFAULT_WARNING_HF = 1_600_000_000_000_000_000; // 1.6e18
    uint256 constant DEFAULT_ACTION_HF = 1_400_000_000_000_000_000; // 1.4e18
    uint16 constant DEFAULT_MAX_REPAY = 2000; // 20 %
    uint16 constant DEFAULT_MAX_DELEVG = 3000; // 30 %
    uint256 constant MAX_KEEPERS = 5;
    uint256 constant BASIS_POINTS = 10_000;
    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Global keeper address set by protocol owner
    ///         (the main agent wallet — always authorised)
    address public globalKeeper;

    /// @notice user → their full config
    mapping(address => UserAgentConfig) private _configs;

    /// @notice user → whether they have initialised a config
    mapping(address => bool) public hasConfig;

    /// @notice user → extra whitelisted keeper addresses (user-controlled)
    mapping(address => address[]) private _userKeepers;

    /// @notice user → keeper → bool (for O(1) lookup)
    mapping(address => mapping(address => bool)) public isKeeperWhitelisted;

    /// @notice Authorised protocol contracts that may record actions
    mapping(address => bool) public authorisedRecorders;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _globalKeeper) Ownable(msg.sender) {
        globalKeeper = _globalKeeper;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner administration
    // ─────────────────────────────────────────────────────────────────────────

    function setGlobalKeeper(address newKeeper) external onlyOwner {
        globalKeeper = newKeeper;
    }

    /// @notice Authorise a contract (e.g. VaultManager, ProtectionActions)
    ///         to call recordAction()
    function setAuthorisedRecorder(address recorder, bool status) external onlyOwner {
        authorisedRecorders[recorder] = status;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Initialise config
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a default agent config for the caller.
     *         Called automatically by the frontend on first deposit,
     *         or by the user explicitly.
     */
    function initialiseConfig() external {
        _initialise(msg.sender);
    }

    function _initialise(address user) internal {
        if (hasConfig[user]) return; // idempotent

        _configs[user] = UserAgentConfig({
            warningThresholdHF: DEFAULT_WARNING_HF,
            actionThresholdHF: DEFAULT_ACTION_HF,
            autoRepayEnabled: false, // opt-in
            autoDeleverageEnabled: false, // opt-in
            alertOnlyMode: true, // safe default
            maxRepayBasisPoints: DEFAULT_MAX_REPAY,
            maxDeleverageBP: DEFAULT_MAX_DELEVG,
            agentEnabled: true,
            lastConfigUpdate: block.timestamp,
            totalActionsExecuted: 0,
            totalValueProtectedUSD: 0
        });

        hasConfig[user] = true;
        emit AgentConfigInitialised(user);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Full config update
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Set complete agent configuration in one transaction.
     * @param warningHF     HF level for warning alerts (must be > actionHF)
     * @param actionHF      HF level for autonomous action (must be > 1.0)
     * @param autoRepay     Consent for agent partial repayments
     * @param autoDelevg    Consent for agent deleveraging
     * @param alertOnly     If true, agent only sends alerts — never executes
     * @param maxRepayBP    Max % of debt agent may repay in one tx
     * @param maxDelgBP     Max % of collateral agent may release in one delevg
     */
    function setFullConfig(
        uint256 warningHF,
        uint256 actionHF,
        bool autoRepay,
        bool autoDelevg,
        bool alertOnly,
        uint16 maxRepayBP,
        uint16 maxDelgBP
    ) external {
        _validateThresholds(warningHF, actionHF);
        if (maxRepayBP > BASIS_POINTS) revert InvalidRepayLimit(maxRepayBP);
        if (maxDelgBP > BASIS_POINTS) revert InvalidRepayLimit(maxDelgBP);

        if (!hasConfig[msg.sender]) _initialise(msg.sender);

        UserAgentConfig storage cfg = _configs[msg.sender];

        cfg.warningThresholdHF = warningHF;
        cfg.actionThresholdHF = actionHF;
        cfg.autoRepayEnabled = autoRepay;
        cfg.autoDeleverageEnabled = autoDelevg;
        cfg.alertOnlyMode = alertOnly;
        cfg.maxRepayBasisPoints = maxRepayBP;
        cfg.maxDeleverageBP = maxDelgBP;
        cfg.lastConfigUpdate = block.timestamp;

        emit AgentConfigUpdated(
            msg.sender, warningHF, actionHF, autoRepay, autoDelevg, alertOnly, cfg.agentEnabled
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Targeted updates (cheaper than full config for single changes)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Update only risk thresholds (most common user change).
     */
    function setThresholds(uint256 warningHF, uint256 actionHF) external {
        _validateThresholds(warningHF, actionHF);
        _requireHasConfig(msg.sender);

        UserAgentConfig storage cfg = _configs[msg.sender];
        uint256 oldWarning = cfg.warningThresholdHF;
        uint256 oldAction = cfg.actionThresholdHF;

        cfg.warningThresholdHF = warningHF;
        cfg.actionThresholdHF = actionHF;
        cfg.lastConfigUpdate = block.timestamp;

        emit AgentThresholdsUpdated(msg.sender, oldWarning, warningHF, oldAction, actionHF);
    }

    /**
     * @notice Enable or disable the agent entirely (global kill-switch).
     */
    function setAgentEnabled(bool enabled) external {
        if (!hasConfig[msg.sender]) _initialise(msg.sender);
        _configs[msg.sender].agentEnabled = enabled;
        _configs[msg.sender].lastConfigUpdate = block.timestamp;
        emit AgentKillSwitchToggled(msg.sender, enabled);
    }

    /**
     * @notice Toggle alert-only mode (agent sends alerts but never executes).
     */
    function setAlertOnly(bool alertOnly) external {
        _requireHasConfig(msg.sender);
        _configs[msg.sender].alertOnlyMode = alertOnly;
        _configs[msg.sender].lastConfigUpdate = block.timestamp;
    }

    /**
     * @notice Update action consent flags.
     */
    function setActionConsent(bool autoRepay, bool autoDelevg) external {
        _requireHasConfig(msg.sender);
        UserAgentConfig storage cfg = _configs[msg.sender];
        cfg.autoRepayEnabled = autoRepay;
        cfg.autoDeleverageEnabled = autoDelevg;
        cfg.lastConfigUpdate = block.timestamp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Keeper whitelist management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Add an additional keeper address for your position.
     *         Useful for teams or hardware-wallet setups with a hot key.
     */
    function addKeeper(address keeper) external {
        if (!hasConfig[msg.sender]) _initialise(msg.sender);
        if (isKeeperWhitelisted[msg.sender][keeper]) {
            revert KeeperAlreadyWhitelisted(keeper);
        }
        if (_userKeepers[msg.sender].length >= MAX_KEEPERS) {
            revert MaxKeepersReached();
        }

        _userKeepers[msg.sender].push(keeper);
        isKeeperWhitelisted[msg.sender][keeper] = true;
        emit KeeperWhitelisted(msg.sender, keeper);
    }

    /**
     * @notice Remove a previously added keeper.
     */
    function removeKeeper(address keeper) external {
        if (!isKeeperWhitelisted[msg.sender][keeper]) {
            revert KeeperNotWhitelisted(keeper);
        }

        address[] storage keepers = _userKeepers[msg.sender];
        for (uint256 i = 0; i < keepers.length; i++) {
            if (keepers[i] == keeper) {
                keepers[i] = keepers[keepers.length - 1];
                keepers.pop();
                break;
            }
        }
        isKeeperWhitelisted[msg.sender][keeper] = false;
        emit KeeperRemoved(msg.sender, keeper);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Protocol: Record executed actions (called by ProtectionActions)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Record a successfully executed agent action.
     *         Only callable by authorised contracts (VaultManager, ProtectionActions).
     * @param user        Position owner
     * @param actionType  "PARTIAL_REPAY" | "DELEVERAGE" | "ALERT"
     * @param valueUSD18  USD value of the action, 18-decimal
     */
    function recordAction(address user, string calldata actionType, uint256 valueUSD18) external {
        require(authorisedRecorders[msg.sender], "not authorised recorder");
        if (!hasConfig[user]) _initialise(user);

        _configs[user].totalActionsExecuted++;
        _configs[user].totalValueProtectedUSD += valueUSD18;

        emit ActionRecorded(user, actionType, valueUSD18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns full config for a user.
     */
    function getConfig(address user) external view returns (UserAgentConfig memory) {
        if (!hasConfig[user]) {
            // Return safe defaults for uninitialised users
            return UserAgentConfig({
                warningThresholdHF: DEFAULT_WARNING_HF,
                actionThresholdHF: DEFAULT_ACTION_HF,
                autoRepayEnabled: false,
                autoDeleverageEnabled: false,
                alertOnlyMode: true,
                maxRepayBasisPoints: DEFAULT_MAX_REPAY,
                maxDeleverageBP: DEFAULT_MAX_DELEVG,
                agentEnabled: false,
                lastConfigUpdate: 0,
                totalActionsExecuted: 0,
                totalValueProtectedUSD: 0
            });
        }
        return _configs[user];
    }

    /**
     * @notice Lightweight read used by the agent on every scan cycle.
     *         Single call returns everything needed for a go/no-go decision.
     */
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
        )
    {
        UserAgentConfig storage cfg = _configs[user];
        if (!hasConfig[user]) {
            return (
                false,
                true,
                false,
                false,
                DEFAULT_WARNING_HF,
                DEFAULT_ACTION_HF,
                DEFAULT_MAX_REPAY,
                DEFAULT_MAX_DELEVG
            );
        }

        agentEnabled = cfg.agentEnabled;
        alertOnly = cfg.alertOnlyMode;
        canRepay = cfg.autoRepayEnabled && !cfg.alertOnlyMode;
        canDeleverage = cfg.autoDeleverageEnabled && !cfg.alertOnlyMode;
        warningHF = cfg.warningThresholdHF;
        actionHF = cfg.actionThresholdHF;
        maxRepayBP = cfg.maxRepayBasisPoints;
        maxDelgBP = cfg.maxDeleverageBP;
    }

    /**
     * @notice Check if a given address is authorised to act as keeper for user.
     *         True for global keeper OR any user-whitelisted keeper.
     */
    function isAuthorisedKeeper(address user, address keeper) external view returns (bool) {
        return keeper == globalKeeper || isKeeperWhitelisted[user][keeper];
    }

    /**
     * @notice Returns user-whitelisted keepers (not including globalKeeper).
     */
    function getUserKeepers(address user) external view returns (address[] memory) {
        return _userKeepers[user];
    }

    /**
     * @notice Returns lifetime stats for a user (for the dashboard).
     */
    function getUserStats(address user)
        external
        view
        returns (uint256 totalActions, uint256 totalValueProtectedUSD, uint256 lastConfigUpdate)
    {
        UserAgentConfig storage cfg = _configs[user];
        totalActions = cfg.totalActionsExecuted;
        totalValueProtectedUSD = cfg.totalValueProtectedUSD;
        lastConfigUpdate = cfg.lastConfigUpdate;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _validateThresholds(uint256 warningHF, uint256 actionHF) internal pure {
        // warning must be above action, action must be above liquidation floor
        if (warningHF <= actionHF || actionHF <= MIN_HF || warningHF > MAX_WARNING_HF) {
            revert InvalidThresholds(warningHF, actionHF);
        }
    }

    function _requireHasConfig(address user) internal view {
        if (!hasConfig[user]) revert ConfigNotInitialised(user);
    }
}
