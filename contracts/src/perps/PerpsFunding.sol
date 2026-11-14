// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsFunding
/// @notice Per-market funding index. The hourly rate comes from the taker open-interest skew:
///         rate = MAX_FUNDING_RATE_PER_HOUR * (longOI - shortOI) / (longOI + shortOI),
///         so it is always within ±0.01%/h. Positive rate: long takers pay, short takers receive;
///         the maker on the other side of each pair takes the opposite payment.
/// @dev The index accrues continuously (pro rata per second) and is brought up to date on every
///      open, close, margin change, liquidation and forced exit, and by anyone through
///      `advanceFunding`. Because opening always accrues first, "funding ran within the last hour"
///      holds for every new match by construction.
abstract contract PerpsFunding is PerpsBase {
    /// @notice Bring a market's funding index up to the current time (needs a fresh price).
    function advanceFunding(address market) external nonReentrant returns (int256 index) {
        if (!markets[market].enabled) revert UnknownMarket(market);
        _accrue(market);
        _setRate(market);
        return markets[market].fundingIndex;
    }

    /// @inheritdoc PerpsBase
    function _accrue(address market) internal override returns (uint256 price) {
        Market storage m = markets[market];
        price = oracle.price(market);
        uint256 dt = block.timestamp - m.lastFundingUpdate;
        if (dt != 0) {
            m.fundingIndex += FixedMath.mulDivFloorSigned(m.fundingRate, price * dt, 3600 * 1e18);
            // forge-lint: disable-next-line(unsafe-typecast)
            m.lastFundingUpdate = uint64(block.timestamp);
        }
    }

    /// @inheritdoc PerpsBase
    function _setRate(address market) internal override {
        Market storage m = markets[market];
        uint256 total = m.longOI + m.shortOI;
        int256 rate;
        if (total != 0) {
            rate = (MAX_FUNDING_RATE_PER_HOUR * (FixedMath.toInt(m.longOI) - FixedMath.toInt(m.shortOI)))
                / FixedMath.toInt(total);
        }
        m.fundingRate = rate;
        emit FundingAdvanced(market, rate, m.fundingIndex, block.timestamp);
    }
}
