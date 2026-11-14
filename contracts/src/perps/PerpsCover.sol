// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsCover
/// @notice Deferred, capped, pro-rata insurance cover for liquidation shortfalls (internal audit F-02).
///
/// When a liquidated side's claim is below zero, the winner is paid the whole pool at once and the
/// missing amount (the shortfall) becomes a claim in the current hourly funding epoch. After the epoch
/// ends, anyone may settle it: the epoch's budget is
///         budget = min(total claims of the epoch, COVER_CAP_BPS (10%) x insurance fund now)
/// and each claimant receives claim x budget / total claims. Whatever is not covered is a haircut to
/// the winning side. Cover is therefore never immediate, never first-come, and one epoch can never take
/// more than a tenth of the fund. Rounding dust returns to the fund when the last claimant is paid.
abstract contract PerpsCover is PerpsBase {
    using FixedMath for uint256;

    struct CoverEpoch {
        uint256 claimed; // total shortfall filed in the epoch
        uint256 outstanding; // claims not yet paid out
        uint256 budget; // cover set aside at settlement
        uint256 paid; // cover paid so far
        bool settled;
    }

    mapping(uint256 epoch => CoverEpoch) public coverEpochs;
    mapping(uint256 epoch => mapping(address account => uint256)) public coverClaims;

    /// @notice Epoch that new shortfall claims are filed into.
    function currentCoverEpoch() public view returns (uint256) {
        return block.timestamp / COVER_EPOCH;
    }

    /// @notice Fix an ended epoch's budget, moving it from the insurance fund to `coverReserved`.
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
        budget = FixedMath.min(e.claimed, insurance.mulDivDown(COVER_CAP_BPS, BPS));
        e.budget = budget;
        insurance -= budget;
        coverReserved += budget;
        emit CoverEpochSettled(epoch, e.claimed, budget);
    }

    /// @dev Record a shortfall owed to `account` in the current epoch.
    function _fileClaim(address account, uint256 amount) internal {
        uint256 epoch = currentCoverEpoch();
        CoverEpoch storage e = coverEpochs[epoch];
        e.claimed += amount;
        e.outstanding += amount;
        coverClaims[epoch][account] += amount;
        emit CoverClaimFiled(epoch, account, amount);
    }
}
