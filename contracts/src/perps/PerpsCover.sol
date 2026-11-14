// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsCover
/// @notice Deferred, capped, pro-rata insurance cover for liquidation shortfalls (internal audit F-02,
///         R2-02, R2-03).
///
/// When a liquidated side's claim is below zero, the winner is paid the whole pool at once and the
/// missing amount (the shortfall) becomes a claim in the current hourly epoch. Each epoch has a cap of
///         cap = COVER_CAP_BPS (10%) x insurance fund at the epoch's first draw,
/// fixed the first time the epoch draws on the fund. Two things draw on it, in the order they happen,
/// and leave the fund at once: keeper top-ups (F-11, paid immediately) and cover for filed claims
/// (reserved in `coverReserved`, paid after the epoch). So one epoch never takes more than a tenth of the
/// fund, whoever settles it and whenever; an event spanning two epochs takes at most 19% (10% + 10% of
/// the remaining 90%), k epochs at most 1 - 0.9^k (fees earned in between add to the base).
/// After the epoch ends, each claimant receives claim x budget / total claims, where budget is the cover
/// reserved during the epoch; the rest is a haircut to the winning side. Cover is therefore never
/// immediate and never first-come. Rounding dust returns to the fund when the last claimant is paid.
abstract contract PerpsCover is PerpsBase {
    using FixedMath for uint256;

    struct CoverEpoch {
        uint256 claimed; // total shortfall filed in the epoch
        uint256 outstanding; // claims not yet paid out
        uint256 budget; // cover reserved for the epoch's claims (part of `drawn`)
        uint256 paid; // cover paid so far
        uint256 cap; // 10% of the insurance fund at the epoch's first draw
        uint256 drawn; // keeper top-ups + budget drawn against `cap`
        bool capSet;
        bool settled; // closed for payout (CoverEpochSettled emitted)
    }

    mapping(uint256 epoch => CoverEpoch) public coverEpochs;
    mapping(uint256 epoch => mapping(address account => uint256)) public coverClaims;

    /// @notice Epoch that new shortfall claims and keeper top-ups are filed into.
    function currentCoverEpoch() public view returns (uint256) {
        return block.timestamp / COVER_EPOCH;
    }

    /// @notice Close an ended epoch for payout and report its budget (fixed while the epoch ran).
    function settleCoverEpoch(uint256 epoch) external nonReentrant returns (uint256 budget) {
        return _settleEpoch(epoch);
    }

    /// @notice Pay `account` its pro-rata share of an ended epoch's budget (settling the epoch first if
    ///         needed). Anyone may call; the payout always goes to `account`'s vault balance.
    function claimCover(uint256 epoch, address account) external nonReentrant returns (uint256 amount) {
        uint256 claim = coverClaims[epoch][account];
        if (claim == 0) revert NothingToClaim();
        CoverEpoch storage e = coverEpochs[epoch];
        if (!e.settled) _settleEpoch(epoch);
        amount = claim.mulDivDown(e.budget, e.claimed);
        coverClaims[epoch][account] = 0;
        e.outstanding -= claim;
        e.paid += amount;
        coverReserved -= amount;
        if (e.outstanding == 0) {
            uint256 dust = e.budget - e.paid;
            coverReserved -= dust;
            insurance += dust;
        }
        emit CoverPaid(epoch, account, claim, amount);
        _pay(account, amount);
    }

    function _settleEpoch(uint256 epoch) internal returns (uint256 budget) {
        if (epoch >= currentCoverEpoch()) revert EpochNotOver(epoch);
        CoverEpoch storage e = coverEpochs[epoch];
        if (e.settled) revert EpochSettled(epoch);
        if (e.claimed == 0) revert NothingToClaim();
        e.settled = true;
        budget = e.budget;
        emit CoverEpochSettled(epoch, e.claimed, budget);
    }

    /// @dev Record a shortfall owed to `account` in the current epoch and reserve cover for it, up to what
    ///      is left of the epoch's cap.
    function _fileClaim(address account, uint256 amount) internal {
        uint256 epoch = currentCoverEpoch();
        CoverEpoch storage e = coverEpochs[epoch];
        e.claimed += amount;
        e.outstanding += amount;
        coverClaims[epoch][account] += amount;
        uint256 reserved = _drawCover(e, amount);
        e.budget += reserved;
        coverReserved += reserved;
        emit CoverClaimFiled(epoch, account, amount);
    }

    /// @dev Take up to `amount` out of the insurance fund against epoch `e`'s cap, fixing the cap at the
    ///      epoch's first draw. The caller pays it out (top-up) or reserves it (cover).
    function _drawCover(CoverEpoch storage e, uint256 amount) internal returns (uint256 drawn) {
        if (!e.capSet) {
            e.capSet = true;
            e.cap = insurance.mulDivDown(COVER_CAP_BPS, BPS);
        }
        drawn = FixedMath.min(FixedMath.min(amount, e.cap - e.drawn), insurance);
        e.drawn += drawn;
        insurance -= drawn;
    }
}
