// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAaveOracle {
    /**
     * @notice Returns the price of an asset in USD, 8 decimals.
     */
    function getAssetPrice(address asset) external view returns (uint256);

    /**
     * @notice Returns prices for multiple assets.
     */
    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory);
}
