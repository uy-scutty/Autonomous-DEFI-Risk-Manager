// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestConstants } from "test/helpers/TestConstants.sol";

contract TestHelpers is Test, TestConstants {
    function assertApproxEqAbsCustom(uint256 a, uint256 b, uint256 maxDiff) internal pure {
        if (a > b) {
            assertLe(a - b, maxDiff);
        } else {
            assertLe(b - a, maxDiff);
        }
    }

    function assertHealthFactorValid(uint256 hf) internal pure {
        assertTrue(hf > 0 && hf <= type(uint256).max, "Invalid health factor");
    }

    function mockERC20Transfer(address token, address from, address to, uint256 amount) internal {
        vm.prank(from);
        vm.mockCall(
            token,
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount),
            abi.encode(true)
        );
    }

    function skipTime(uint256 secondsToSkip) internal {
        vm.warp(block.timestamp + secondsToSkip);
    }

    function setBlockNumber(uint256 blockNum) internal {
        vm.roll(blockNum);
    }
}
