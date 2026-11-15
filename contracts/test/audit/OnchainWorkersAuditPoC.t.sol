// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "../Base.t.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";

/// @notice Independent audit of the Phase 3 on-chain workers (2026-11), M-1, inverted into regressions (`*_fixed`).
///
/// M-1  A signed `pushPrices` had no expiry and was stamped with its inclusion time: an RPC that withheld the relay's
///      transaction could land it minutes later as a fresh price. The auditor's run (apps/workers, anvil): the relay
///      signed 392.00, the RPC kept it, the market fell to 380.00, and 206 s later the old push landed as a fresh,
///      non-lagging price at which a short could open 3.2% above the market. Now every push carries the time its
///      prices were observed, must land within MAX_PUSH_DELAY (10 s, the open freshness) and must be newer than the
///      token's last observation; freshness and the rate-limit clock count from the observation.
contract OnchainWorkersAuditPoC is VelumBase {
    uint256 internal offerId;

    function setUp() public override {
        super.setUp();
        offerId = _postOffer(10_000e6, 5000e6, 10, 10);
        _fund(alice, usdg, 10_000e6);
    }

    function _push(uint256 p, uint256 observedAt) internal {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = p;
        vm.prank(relayer);
        oracle.pushPrices(t, v, observedAt);
    }

    /// @dev The relay's signed push (price and observation time), as the withholding RPC keeps it.
    function _signedPush(uint256 p, uint256 observedAt) internal pure returns (bytes memory) {
        return abi.encode(p, observedAt);
    }

    function _land(bytes memory signed) internal returns (bool ok, bytes memory ret) {
        (uint256 p, uint256 observedAt) = abi.decode(signed, (uint256, uint256));
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = p;
        vm.prank(relayer);
        (ok, ret) = address(oracle).call(abi.encodeCall(OracleAdapter.pushPrices, (t, v, observedAt)));
    }

    function _shortOpenAtStalePrice() internal returns (bool ok, bytes memory ret) {
        vm.prank(alice);
        (ok, ret) = address(perps).call(abi.encodeCall(perps.open, (offerId, address(tsla), false, 1000e6, 10, 1)));
    }

    /// @notice The auditor's R1 run: the withheld push lands 206 s after it was signed. Before: accepted as a fresh,
    ///         non-lagging 392.00 (true price 380.00) and a short opened at it. Now: refused (PushExpired), the price
    ///         stays stale and no open goes through.
    function test_M1_withheldPushLandedMinutesLaterIsRefused_fixed() public {
        vm.warp(block.timestamp + 30);
        uint256 t0 = block.timestamp;
        _push(391.65e18, t0); // honest push, lands at once
        // t0 + 9: the relay observes 392.00 and signs; the RPC answers the hash but keeps the transaction.
        vm.warp(t0 + 9);
        bytes memory held = _signedPush(392e18, t0 + 9);
        // The market falls to 380.00; the relay's replacements are withheld too; 197 s pass on chain.
        vm.warp(t0 + 9 + 197);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), t0));
        oracle.price(address(tsla));
        (bool ok, bytes memory ret) = _land(held);
        assertFalse(ok, "the old push no longer lands");
        assertEq(ret, abi.encodeWithSelector(OracleAdapter.PushExpired.selector, t0 + 9));
        (uint128 p, uint64 updatedAt,) = oracle.relayed(address(tsla));
        assertEq(p, 391.65e18);
        assertEq(updatedAt, t0);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), t0));
        oracle.price(address(tsla));
        (ok,) = _shortOpenAtStalePrice();
        assertFalse(ok, "no open at the stale price");
    }

    /// @notice Held for exactly MAX_PUSH_DELAY, the push still lands, but carries its age: the open window it leaves is
    ///         the 10 s counted from the observation, not from the landing, so delaying a push never extends the
    ///         option an open has on an old price.
    function test_M1_pushHeldForTheMaxDelayLeavesNoExtraOpenWindow_fixed() public {
        vm.warp(block.timestamp + 30);
        uint256 t0 = block.timestamp;
        _push(391.65e18, t0);
        vm.warp(t0 + 9);
        bytes memory held = _signedPush(392e18, t0 + 9);
        vm.warp(t0 + 9 + 10);
        (bool ok,) = _land(held);
        assertTrue(ok);
        (uint256 p, uint256 at) = oracle.latest(address(tsla));
        assertEq(p, 392e18);
        assertEq(at, t0 + 9, "stamped with its observation, not its inclusion");
        vm.warp(t0 + 9 + 11);
        bytes memory ret;
        (ok, ret) = _shortOpenAtStalePrice();
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), t0 + 9));
    }

    /// @notice A withheld push can never replace a newer one that landed (each token's observations only move forward).
    function test_M1_withheldOlderPushCannotOverrideANewerOne_fixed() public {
        vm.warp(block.timestamp + 30);
        uint256 t0 = block.timestamp;
        _push(391.65e18, t0);
        vm.warp(t0 + 9);
        bytes memory held = _signedPush(392e18, t0 + 9);
        // The relay pushes again through another endpoint (RPC_URL_SEND): observed t0 + 17, lands at t0 + 18.
        vm.warp(t0 + 18);
        _push(380e18 + 1, t0 + 17);
        vm.warp(t0 + 19);
        (bool ok, bytes memory ret) = _land(held);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(OracleAdapter.StaleObservation.selector, address(tsla), t0 + 9));
        (uint128 p,,) = oracle.relayed(address(tsla));
        assertEq(p, 380e18 + 1);
    }
}
