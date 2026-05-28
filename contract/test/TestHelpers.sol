// // SPDX-License-Identifier: MIT
// pragma solidity ^0.8.20;

// /**
//  * @notice Shared mocks and base contract used by all test files.
//  *
//  *         MockERC20         — mintable token for collateral/debt
//  *         MockChainlinkFeed — controllable price feed (set price, make stale)
//  *         BaseTest          — deploys full contract suite with sane defaults
//  */

// import "forge-std/Test.sol";
// import { AgentRegistry } from "src/AgentRegistry.sol";
// import { ProtectionActions } from "src/ProtectionActions_Aave.sol";

// // ─────────────────────────────────────────────────────────────────────────────
// // Mock ERC-20
// // ─────────────────────────────────────────────────────────────────────────────

// contract MockERC20 {
//     string public name;
//     string public symbol;
//     uint8 public decimals;
//     uint256 public totalSupply;

//     mapping(address => uint256) public balanceOf;
//     mapping(address => mapping(address => uint256)) public allowance;

//     event Transfer(address indexed from, address indexed to, uint256 value);
//     event Approval(address indexed owner, address indexed spender, uint256 value);

//     constructor(string memory _name, string memory _sym, uint8 _dec) {
//         name = _name;
//         symbol = _sym;
//         decimals = _dec;
//     }

//     function mint(address to, uint256 amount) external {
//         totalSupply += amount;
//         balanceOf[to] += amount;
//         emit Transfer(address(0), to, amount);
//     }

//     function burn(address from, uint256 amount) external {
//         balanceOf[from] -= amount;
//         totalSupply -= amount;
//         emit Transfer(from, address(0), amount);
//     }

//     function transfer(address to, uint256 amount) external returns (bool) {
//         balanceOf[msg.sender] -= amount;
//         balanceOf[to] += amount;
//         emit Transfer(msg.sender, to, amount);
//         return true;
//     }

//     function transferFrom(address from, address to, uint256 amount) external returns (bool) {
//         if (allowance[from][msg.sender] != type(uint256).max) {
//             allowance[from][msg.sender] -= amount;
//         }
//         balanceOf[from] -= amount;
//         balanceOf[to] += amount;
//         emit Transfer(from, to, amount);
//         return true;
//     }

//     function approve(address spender, uint256 amount) external returns (bool) {
//         allowance[msg.sender][spender] = amount;
//         emit Approval(msg.sender, spender, amount);
//         return true;
//     }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Mock Chainlink AggregatorV3
// // ─────────────────────────────────────────────────────────────────────────────

// contract MockChainlinkFeed {
//     uint8 public decimals = 8;
//     int256 private _price;
//     uint256 private _updatedAt;
//     uint80 private _roundId = 1;

//     // Historical rounds for volatility tests
//     mapping(uint80 => int256) public roundPrice;
//     mapping(uint80 => uint256) public roundTimestamp;

//     constructor(int256 initialPrice) {
//         _price = initialPrice;
//         _updatedAt = block.timestamp;
//         roundPrice[1] = initialPrice;
//         roundTimestamp[1] = block.timestamp;
//     }

//     // ── Test helpers ─────────────────────────────────────────────────────

//     /// @dev Push a new round (advances roundId)
//     function setPrice(int256 newPrice) external {
//         _roundId++;
//         _price = newPrice;
//         _updatedAt = block.timestamp;
//         roundPrice[_roundId] = newPrice;
//         roundTimestamp[_roundId] = block.timestamp;
//     }

//     /// @dev Simulate a stale feed by backdating updatedAt
//     function makeStale(uint256 ageSeconds) external {
//         _updatedAt = block.timestamp - ageSeconds;
//         roundTimestamp[_roundId] = _updatedAt;
//     }

//     /// @dev Seed many historical rounds at once (for volatility tests)
//     /// @dev Seed many historical rounds at once (for volatility tests)
//     function seedHistory(int256[] memory prices, uint256 spacing) external {
//         require(prices.length > 0, "no prices");

//         // Reset round counter
//         _roundId = 0;

//         for (uint256 i = 0; i < prices.length; i++) {
//             _roundId++;

//             roundPrice[_roundId] = prices[i];

//             // IMPORTANT:
//             // Historical rounds must go BACKWARDS in time,
//             // never into the future.
//             roundTimestamp[_roundId] = block.timestamp - ((prices.length - i) * spacing);
//         }

//         // Latest round becomes final seeded round
//         _price = prices[prices.length - 1];
//         _updatedAt = roundTimestamp[_roundId];
//     }
//     // ── AggregatorV3Interface ─────────────────────────────────────────────

//     function latestRoundData()
//         external
//         view
//         returns (
//             uint80 roundId,
//             int256 answer,
//             uint256 startedAt,
//             uint256 updatedAt,
//             uint80 answeredInRound
//         )
//     {
//         return (_roundId, _price, _updatedAt, _updatedAt, _roundId);
//     }

//     function getRoundData(uint80 _rid)
//         external
//         view
//         returns (
//             uint80 roundId,
//             int256 answer,
//             uint256 startedAt,
//             uint256 updatedAt,
//             uint80 answeredInRound
//         )
//     {
//         require(roundPrice[_rid] != 0, "no data");
//         return (_rid, roundPrice[_rid], roundTimestamp[_rid], roundTimestamp[_rid], _rid);
//     }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Base test — deploys everything and sets up standard actors
// // ─────────────────────────────────────────────────────────────────────────────

// abstract contract BaseTest is Test {
//     // ── Actors ───────────────────────────────────────────────────────────
//     address internal deployer = makeAddr("deployer");
//     address internal keeper = makeAddr("keeper");
//     address internal alice = makeAddr("alice");
//     address internal bob = makeAddr("bob");
//     address internal carol = makeAddr("carol");

//     // ── Tokens ───────────────────────────────────────────────────────────
//     MockERC20 internal weth; // 18 dec, collateral + borrowable
//     MockERC20 internal usdc; // 6  dec, collateral + borrowable
//     MockERC20 internal wbtc; // 8  dec, collateral only

//     // ── Price feeds ──────────────────────────────────────────────────────
//     MockChainlinkFeed internal ethFeed; // $2000 initial
//     MockChainlinkFeed internal usdcFeed; // $1
//     MockChainlinkFeed internal wbtcFeed; // $60000

//     // ── Contracts ────────────────────────────────────────────────────────
//     AgentRegistry internal registry;
//     ProtectionActions internal protection;

//     // ── Prices (8-decimal Chainlink format) ──────────────────────────────
//     int256 constant ETH_PRICE = 2000e8; // $2,000
//     int256 constant USDC_PRICE = 1e8; // $1
//     int256 constant WBTC_PRICE = 60_000e8; // $60,000

//     // ── Default liquidity seeded per token ───────────────────────────────
//     uint256 constant SEED_LIQUIDITY = 100_000e18;

//     function setUp() public virtual {
//         vm.startPrank(deployer);

//         // Deploy tokens
//         weth = new MockERC20("Wrapped Ether", "WETH", 18);
//         usdc = new MockERC20("USD Coin", "USDC", 6);
//         wbtc = new MockERC20("Wrapped BTC", "WBTC", 8);

//         // Deploy feeds
//         ethFeed = new MockChainlinkFeed(ETH_PRICE);
//         usdcFeed = new MockChainlinkFeed(USDC_PRICE);
//         wbtcFeed = new MockChainlinkFeed(WBTC_PRICE);

//         // Deploy protocol
//         oracle = new RiskOracle();
//         registry = new AgentRegistry(keeper);
//         vault = new VaultManager(keeper);
//         protection = new ProtectionActions(
//             address(vault),
//             address(registry),
//             address(0) // no DEX in unit tests (overridden in fork tests)
//         );

//         // Configure RiskOracle
//         oracle.registerFeed(address(weth), address(ethFeed), 18, 3600);
//         oracle.registerFeed(address(usdc), address(usdcFeed), 6, 86400);
//         oracle.registerFeed(address(wbtc), address(wbtcFeed), 8, 3600);

//         // Configure VaultManager
//         // liqThreshold: weth/wbtc = 80%, usdc = 90%
//         vault.configureToken(address(weth), address(ethFeed), 8000, 500, true, true);
//         vault.configureToken(address(usdc), address(usdcFeed), 9000, 200, true, true);
//         vault.configureToken(address(wbtc), address(wbtcFeed), 8000, 500, true, false);

//         // Seed protocol liquidity (for borrowing)
//         weth.mint(deployer, SEED_LIQUIDITY);
//         usdc.mint(deployer, SEED_LIQUIDITY);
//         weth.approve(address(vault), type(uint256).max);
//         usdc.approve(address(vault), type(uint256).max);
//         vault.depositLiquidity(address(weth), 50_000e18);
//         vault.depositLiquidity(address(usdc), 50_000e6);

//         // Authorise ProtectionActions as recorder
//         registry.setAuthorisedRecorder(address(protection), true);

//         vm.stopPrank();

//         // Fund actors
//         _fundActor(alice);
//         _fundActor(bob);
//         _fundActor(carol);

//         // Fund keeper (needs debt tokens to call agentPartialRepay)
//         weth.mint(keeper, 1000e18);
//         usdc.mint(keeper, 1_000_000e6);
//     }

//     // ── Internal helpers ─────────────────────────────────────────────────

//     function _fundActor(address actor) internal {
//         weth.mint(actor, 100e18);
//         usdc.mint(actor, 100_000e6);
//         wbtc.mint(actor, 5e8);
//     }

//     /// @dev Deposit weth collateral + borrow usdc for an actor
//     function _openPosition(address actor, uint256 wethAmount, uint256 usdcBorrow) internal {
//         vm.startPrank(actor);
//         weth.approve(address(vault), type(uint256).max);
//         vault.depositCollateral(address(weth), wethAmount);
//         if (usdcBorrow > 0) vault.borrow(address(usdc), usdcBorrow);
//         vm.stopPrank();
//     }

//     /// @dev Enable full agent autonomy for actor
//     function _enableAgent(address actor) internal {
//         vm.prank(actor);
//         registry.setFullConfig(
//             1.6e18, // warningHF
//             1.4e18, // actionHF
//             true, // autoRepay
//             true, // autoDeleverage
//             false, // alertOnly = off
//             2000, // maxRepayBP  = 20%
//             3000 // maxDelgBP   = 30%
//         );
//     }

//     /// @dev Assert HF is within 0.01 of expected (accounts for rounding)
//     function _assertHFClose(address actor, uint256 expectedHF, uint256 toleranceBP) internal view {
//         uint256 hf = vault.getHealthFactor(actor);
//         uint256 tol = (expectedHF * toleranceBP) / 10_000;
//         assertApproxEqAbs(
//             hf, expectedHF, tol, string.concat("HF mismatch for ", vm.toString(actor))
//         );
//     }

//     /// @dev Drop ETH price by `pct` percent (e.g. 10 = -10%)
//     function _dropEthPrice(uint256 pct) internal {
//         int256 newPrice = ETH_PRICE - (ETH_PRICE * int256(pct)) / 100;
//         ethFeed.setPrice(newPrice);
//     }
// }
