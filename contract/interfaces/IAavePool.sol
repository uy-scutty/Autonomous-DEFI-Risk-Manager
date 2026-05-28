// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAavePool {
    /**
     * @notice Returns the user account data across all reserves.
     * @return totalCollateralBase     Total collateral in USD, 8 decimals
     * @return totalDebtBase           Total debt in USD, 8 decimals
     * @return availableBorrowsBase    Available to borrow in USD, 8 decimals
     * @return currentLiquidationThreshold  Weighted avg liq threshold, 4 dec (e.g. 8250 = 82.5%)
     * @return ltv                     Weighted avg LTV, 4 decimals
     * @return healthFactor            18 decimals. type(uint256).max = no debt
     */
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    /**
     * @notice Repays a borrowed asset on behalf of a user.
     * @param asset             The borrowed asset address
     * @param amount            Amount to repay (use type(uint256).max for full repay)
     * @param interestRateMode  1 = stable, 2 = variable
     * @param onBehalfOf        The user whose debt to repay
     * @return                  The actual amount repaid
     */
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    /**
     * @notice Supplies an asset as collateral on behalf of a user.
     * @param asset        The asset to supply
     * @param amount       Amount to supply
     * @param onBehalfOf   Who receives the aToken (the user)
     * @param referralCode Use 0
     */
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /**
     * @notice Withdraws an asset from the user's Aave collateral.
     *         Can only be called by the user themselves OR an approved operator.
     *         For deleverage: user must have approved this contract as an operator.
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
