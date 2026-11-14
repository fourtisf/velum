// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsFunding} from "./PerpsFunding.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsLiquidation
/// @notice Anyone may liquidate a pair when either side's claim falls below maintenance margin
///         (10% of notional) at an oracle price at most 60 s old (a lagging effective price is fine).
///         The side with the smaller claim is liquidated:
///           penalty  = 1% of notional, taken from that side's remaining claim (capped at it),
///                      split 50/50 between the liquidator and the insurance fund;
///           loser    = its claim minus the penalty (never below zero);
///           winner   = the rest of the pool;
///           shortfall (loser claim below zero) becomes a cover claim for the winner, paid after the
///                      hourly epoch, pro rata, from the epoch's capped budget (PerpsCover, F-02).
///         If the loser could not pay the full penalty, the liquidator's reward is topped up from
///         insurance to half the full penalty, at most 1 USDG per liquidation (F-11). Top-ups count
///         against the same per-epoch cap as cover (R2-02): once the epoch's cap is used up, keepers get
///         only the penalty half (the winner still gains the pool by liquidating).
///         At a lagging price the loser is settled at the effective price, not the source price. It is
///         liquidatable, so its claim there is under 10% of notional: it keeps less than 9% of notional
///         (claim minus the 1% penalty) that it would lose at the source price, and the winner's cover
///         claim is smaller by the same amount (R2-04, documented bound).
/// @dev Liquidations are blocked while the L2 sequencer is down or in its grace period (F-05). Closing
///      or force-exiting a liquidatable position settles it through this same path (F-08, F-12).
abstract contract PerpsLiquidation is PerpsFunding {
    using FixedMath for uint256;

    struct LiquidationResult {
        bool takerSide;
        uint256 penalty;
        uint256 reward;
        uint256 shortfall;
        uint256 takerOut;
        uint256 makerOut;
    }

    function liquidate(uint256 id) external nonReentrant returns (uint256 reward) {
        Position storage p = _position(id);
        _requireSequencer();
        (uint256 price,) = _accrue(p.market, MAX_PRICE_AGE);
        if (!_liquidatable(p, price)) revert NotLiquidatable(id);
        (, reward) = _liquidateAt(id, p, price, msg.sender);
    }

    /// @notice Whether `liquidate(id)` would succeed now (view helper for keepers).
    function isLiquidatable(uint256 id) external view returns (bool liquidatable) {
        Position storage p = _positions[id];
        if (!p.open || !oracle.sequencerReady()) return false;
        uint256 price = oracle.price(p.market);
        (liquidatable,,,) = _liquidationSide(p, price, _pendingIndex(p.market, price));
    }

    /// @dev After `_accrue`: is either side below maintenance at `price`?
    function _liquidatable(Position storage p, uint256 price) internal view returns (bool liquidatable) {
        (liquidatable,,,) = _liquidationSide(p, price, markets[p.market].fundingIndex);
    }

    /// @dev Settle a liquidatable position (after `_accrue`) and pay `keeper` its reward.
    function _liquidateAt(uint256 id, Position storage p, uint256 price, address keeper)
        internal
        returns (uint256 takerOut, uint256 reward)
    {
        LiquidationResult memory r = _liquidationSplit(p, price);
        insurance += r.penalty - r.reward;
        // F-11: top the keeper up to half the full penalty (capped) when the loser could not pay it,
        // drawing on the current epoch's cover cap (R2-02) like a cover claim.
        uint256 target =
            FixedMath.min(_notionalUp(p.qty, price).mulDivUp(LIQUIDATION_PENALTY_BPS, BPS) / 2, keeperRewardCap);
        if (r.reward < target) r.reward += _drawCover(coverEpochs[currentCoverEpoch()], target - r.reward);
        emit Liquidated(id, keeper, r.takerSide, price, r.penalty, r.reward, r.shortfall);
        _emitChange(id, p, Action.Liquidate, price);
        emit PositionSettled(
            id, price, _takerPnl(p, price), _takerFunding(p, markets[p.market]), r.penalty, r.takerOut, r.makerOut
        );
        address winner = r.takerSide ? p.maker : p.taker;
        _settle(p, r.takerOut, r.makerOut);
        if (r.shortfall != 0) _fileClaim(winner, r.shortfall);
        _pay(keeper, r.reward);
        return (r.takerOut, r.reward);
    }

    /// @dev Split the pool between loser, winner and penalty at `price`.
    function _liquidationSplit(Position storage p, uint256 price) internal view returns (LiquidationResult memory r) {
        int256 takerClaim;
        uint256 notional;
        (, r.takerSide, takerClaim, notional) = _liquidationSide(p, price, markets[p.market].fundingIndex);
        uint256 pool = p.takerMargin + p.makerMargin;
        int256 loserClaim = r.takerSide ? takerClaim : FixedMath.toInt(pool) - takerClaim;
        uint256 loserOut;
        if (loserClaim <= 0) {
            r.shortfall = FixedMath.toUint(-loserClaim);
        } else {
            uint256 lc = FixedMath.toUint(loserClaim);
            r.penalty = FixedMath.min(notional.mulDivUp(LIQUIDATION_PENALTY_BPS, BPS), lc);
            loserOut = lc - r.penalty;
        }
        // The loser always holds the smaller claim, so loserOut + penalty <= pool / 2.
        uint256 winnerOut = pool - loserOut - r.penalty;
        r.reward = r.penalty / 2;
        (r.takerOut, r.makerOut) = r.takerSide ? (loserOut, winnerOut) : (winnerOut, loserOut);
    }
}
