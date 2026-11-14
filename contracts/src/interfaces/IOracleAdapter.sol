// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Prices are USDG per whole token, scaled by 1e18.
interface IOracleAdapter {
    /// @notice Fresh price (at most MAX_AGE seconds old). Reverts if stale, missing or out of bounds.
    function price(address token) external view returns (uint256);

    /// @notice True when no valid price arrived for DEAD_AFTER (14 days), or never.
    function isDead(address token) external view returns (bool);
}
