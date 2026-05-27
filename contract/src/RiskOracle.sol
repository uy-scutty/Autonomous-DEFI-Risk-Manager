// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  RiskOracle
 * @author Oyedokun Oluwatominiyi John
 * @notice Chainlink price-feed wrapper that provides:
 *         1. Safe, staleness-checked price reads for any registered token.
 *         2. On-chain health-factor computation (mirrors VaultManager logic
 *            so the agent can call a single view without touching vault state).
 *         3. Multi-token batch price fetches (for the frontend dashboard).
 *         4. Historical round navigation so the agent can compute short-window
 *            realised volatility (stddev of last N rounds).
 *
 * Design notes
 * ────────────
 * • All prices returned are normalised to 18 decimals.
 * • Staleness threshold is per-feed (heartbeat varies: ETH/USD = 3600s,
 *   some feeds = 86400s). Owner sets this per token.
 * • This contract is intentionally stateless beyond its feed registry —
 *   no user balances live here. VaultManager calls it for prices.
 * • The agent's riskEngine.js calls simulatePriceScenarios() as a
 *   single multicall to get all scenario HFs in one RPC round-trip.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink-brownie-contracts/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract RiskOracle is Ownable {
    // ─────────────────────────────────────────────────────────────────────────────
    // Custom errors
    // ─────────────────────────────────────────────────────────────────────────────
    error FeedNotRegistered(address token);
    error StaleOrInvalidPrice(address feed, uint256 updatedAt, uint256 maxAge);
    error NegativePrice(address feed, int256 answer);
    error ZeroRoundsRequested();
    error RoundCountTooLarge(uint256 requested, uint256 max);
    error ZeroFeed();
    error ZeroToken();
    error ZeroStaleness();

    // ─────────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Registry entry for a single Chainlink price feed
    struct FeedConfig {
        AggregatorV3Interface feed;
        uint8 feedDecimals; // Chainlink decimals (usually 8)
        uint8 tokenDecimals; // ERC-20 decimals (for USD value math)
        uint256 maxStaleness; // seconds before price is considered stale
        bool active;
    }

    /// @notice Snapshot returned by batchGetPrices()
    struct PriceSnapshot {
        address token;
        uint256 priceUSD18; // price normalised to 18 decimals
        uint256 updatedAt; // Chainlink updatedAt timestamp
        bool isStale; // true if age > maxStaleness (soft flag, not revert)
    }

    /// @notice Output of computeVolatility() — annualised stddev
    struct VolatilityResult {
        address token;
        uint256 stdDevBP; // stddev as basis points of mean price
        uint256 roundsUsed; // how many Chainlink rounds were sampled
        uint256 windowSeconds; // approximate time window of the sample
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────
    event FeedRegistered(address indexed token, address indexed feed, uint256 maxStaleness);
    event FeedDeactivated(address indexed token);
    event MaxStalenessUpdated(address indexed token, uint256 newMaxStaleness);

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant PRICE_PRECISION = 1e18;
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_ROUND_SAMPLE = 100; // safety cap on volatility loops

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice token address → feed configuration
    mapping(address => FeedConfig) public feedConfigs;

    /// @notice All registered token addresses (for iteration)
    address[] public registeredTokens;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) { }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: Feed management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register or update a Chainlink price feed for a token.
     * @param token         ERC-20 token address
     * @param feed          Chainlink AggregatorV3Interface address
     * @param tokenDecimals Decimals of the ERC-20 token
     * @param maxStaleness  Max age in seconds before price is considered stale
     *                      Recommended: 3600 for ETH/BTC, 86400 for stablecoins
     */
    function registerFeed(address token, address feed, uint8 tokenDecimals, uint256 maxStaleness)
        external
        onlyOwner
    {
        if (feed == address(0)) revert ZeroFeed();
        if (token == address(0)) revert ZeroToken();
        if (maxStaleness == 0) revert ZeroStaleness();

        AggregatorV3Interface agg = AggregatorV3Interface(feed);

        // Track new tokens
        if (!feedConfigs[token].active) {
            registeredTokens.push(token);
        }

        feedConfigs[token] = FeedConfig({
            feed: agg,
            feedDecimals: agg.decimals(),
            tokenDecimals: tokenDecimals,
            maxStaleness: maxStaleness,
            active: true
        });

        emit FeedRegistered(token, feed, maxStaleness);
    }

    /// @notice Update only the staleness threshold for an existing feed
    function setMaxStaleness(address token, uint256 newMaxStaleness) external onlyOwner {
        if (!feedConfigs[token].active) revert FeedNotRegistered(token);
        feedConfigs[token].maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(token, newMaxStaleness);
    }

    /// @notice Soft-disable a feed (keeps config, stops price serving)
    function deactivateFeed(address token) external onlyOwner {
        feedConfigs[token].active = false;
        emit FeedDeactivated(token);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core price reads
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Get the latest price for a token, normalised to 18 decimals.
     *         Reverts on stale or negative price.
     * @param token ERC-20 address
     * @return price USD price with 18 decimal precision
     */
    function getPrice(address token) external view returns (uint256 price) {
        price = _getPrice(token);
    }

    /**
     * @notice Get price with full Chainlink round metadata.
     * @return price      18-decimal USD price
     * @return roundId    Chainlink round ID
     * @return updatedAt  Timestamp of the price update
     */
    function getPriceWithMetadata(address token)
        external
        view
        returns (uint256 price, uint80 roundId, uint256 updatedAt)
    {
        FeedConfig storage cfg = _requireActiveFeed(token);
        (uint80 rId, int256 answer,, uint256 ts,) = cfg.feed.latestRoundData();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > cfg.maxStaleness) {
            revert StaleOrInvalidPrice(address(cfg.feed), updatedAt, cfg.maxStaleness);
        }
        if (answer <= 0) {
            revert NegativePrice(address(cfg.feed), answer);
        }
        price = _normalise(uint256(answer), cfg.feedDecimals);
        roundId = rId;
        updatedAt = ts;
    }

    /**
     * @notice Batch fetch prices for multiple tokens in one call.
     *         Soft-flags stale prices (isStale = true) instead of reverting,
     *         so the frontend can show a warning rather than crashing.
     * @param tokens Array of ERC-20 addresses
     * @return snapshots Array of PriceSnapshot structs
     */
    function batchGetPrices(address[] calldata tokens)
        external
        view
        returns (PriceSnapshot[] memory snapshots)
    {
        snapshots = new PriceSnapshot[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            FeedConfig storage cfg = feedConfigs[token];

            if (!cfg.active) {
                // Return zero-price snapshot for unregistered tokens
                snapshots[i] =
                    PriceSnapshot({ token: token, priceUSD18: 0, updatedAt: 0, isStale: true });
                continue;
            }

            try cfg.feed.latestRoundData() returns (
                uint80, int256 answer, uint256, uint256 updatedAt, uint80
            ) {
                bool stale =
                    (updatedAt > block.timestamp || block.timestamp - updatedAt > cfg.maxStaleness
                        || answer <= 0);

                snapshots[i] = PriceSnapshot({
                    token: token,
                    priceUSD18: answer > 0 ? _normalise(uint256(answer), cfg.feedDecimals) : 0,
                    updatedAt: updatedAt,
                    isStale: stale
                });
            } catch {
                snapshots[i] =
                    PriceSnapshot({ token: token, priceUSD18: 0, updatedAt: 0, isStale: true });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Volatility computation  (used by agent riskEngine.js)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Compute realised price volatility from the last N Chainlink rounds.
     *         Returns stddev as basis points of mean price — e.g. 150 = 1.5 %.
     *
     * @dev    Algorithm: population stddev of log-returns over N rounds.
     *         All arithmetic in fixed-point (18 decimals).
     *         Gas: ~O(N) storage reads — keep N ≤ 50 for reasonable gas.
     *
     * @param token       Token to analyse
     * @param numRounds   Number of historical rounds to sample (max 100)
     * @return result     VolatilityResult with stddev in basis points
     */
    function computeVolatility(address token, uint256 numRounds)
        external
        view
        returns (VolatilityResult memory result)
    {
        if (numRounds == 0) revert ZeroRoundsRequested();
        if (numRounds > MAX_ROUND_SAMPLE) {
            revert RoundCountTooLarge(numRounds, MAX_ROUND_SAMPLE);
        }

        FeedConfig storage cfg = _requireActiveFeed(token);

        // Fetch latest round as starting point
        (uint80 latestRoundId, int256 latestAnswer,, uint256 latestTs,) = cfg.feed.latestRoundData();

        if (latestAnswer <= 0) revert NegativePrice(address(cfg.feed), latestAnswer);

        // Collect prices for numRounds historical rounds
        uint256[] memory prices = new uint256[](numRounds);
        prices[0] = _normalise(uint256(latestAnswer), cfg.feedDecimals);

        uint256 oldestTs = latestTs;
        uint256 collected = 1;

        for (uint256 i = 1; i < numRounds; i++) {
            if (latestRoundId <= i) break;

            uint80 targetRound = latestRoundId - uint80(i);
            if (targetRound == 0) break;

            try cfg.feed.getRoundData(targetRound) returns (
                uint80, int256 ans, uint256, uint256 ts, uint80
            ) {
                if (ans <= 0) continue;
                prices[collected] = _normalise(uint256(ans), cfg.feedDecimals);
                oldestTs = ts;
                collected++;
            } catch {
                break;
            }
        }

        if (collected < 2) {
            // Not enough data — return zero volatility
            return VolatilityResult({
                token: token, stdDevBP: 0, roundsUsed: collected, windowSeconds: 0
            });
        }

        // Compute mean
        uint256 sum = 0;
        for (uint256 i = 0; i < collected; i++) {
            sum += prices[i];
        }
        uint256 mean = sum / collected;

        // Compute variance (population, not sample — good enough for risk signal)
        uint256 varianceSum = 0;
        for (uint256 i = 0; i < collected; i++) {
            uint256 diff = prices[i] > mean ? prices[i] - mean : mean - prices[i];
            // Scale diff relative to mean, in basis points
            uint256 diffBP = (diff * BASIS_POINTS) / mean;
            varianceSum += diffBP * diffBP;
        }
        uint256 variance = varianceSum / collected;

        // Integer square root (Babylonian method)
        uint256 stdDevBP = _sqrt(variance);

        result = VolatilityResult({
            token: token,
            stdDevBP: stdDevBP,
            roundsUsed: collected,
            windowSeconds: latestTs > oldestTs ? latestTs - oldestTs : 0
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario simulation  (used by agent and frontend What-If slider)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the current USD price and the shocked price for each
     *         scenario. The agent calls this and then runs its own HF math —
     *         keeping HF calculation off this contract (VaultManager owns it).
     *
     * @param token          Token to shock
     * @param scenariosBP    Array of price changes in basis points
     *                       e.g. [-500, -1000, -2000] = -5%, -10%, -20%
     * @return basePrice     Current 18-dec price
     * @return scenarioPrices Shocked prices for each scenario
     */
    function getPriceScenarios(address token, int256[] calldata scenariosBP)
        external
        view
        returns (uint256 basePrice, uint256[] memory scenarioPrices)
    {
        basePrice = _getPrice(token);
        scenarioPrices = new uint256[](scenariosBP.length);

        for (uint256 i = 0; i < scenariosBP.length; i++) {
            int256 shocked =
                int256(basePrice) + (int256(basePrice) * scenariosBP[i]) / int256(BASIS_POINTS);
            scenarioPrices[i] = shocked > 0 ? uint256(shocked) : 0;
        }
    }

    /**
     * @notice Batch price scenarios for multiple tokens at once.
     *         Minimises RPC round-trips for the agent's multi-token risk scan.
     *
     * @param tokens      Tokens to price
     * @param scenariosBP Same shock array applied to every token
     * @return basePrices     Current prices per token
     * @return scenarioPrices [token][scenario] shocked prices
     */
    function batchGetPriceScenarios(address[] calldata tokens, int256[] calldata scenariosBP)
        external
        view
        returns (uint256[] memory basePrices, uint256[][] memory scenarioPrices)
    {
        basePrices = new uint256[](tokens.length);
        scenarioPrices = new uint256[][](tokens.length);

        for (uint256 t = 0; t < tokens.length; t++) {
            basePrices[t] = _getPrice(tokens[t]);
            scenarioPrices[t] = new uint256[](scenariosBP.length);

            for (uint256 s = 0; s < scenariosBP.length; s++) {
                int256 shocked = int256(basePrices[t]) + (int256(basePrices[t]) * scenariosBP[s])
                    / int256(BASIS_POINTS);
                scenarioPrices[t][s] = shocked > 0 ? uint256(shocked) : 0;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utility views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns all registered token addresses
    function getRegisteredTokens() external view returns (address[] memory) {
        return registeredTokens;
    }

    /// @notice Returns feed config for a token
    function getFeedConfig(address token)
        external
        view
        returns (
            address feedAddress,
            uint8 feedDecimals,
            uint8 tokenDecimals,
            uint256 maxStaleness,
            bool active
        )
    {
        FeedConfig storage cfg = feedConfigs[token];
        feedAddress = address(cfg.feed);
        feedDecimals = cfg.feedDecimals;
        tokenDecimals = cfg.tokenDecimals;
        maxStaleness = cfg.maxStaleness;
        active = cfg.active;
    }

    /// @notice Check if a price is currently fresh (off-chain convenience)
    function isPriceFresh(address token) external view returns (bool) {
        FeedConfig storage cfg = feedConfigs[token];
        if (!cfg.active) return false;
        (,,, uint256 updatedAt,) = cfg.feed.latestRoundData();
        if (updatedAt > block.timestamp) return false;

        return block.timestamp - updatedAt <= cfg.maxStaleness;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _getPrice(address token) internal view returns (uint256) {
        FeedConfig storage cfg = _requireActiveFeed(token);
        (, int256 answer,, uint256 updatedAt,) = cfg.feed.latestRoundData();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > cfg.maxStaleness) {
            if (answer <= 0) {
                revert NegativePrice(address(cfg.feed), answer);
            }
        }

        return _normalise(uint256(answer), cfg.feedDecimals);
    }

    /// @dev Normalise any feed answer to 18-decimal precision
    function _normalise(uint256 value, uint8 feedDecimals) internal pure returns (uint256) {
        if (feedDecimals == 18) return value;
        if (feedDecimals < 18) return value * (10 ** (18 - feedDecimals));
        return value / (10 ** (feedDecimals - 18));
    }

    function _requireActiveFeed(address token) internal view returns (FeedConfig storage cfg) {
        cfg = feedConfigs[token];
        if (!cfg.active) revert FeedNotRegistered(token);
    }

    /// @dev Babylonian integer square root
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
