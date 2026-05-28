const AaveAdapter = [
  // Position reads
  "function getUserPosition(address user) external view returns (tuple(address user, uint256 totalCollateralUSD, uint256 totalDebtUSD, uint256 availableBorrowsUSD, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor, uint256 netWorthUSD, bool isAtRisk))",
  "function getHealthFactor(address user) external view returns (uint256)",
  "function getUserDebt(address user, address asset) external view returns (uint256 variableDebt, uint256 stableDebt)",
  "function getUserCollateral(address user, address asset) external view returns (uint256 aTokenBalance, bool usedAsCollateral)",
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function getAssetPrices(address[] calldata assets) external view returns (uint256[])",
  // Simulation
  "function simulateHFAfterRepay(address user, uint256 repayUSD) external view returns (uint256)",
  "function simulateHFAfterSupply(address user, uint256 addCollateralUSD) external view returns (uint256)",
  "function simulateHFAfterPriceShock(address user, address asset, int256 priceChangeBP) external view returns (uint256)",
  // Write (only callable by ProtectionActions)
  "function repayDebt(address user, address asset, uint256 amount) external returns (uint256)",
  "function supplyCollateral(address user, address asset, uint256 amount) external",
  // Events
  "event RepayExecuted(address indexed user, address indexed asset, uint256 requestedAmount, uint256 actualAmount, uint256 healthFactorBefore, uint256 healthFactorAfter)",
  "event CollateralSupplied(address indexed user, address indexed asset, uint256 amount, uint256 healthFactorBefore, uint256 healthFactorAfter)",
];

const AgentRegistry = [
  "function getConfig(address user) external view returns (tuple(uint256 warningThresholdHF, uint256 actionThresholdHF, bool autoRepayEnabled, bool autoDeleverageEnabled, bool alertOnlyMode, uint16 maxRepayBasisPoints, uint16 maxDeleverageBP, bool agentEnabled, uint256 lastConfigUpdate, uint256 totalActionsExecuted, uint256 totalValueProtectedUSD))",
  "function getAgentDecisionParams(address user) external view returns (bool agentEnabled, bool alertOnly, bool canRepay, bool canDeleverage, uint256 warningHF, uint256 actionHF, uint16 maxRepayBP, uint16 maxDelgBP)",
  "function isAuthorisedKeeper(address user, address keeper) external view returns (bool)",
  "function recordAction(address user, string calldata actionType, uint256 valueUSD18) external",
  "function getUserStats(address user) external view returns (uint256 totalActions, uint256 totalValueProtectedUSD, uint256 lastConfigUpdate)",
  "function hasConfig(address user) external view returns (bool)",
  "event AgentConfigUpdated(address indexed user, uint256 warningThresholdHF, uint256 actionThresholdHF, bool autoRepayEnabled, bool autoDeleverageEnabled, bool alertOnlyMode, bool agentEnabled)",
  "event AgentKillSwitchToggled(address indexed user, bool enabled)",
];

const ProtectionActions = [
  // Actions
  "function executePartialRepay(tuple(address user, address debtAsset, uint256 repayAmount) params) external",
  "function executeCollateralTopUp(tuple(address user, address collateralAsset, uint256 amount) params) external",
  "function executeFlashDeleverage(tuple(address user, address collateralAsset, address debtAsset, uint256 collateralAmount, uint256 minDebtRepaid, uint24 poolFee) params) external",
  "function batchPartialRepay(tuple(address user, address debtAsset, uint256 repayAmount)[] params) external",
  // Views
  "function canExecuteRepay(address user, address debtAsset, uint256 amount) external view returns (bool permitted, string memory reason)",
  "function simulateRepayImpact(address user, address debtAsset, uint256 repayAmount) external view returns (uint256 currentHF, uint256 projectedHF)",
  // Events
  "event ProtectionExecuted(address indexed user, address indexed keeper, string actionType, address asset, uint256 amount, uint256 hfBefore, uint256 hfAfter, uint256 timestamp)",
  "event ProtectionFailed(address indexed user, string actionType, string reason, uint256 timestamp)",
];

module.exports = {
  AaveAdapter,
  AgentRegistry,
  ProtectionActions,
};
