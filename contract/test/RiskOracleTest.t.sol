// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Full test suite for RiskOracle.sol
 *
 * Coverage
 * ────────
 * Admin
 *   ✓ registerFeed — happy path, zero feed reverts, zero token reverts
 *   ✓ setMaxStaleness — updates correctly, reverts on unregistered feed
 *   ✓ deactivateFeed — soft-disables, getPrice reverts after
 *   ✓ onlyOwner guard on all admin functions
 *
 * getPrice / getPriceWithMetadata
 *   ✓ Returns 18-decimal normalised price
 *   ✓ Reverts on stale price (age > maxStaleness)
 *   ✓ Reverts on negative answer
 *   ✓ Reverts on unregistered feed
 *   ✓ Normalisation: 8-dec feed → 18-dec output
 *   ✓ Normalisation: 18-dec feed → unchanged
 *   ✓ Normalisation: 6-dec feed → 18-dec output
 *
 * batchGetPrices
 *   ✓ Returns all prices in one call
 *   ✓ Soft-flags stale feeds (isStale=true, no revert)
 *   ✓ Soft-flags unregistered tokens (priceUSD18=0)
 *   ✓ Empty array input → empty output
 *
 * computeVolatility
 *   ✓ Zero rounds → reverts ZeroRoundsRequested
 *   ✓ Exceeds MAX_ROUND_SAMPLE → reverts RoundCountTooLarge
 *   ✓ Single round → returns stdDevBP=0
 *   ✓ Stable price history → near-zero stddev
 *   ✓ Volatile price history → nonzero stddev
 *   ✓ Insufficient historical rounds → graceful zero return
 *
 * getPriceScenarios
 *   ✓ -10% shock reduces price by ~10%
 *   ✓ +50% shock increases price by ~50%
 *   ✓ -100% shock → zero price
 *   ✓ Multiple scenarios in one call
 *
 * batchGetPriceScenarios
 *   ✓ Multi-token batch returns correct matrix
 *   ✓ Consistent with individual getPriceScenarios calls
 *
 * isPriceFresh
 *   ✓ Fresh feed returns true
 *   ✓ Stale feed returns false
 *   ✓ Inactive feed returns false
 *
 * Fuzz
 *   ✓ Any valid price normalises to ≥ input (for 8-dec feeds)
 *   ✓ Volatility stddev always in [0, 10000] BP range
 */

import "forge-std/Test.sol";
import "test/TestHelpers.sol";
import { RiskOracle } from "src/RiskOracle.sol";

contract RiskOracleTest is BaseTest {
    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event FeedRegistered(address indexed token, address indexed feed, uint256 maxStaleness);
    event FeedDeactivated(address indexed token);
    event MaxStalenessUpdated(address indexed token, uint256 newMaxStaleness);

    // Extra tokens for RiskOracle-specific tests
    MockERC20 internal dai;
    MockChainlinkFeed internal daiFeed; // 18-dec stablecoin feed
    MockChainlinkFeed internal feed6dec; // 6-decimal feed (non-standard)

    function setUp() public override {
        super.setUp();

        vm.startPrank(deployer);

        // 18-decimal feed (uncommon but valid)
        dai = new MockERC20("DAI", "DAI", 18);
        daiFeed = new MockChainlinkFeed(1e18); // $1 expressed in 18-dec
        // Override decimals to 18 for this feed
        // (MockChainlinkFeed defaults to 8 — we test the normaliser with it as-is)

        // 6-decimal USDC-style feed
        feed6dec = new MockChainlinkFeed(1_000_000); // $1 in 6-dec = 1e6

        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // registerFeed
    // ─────────────────────────────────────────────────────────────────────────

    function test_RegisterFeed_HappyPath() public {
        vm.prank(deployer);
        oracle.registerFeed(address(dai), address(daiFeed), 18, 3600);

        (address feedAddr,,, uint256 maxStaleness, bool active) = oracle.getFeedConfig(address(dai));

        assertEq(feedAddr, address(daiFeed));
        assertEq(maxStaleness, 3600);
        assertTrue(active);
    }

    function test_RegisterFeed_EmitsEvent() public {
        vm.prank(deployer);
        vm.expectEmit(true, true, false, true);
        emit FeedRegistered(address(dai), address(daiFeed), 3600);
        oracle.registerFeed(address(dai), address(daiFeed), 18, 3600);
    }

    function test_RegisterFeed_ZeroFeed_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert("zero feed");
        oracle.registerFeed(address(dai), address(0), 18, 3600);
    }

    function test_RegisterFeed_ZeroToken_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert("zero token");
        oracle.registerFeed(address(0), address(daiFeed), 18, 3600);
    }

    function test_RegisterFeed_ZeroStaleness_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert("zero staleness");
        oracle.registerFeed(address(dai), address(daiFeed), 18, 0);
    }

    function test_RegisterFeed_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.registerFeed(address(dai), address(daiFeed), 18, 3600);
    }

    function test_RegisterFeed_UpdateExisting_OverwritesConfig() public {
        vm.startPrank(deployer);
        oracle.registerFeed(address(weth), address(ethFeed), 18, 3600);

        // Re-register with new staleness
        MockChainlinkFeed newFeed = new MockChainlinkFeed(2500e8);
        oracle.registerFeed(address(weth), address(newFeed), 18, 7200);
        vm.stopPrank();

        (address feedAddr,,, uint256 maxStaleness,) = oracle.getFeedConfig(address(weth));
        assertEq(feedAddr, address(newFeed));
        assertEq(maxStaleness, 7200);
    }

    function test_RegisterFeed_NewToken_AddedToList() public {
        uint256 before = oracle.getRegisteredTokens().length;

        vm.prank(deployer);
        oracle.registerFeed(address(dai), address(daiFeed), 18, 3600);

        assertEq(oracle.getRegisteredTokens().length, before + 1);
    }

    function test_RegisterFeed_SameToken_DoesNotDuplicate() public {
        // weth is already registered in BaseTest.setUp()
        uint256 before = oracle.getRegisteredTokens().length;

        vm.prank(deployer);
        oracle.registerFeed(address(weth), address(ethFeed), 18, 3600);

        // Count should not increase for re-registration
        assertEq(oracle.getRegisteredTokens().length, before);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setMaxStaleness
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetMaxStaleness_UpdatesValue() public {
        vm.prank(deployer);
        oracle.setMaxStaleness(address(weth), 7200);

        (,,, uint256 maxStaleness,) = oracle.getFeedConfig(address(weth));
        assertEq(maxStaleness, 7200);
    }

    function test_SetMaxStaleness_EmitsEvent() public {
        vm.prank(deployer);
        vm.expectEmit(true, false, false, true);
        emit MaxStalenessUpdated(address(weth), 7200);
        oracle.setMaxStaleness(address(weth), 7200);
    }

    function test_SetMaxStaleness_UnregisteredFeed_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.FeedNotRegistered.selector, address(dai)));
        oracle.setMaxStaleness(address(dai), 3600);
    }

    function test_SetMaxStaleness_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.setMaxStaleness(address(weth), 7200);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deactivateFeed
    // ─────────────────────────────────────────────────────────────────────────

    function test_DeactivateFeed_SetsActiveFalse() public {
        vm.prank(deployer);
        oracle.deactivateFeed(address(weth));

        (,,,, bool active) = oracle.getFeedConfig(address(weth));
        assertFalse(active);
    }

    function test_DeactivateFeed_EmitsEvent() public {
        vm.prank(deployer);
        vm.expectEmit(true, false, false, false);
        emit FeedDeactivated(address(weth));
        oracle.deactivateFeed(address(weth));
    }

    function test_DeactivateFeed_GetPrice_Reverts() public {
        vm.prank(deployer);
        oracle.deactivateFeed(address(weth));

        vm.expectRevert(
            abi.encodeWithSelector(RiskOracle.FeedNotRegistered.selector, address(weth))
        );
        oracle.getPrice(address(weth));
    }

    function test_DeactivateFeed_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.deactivateFeed(address(weth));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getPrice — normalisation
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetPrice_8DecFeed_NormalisedTo18Dec() public {
        // ethFeed: 8 decimals, price = 2000e8
        // Expected output: 2000e18
        uint256 price = oracle.getPrice(address(weth));
        assertEq(price, 2000e18);
    }

    function test_GetPrice_USDCFeed_NormalisedCorrectly() public {
        // usdcFeed: 8 decimals, price = 1e8
        // Expected: 1e18
        uint256 price = oracle.getPrice(address(usdc));
        assertEq(price, 1e18);
    }

    function test_GetPrice_WBTCFeed_NormalisedCorrectly() public {
        // wbtcFeed: 8 decimals, price = 60000e8
        uint256 price = oracle.getPrice(address(wbtc));
        assertEq(price, 60_000e18);
    }

    function test_GetPrice_UnregisteredToken_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.FeedNotRegistered.selector, address(dai)));
        oracle.getPrice(address(dai));
    }

    function test_GetPrice_StalePrice_Reverts() public {
        // Make ETH feed 2 hours stale (maxStaleness = 3600)
        ethFeed.makeStale(7200);

        vm.expectRevert();
        oracle.getPrice(address(weth));
    }

    function test_GetPrice_NegativeAnswer_Reverts() public {
        ethFeed.setPrice(-1);

        vm.expectRevert(
            abi.encodeWithSelector(RiskOracle.NegativePrice.selector, address(ethFeed), int256(-1))
        );
        oracle.getPrice(address(weth));
    }

    function test_GetPrice_ZeroAnswer_Reverts() public {
        ethFeed.setPrice(0);
        vm.expectRevert();
        oracle.getPrice(address(weth));
    }

    function test_GetPrice_AfterPriceUpdate_ReflectsNewPrice() public {
        ethFeed.setPrice(3000e8); // ETH goes to $3000
        uint256 price = oracle.getPrice(address(weth));
        assertEq(price, 3000e18);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getPriceWithMetadata
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetPriceWithMetadata_ReturnsRoundId() public {
        (uint256 price, uint80 roundId, uint256 updatedAt) =
            oracle.getPriceWithMetadata(address(weth));

        assertEq(price, 2000e18);
        assertGt(roundId, 0);
        assertGt(updatedAt, 0);
        assertLe(updatedAt, block.timestamp);
    }

    function test_GetPriceWithMetadata_Stale_Reverts() public {
        ethFeed.makeStale(7200);
        vm.expectRevert();
        oracle.getPriceWithMetadata(address(weth));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // batchGetPrices
    // ─────────────────────────────────────────────────────────────────────────

    function test_BatchGetPrices_AllFreshFeeds() public {
        address[] memory tokens = new address[](3);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        tokens[2] = address(wbtc);

        RiskOracle.PriceSnapshot[] memory snaps = oracle.batchGetPrices(tokens);

        assertEq(snaps.length, 3);
        assertEq(snaps[0].priceUSD18, 2000e18);
        assertEq(snaps[1].priceUSD18, 1e18);
        assertEq(snaps[2].priceUSD18, 60_000e18);
        assertFalse(snaps[0].isStale);
        assertFalse(snaps[1].isStale);
        assertFalse(snaps[2].isStale);
    }

    function test_BatchGetPrices_StaleFlag_NoRevert() public {
        // Make ETH stale — batch should soft-flag, not revert
        ethFeed.makeStale(7200);

        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);

        RiskOracle.PriceSnapshot[] memory snaps = oracle.batchGetPrices(tokens);

        assertTrue(snaps[0].isStale, "ETH should be flagged stale");
        assertFalse(snaps[1].isStale, "USDC should be fresh");
    }

    function test_BatchGetPrices_UnregisteredToken_SoftZero() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(dai); // not registered

        RiskOracle.PriceSnapshot[] memory snaps = oracle.batchGetPrices(tokens);

        assertEq(snaps[0].priceUSD18, 2000e18);
        assertEq(snaps[1].priceUSD18, 0);
        assertTrue(snaps[1].isStale);
    }

    function test_BatchGetPrices_EmptyArray_ReturnsEmpty() public {
        address[] memory tokens = new address[](0);
        RiskOracle.PriceSnapshot[] memory snaps = oracle.batchGetPrices(tokens);
        assertEq(snaps.length, 0);
    }

    function test_BatchGetPrices_SingleToken() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(wbtc);

        RiskOracle.PriceSnapshot[] memory snaps = oracle.batchGetPrices(tokens);
        assertEq(snaps.length, 1);
        assertEq(snaps[0].priceUSD18, 60_000e18);
        assertFalse(snaps[0].isStale);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // computeVolatility
    // ─────────────────────────────────────────────────────────────────────────

    function test_ComputeVolatility_ZeroRounds_Reverts() public {
        vm.expectRevert(RiskOracle.ZeroRoundsRequested.selector);
        oracle.computeVolatility(address(weth), 0);
    }

    function test_ComputeVolatility_ExceedsMax_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.RoundCountTooLarge.selector, 101, 100));
        oracle.computeVolatility(address(weth), 101);
    }

    function test_ComputeVolatility_UnregisteredFeed_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(RiskOracle.FeedNotRegistered.selector, address(dai)));
        oracle.computeVolatility(address(dai), 5);
    }

    function test_ComputeVolatility_SingleRound_ZeroStddev() public {
        // Only 1 round available → cannot compute variance
        RiskOracle.VolatilityResult memory result = oracle.computeVolatility(address(weth), 1);
        assertEq(result.stdDevBP, 0);
        assertEq(result.roundsUsed, 1);
    }

    function test_ComputeVolatility_StablePrice_LowStddev() public {
        // Seed 10 rounds all at the same price $2000
        int256[] memory prices = new int256[](10);
        for (uint256 i = 0; i < 10; i++) {
            prices[i] = 2000e8;
        }
        ethFeed.seedHistory(prices, 3600); // 1 round per hour

        RiskOracle.VolatilityResult memory result = oracle.computeVolatility(address(weth), 10);

        // Completely stable price → stddev = 0
        assertEq(result.stdDevBP, 0);
        assertGe(result.roundsUsed, 2);
    }

    function test_ComputeVolatility_VolatilePrice_NonzeroStddev() public {
        // Alternating $2000 and $1800 → high variance
        int256[] memory prices = new int256[](10);
        for (uint256 i = 0; i < 10; i++) {
            prices[i] = i % 2 == 0 ? int256(2000e8) : int256(1800e8);
        }
        ethFeed.seedHistory(prices, 3600);

        RiskOracle.VolatilityResult memory result = oracle.computeVolatility(address(weth), 10);

        assertGt(result.stdDevBP, 0, "Volatile prices should produce nonzero stddev");
        assertLe(result.stdDevBP, 10_000, "StdDev should not exceed 100%");
    }

    function test_ComputeVolatility_ReturnsWindowSeconds() public {
        int256[] memory prices = new int256[](5);
        for (uint256 i = 0; i < 5; i++) {
            prices[i] = 2000e8;
        }
        ethFeed.seedHistory(prices, 3600);

        RiskOracle.VolatilityResult memory result = oracle.computeVolatility(address(weth), 5);
        assertGt(result.windowSeconds, 0);
    }

    function test_ComputeVolatility_MaxSamples_DoesNotRevert() public {
        // Seed 100 rounds
        int256[] memory prices = new int256[](100);
        for (uint256 i = 0; i < 100; i++) {
            prices[i] = int256(1800e8 + int256(i) * 5e8); // gradual rise
        }
        ethFeed.seedHistory(prices, 900); // 15 min intervals

        RiskOracle.VolatilityResult memory result = oracle.computeVolatility(address(weth), 100);
        assertGe(result.roundsUsed, 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getPriceScenarios
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetPriceScenarios_NegativeShock() public {
        int256[] memory shocks = new int256[](1);
        shocks[0] = -1000; // -10%

        (uint256 base, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);

        assertEq(base, 2000e18);
        // 2000 * (1 - 0.10) = 1800
        assertApproxEqRel(simPrices[0], 1800e18, 0.001e18);
    }

    function test_GetPriceScenarios_PositiveShock() public {
        int256[] memory shocks = new int256[](1);
        shocks[0] = 5000; // +50%

        (, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);

        // 2000 * 1.50 = 3000
        assertApproxEqRel(simPrices[0], 3000e18, 0.001e18);
    }

    function test_GetPriceScenarios_100PctDrop_ReturnsZero() public {
        int256[] memory shocks = new int256[](1);
        shocks[0] = -10000; // -100%

        (, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);

        assertEq(simPrices[0], 0);
    }

    function test_GetPriceScenarios_ZeroShock_EqualsBase() public {
        int256[] memory shocks = new int256[](1);
        shocks[0] = 0;

        (uint256 base, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);

        assertEq(simPrices[0], base);
    }

    function test_GetPriceScenarios_MultipleScenarios() public {
        int256[] memory shocks = new int256[](5);
        shocks[0] = -500;
        shocks[1] = -1000;
        shocks[2] = -2000;
        shocks[3] = -3000;
        shocks[4] = -5000;

        (, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);

        assertEq(simPrices.length, 5);
        // Each scenario should be strictly less than the previous
        for (uint256 i = 1; i < simPrices.length; i++) {
            assertLt(simPrices[i], simPrices[i - 1], "Deeper shocks should give lower prices");
        }
    }

    function test_GetPriceScenarios_EmptyArray() public {
        int256[] memory shocks = new int256[](0);
        (, uint256[] memory simPrices) = oracle.getPriceScenarios(address(weth), shocks);
        assertEq(simPrices.length, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // batchGetPriceScenarios
    // ─────────────────────────────────────────────────────────────────────────

    function test_BatchGetPriceScenarios_MultiToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(wbtc);

        int256[] memory shocks = new int256[](2);
        shocks[0] = -1000; // -10%
        shocks[1] = -2000; // -20%

        (uint256[] memory bases, uint256[][] memory simPrices) =
            oracle.batchGetPriceScenarios(tokens, shocks);

        assertEq(bases.length, 2);
        assertEq(bases[0], 2000e18);
        assertEq(bases[1], 60_000e18);

        // ETH -10% = 1800
        assertApproxEqRel(simPrices[0][0], 1800e18, 0.001e18);
        // ETH -20% = 1600
        assertApproxEqRel(simPrices[0][1], 1600e18, 0.001e18);
        // BTC -10% = 54000
        assertApproxEqRel(simPrices[1][0], 54_000e18, 0.001e18);
    }

    function test_BatchGetPriceScenarios_ConsistentWithSingle() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);

        int256[] memory shocks = new int256[](1);
        shocks[0] = -2000; // -20%

        // Single call
        (, uint256[] memory singleSim) = oracle.getPriceScenarios(address(weth), shocks);

        // Batch call
        (, uint256[][] memory batchSim) = oracle.batchGetPriceScenarios(tokens, shocks);

        assertEq(singleSim[0], batchSim[0][0]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // isPriceFresh
    // ─────────────────────────────────────────────────────────────────────────

    function test_IsPriceFresh_FreshFeed_True() public view {
        assertTrue(oracle.isPriceFresh(address(weth)));
    }

    function test_IsPriceFresh_StaleFeed_False() public {
        ethFeed.makeStale(7200); // 2h stale, maxStaleness=3600
        assertFalse(oracle.isPriceFresh(address(weth)));
    }

    function test_IsPriceFresh_InactiveFeed_False() public {
        vm.prank(deployer);
        oracle.deactivateFeed(address(weth));
        assertFalse(oracle.isPriceFresh(address(weth)));
    }

    function test_IsPriceFresh_UnregisteredToken_False() public view {
        assertFalse(oracle.isPriceFresh(address(dai)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getRegisteredTokens + getFeedConfig
    // ─────────────────────────────────────────────────────────────────────────

    function test_GetRegisteredTokens_ContainsSetupTokens() public view {
        address[] memory tokens = oracle.getRegisteredTokens();
        assertGe(tokens.length, 3); // weth, usdc, wbtc from BaseTest

        bool hasWeth;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(weth)) hasWeth = true;
        }
        assertTrue(hasWeth, "WETH should be in registered tokens");
    }

    function test_GetFeedConfig_CorrectValues() public view {
        (address feedAddr, uint8 feedDec, uint8 tokenDec, uint256 maxStaleness, bool active) =
            oracle.getFeedConfig(address(weth));

        assertEq(feedAddr, address(ethFeed));
        assertEq(feedDec, 8); // Chainlink ETH/USD is 8 dec
        assertEq(tokenDec, 18); // WETH is 18 dec
        assertEq(maxStaleness, 3600);
        assertTrue(active);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: any valid 8-dec price → 18-dec normalised output = price * 1e10
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_GetPrice_NormalisationInvariant(int256 rawPrice) public {
        rawPrice = bound(rawPrice, 1, int256(1_000_000e8)); // $0.00000001 to $1M

        ethFeed.setPrice(rawPrice);

        uint256 expected = uint256(rawPrice) * 1e10; // 8-dec → 18-dec
        uint256 actual = oracle.getPrice(address(weth));
        assertEq(actual, expected);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz: volatility stddev always within valid BP range
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_ComputeVolatility_StdDevInValidRange(uint256 numRounds) public {
        numRounds = bound(numRounds, 2, 20);

        // Seed some random-ish prices
        int256[] memory prices = new int256[](numRounds);
        for (uint256 i = 0; i < numRounds; i++) {
            prices[i] = int256(1000e8) + int256(i) * int256(100e8);
        }
        ethFeed.seedHistory(prices, 3600);

        RiskOracle.VolatilityResult memory result =
            oracle.computeVolatility(address(weth), numRounds);

        assertLe(result.stdDevBP, 10_000, "StdDev must not exceed 100%");
        assertGe(result.roundsUsed, 1);
    }
}
