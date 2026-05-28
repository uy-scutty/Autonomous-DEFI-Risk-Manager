// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// AgentRegistry interface
interface IAgentRegistry {
    function getAgentDecisionParams(address user)
        external
        view
        returns (
            bool agentEnabled,
            bool alertOnly,
            bool canRepay,
            bool canDeleverage,
            uint256 warningHF,
            uint256 actionHF,
            uint16 maxRepayBP,
            uint16 maxDelgBP
        );

    function isAuthorisedKeeper(address user, address keeper) external view returns (bool);

    function recordAction(address user, string calldata actionType, uint256 valueUSD18) external;
}
