// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsFunding} from "./PerpsFunding.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsLiquidation
/// @notice Anyone may liquidate a pair when either side's claim falls below maintenance margin
///         (10% of notional) at a fresh oracle price. The side with the smaller claim is
///         liquidated:
///           penalty  = 1% of notional, taken from that side's remaining claim (capped at it),
///                      split 50/50 between the liquidator and the insurance fund;
///           loser    = its claim minus the penalty (never below zero);
///           winner   = the rest of the pool;
///           shortfall (loser claim below zero) is paid to the winner from insurance, as far as the
///                      fund reaches.
/// @dev Simplification vs docs/04: shortfall is covered immediately from the insurance balance
///      (no deferred pro-rata claim). Payouts can therefore never exceed the posted margins plus the
///      insurance fund.
abstract contract PerpsLiquidation is PerpsFunding {
    using FixedMath for uint256;

    struct LiquidationResult {
        bool takerSide;
        uint256 price;
        uint256 penaltyPaid;
        uint256 reward;
        uint256 cover;
        uint256 takerOut;
        uint256 makerOut;
    }

    function liquidate(uint256 id) external nonReentrant returns (uint256 reward) {
        Position storage p = _position(id);
        LiquidationResult memory r = _liquidation(id, p);
        insurance = insurance - r.cover + (r.penaltyPaid - r.reward);
        emit Liquidated(id, msg.sender, r.takerSide, r.price, r.penaltyPaid, r.reward, r.cover);
        _emitChange(id, p, Action.Liquidate, r.price);
        emit PositionSettled(
            id, r.price, _takerPnl(p, r.price), _takerFunding(p, markets[p.market]), 0, r.takerOut, r.makerOut
        );
        _settle(p, r.takerOut, r.makerOut);
        _pay(msg.sender, r.reward);
        return r.reward;
    }

    /// @dev Accrues funding, checks the position is liquidatable and computes the split.
    function _liquidation(uint256 id, Position storage p) internal returns (LiquidationResult memory r) {
        r.price = _accrue(p.market);
        int256 takerClaim = _takerClaim(p, markets[p.market], r.price);
        uint256 pool = p.takerMargin + p.makerMargin;
        int256 makerClaim = FixedMath.toInt(pool) - takerClaim;
        uint256 notional = _notionalUp(p.qty, r.price);
        int256 req = FixedMath.toInt(notional.mulDivUp(MM_BPS, BPS));

        if (takerClaim < req && takerClaim <= makerClaim) r.takerSide = true;
        else if (makerClaim < req) r.takerSide = false;
        else revert NotLiquidatable(id);

        int256 loserClaim = r.takerSide ? takerClaim : makerClaim;
        uint256 loserOut;
        uint256 shortfall;
        if (loserClaim <= 0) {
            shortfall = FixedMath.toUint(-loserClaim);
        } else {
            uint256 lc = FixedMath.toUint(loserClaim);
            r.penaltyPaid = FixedMath.min(notional.mulDivUp(LIQUIDATION_PENALTY_BPS, BPS), lc);
            loserOut = lc - r.penaltyPaid;
        }
        // The loser always holds the smaller claim, so loserOut + penaltyPaid <= pool / 2.
        uint256 winnerOut = pool - loserOut - r.penaltyPaid;
        r.cover = FixedMath.min(shortfall, insurance);
        winnerOut += r.cover;
        r.reward = r.penaltyPaid / 2;
        (r.takerOut, r.makerOut) = r.takerSide ? (loserOut, winnerOut) : (winnerOut, loserOut);
    }

    /// @notice Whether `liquidate(id)` would succeed at the current oracle price (view helper).
    function isLiquidatable(uint256 id) external view returns (bool) {
        Position storage p = _positions[id];
        if (!p.open) return false;
        uint256 price = oracle.price(p.market);
        int256 takerClaim = _takerClaim(p, markets[p.market], price);
        int256 makerClaim = FixedMath.toInt(p.takerMargin + p.makerMargin) - takerClaim;
        int256 req = FixedMath.toInt(_notionalUp(p.qty, price).mulDivUp(MM_BPS, BPS));
        return takerClaim < req || makerClaim < req;
    }
}
