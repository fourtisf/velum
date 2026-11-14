// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Prices are USDG per whole token, scaled by 1e18. Every price is the adapter's rate-limited
///         ("effective") price: it moves from the last recorded price by at most 5% x dt / 5 minutes,
///         dt = time since that recording capped at 5 minutes (1% per minute, at most 5% per recording).
interface IOracleAdapter {
    /// @notice Fresh price (at most MAX_AGE seconds old). Reverts if stale, missing or out of bounds.
    function price(address token) external view returns (uint256);

    /// @notice Price no older than `maxAge` seconds (capped at MAX_AGE). Also records the reading: the
    ///         rate-limited price becomes the new last price, and the token's last valid time advances.
    ///         Reverts if stale, missing or out of bounds.
    /// @return p The effective (rate-limited) price.
    /// @return lagging True when the source price is outside the rate limit (the effective price is
    ///         catching up).
    function read(address token, uint256 maxAge) external returns (uint256 p, bool lagging);

    /// @notice Record the current source reading if it is valid (never reverts). It is rate-limited
    ///         exactly like any other recording.
    function poke(address token) external returns (bool valid);

    /// @notice True when no valid price was seen for DEAD_AFTER (14 days) since the last valid price,
    ///         or since setup if there never was one. A failed or out-of-bounds read is never "dead".
    function isDead(address token) external view returns (bool);

    /// @notice False while the L2 sequencer is down or within the grace period after it came back
    ///         (always true when no sequencer feed is configured: testnet relay only).
    function sequencerReady() external view returns (bool);
}
