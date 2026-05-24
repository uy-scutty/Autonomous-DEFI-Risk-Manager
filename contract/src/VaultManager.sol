// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  VaultManager
 * @author Autonomous DeFi Risk Manager
 * @notice Core user-facing vault for the Autonomous DeFi Risk Manager.
 *         Users deposit ERC-20 collateral, borrow against it, and repay.
 *         A Chainlink-backed health factor is maintained on every state change.
 *         The registered AI agent can call emergency protection functions
 *         within limits the user has set.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  Actors                                                 │
 * │  • User        → deposit / borrow / repay / withdraw    │
 * │  • AgentKeeper → triggerPartialRepay / emergencyDelevg  │
 * │  • Owner       → add/remove supported tokens, set oracle│
 * └─────────────────────────────────────────────────────────┘
 *
 * Security model
 * ─────────────
 * • ReentrancyGuard on all state-changing external functions.
 * • AgentKeeper actions are bounded by user-defined safety limits
 *   stored in AgentConfig (max repay %, min HF target).
 * • No flash-loan attack surface: health factor checked AFTER
 *   every borrow / withdrawal.
 * • Emergency pause via OpenZeppelin Pausable.
 *
 * Health Factor formula (mirrors Aave v3)
 * ───────────────────────────────────────
 *   HF = Σ(collateral_i × price_i × liqThreshold_i)
 *        ─────────────────────────────────────────────
 *              Σ(borrowed_j × price_j)
 *
 * HF < 1.0  → position is undercollateralised (liquidatable)
 * HF < 1.4  → agent's ACTION threshold (configurable)
 * HF < 1.6  → agent's WARNING threshold (configurable)
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink-brownie-contracts/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract VaultManager is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Custom errors
    // ─────────────────────────────────────────────────────────────────────────────
    error TokenNotSupported(address token);
    error InsufficientCollateral(address token, uint256 requested, uint256 available);
    error InsufficientBorrowLiquidity(address token, uint256 requested, uint256 available);
    error HealthFactorTooLow(uint256 currentHF, uint256 minimumHF);
    error HealthFactorAlreadySafe(uint256 currentHF);
    error Unauthorized(address caller);
    error ZeroAmount();
    error StalePrice(address feed, uint256 updatedAt);
    error ExceedsAgentRepayLimit(uint256 requested, uint256 limit);
    error RepayExceedsDebt(uint256 repayAmount, uint256 debtAmount);
    error InvalidThreshold();

    // ─────────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Per-token configuration set by the protocol owner
    struct TokenConfig {
        AggregatorV3Interface priceFeed; // Chainlink USD feed
        uint8 feedDecimals; // Chainlink feed decimals (usually 8)
        uint8 tokenDecimals; // ERC-20 decimals
        uint16 liquidationThreshold; // basis points, e.g. 8000 = 80 %
        uint16 liquidationBonus; // basis points, e.g. 500  =  5 %
        bool isCollateral; // can be used as collateral
        bool isBorrowable; // can be borrowed
        bool isActive; // soft-disable without removing
    }

    /// @notice A user's complete on-chain position
    struct Position {
        // collateral[token] = raw token units deposited
        mapping(address => uint256) collateral;
        // borrowed[token]   = raw token units borrowed (principal only)
        mapping(address => uint256) borrowed;
        // Snapshot of last on-chain HF (18-decimal fixed point, 1e18 = 1.0)
        uint256 lastHealthFactor;
        uint256 lastUpdateTime;
        bool exists;
    }

    /// @notice User-configurable AI agent safety rules
    /// @dev    Stored here so the agent can read a single source of truth.
    ///         The frontend writes these; the agent reads them before acting.
    struct AgentConfig {
        uint256 warningThresholdHF; // 18-dec, e.g. 1.6e18 — send alert
        uint256 actionThresholdHF; // 18-dec, e.g. 1.4e18 — execute action
        uint16 maxRepayBasisPoints; // max % of debt agent may repay in one tx
        bool autoRepayEnabled; // user consents to autonomous repay
        bool autoDeleverageEnabled; // user consents to autonomous deleverage
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Emitted on every deposit, borrow, repay, withdrawal
    event PositionUpdated(
        address indexed user,
        address indexed token,
        string action, // "deposit" | "borrow" | "repay" | "withdraw"
        uint256 amount,
        uint256 newHealthFactor
    );

    /// @dev Emitted whenever the computed HF crosses a threshold band
    event HealthFactorChanged(
        address indexed user,
        uint256 oldHF,
        uint256 newHF,
        string band // "SAFE" | "WARNING" | "ACTION" | "CRITICAL"
    );

    /// @dev Emitted when the agent fires a protection action
    event ProtectionTriggered(
        address indexed user,
        address indexed keeper,
        string actionType, // "PARTIAL_REPAY" | "DELEVERAGE"
        address token,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter
    );

    /// @dev Emitted when user updates their agent configuration
    event AgentConfigUpdated(
        address indexed user,
        uint256 warningThresholdHF,
        uint256 actionThresholdHF,
        bool autoRepayEnabled,
        bool autoDeleverageEnabled
    );

    /// @dev Emitted when liquidity is added/removed by owner
    event LiquidityDeposited(address indexed token, uint256 amount);
    event LiquidityWithdrawn(address indexed token, uint256 amount);

    /// @dev Emitted when a new token is configured
    event TokenConfigured(address indexed token, bool isCollateral, bool isBorrowable);

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────

    uint256 constant HF_PRECISION = 1e18; // 18-decimal fixed point
    uint256 constant MIN_HF = 1e18; // HF must stay above 1.0
    uint256 constant DEFAULT_WARNING_HF = 1.6e18;
    uint256 constant DEFAULT_ACTION_HF = 1.4e18;
    uint256 constant MAX_STALE_SECONDS = 3600; // 1 hour price staleness limit
    uint256 constant BASIS_POINTS = 10_000;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Address authorized to execute agent protection actions
    address public agentKeeper;

    /// @notice Supported token registry
    mapping(address => TokenConfig) public tokenConfigs;
    address[] public supportedTokens; // for iteration

    /// @notice User positions  (user → Position)
    mapping(address => Position) private _positions;

    /// @notice User agent configurations  (user → AgentConfig)
    mapping(address => AgentConfig) public agentConfigs;

    /// @notice Protocol-held liquidity per token (for borrowing)
    mapping(address => uint256) public liquidity;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _agentKeeper Address of the off-chain agent wallet.
     *                     Can be a multisig or a dedicated EOA.
     */
    constructor(address _agentKeeper) Ownable(msg.sender) {
        agentKeeper = _agentKeeper;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyAgentKeeper() {
        if (msg.sender != agentKeeper) revert Unauthorized(msg.sender);
        _;
    }

    modifier tokenSupported(address token) {
        if (!tokenConfigs[token].isActive) revert TokenNotSupported(token);
        _;
    }

    modifier notZero(uint256 amount) {
        if (amount == 0) revert ZeroAmount();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner administration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register or update a supported token.
     * @param token               ERC-20 address
     * @param priceFeed           Chainlink AggregatorV3 feed address
     * @param liquidationThreshold Basis points, e.g. 8000 = 80 %
     * @param liquidationBonus    Basis points, e.g. 500  =  5 %
     * @param isCollateral        Can users deposit this as collateral?
     * @param isBorrowable        Can users borrow this token?
     */
    function configureToken(
        address token,
        address priceFeed,
        uint16 liquidationThreshold,
        uint16 liquidationBonus,
        bool isCollateral,
        bool isBorrowable
    ) external onlyOwner {
        require(liquidationThreshold <= BASIS_POINTS, "threshold > 100%");
        require(priceFeed != address(0), "zero feed");

        AggregatorV3Interface feed = AggregatorV3Interface(priceFeed);

        // track new tokens for iteration
        if (!tokenConfigs[token].isActive) {
            supportedTokens.push(token);
        }

        tokenConfigs[token] = TokenConfig({
            priceFeed: feed,
            feedDecimals: feed.decimals(),
            tokenDecimals: _erc20Decimals(token),
            liquidationThreshold: liquidationThreshold,
            liquidationBonus: liquidationBonus,
            isCollateral: isCollateral,
            isBorrowable: isBorrowable,
            isActive: true
        });

        emit TokenConfigured(token, isCollateral, isBorrowable);
    }

    /// @notice Soft-disable a token without removing its config
    function deactivateToken(address token) external onlyOwner {
        tokenConfigs[token].isActive = false;
    }

    /// @notice Update the agent keeper address (e.g. rotate keys)
    function setAgentKeeper(address newKeeper) external onlyOwner {
        agentKeeper = newKeeper;
    }

    /// @notice Owner deposits protocol liquidity for borrowing
    function depositLiquidity(address token, uint256 amount)
        external
        onlyOwner
        tokenSupported(token)
        notZero(amount)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        liquidity[token] += amount;
        emit LiquidityDeposited(token, amount);
    }

    /// @notice Owner withdraws idle protocol liquidity
    function withdrawLiquidity(address token, uint256 amount) external onlyOwner notZero(amount) {
        if (liquidity[token] < amount) {
            revert InsufficientBorrowLiquidity(token, amount, liquidity[token]);
        }
        liquidity[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(token, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Agent configuration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Configure the AI agent's safety rules for your position.
     * @param warningHF    HF level at which you want a warning alert (e.g. 1.6e18)
     * @param actionHF     HF level at which the agent may act autonomously (e.g. 1.4e18)
     * @param maxRepayBP   Max % of total debt the agent can repay in one tx (basis points)
     * @param autoRepay    Consent for autonomous partial repayment
     * @param autoDelevg   Consent for autonomous deleveraging
     */
    function setAgentConfig(
        uint256 warningHF,
        uint256 actionHF,
        uint16 maxRepayBP,
        bool autoRepay,
        bool autoDelevg
    ) external {
        if (warningHF <= actionHF) revert InvalidThreshold();
        if (actionHF <= MIN_HF) revert InvalidThreshold();
        if (maxRepayBP > BASIS_POINTS) revert InvalidThreshold();

        agentConfigs[msg.sender] = AgentConfig({
            warningThresholdHF: warningHF,
            actionThresholdHF: actionHF,
            maxRepayBasisPoints: maxRepayBP,
            autoRepayEnabled: autoRepay,
            autoDeleverageEnabled: autoDelevg
        });

        emit AgentConfigUpdated(msg.sender, warningHF, actionHF, autoRepay, autoDelevg);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User: Core position management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit collateral into your vault position.
     * @param token  ERC-20 token address (must be configured as collateral)
     * @param amount Amount in token's native decimals
     */
    function depositCollateral(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        tokenSupported(token)
        notZero(amount)
    {
        TokenConfig storage cfg = tokenConfigs[token];
        if (!cfg.isCollateral) revert TokenNotSupported(token);

        _ensurePositionExists(msg.sender);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _positions[msg.sender].collateral[token] += amount;

        uint256 newHF = _updateHealthFactor(msg.sender);

        emit PositionUpdated(msg.sender, token, "deposit", amount, newHF);
    }

    /**
     * @notice Borrow a supported token against your collateral.
     * @param token  ERC-20 token to borrow (must be configured as borrowable)
     * @param amount Amount in token's native decimals
     */
    function borrow(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        tokenSupported(token)
        notZero(amount)
    {
        TokenConfig storage cfg = tokenConfigs[token];
        if (!cfg.isBorrowable) revert TokenNotSupported(token);
        if (liquidity[token] < amount) {
            revert InsufficientBorrowLiquidity(token, amount, liquidity[token]);
        }

        _ensurePositionExists(msg.sender);

        // Increase debt first, then check HF (optimistic approach with revert guard)
        _positions[msg.sender].borrowed[token] += amount;
        liquidity[token] -= amount;

        uint256 newHF = _updateHealthFactor(msg.sender);

        // Revert if borrow makes position undercollateralised
        if (newHF < MIN_HF) {
            revert HealthFactorTooLow(newHF, MIN_HF);
        }

        IERC20(token).safeTransfer(msg.sender, amount);

        emit PositionUpdated(msg.sender, token, "borrow", amount, newHF);
    }

    /**
     * @notice Repay borrowed tokens (full or partial).
     * @param token  Token to repay
     * @param amount Amount to repay (capped at full debt to prevent over-repay)
     */
    function repay(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        tokenSupported(token)
        notZero(amount)
    {
        Position storage pos = _positions[msg.sender];
        uint256 debt = pos.borrowed[token];

        // Silently cap at full debt (UX convenience)
        uint256 repayAmount = amount > debt ? debt : amount;
        if (repayAmount == 0) revert RepayExceedsDebt(amount, 0);

        IERC20(token).safeTransferFrom(msg.sender, address(this), repayAmount);
        pos.borrowed[token] -= repayAmount;
        liquidity[token] += repayAmount;

        uint256 newHF = _updateHealthFactor(msg.sender);

        emit PositionUpdated(msg.sender, token, "repay", repayAmount, newHF);
    }

    /**
     * @notice Withdraw collateral (only if HF remains healthy after withdrawal).
     * @param token  Collateral token to withdraw
     * @param amount Amount to withdraw
     */
    function withdrawCollateral(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        tokenSupported(token)
        notZero(amount)
    {
        Position storage pos = _positions[msg.sender];
        if (pos.collateral[token] < amount) {
            revert InsufficientCollateral(token, amount, pos.collateral[token]);
        }

        pos.collateral[token] -= amount;

        uint256 newHF = _updateHealthFactor(msg.sender);

        // Prevent withdrawal that would under-collateralise
        if (newHF < MIN_HF) {
            revert HealthFactorTooLow(newHF, MIN_HF);
        }

        IERC20(token).safeTransfer(msg.sender, amount);

        emit PositionUpdated(msg.sender, token, "withdraw", amount, newHF);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Agent: Protection actions (called by agentKeeper only)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Agent-triggered partial repayment to raise a user's HF.
     * @dev    Funds must already be in the contract (agent pre-approved transfer
     *         or flash-funded route). Bounded by AgentConfig.maxRepayBasisPoints.
     *
     * @param user        Position owner
     * @param token       Debt token to repay
     * @param amount      Amount to repay on the user's behalf
     */
    function agentPartialRepay(address user, address token, uint256 amount)
        external
        nonReentrant
        onlyAgentKeeper
        whenNotPaused
        notZero(amount)
    {
        AgentConfig storage cfg = agentConfigs[user];

        // Require user consent for autonomous repay
        if (!cfg.autoRepayEnabled) revert Unauthorized(user);

        Position storage pos = _positions[user];
        uint256 debt = pos.borrowed[token];
        if (debt == 0) revert RepayExceedsDebt(amount, 0);

        // Enforce the user's max repay limit
        uint256 maxAllowed = (debt * cfg.maxRepayBasisPoints) / BASIS_POINTS;
        if (amount > maxAllowed) {
            revert ExceedsAgentRepayLimit(amount, maxAllowed);
        }

        uint256 hfBefore = pos.lastHealthFactor;

        // Agent transfers funds into contract on behalf of user
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        pos.borrowed[token] -= amount;
        liquidity[token] += amount;

        uint256 hfAfter = _updateHealthFactor(user);

        emit ProtectionTriggered(
            user, msg.sender, "PARTIAL_REPAY", token, amount, hfBefore, hfAfter
        );
    }

    /**
     * @notice Agent-triggered emergency deleveraging.
     *         Withdraws a portion of collateral, swaps it to repay debt.
     *         For MVP: performs a direct collateral-to-repay accounting
     *         (assumes the agent has pre-arranged the swap off-chain or via
     *         a DEX router call before calling this).
     *
     * @param user              Position owner
     * @param collateralToken   Token to pull from collateral
     * @param debtToken         Token to repay
     * @param collateralAmount  Amount of collateral to release
     * @param debtRepayAmount   Amount of debt to clear (post-swap proceeds)
     */
    function agentEmergencyDeleverage(
        address user,
        address collateralToken,
        address debtToken,
        uint256 collateralAmount,
        uint256 debtRepayAmount
    ) external nonReentrant onlyAgentKeeper whenNotPaused {
        AgentConfig storage cfg = agentConfigs[user];
        if (!cfg.autoDeleverageEnabled) revert Unauthorized(user);

        Position storage pos = _positions[user];

        if (pos.collateral[collateralToken] < collateralAmount) {
            revert InsufficientCollateral(
                collateralToken, collateralAmount, pos.collateral[collateralToken]
            );
        }

        uint256 debt = pos.borrowed[debtToken];
        uint256 maxAllowed = (debt * cfg.maxRepayBasisPoints) / BASIS_POINTS;
        if (debtRepayAmount > maxAllowed) {
            revert ExceedsAgentRepayLimit(debtRepayAmount, maxAllowed);
        }

        uint256 hfBefore = pos.lastHealthFactor;

        // Release collateral, reduce debt
        pos.collateral[collateralToken] -= collateralAmount;
        pos.borrowed[debtToken] -= debtRepayAmount;
        liquidity[debtToken] += debtRepayAmount;

        // Transfer released collateral to agent (agent handles swap externally)
        IERC20(collateralToken).safeTransfer(msg.sender, collateralAmount);

        uint256 hfAfter = _updateHealthFactor(user);

        emit ProtectionTriggered(
            user, msg.sender, "DELEVERAGE", collateralToken, collateralAmount, hfBefore, hfAfter
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View functions (called by agent and frontend)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the token configuration of the token passed
     */

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return tokenConfigs[token];
    }
    /**
     * @notice Returns the configuration of the agent passed
     */

    function getAgentConfig(address user) external view returns (AgentConfig memory) {
        return agentConfigs[user];
    }

    /**
     * @notice Returns the current health factor for a user (18-decimal).
     *         Returns type(uint256).max if user has no debt.
     */
    function getHealthFactor(address user) external view returns (uint256) {
        return _computeHealthFactor(user);
    }

    /**
     * @notice Returns collateral balance for a specific token.
     */
    function getCollateral(address user, address token) external view returns (uint256) {
        return _positions[user].collateral[token];
    }

    /**
     * @notice Returns borrowed balance for a specific token.
     */
    function getBorrowed(address user, address token) external view returns (uint256) {
        return _positions[user].borrowed[token];
    }

    /**
     * @notice Returns total collateral value in USD (18-decimal).
     */
    function getTotalCollateralUSD(address user) external view returns (uint256) {
        return _totalCollateralValueUSD(user);
    }

    /**
     * @notice Returns total debt value in USD (18-decimal).
     */
    function getTotalDebtUSD(address user) external view returns (uint256) {
        return _totalDebtValueUSD(user);
    }

    /**
     * @notice Returns a user's full position snapshot for the frontend.
     */
    function getPositionSummary(address user)
        external
        view
        returns (
            uint256 totalCollateralUSD,
            uint256 totalDebtUSD,
            uint256 healthFactor,
            uint256 lastUpdate
        )
    {
        totalCollateralUSD = _totalCollateralValueUSD(user);
        totalDebtUSD = _totalDebtValueUSD(user);
        healthFactor = _computeHealthFactor(user);
        lastUpdate = _positions[user].lastUpdateTime;
    }

    /**
     * @notice Simulate HF after a hypothetical price change.
     *         Used by the frontend What-If simulator and the agent risk engine.
     * @param user          Position owner
     * @param token         Token whose price is being shocked
     * @param priceChangeBP Price change in basis points (signed: negative = drop)
     *                      e.g. -1000 = -10 % price drop
     */
    function simulateHealthFactor(address user, address token, int256 priceChangeBP)
        external
        view
        returns (uint256 simulatedHF)
    {
        // Get all token prices with the shock applied to `token`
        uint256 adjCollateralUSD = 0;
        uint256 adjDebtUSD = 0;

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address t = supportedTokens[i];
            TokenConfig storage cfg = tokenConfigs[t];
            if (!cfg.isActive) continue;

            uint256 price = _getPrice(t);

            // Apply price shock to the specified token
            if (t == token) {
                int256 shockedPrice =
                    int256(price) + (int256(price) * priceChangeBP) / int256(BASIS_POINTS);
                price = shockedPrice > 0 ? uint256(shockedPrice) : 0;
            }

            uint256 collateral = _positions[user].collateral[t];
            if (collateral > 0 && cfg.isCollateral) {
                uint256 valueUSD = _toUSD(collateral, price, cfg.tokenDecimals);
                adjCollateralUSD += (valueUSD * cfg.liquidationThreshold) / BASIS_POINTS;
            }

            uint256 borrowed = _positions[user].borrowed[t];
            if (borrowed > 0) {
                adjDebtUSD += _toUSD(borrowed, price, cfg.tokenDecimals);
            }
        }

        if (adjDebtUSD == 0) return type(uint256).max;
        simulatedHF = (adjCollateralUSD * HF_PRECISION) / adjDebtUSD;
    }

    /**
     * @notice Returns all supported token addresses (for frontend enumeration).
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Initialize position struct for a new user
    function _ensurePositionExists(address user) internal {
        if (!_positions[user].exists) {
            _positions[user].exists = true;
            // Default agent config
            agentConfigs[user] = AgentConfig({
                warningThresholdHF: DEFAULT_WARNING_HF,
                actionThresholdHF: DEFAULT_ACTION_HF,
                maxRepayBasisPoints: 2000, // 20 % default
                autoRepayEnabled: false, // opt-in only
                autoDeleverageEnabled: false
            });
        }
    }

    /**
     * @dev Recalculate and persist the user's HF.
     *      Emits HealthFactorChanged if the band changes.
     */
    function _updateHealthFactor(address user) internal returns (uint256 newHF) {
        uint256 oldHF = _positions[user].lastHealthFactor;
        newHF = _computeHealthFactor(user);

        _positions[user].lastHealthFactor = newHF;
        _positions[user].lastUpdateTime = block.timestamp;

        string memory oldBand = _hfBand(oldHF, user);
        string memory newBand = _hfBand(newHF, user);

        // Only emit if band changed (saves gas on no-op updates)
        if (keccak256(bytes(oldBand)) != keccak256(bytes(newBand))) {
            emit HealthFactorChanged(user, oldHF, newHF, newBand);
        }
    }

    /// @dev Pure HF computation — does NOT persist to storage
    function _computeHealthFactor(address user) internal view returns (uint256) {
        uint256 totalDebtUSD = _totalDebtValueUSD(user);
        if (totalDebtUSD == 0) return type(uint256).max;

        uint256 adjustedCollateralUSD = _totalCollateralValueUSD(user);
        return (adjustedCollateralUSD * HF_PRECISION) / totalDebtUSD;
    }

    /// @dev Sum of (collateral × price × liqThreshold) across all tokens
    function _totalCollateralValueUSD(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i];
            TokenConfig storage cfg = tokenConfigs[token];
            if (!cfg.isActive || !cfg.isCollateral) continue;

            uint256 collateral = _positions[user].collateral[token];
            if (collateral == 0) continue;

            uint256 price = _getPrice(token);
            uint256 valueUSD = _toUSD(collateral, price, cfg.tokenDecimals);
            total += (valueUSD * cfg.liquidationThreshold) / BASIS_POINTS;
        }
    }

    /// @dev Sum of (borrowed × price) across all tokens
    function _totalDebtValueUSD(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i];
            TokenConfig storage cfg = tokenConfigs[token];
            if (!cfg.isActive) continue;

            uint256 borrowed = _positions[user].borrowed[token];
            if (borrowed == 0) continue;

            uint256 price = _getPrice(token);
            total += _toUSD(borrowed, price, cfg.tokenDecimals);
        }
    }

    /**
     * @dev Fetch the latest Chainlink price, normalised to 18 decimals.
     *      Reverts on stale data.
     */
    function _getPrice(address token) internal view returns (uint256) {
        TokenConfig storage cfg = tokenConfigs[token];
        (
            /* roundId */,
            int256 answer,
            /* startedAt */,
            uint256 updatedAt,
            /* answeredInRound */
        ) = cfg.priceFeed.latestRoundData();

        if (block.timestamp - updatedAt > MAX_STALE_SECONDS) {
            revert StalePrice(address(cfg.priceFeed), updatedAt);
        }

        // Normalise to 18 decimals
        // Chainlink feeds are typically 8 decimals
        uint8 feedDec = cfg.feedDecimals;
        uint256 price = uint256(answer);
        if (feedDec < 18) {
            price = price * (10 ** (18 - feedDec));
        } else if (feedDec > 18) {
            price = price / (10 ** (feedDec - 18));
        }
        return price;
    }

    /**
     * @dev Convert a raw token amount to USD value (18-decimal).
     * @param amount      Raw token units
     * @param priceUSD18  Price per 1 full token in USD, 18-decimal
     * @param tokenDec    Token's own decimals
     */
    function _toUSD(uint256 amount, uint256 priceUSD18, uint8 tokenDec)
        internal
        pure
        returns (uint256)
    {
        // Normalise token amount to 18 decimals, then multiply by price
        uint256 normalised =
            tokenDec < 18 ? amount * (10 ** (18 - tokenDec)) : amount / (10 ** (tokenDec - 18));
        return (normalised * priceUSD18) / HF_PRECISION;
    }

    /**
     * @dev Return a string band label based on HF relative to user's thresholds.
     */
    function _hfBand(uint256 hf, address user) internal view returns (string memory) {
        AgentConfig storage cfg = agentConfigs[user];
        if (hf >= cfg.warningThresholdHF) return "SAFE";
        if (hf >= cfg.actionThresholdHF) return "WARNING";
        if (hf >= MIN_HF) return "ACTION";
        return "CRITICAL";
    }

    /// @dev Safely read ERC-20 decimals (falls back to 18 on failure)
    function _erc20Decimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }
}

// Minimal interface needed for decimals() call
interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}
