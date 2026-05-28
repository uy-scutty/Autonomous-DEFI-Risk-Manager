// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Deploy script for the Aave Guardian edition.
 *
 *         Deploys only 3 contracts (was 4):
 *           1. AgentRegistry
 *           2. AaveAdapter
 *           3. ProtectionActions
 *
 *         VaultManager and RiskOracle are gone — Aave replaces them.
 *
 * Usage (Arbitrum Sepolia):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url arbitrum_sep --broadcast --verify -vvvv
 *
 * Usage (Arbitrum One mainnet):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url arbitrum --broadcast --verify -vvvv
 */

import "forge-std/Script.sol";
import { AgentRegistry } from "src/AgentRegistry.sol";
import { ProtectionActions } from "src/ProtectionActions_Aave.sol";
import { AaveAdapter } from "src/AaveAdapter.sol";

contract Deploy is Script {
    // ── Aave v3 Arbitrum One addresses ────────────────────────────────────
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AAVE_DATA_PROVIDER = 0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654;
    address constant AAVE_ORACLE = 0xb56c2f0B653173F1eB93B11a756EEae4e26e7E54;

    // ── Aave v3 Arbitrum Sepolia testnet addresses ────────────────────────
    // address constant AAVE_POOL          = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    // address constant AAVE_DATA_PROVIDER = 0x501c23c48a2837B6895B5F10Ca28C2AA5EA0CdC4;
    // address constant AAVE_ORACLE        = 0x4da4E7ef052FE5e8B4FAe429d34D3063bBBb0B3e;

    // ── Uniswap v3 SwapRouter02 on Arbitrum ──────────────────────────────
    address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address agentKeeper = vm.envAddress("AGENT_KEEPER_ADDRESS");
        address deployer = vm.addr(deployerKey);

        console.log("=== Autonomous DeFi Risk Manager (Aave Guardian) ===");
        console.log("Deployer:     ", deployer);
        console.log("Agent Keeper: ", agentKeeper);
        console.log("Chain ID:     ", block.chainid);

        vm.startBroadcast(deployerKey);

        // ── 1. AgentRegistry ─────────────────────────────────────────────
        AgentRegistry registry = new AgentRegistry(agentKeeper);
        console.log("AgentRegistry:      ", address(registry));

        // ── 2. AaveAdapter (no protectionActions yet — set after deploy) ──
        AaveAdapter adapter = new AaveAdapter(
            AAVE_POOL,
            AAVE_DATA_PROVIDER,
            AAVE_ORACLE,
            address(0) // placeholder — updated below
        );
        console.log("AaveAdapter:        ", address(adapter));

        // ── 3. ProtectionActions ─────────────────────────────────────────
        ProtectionActions protection =
            new ProtectionActions(address(adapter), address(registry), UNISWAP_ROUTER);
        console.log("ProtectionActions:  ", address(protection));

        // ── 4. Wire up: tell AaveAdapter who can call its write functions ─
        adapter.setProtectionActions(address(protection));

        // ── 5. Authorise ProtectionActions to record in AgentRegistry ────
        registry.setAuthorisedRecorder(address(protection), true);

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
        console.log("Add these to your .env:");
        console.log("NEXT_PUBLIC_AGENT_REGISTRY=  ", address(registry));
        console.log("NEXT_PUBLIC_AAVE_ADAPTER=    ", address(adapter));
        console.log("NEXT_PUBLIC_PROTECTION=      ", address(protection));
        console.log("\nAgent .env:");
        console.log("AGENT_REGISTRY_ADDRESS=      ", address(registry));
        console.log("AAVE_ADAPTER_ADDRESS=        ", address(adapter));
        console.log("PROTECTION_ACTIONS_ADDRESS=  ", address(protection));
    }
}
