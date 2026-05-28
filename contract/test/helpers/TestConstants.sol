// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestConstants {
    // Aave v3 Arbitrum One addresses (mocked in tests)
    address constant MOCK_AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant MOCK_DATA_PROVIDER = 0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654;
    address constant MOCK_AAVE_ORACLE = 0xb56c2f0B653173F1eB93B11a756EEae4e26e7E54;
    address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // Test addresses
    address constant USER = 0x1111111111111111111111111111111111111111;
    address constant KEEPER = 0x2222222222222222222222222222222222222222;
    address constant OTHER_USER = 0x3333333333333333333333333333333333333333;
    address constant PROTOCOL_OWNER = 0x4444444444444444444444444444444444444444;

    // Token addresses (Arbitrum One)
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

    // aToken addresses (Aave v3 Arbitrum One)
    address constant aWETH = 0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8;
    address constant aUSDC = 0x724dc807b04555b71ed48a6896b6F41593b8C637;
    address constant aWBTC = 0x078f358208685046a11C85e8ad32895DED33A249;
    address constant aARB = 0x6533afac2E7BCCB20dca161449A13A32D391fb00;

    // Constants
    uint256 constant HF_PRECISION = 1e18;
    uint256 constant BASIS_POINTS = 10_000;
    uint256 constant DEFAULT_WARNING_HF = 1.6e18;
    uint256 constant DEFAULT_ACTION_HF = 1.4e18;
    uint256 constant MIN_HF = 1e18;
    uint256 constant MAX_WARNING_HF = 3e18;

    // Default test amounts
    uint256 constant DEFAULT_REPAY_AMOUNT = 1000e6; // 1000 USDC
    uint256 constant DEFAULT_COLLATERAL_AMOUNT = 1e18; // 1 WETH
}
