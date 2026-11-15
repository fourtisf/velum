// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsLiquidation} from "./PerpsLiquidation.sol";

/// @title PerpsForcedExit
/// @notice Either side of a pair can request a forced exit with a refundable 0.001 ETH bond. Seven days later
///         anyone may settle it. The bond is refunded to the requester when the position closes for any reason.
///
///         Settlement price: the oracle price, at most 10 s old (OPEN_MAX_AGE, final audit FA-04: the settler
///         picks the moment, so the price must be as fresh as for an open; liquidations keep 60 s through
///         `liquidate`). If the oracle is dead (no valid price for 14 days) the entry price. If the source is
///         outside the oracle's fixed bounds and the effective price has reached the bound, the bound
///         (independent audit IA-06); any other lagging price is refused.
///         A position that is liquidatable at settlement is liquidated instead (internal audit F-08): the
///         penalty applies, the settler receives the liquidator reward, and the sequencer rule of
///         `liquidate` applies.
///
///         Economics depend on whose request it is (independent audit IA-01):
///           - taker's request: exactly what a plain close would cost, the maker's committed close spread and
///             the 0.06% close fee on exit notional, both capped at the taker's claim (so it never reverts on a
///             small margin), whoever calls settle. At the entry price (dead oracle) the spread and fee are
///             losses for the taker, never gains. The escape hatch stays, the close-spread bypass is gone.
///           - maker's request: the price with no spread and no fee (unchanged). Compared with the plain close
///             only the taker can do, the maker gives up its close spread and the taker pays nothing extra, so
///             the maker gains nothing over a close; the close fee is not charged to a taker who did not ask
///             to leave.
/// @dev In Phase 3 a taker can always close directly; forced exit is the "services went quiet" escape hatch
///      (for makers too, who otherwise depend on the taker closing) and the way out of a dead or out-of-bounds
///      market.
abstract contract PerpsForcedExit is PerpsLiquidation {
    function requestForcedExit(uint256 id) external payable nonReentrant {
        Position storage p = _position(id);
        if (msg.sender != p.taker && msg.sender != p.maker) revert NotParty();
        if (p.exitRequestedAt != 0) revert AlreadyRequested(id);
        if (msg.value != FORCED_EXIT_BOND) revert BadBond();
        // forge-lint: disable-next-line(unsafe-typecast)
        p.exitRequestedAt = uint64(block.timestamp);
        p.exitRequester = msg.sender;
        emit ForcedExitRequested(id, msg.sender, block.timestamp + FORCED_EXIT_DELAY);
    }

    function settleForcedExit(uint256 id) external nonReentrant {
        Position storage p = _position(id);
        if (p.exitRequestedAt == 0) revert NotRequested(id);
        uint256 settleAfter = uint256(p.exitRequestedAt) + FORCED_EXIT_DELAY;
        if (block.timestamp < settleAfter) revert TooEarly(settleAfter);
        bool atEntry = oracle.isDead(p.market);
        uint256 price = p.entry;
        if (atEntry) {
            _accrueDead(p.market); // IA-02: no funding over the dead period
        } else {
            bool lagging;
            // FA-04: whoever settles chooses when; a 60 s window would let them pick among a minute of stale
            // prices. 10 s, as for an open (the relay pushes every 5-8 s); a liquidatable position can always be
            // liquidated at 60 s through `liquidate`.
            (price, lagging) = _accrue(p.market, OPEN_MAX_AGE);
            (bool liquidatable, bool allowed) = _liquidationState(p, price);
            if (liquidatable) {
                if (!allowed) revert SequencerDown();
                emit ForcedExitSettled(id, price, false);
                _liquidateAt(id, p, price, msg.sender);
                return;
            }
            // IA-06: a source outside the bounds keeps the price lagging for good; settle at the bound once the
            // effective price has reached it. Any other lagging price is refused.
            if (lagging && !oracle.atBound(p.market)) revert PriceLagging(p.market);
        }
        emit ForcedExitSettled(id, price, atEntry);
        if (p.exitRequester == p.taker) {
            uint256 exit = _exitPrice(p, price);
            _settleAt(id, p, Action.ForcedExit, price, exit, _closeFee(p, exit));
        } else {
            _settleAt(id, p, Action.ForcedExit, price, price, 0);
        }
    }

    /// @notice Withdraw forced-exit bond refunds (refunds are never pushed during settlement).
    function claimBond() external nonReentrant {
        uint256 amount = bondRefunds[msg.sender];
        if (amount == 0) revert NothingToClaim();
        bondRefunds[msg.sender] = 0;
        emit BondClaimed(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
