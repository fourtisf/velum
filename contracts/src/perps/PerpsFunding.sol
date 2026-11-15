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
///      (rate-limited last price and last valid time, internal audit F-03/F-04, R2-01).
///
///      Funding runs on the oracle's live clock, not on block time (final audit FA-02, FA-03; it generalises
///      IA-02). A gap of more than the oracle's DEAD_AFTER (14 days) between two valid prices is dead time and is
///      never charged: an accrual charges the rate in force over the live time since the last accrual, that is up to
///      the last valid price before such a gap and from the first one after it. A dead-oracle forced exit charges up
///      to the last valid time at the last recorded price (IA-02); if the token stays dead and prices return later,
///      the time after the exit is dead time too, so the rate reset by the exit is never applied to it (FA-03). A
///      shorter gap is charged in full at the next accrual, as before: at most 14 days x 0.01%/h = 3.36% of the
///      price, which with the 5% cap on one price recording is at most 8.53% of notional, under the 10% maintenance
///      margin: a side that was above maintenance at the last valid price (funding accrued up to it) is still solvent
///      at the first accrual after the gap, so keepers get a liquidatable-and-solvent price (FA-02).
abstract contract PerpsFunding is PerpsCover {
    /// @dev The oracle's live clock at the market's last accrual (set at setup).
    mapping(address market => uint256) internal _fundingLiveAt;

    /// @notice Bring a market's funding index up to the current time (needs a price at most 60 s old).
    function advanceFunding(address market) external nonReentrant returns (int256 index) {
        if (!markets[market].enabled) revert UnknownMarket(market);
        _accrue(market, MAX_PRICE_AGE);
        _setRate(market);
        return markets[market].fundingIndex;
    }

    /// @dev Reads the oracle (recording the reading, which also books any dead gap that just ended) and accrues
    ///      funding over the live time since the last accrual at the effective price.
    function _accrue(address market, uint256 maxAge) internal override returns (uint256 price, bool lagging) {
        (price, lagging) = oracle.read(market, maxAge);
        _advanceIndex(market, price);
    }

    /// @dev Dead-oracle settlement (independent audit IA-02). There is no current price. The oracle is poked first,
    ///      so a feed round nobody recorded counts as the last valid price; the token is dead, so its live clock
    ///      stands at the last valid time and funding accrues at the rate in force up to that time, at the last
    ///      recorded price, and not at all over the dead period. The rate reset that follows (`_settle` ->
    ///      `_setRate`) therefore applies from now on, and if the token stays dead, the time after the exit is
    ///      dead time as well when prices return (FA-03).
    function _accrueDead(address market) internal {
        oracle.poke(market);
        (uint256 lastPrice,) = oracle.lastRecorded(market);
        _advanceIndex(market, lastPrice);
    }

    /// @dev Charge the rate in force over the live time since the last accrual, at `price`, and move the market's
    ///      funding clocks to now. The live clock can step back by at most a read's maxAge, when a gap found later
    ///      turns out to have started before an accrual: nothing is charged then, and nothing twice.
    function _advanceIndex(address market, uint256 price) internal {
        Market storage m = markets[market];
        uint256 live = oracle.liveClock(market);
        uint256 from = _fundingLiveAt[market];
        if (live > from) m.fundingIndex += _fundingDelta(m, price, live - from);
        _fundingLiveAt[market] = live;
        // forge-lint: disable-next-line(unsafe-typecast)
        m.lastFundingUpdate = uint64(block.timestamp);
    }

    /// @dev The funding index `_accrue` would reach now at `price` (for views).
    function _pendingIndex(address market, uint256 price) internal view returns (int256) {
        Market storage m = markets[market];
        uint256 live = oracle.liveClock(market);
        uint256 from = _fundingLiveAt[market];
        return live > from ? m.fundingIndex + _fundingDelta(m, price, live - from) : m.fundingIndex;
    }

    function _fundingDelta(Market storage m, uint256 price, uint256 dt) internal view returns (int256) {
        return FixedMath.mulDivFloorSigned(m.fundingRate, price * dt, 3600 * 1e18);
    }

    /// @dev Resets the rate from open interest. FundingAdvanced is only emitted when the index is current,
    ///      i.e. settled up to now (after `_accrue`, or after `_accrueDead`, which settles the dead period at
    ///      zero). `lastFundingUpdate` is the block time of the last accrual; the amount charged follows the live
    ///      clock.
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
