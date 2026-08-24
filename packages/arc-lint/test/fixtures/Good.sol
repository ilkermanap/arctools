// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Arc-native accounting: the 6-decimal ERC-20 view is the only unit used, and
/// value is retired to an explicit sink rather than burned to address(0).
contract Good {
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    uint256 private constant ONE_USDC = 1e6;
    address public immutable sink;

    constructor(address _sink) {
        require(_sink != address(0), "sink required");
        sink = _sink;
    }

    function stake(uint256 amount) external {
        require(amount >= ONE_USDC, "min 1 USDC");
        USDC.transferFrom(msg.sender, address(this), amount);
    }

    function retire(uint256 amount) external {
        USDC.transfer(sink, amount);
    }

    function trulyEmpty(address who) external view returns (bool) {
        return who.balance == 0;
    }
}
