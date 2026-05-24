// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// /**
//  * @notice Deployment script for the full Autonomous DeFi Risk Manager suite.
//  *
//  * Usage (Arbitrum Sepolia testnet):
//  *   forge script script/Deploy.s.sol:Deploy \
//  *     --rpc-url arbitrum_sep \
//  *     --broadcast \
//  *     --verify \
//  *     -vvvv
//  *
//  * Usage (Arbitrum One mainnet):
//  *   forge script script/Deploy.s.sol:Deploy \
//  *     --rpc-url arbitrum \
//  *     --broadcast \
//  *     --verify \
//  *     -vvvv
//  *
//  * Set environment variables in a .env file (never commit this):
//  *   PRIVATE_KEY=0x...
//  *   AGENT_KEEPER_ADDRESS=0x...
//  *   ARBITRUM_RPC_URL=https://...
//  *   ARBITRUM_SEPOLIA_RPC_URL=https://...
//  *   ARBISCAN_API_KEY=...
//  */

// import { Script } from "forge-std/Script.sol";
// import { VaultManager } from "src/VaultManager.sol";
// import { RiskOracle } from "src/RiskOracle.sol";
// import { AgentRegistry } from "src/AgentRegistry.sol";
// import { ProtectionActions } from "src/ProtectionActions.sol";

// contract Deploy is Script {
//     // ── Arbitrum One Chainlink feeds ──────────────────────────────────────
//     address constant FEED_ETH_USD = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
//     address constant FEED_USDC_USD = 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3;
//     address constant FEED_WBTC_USD = 0x6Ce185539aD4fDaBF2B548de13A3b9aBfd576b11;
//     address constant FEED_ARB_USD = 0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6;

//     // ── Arbitrum One token addresses ──────────────────────────────────────
//     address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
//     address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
//     address constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
//     address constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

//     // ── Uniswap v3 SwapRouter02 on Arbitrum ──────────────────────────────
//     address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

//     function run() external {
//         uint256 deployerKey = vm.envUint("PRIVATE_KEY");
//         address agentKeeper = vm.envAddress("AGENT_KEEPER_ADDRESS");
//         address deployer = vm.addr(deployerKey);

//         console.log("=== Autonomous DeFi Risk Manager Deployment ===");
//         console.log("Deployer:     ", deployer);
//         console.log("Agent Keeper: ", agentKeeper);
//         console.log("Chain ID:     ", block.chainid);

//         vm.startBroadcast(deployerKey);

//         // ── 1. Deploy RiskOracle ─────────────────────────────────────────
//         RiskOracle oracle = new RiskOracle();
//         console.log("RiskOracle:         ", address(oracle));

//         // Register feeds
//         oracle.registerFeed(WETH, FEED_ETH_USD, 18, 3600); // 1hr heartbeat
//         oracle.registerFeed(USDC, FEED_USDC_USD, 6, 86400); // 24hr heartbeat
//         oracle.registerFeed(WBTC, FEED_WBTC_USD, 8, 3600);
//         oracle.registerFeed(ARB, FEED_ARB_USD, 18, 3600);

//         // ── 2. Deploy AgentRegistry ──────────────────────────────────────
//         AgentRegistry registry = new AgentRegistry(agentKeeper);
//         console.log("AgentRegistry:      ", address(registry));

//         // ── 3. Deploy VaultManager ───────────────────────────────────────
//         VaultManager vault = new VaultManager(agentKeeper);
//         console.log("VaultManager:       ", address(vault));

//         // Configure tokens in VaultManager
//         // (liqThreshold in basis points: 8000 = 80%, 7500 = 75%)
//         vault.configureToken(WETH, FEED_ETH_USD, 8000, 500, true, true);
//         vault.configureToken(USDC, FEED_USDC_USD, 9000, 200, true, true);
//         vault.configureToken(WBTC, FEED_WBTC_USD, 8000, 500, true, true);
//         vault.configureToken(ARB, FEED_ARB_USD, 7500, 800, true, false);

//         // ── 4. Deploy ProtectionActions ──────────────────────────────────
//         ProtectionActions protection =
//             new ProtectionActions(address(vault), address(registry), UNISWAP_ROUTER);
//         console.log("ProtectionActions:  ", address(protection));

//         // Authorise ProtectionActions to record actions in registry
//         registry.setAuthorisedRecorder(address(protection), true);

//         vm.stopBroadcast();

//         console.log("\n=== Deployment Complete ===");
//         console.log("Copy these to your .env / frontend config:");
//         console.log("NEXT_PUBLIC_VAULT_MANAGER=   ", address(vault));
//         console.log("NEXT_PUBLIC_RISK_ORACLE=     ", address(oracle));
//         console.log("NEXT_PUBLIC_AGENT_REGISTRY=  ", address(registry));
//         console.log("NEXT_PUBLIC_PROTECTION=      ", address(protection));
//     }
// }
