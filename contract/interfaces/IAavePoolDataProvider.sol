// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAavePoolDataProvider {
    /**
     * @notice Returns token balances for a specific user and reserve.
     * @return currentATokenBalance     aToken balance (= collateral amount)
     * @return currentStableDebt
     * @return currentVariableDebt      Variable rate debt (most common)
     * @return principalStableDebt
     * @return scaledVariableDebt
     * @return stableBorrowRate
     * @return liquidityRate
     * @return stableRateLastUpdated
     * @return usageAsCollateralEnabled
     */
    function getUserReserveData(address asset, address user)
        external
        view
        returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        );

    /**
     * @notice Returns all reserve token addresses.
     */
    function getAllReservesTokens()
        external
        view
        returns (
            // (symbol, address)[]
            TokenData[] memory
        );

    struct TokenData {
        string symbol;
        address tokenAddress;
    }
}
