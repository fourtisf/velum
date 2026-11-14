// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {PerpsFunding} from "./PerpsFunding.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsForcedExit
/// @notice Either side of a pair can request a forced exit with a refundable 0.001 ETH bond.
///         Seven days later anyone may settle it at the oracle price with no spread, no fee and no
///         penalty. If the oracle is dead (no valid price for 14 days) it settles at the entry
///         price. The bond is refunded to the requester when the position closes for any reason.
/// @dev In Phase 3 a taker can always close directly; forced exit is the "services went quiet"
///      escape hatch (for makers too, who otherwise depend on the taker closing).
abstract contract PerpsForcedExit is PerpsFunding {
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
        uint256 price = atEntry ? p.entry : _accrue(p.market);
        int256 claim = _takerClaim(p, markets[p.market], price);
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 takerOut = claim <= 0 ? 0 : FixedMath.min(FixedMath.toUint(claim), pool);
        uint256 makerOut = pool - takerOut;
        emit ForcedExitSettled(id, price, atEntry);
        _emitChange(id, p, Action.ForcedExit, price);
        emit PositionSettled(id, price, _takerPnl(p, price), _takerFunding(p, markets[p.market]), 0, takerOut, makerOut);
        _settle(p, takerOut, makerOut);
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
