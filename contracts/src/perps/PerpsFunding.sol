// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsCover} from "./PerpsCover.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsFunding
/// @notice Per-market funding index. The hourly rate comes from the taker open-interest skew:
///         rate = MAX_FUNDING_RATE_PER_HOUR * (longOI - shortOI) / (longOI + shortOI),
///         so it is always within ±0.01%/h. Positive rate: long takers pay, short takers receive;
///         the maker on the other side of each pair takes the opposite payment.
/// @dev The index accrues continuously (pro rata per second) and is brought up to date on every
///      open, close, margin change, liquidation and forced exit, and by anyone through
///      `advanceFunding`. Because opening always accrues first, "funding ran within the last hour"
///      holds for every new match by construction. Each accrual also records the oracle reading
///      (rate-limited last price and last valid time, internal audit F-03/F-04, R2-01). A dead-oracle forced
///      exit accrues only up to the token's last valid time and charges nothing for the dead period (IA-02).
abstract contract PerpsFunding is PerpsCover {
    /// @notice Bring a market's funding index up to the current time (needs a price at most 60 s old).
    function advanceFunding(address market) external nonReentrant returns (int256 index) {
        if (!markets[market].enabled) revert UnknownMarket(market);
        _accrue(market, MAX_PRICE_AGE);
        _setRate(market);
        return markets[market].fundingIndex;
    }

    /// @dev Reads the oracle (recording the reading) and accrues funding up to now.
    function _accrue(address market, uint256 maxAge) internal override returns (uint256 price, bool lagging) {
        Market storage m = markets[market];
        (price, lagging) = oracle.read(market, maxAge);
        uint256 dt = block.timestamp - m.lastFundingUpdate;
        if (dt != 0) {
            m.fundingIndex += _fundingDelta(m, price, dt);
            // forge-lint: disable-next-line(unsafe-typecast)
            m.lastFundingUpdate = uint64(block.timestamp);
        }
    }

    /// @dev Dead-oracle settlement (independent audit IA-02). There is no current price, so funding accrues at
    ///      the rate in force only up to the token's last valid time, at the last recorded price, and not at
    ///      all over the dead period after it; the market's clock then moves to now. The rate reset that
    ///      follows (`_settle` -> `_setRate`) therefore applies from now on, never back over the dead period.
    ///      "Last valid time" is the newest source timestamp the oracle recorded (anyone can `poke` first to
    ///      record a feed round nobody recorded).
    function _accrueDead(address market) internal {
        Market storage m = markets[market];
        (uint256 lastPrice, uint256 validAt) = oracle.lastRecorded(market);
        if (validAt > block.timestamp) validAt = block.timestamp;
        uint256 from = m.lastFundingUpdate;
        if (validAt > from) m.fundingIndex += _fundingDelta(m, lastPrice, validAt - from);
        // forge-lint: disable-next-line(unsafe-typecast)
        m.lastFundingUpdate = uint64(block.timestamp);
    }

    /// @dev The funding index `_accrue` would reach now at `price` (for views).
    function _pendingIndex(address market, uint256 price) internal view returns (int256) {
        Market storage m = markets[market];
        return m.fundingIndex + _fundingDelta(m, price, block.timestamp - m.lastFundingUpdate);
    }

    function _fundingDelta(Market storage m, uint256 price, uint256 dt) internal view returns (int256) {
        return FixedMath.mulDivFloorSigned(m.fundingRate, price * dt, 3600 * 1e18);
    }

    /// @dev Resets the rate from open interest. FundingAdvanced is only emitted when the index is current,
    ///      i.e. settled up to now (after `_accrue`, or after `_accrueDead`, which settles the dead period at
    ///      zero).
    function _setRate(address market) internal override {
        Market storage m = markets[market];
        uint256 total = m.longOI + m.shortOI;
        int256 rate;
        if (total != 0) {
            rate = (MAX_FUNDING_RATE_PER_HOUR * (FixedMath.toInt(m.longOI) - FixedMath.toInt(m.shortOI)))
                / FixedMath.toInt(total);
        }
        m.fundingRate = rate;
        if (m.lastFundingUpdate == block.timestamp) {
            emit FundingAdvanced(market, rate, m.fundingIndex, block.timestamp);
        }
    }
}
