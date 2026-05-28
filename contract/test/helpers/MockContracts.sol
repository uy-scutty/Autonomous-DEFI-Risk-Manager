// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Mock Aave Pool
contract MockAavePool {
    mapping(address => mapping(address => uint256)) public userDebt;
    mapping(address => mapping(address => uint256)) public userCollateral;
    mapping(address => uint256) public userTotalCollateral;
    mapping(address => uint256) public userTotalDebt;
    mapping(address => uint256) public userLiquidationThreshold;
    mapping(address => uint256) public userLTV;
    mapping(address => uint256) public userHealthFactor;

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
        external
    {
        userCollateral[onBehalfOf][asset] += amount;
        _updateUserData(onBehalfOf);
    }

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256)
    {
        uint256 debt = userDebt[onBehalfOf][asset];
        uint256 actualRepaid = amount > debt ? debt : amount;
        userDebt[onBehalfOf][asset] -= actualRepaid;
        _updateUserData(onBehalfOf);
        return actualRepaid;
    }

    function withdraw(address asset, uint256 amount, address to) external pure returns (uint256) {
        // Mock implementation
        return amount;
    }

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
        )
    {
        return (
            userTotalCollateral[user],
            userTotalDebt[user],
            0,
            userLiquidationThreshold[user] == 0 ? 8000 : userLiquidationThreshold[user],
            userLTV[user] == 0 ? 7000 : userLTV[user],
            userHealthFactor[user] == 0 ? 1.5e18 : userHealthFactor[user]
        );
    }

    function _updateUserData(address user) internal {
        uint256 totalCollat = 0;
        uint256 totalDebt = 0;

        // Simplified update logic
        userTotalCollateral[user] = totalCollat;
        userTotalDebt[user] = totalDebt;

        if (totalDebt > 0) {
            userHealthFactor[user] = (totalCollat * 8000 / 10000 * 1e18) / totalDebt;
        } else {
            userHealthFactor[user] = type(uint256).max;
        }
    }

    function setUserDebt(address user, address asset, uint256 amount) external {
        userDebt[user][asset] = amount;
        userTotalDebt[user] = amount;
        userHealthFactor[user] = (userTotalCollateral[user] * 8000 / 10000 * 1e18) / amount;
    }

    function setUserCollateral(address user, address asset, uint256 amount) external {
        userCollateral[user][asset] = amount;
        userTotalCollateral[user] = amount;
        if (userTotalDebt[user] > 0) {
            userHealthFactor[user] = (amount * 8000 / 10000 * 1e18) / userTotalDebt[user];
        }
    }
}

// Mock Aave Oracle
contract MockAaveOracle {
    mapping(address => uint256) public prices;

    constructor() {
        // Set default prices (8 decimals)
        prices[0x82aF49447D8a07e3bd95BD0d56f35241523fBab1] = 2000e8; // WETH = $2000
        prices[0xaf88d065e77c8cC2239327C5EDb3A432268e5831] = 1e8; // USDC = $1
        prices[0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f] = 30000e8; // WBTC = $30,000
    }

    function getAssetPrice(address asset) external view returns (uint256) {
        return prices[asset];
    }

    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory) {
        uint256[] memory results = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            results[i] = prices[assets[i]];
        }
        return results;
    }

    function setPrice(address asset, uint256 price) external {
        prices[asset] = price;
    }
}

// Mock Aave Pool Data Provider
// In test/helpers/MockContracts.sol
contract MockAaveDataProvider {
    mapping(address => mapping(address => UserReserveData)) public userReserves;

    struct UserReserveData {
        uint256 aTokenBalance;
        uint256 stableDebt;
        uint256 variableDebt;
        bool usageAsCollateralEnabled;
    }

    // Fix: Return EXACTLY 9 values matching the interface
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
        )
    {
        UserReserveData storage data = userReserves[asset][user];
        return (
            data.aTokenBalance, // currentATokenBalance
            data.stableDebt, // currentStableDebt
            data.variableDebt, // currentVariableDebt
            0, // principalStableDebt
            0, // scaledVariableDebt
            0, // stableBorrowRate
            0, // liquidityRate
            uint40(0), // stableRateLastUpdated
            data.usageAsCollateralEnabled // usageAsCollateralEnabled
        );
    }

    function setUserReserve(
        address asset,
        address user,
        uint256 aTokenBal,
        uint256 variableDebt,
        bool asCollateral
    ) external {
        userReserves[asset][user] = UserReserveData({
            aTokenBalance: aTokenBal,
            stableDebt: 0,
            variableDebt: variableDebt,
            usageAsCollateralEnabled: asCollateral
        });
    }
}

// Mock ERC20
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

// Mock Swap Router
contract MockSwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        // Mock: 1:1 swap with 0.3% fee
        amountOut = (params.amountIn * 9970) / 10000;

        // Transfer tokens (simplified)
        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);

        return amountOut;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}
