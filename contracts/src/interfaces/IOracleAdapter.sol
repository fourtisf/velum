// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Prices are USDG per whole token, scaled by 1e18. Every price is the adapter's rate-limited
///         ("effective") price: the source price clamped to the token's fixed bounds, then moved from the last
///         recorded price by at most 5% x dt / 5 minutes, dt = time since that recording capped at 5 minutes
///         (1% per minute, at most 5% per recording). A price's age counts from its source timestamp: the feed's
///         round time, or for a relay-sourced token the observation time its push carried, which the adapter only
///         accepts up to MAX_PUSH_DELAY (10 s) before the push's block (on-chain workers audit M-1).
interface IOracleAdapter {
    /// @notice Fresh price (at most MAX_AGE seconds old). Reverts if stale or missing; a source price outside
    ///         the bounds is clamped to the nearest bound (and reads as lagging).
    function price(address token) external view returns (uint256);

    /// @notice Price no older than `maxAge` seconds (capped at MAX_AGE). Also records the reading: the
    ///         rate-limited price becomes the new last price, and the token's last valid time advances. A reading
    ///         of the same source value at an unchanged price writes nothing (the rate-limit clock keeps running,
    ///         final audit FA-01). Reverts if stale or missing.
    /// @return p The effective (clamped, rate-limited) price.
    /// @return lagging True when the effective price differs from the source price: the source is outside the
    ///         rate limit (the effective price is catching up) or outside the bounds.
    function read(address token, uint256 maxAge) external returns (uint256 p, bool lagging);

    /// @notice Record the current source reading if it is valid (never reverts, also with a broken feed). It is
    ///         clamped and rate-limited exactly like any other recording.
    function poke(address token) external returns (bool valid);

    /// @notice Live time for funding (FA-02, FA-03): block time minus every gap of more than DEAD_AFTER between two
    ///         consecutive valid source times; while such a gap is running it stands at the last valid time. A
    ///         valid source reading nobody recorded yet is counted as recording it would be.
    function liveClock(address token) external view returns (uint256);

    /// @notice True when no valid price was seen for DEAD_AFTER (14 days) since the last valid price,
    ///         or since setup if there never was one. Any positive answer is valid, inside the bounds or not
    ///         (a feed that keeps publishing out-of-bounds prices is alive); a failed or zero read never
    ///         makes a token dead by itself.
    function isDead(address token) external view returns (bool);

    /// @notice True when the source price is outside the bounds and the effective price has reached the
    ///         nearest bound (a recording now reports exactly the bound). Forced exits may settle there.
    function atBound(address token) external view returns (bool);

    /// @notice The last recorded effective price and the newest valid source timestamp recorded (zeros before
    ///         the first recording). A dead-oracle forced exit settles funding at this price.
    function lastRecorded(address token) external view returns (uint256 p, uint256 validAt);

    /// @notice `up`: the L2 sequencer reports up. `ready`: up for longer than the grace period. Both true
    ///         when no sequencer feed is configured (testnet relay only); both false if the feed is unreadable.
    function sequencerStatus() external view returns (bool up, bool ready);

    /// @notice False while the L2 sequencer is down or within the grace period after it came back
    ///         (always true when no sequencer feed is configured: testnet relay only).
    function sequencerReady() external view returns (bool);
}
