/**
 * abis.js — Contract ABI definitions
 * ─────────────────────────────────────
 * Only includes the function signatures the agent actually calls.
 * Using minimal ABIs keeps startup fast and avoids loading full build artifacts.
 *
 * To regenerate from Foundry: forge build → copy from out/<Contract>.json
 */

"use strict";

const VaultManager = [
  // View
  "function getSupportedTokens() external view returns (address[])",
  "function getHealthFactor(address user) external view returns (uint256)",
  "function getCollateral(address user, address token) external view returns (uint256)",
  "function getBorrowed(address user, address token) external view returns (uint256)",
  "function getTotalCollateralUSD(address user) external view returns (uint256)",
  "function getTotalDebtUSD(address user) external view returns (uint256)",
  "function getPositionSummary(address user) external view returns (uint256 totalCollateralUSD, uint256 totalDebtUSD, uint256 healthFactor, uint256 lastUpdate)",
  "function simulateHealthFactor(address user, address token, int256 priceChangeBP) external view returns (uint256)",
  "function agentConfigs(address user) external view returns (uint256 warningThresholdHF, uint256 actionThresholdHF, uint16 maxRepayBasisPoints, bool autoRepayEnabled, bool autoDeleverageEnabled)",
  // Agent actions
  "function agentPartialRepay(address user, address token, uint256 amount) external",
  "function agentEmergencyDeleverage(address user, address collateralToken, address debtToken, uint256 collateralAmount, uint256 debtRepayAmount, uint256 unused) external",
  // Events
  "event PositionUpdated(address indexed user, address indexed token, string action, uint256 amount, uint256 newHealthFactor)",
  "event HealthFactorChanged(address indexed user, uint256 oldHF, uint256 newHF, string band)",
  "event ProtectionTriggered(address indexed user, address indexed keeper, string actionType, address token, uint256 amount, uint256 hfBefore, uint256 hfAfter)",
];

const RiskOracle = [
  "function getPrice(address token) external view returns (uint256)",
  "function batchGetPrices(address[] calldata tokens) external view returns (tuple(address token, uint256 priceUSD18, uint256 updatedAt, bool isStale)[])",
  "function computeVolatility(address token, uint256 numRounds) external view returns (tuple(address token, uint256 stdDevBP, uint256 roundsUsed, uint256 windowSeconds))",
  "function getPriceScenarios(address token, int256[] calldata scenariosBP) external view returns (uint256 basePrice, uint256[] memory scenarioPrices)",
  "function batchGetPriceScenarios(address[] calldata tokens, int256[] calldata scenariosBP) external view returns (uint256[] memory basePrices, uint256[][] memory scenarioPrices)",
  "function isPriceFresh(address token) external view returns (bool)",
];

const AgentRegistry = [
  "function getConfig(address user) external view returns (tuple(uint256 warningThresholdHF, uint256 actionThresholdHF, bool autoRepayEnabled, bool autoDeleverageEnabled, bool alertOnlyMode, uint16 maxRepayBasisPoints, uint16 maxDeleverageBP, bool agentEnabled, uint256 lastConfigUpdate, uint256 totalActionsExecuted, uint256 totalValueProtectedUSD))",
  "function getAgentDecisionParams(address user) external view returns (bool agentEnabled, bool alertOnly, bool canRepay, bool canDeleverage, uint256 warningHF, uint256 actionHF, uint16 maxRepayBP, uint16 maxDelgBP)",
  "function isAuthorisedKeeper(address user, address keeper) external view returns (bool)",
  "function recordAction(address user, string calldata actionType, uint256 valueUSD18) external",
  "function getUserStats(address user) external view returns (uint256 totalActions, uint256 totalValueProtectedUSD, uint256 lastConfigUpdate)",
  "event AgentConfigUpdated(address indexed user, uint256 warningThresholdHF, uint256 actionThresholdHF, bool autoRepayEnabled, bool autoDeleverageEnabled, bool alertOnlyMode, bool agentEnabled)",
];

const ProtectionActions = [
  "function executePartialRepay(tuple(address user, address debtToken, uint256 repayAmount, uint256 hfTargetMin) params) external",
  "function executeEmergencyDeleverage(tuple(address user, address collateralToken, address debtToken, uint256 collateralToSell, uint256 minDebtRepaid, uint24 poolFee, uint256 hfTargetMin) params) external",
  "function executeCollateralTopUp(tuple(address user, address collateralToken, uint256 amount) params) external",
  "function canExecuteRepay(address user, address debtToken, uint256 amount) external view returns (bool permitted, string memory reason)",
  "event ProtectionExecuted(address indexed user, address indexed keeper, string actionType, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 hfBefore, uint256 hfAfter, uint256 timestamp)",
  "event ProtectionFailed(address indexed user, string actionType, string reason, uint256 timestamp)",
];

module.exports = {
  VaultManager,
  RiskOracle,
  AgentRegistry,
  ProtectionActions,
};
