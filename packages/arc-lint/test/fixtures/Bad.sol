// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A deliberately Arc-hostile contract used by the arc-lint test suite.
/// The comment below must NOT be flagged: block.prevrandao selfdestruct(
contract Bad {
    IERC20 public immutable usdc;
    uint256 public constant STAKE = 1e18;

    constructor(IERC20 _usdc) {
        usdc = _usdc;
    }

    function pickWinner(address[] calldata players) external view returns (address) {
        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp)));
        return players[seed % players.length];
    }

    function legacySeed() external view returns (uint256) {
        return block.difficulty;
    }

    function asmSeed() external view returns (uint256 s) {
        assembly {
            s := prevrandao()
        }
    }

    function blobFee() external view returns (uint256) {
        return block.blobbasefee;
    }

    function burn(uint256 amount) external {
        payable(address(0)).transfer(amount);
    }

    function kill() external {
        selfdestruct(payable(address(0)));
    }

    function isEmpty(address who) external view returns (bool) {
        return usdc.balanceOf(who) == 0;
    }

    function tip() external payable {
        require(msg.value >= 1 ether, "too small");
    }

    function suppressed() external pure returns (uint256) {
        // arc-lint-disable-next-line arc/decimals-mix
        return 10 ** 18;
    }
}
