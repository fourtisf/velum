// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VelumBase} from "../Base.t.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {IVelumVault} from "../../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../../src/interfaces/IMakerBook.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {BombAccount} from "./AuditHelpers.sol";

/// @notice Internal audit (2026-11) proof-of-concept tests, named after the finding they prove
///         (IDs as in docs/audit/2026-11-internal.md). Tests named test_Fxx_fixed_* are regressions:
///         they run the original exploit and assert it now fails. test_F09_* and test_F10_residual_*
///         document what remains of the accepted Low findings.
contract AuditPoC is VelumBase {
    address internal mallory = makeAddr("mallory"); // attacker, maker address
    address internal mallory2 = makeAddr("mallory2"); // attacker, second (taker) address

    // ------------------------------------------------------------ helpers

    function _pos(uint256 id) internal view returns (PerpsBase.Position memory) {
        return perps.getPosition(id);
    }

    function _fundingIndex() internal view returns (int256 idx) {
        (,,,, idx,,) = perps.markets(address(tsla));
    }

    function _fundingRate() internal view returns (int256 rate) {
        (,,,,, rate,) = perps.markets(address(tsla));
    }

    function _offerAs(address maker, uint256 backing, uint16 openBps, uint16 closeBps) internal returns (uint256 id) {
        _fund(maker, usdg, backing);
        vm.prank(maker);
        id = book.postOffer(address(tsla), backing, backing, openBps, closeBps, uint64(block.timestamp + 365 days));
    }

    function _try(address caller, uint256 gasLimit, bytes memory data) internal returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(perps).call{gas: gasLimit}(data);
    }

    function _seedInsurance(uint256 amount) internal {
        _fund(carol, usdg, amount);
        vm.prank(carol);
        perps.fundInsurance(amount);
    }

    function _total(address a, address b) internal view returns (uint256) {
        return _bal(a, usdg) + _bal(b, usdg);
    }

    // ------------------------------------------------------------ F-01: return-bomb bond refund

    /// @notice F-01 regression (fixed): bond refunds are pull-only, so a requester contract that
    ///         answers ETH with a huge revert payload can no longer block close, liquidation or
    ///         forced-exit settlement. The refund is recorded and claimable instead.
    function test_F01_fixed_takerBombCannotBlockLiquidation() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        BombAccount evil = new BombAccount();
        _fund(address(evil), usdg, 1000 * USD);
        vm.deal(address(evil), 1 ether);
        vm.prank(address(evil));
        uint256 id = perps.open(offer, address(tsla), true, 1000 * USD, 10, type(uint256).max);
        vm.prank(address(evil));
        perps.requestForcedExit{value: 0.001 ether}(id);
        evil.setArmed(true);

        _movePriceTo(address(tsla), 333e18);
        assertTrue(perps.isLiquidatable(id));
        assertTrue(_try(liquidator, 30_000_000, abi.encodeCall(perps.liquidate, (id))), "liquidation goes through");
        assertFalse(_pos(id).open);
        assertEq(perps.bondRefunds(address(evil)), 0.001 ether, "bond recorded for claiming");
    }

    function test_F01_fixed_makerBombCannotBlockTakerClose() public {
        BombAccount evilMaker = new BombAccount();
        _fund(address(evilMaker), usdg, 10_000 * USD);
        vm.deal(address(evilMaker), 1 ether);
        vm.prank(address(evilMaker));
        uint256 offer =
            book.postOffer(address(tsla), 10_000 * USD, 10_000 * USD, 5, 5, uint64(block.timestamp + 365 days));
        _fund(alice, usdg, 1001 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 2);
        _movePriceTo(address(tsla), 420e18);
        vm.prank(address(evilMaker));
        perps.requestForcedExit{value: 0.001 ether}(id);
        evilMaker.setArmed(true);

        assertTrue(_try(alice, 30_000_000, abi.encodeCall(perps.close, (id, 1))), "taker closes");
        assertFalse(_pos(id).open);
    }

    // ------------------------------------------------------------ F-02: self-paired gap straddle

    /// @dev The original exploit: a 5x long from mallory2 against mallory's own offer (SelfTrade only
    ///      compares one address), held over a 16 h relay silence, then a 30% gap and an immediate
    ///      liquidation for insurance cover. Returns the attacker's P&L. `selfLiquidate` = the attacker
    ///      liquidates (and keeps the reward) instead of a third-party keeper.
    function _straddle(bool down, bool selfLiquidate) internal returns (int256 pnl, uint256 fee) {
        _seedInsurance(20_000 * USD);
        uint256 offer = _offerAs(mallory, 20_000 * USD, 2, 0); // the open-spread floor (F-06)
        _fund(mallory2, usdg, 5000 * USD);
        uint256 start = _total(mallory, mallory2) + book.totalBacking();
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 20_000 * USD, 10, type(uint256).max);
        fee = 20_000 * USD * 6 / 10_000;

        vm.warp(block.timestamp + 16 hours); // market closed overnight, relay silent
        uint256 gap = down ? (TSLA_PRICE * 70) / 100 : (TSLA_PRICE * 130) / 100; // 30% gap
        _pushPrice(address(tsla), gap);
        // The first price after the silence moves at most 5% from the last recorded one (rate limit, R2-01).
        uint256 capped = down ? (TSLA_PRICE * 95) / 100 : (TSLA_PRICE * 105) / 100;
        assertEq(_effectivePrice(address(tsla)), capped);
        assertTrue(oracle.lagging(address(tsla)));
        // No shortfall can be cashed in at once; closing at a known-wrong price is refused too.
        if (down) {
            vm.prank(mallory2);
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
            perps.liquidate(id);
            vm.prank(mallory2);
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
            perps.close(id, 1);
        }
        // The price walks 5% per window; the first liquidatable step is solvent (one recording moves at most
        // 5%, half the 10% maintenance cushion) and pays the 1% penalty.
        while (!perps.isLiquidatable(id)) {
            _nextWindowPush(address(tsla), gap);
        }
        uint256 insBefore = perps.insurance();
        int256 claim = perps.takerClaimAt(id, _effectivePrice(address(tsla)));
        assertGt(claim, 0);
        assertLt(claim, int256(20_000 * USD * 2 / 5));
        vm.prank(selfLiquidate ? mallory2 : liquidator);
        perps.liquidate(id);
        assertGt(perps.insurance(), insBefore, "insurance gains half the penalty");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), mallory), 0, "no shortfall claim");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), mallory2), 0, "no shortfall claim");
        vm.prank(mallory);
        book.withdrawOffer(offer);
        pnl = int256(_total(mallory, mallory2)) - int256(start);
        _assertPerpsSolvent();
    }

    /// @notice F-02 regression: the straddle now loses money even when the attacker liquidates itself
    ///         and keeps the keeper reward: it pays the fee plus the insurance half of the penalty.
    function test_F02_fixed_gapDownStraddleLosesMoney() public {
        (int256 pnl, uint256 fee) = _straddle(true, true);
        emit log_named_decimal_int("attacker P&L, -30% gap, self-liquidated", pnl, 6);
        assertLt(pnl, -int256(fee), "loses more than the fee");
    }

    function test_F02_fixed_gapUpStraddleLosesMoney() public {
        (int256 pnl, uint256 fee) = _straddle(false, true);
        emit log_named_decimal_int("attacker P&L, +30% gap, self-liquidated", pnl, 6);
        assertLt(pnl, -int256(fee), "loses more than the fee");
    }

    function test_F02_fixed_gapStraddleLosesMoreWithKeeper() public {
        (int256 pnl, uint256 fee) = _straddle(true, false);
        emit log_named_decimal_int("attacker P&L, -30% gap, keeper liquidated", pnl, 6);
        assertLt(pnl, -int256(fee));
    }

    /// @notice F-02 worst case: keepers stay away while the price walks, so both an honest pair and the
    ///         attacker's self-pair go insolvent. Cover is not paid at liquidation: it is reserved against the
    ///         epoch's cap (10% of the fund at its first draw, shared with keeper top-ups, R2-02), paid after
    ///         the epoch ends, pro rata; the rest is a haircut.
    function test_F02_fixed_worstCaseCoverDeferredCappedProRata() public {
        _seedInsurance(20_000 * USD);
        uint256 honestOffer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 2100 * USD);
        uint256 honest = _open(alice, honestOffer, true, 10_000 * USD, 10);
        uint256 evilOffer = _offerAs(mallory, 20_000 * USD, 2, 0);
        _fund(mallory2, usdg, 5000 * USD);
        vm.prank(mallory2);
        uint256 evil = perps.open(evilOffer, address(tsla), true, 20_000 * USD, 10, type(uint256).max);

        vm.warp(block.timestamp + 16 hours);
        _movePriceTo(address(tsla), (TSLA_PRICE * 70) / 100); // walks 7 windows, nobody liquidates
        uint256 insBefore = perps.insurance();
        uint256 bobBefore = _bal(bob, usdg);
        uint256 malloryBefore = _bal(mallory, usdg);
        uint256 epoch = perps.currentCoverEpoch();
        vm.startPrank(liquidator);
        perps.liquidate(honest);
        perps.liquidate(evil);
        vm.stopPrank();
        assertEq(_bal(bob, usdg) - bobBefore, 4000 * USD, "winner gets the pool, no cover yet");
        assertEq(_bal(mallory, usdg) - malloryBefore, 8000 * USD, "winner gets the pool, no cover yet");
        (,, uint256 budget,, uint256 cap, uint256 drawn,,) = perps.coverEpochs(epoch);
        assertEq(cap, insBefore / 10, "cap: 10% of the fund at the epoch's first draw");
        assertEq(drawn - budget, 2 * USD, "only the two capped keeper rewards paid now");
        assertEq(drawn, cap, "large claims: the whole cap is drawn");
        assertEq(insBefore - perps.insurance(), drawn);
        assertEq(perps.coverReserved(), budget, "cover reserved, not paid");
        uint256 bobClaim = perps.coverClaims(epoch, bob);
        uint256 evilClaim = perps.coverClaims(epoch, mallory);
        assertGt(bobClaim, 0);
        assertGt(evilClaim, 0);

        vm.expectRevert(abi.encodeWithSelector(PerpsBase.EpochNotOver.selector, epoch));
        perps.claimCover(epoch, mallory);
        vm.warp((epoch + 1) * 1 hours);
        uint256 ins = perps.insurance();
        assertEq(perps.settleCoverEpoch(epoch), budget, "budget fixed while the epoch ran");
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.EpochSettled.selector, epoch));
        perps.settleCoverEpoch(epoch);
        uint256 evilCover = perps.claimCover(epoch, mallory);
        uint256 bobCover = perps.claimCover(epoch, bob);
        uint256 claimed = bobClaim + evilClaim;
        assertEq(evilCover, evilClaim * budget / claimed, "pro rata");
        assertEq(bobCover, bobClaim * budget / claimed, "pro rata");
        assertLt(evilCover, evilClaim, "haircut");
        assertLt(bobCover, bobClaim, "haircut");
        assertEq(perps.coverReserved(), 0, "dust back to the fund");
        assertEq(perps.insurance(), ins + budget - evilCover - bobCover);
        vm.expectRevert(PerpsBase.NothingToClaim.selector);
        perps.claimCover(epoch, mallory);
        // Bounded: the attacker took at most its share of a tenth of the fund, only by keepers missing
        // more than 9 minutes in which its position offered a ~100 USDG liquidation reward.
        assertLe(evilCover, insBefore / 10);
        _assertPerpsSolvent();
    }

    /// @notice F-02 property: right after an open, no relayed price can push either side of a pair below zero
    ///         at the next recording, whatever the leverage, side or open spread (the 12-minute version at
    ///         arbitrary open prices is testFuzz_R2_01_fixed_noSideInsolventWithin12MinOfAnyNonLaggingOpen).
    function testFuzz_F02_fixed_bandKeepsPairsSolventWithinWindow(
        uint256 size,
        uint8 levHalf,
        bool isLong,
        uint16 openBps,
        uint256 pushed
    ) public {
        uint256 offer = _offerAs(bob, 100_000 * USD, uint16(bound(openBps, 2, 500)), 5);
        size = bound(size, 10 * USD, 30_000 * USD);
        levHalf = uint8(bound(levHalf, 2, 10));
        _fund(alice, usdg, size + size / 100);
        uint256 id = _open(alice, offer, isLong, size, levHalf);
        _pushPrice(address(tsla), bound(pushed, 1e18, 100_000e18));
        uint256 p = _effectivePrice(address(tsla));
        int256 takerClaim = perps.takerClaimAt(id, p);
        PerpsBase.Position memory pos = _pos(id);
        assertGe(takerClaim, 0, "taker solvent");
        assertGe(int256(pos.takerMargin + pos.makerMargin) - takerClaim, 0, "maker solvent");
    }

    // ------------------------------------------------------------ F-04: relayer power

    /// @notice F-04 regression: the relayer key pushed +10% eight times in 8 s to double the price and let an
    ///         accomplice take the maker's margin plus insurance. Now the reported price moves at most 1/6000
    ///         per second from the last recorded price (1% per minute, at most 5% per recording): after those
    ///         8 s it has moved 0.13%, the maker is nowhere near liquidation, the accomplice cannot exit at the
    ///         pushed price, and doubling takes over 69 minutes.
    function test_F04_fixed_relayerCannotDoublePriceQuickly() public {
        _seedInsurance(1000 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(mallory2, usdg, 1000 * USD);
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 1000 * USD, 10, type(uint256).max);
        uint256 p = TSLA_PRICE;
        for (uint256 i; i < 8; ++i) {
            p = (p * 110) / 100;
            _pushPrice(address(tsla), p);
        }
        assertGt(p, 2 * TSLA_PRICE);
        assertLe(_effectivePrice(address(tsla)), (TSLA_PRICE * 10_014) / 10_000, "+0.13% after 8 s");
        uint256 ins = perps.insurance();
        vm.prank(mallory2);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
        perps.liquidate(id);
        vm.prank(mallory2);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.close(id, 1);
        assertEq(perps.insurance(), ins, "no insurance paid out");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), mallory2), 0);

        // Doubling now takes 15 recording windows (75 minutes) with one push per window, and at least
        // 69 minutes even with a recording every second: time for makers and keepers to react.
        uint256 t0 = block.timestamp;
        while (_effectivePrice(address(tsla)) < 2 * TSLA_PRICE) {
            _nextWindowPush(address(tsla), 2 * TSLA_PRICE);
        }
        assertGe(block.timestamp - t0, 69 minutes);
    }

    // ------------------------------------------------------------ F-06: free option on stale prices

    /// @notice F-06 regression: opens need a price at most 10 s old (closes keep 60 s).
    function test_F06_fixed_opensNeedTenSecondPrice() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 2, 5);
        _fund(alice, usdg, 2000 * USD);
        uint256 id = _open(alice, offer, true, 500 * USD, 4);
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 11);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        perps.open(offer, address(tsla), true, 500 * USD, 4, type(uint256).max);
        vm.warp(at + 60);
        vm.prank(alice);
        perps.close(id, 1); // a 60 s old price is still fine for closing
        assertFalse(_pos(id).open);
    }

    /// @notice F-06 regression: 0-spread offers (the other half of the free option) are refused.
    function test_F06_fixed_zeroSpreadOffersRefused() public {
        _fund(mallory, usdg, 1000 * USD);
        vm.prank(mallory);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 1000 * USD, 1000 * USD, 0, 0, uint64(block.timestamp + 1 days));
    }

    // ------------------------------------------------------------ F-07: corporate actions

    /// @notice F-07: the optional guardian can only switch a market into or out of close-only. Opens stop;
    ///         closing, margin, liquidation and forced exit keep working; no balance moves.
    function test_F07_fixed_guardianCloseOnly() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 3000 * USD);
        vm.deal(alice, 1 ether);
        uint256 a = _open(alice, offer, true, 1000 * USD, 10);
        uint256 b = _open(alice, offer, true, 1000 * USD, 4);
        uint256 c = _open(alice, offer, false, 500 * USD, 4);

        vm.prank(alice);
        vm.expectRevert(PerpsBase.NotGuardian.selector);
        perps.setCloseOnly(address(tsla), true);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.UnknownMarket.selector, address(usdg)));
        perps.setCloseOnly(address(usdg), true);

        uint256 perpsBal = _bal(address(perps), usdg);
        uint256 bookBal = _bal(address(book), usdg);
        uint256 ins = perps.insurance();
        vm.prank(guardian);
        perps.setCloseOnly(address(tsla), true);
        assertTrue(perps.closeOnly(address(tsla)));
        assertEq(_bal(address(perps), usdg), perpsBal, "no funds move");
        assertEq(_bal(address(book), usdg), bookBal, "no funds move");
        assertEq(perps.insurance(), ins);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.CloseOnly.selector, address(tsla)));
        perps.open(offer, address(tsla), true, 500 * USD, 4, type(uint256).max);
        vm.prank(alice);
        perps.close(b, 1);
        vm.prank(alice);
        perps.addMargin(c, 10 * USD);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(c);
        _movePriceTo(address(tsla), 345e18);
        vm.prank(liquidator);
        perps.liquidate(a);
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), 345e18);
        perps.settleForcedExit(c);

        vm.prank(guardian);
        perps.setCloseOnly(address(tsla), false);
        _open(alice, offer, true, 500 * USD, 4);
        _assertPerpsSolvent();
    }

    function test_F07_fixed_noGuardianNoSwitch() public {
        PerpsMarkets p = new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );
        p.setup(_stocks(), new uint256[](2), address(0));
        vm.prank(address(0));
        vm.expectRevert(PerpsBase.NotGuardian.selector);
        p.setCloseOnly(address(tsla), true);
        vm.expectRevert(PerpsBase.NotGuardian.selector); // not even the deployer
        p.setCloseOnly(address(tsla), true);
    }

    // ------------------------------------------------------------ F-08: forced exit vs penalty

    /// @notice F-08 regression: a loser below maintenance with a matured forced-exit request used to settle
    ///         it itself and skip the liquidation penalty. Now that settlement is a liquidation: the
    ///         penalty applies (half to insurance) and the settler gets the keeper half.
    function test_F08_fixed_forcedExitOnLiquidatablePaysPenalty() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 2, 500); // 5% binding close spread
        _fund(alice, usdg, 1000 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 7 days);
        _movePriceTo(address(tsla), 353e18);
        perps.advanceFunding(address(tsla));
        assertTrue(perps.isLiquidatable(id));
        int256 claim = perps.takerClaimAt(id, 353e18);
        assertGt(claim, 0);
        uint256 penalty = (_pos(id).qty * 353e18 + 1e30 - 1) / 1e30;
        penalty = (penalty * 100 + 9999) / 10_000;
        uint256 insBefore = perps.insurance();
        uint256 before = _bal(alice, usdg);
        vm.prank(alice);
        perps.settleForcedExit(id);
        assertEq(_bal(alice, usdg) - before, uint256(claim) - penalty + penalty / 2, "penalty applied");
        assertEq(perps.insurance() - insBefore, penalty - penalty / 2);
        assertEq(perps.bondRefunds(alice), 0.001 ether);
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ F-09: wash trading moves funding (accepted)

    /// @notice F-09 (accepted Low, documented): funding follows global taker skew, so a self-paired
    ///         position still moves it. It is bounded by the 0.01%/h cap and costs fees and locked margin.
    function test_F09_washTradeStillMovesFundingWithinCap() public {
        uint256 offer = _offerAs(bob, 50_000 * USD, 5, 5);
        _fund(alice, usdg, 10_000 * USD);
        _fund(carol, usdg, 10_000 * USD);
        _open(alice, offer, true, 1000 * USD, 4); // honest long
        _open(carol, offer, false, 3000 * USD, 4); // honest short: shorts dominate
        assertLt(_fundingRate(), 0, "longs receive before the wash");

        uint256 m = _offerAs(mallory, 30_000 * USD, 2, 0);
        _fund(mallory2, usdg, 10_000 * USD);
        uint256 lockedBefore = perps.totalMargin();
        vm.prank(mallory2);
        perps.open(m, address(tsla), true, 30_000 * USD, 10, type(uint256).max);
        assertGt(_fundingRate(), 0, "longs pay after the wash");
        assertLe(_fundingRate(), perps.MAX_FUNDING_RATE_PER_HOUR(), "within the cap");
        assertEq(perps.totalMargin() - lockedBefore, 12_000 * USD, "attacker locks 40% of the wash size");
    }

    // ------------------------------------------------------------ F-10, F-11, F-12

    /// @notice F-10: positions below 10 USDG are refused, so dust cannot grief keepers or the book.
    function test_F10_fixed_dustPositionsRejected() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 2, 5);
        _fund(mallory2, usdg, 100 * USD);
        vm.prank(mallory2);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PositionTooSmall.selector, 9_999_999, 10 * USD));
        perps.open(offer, address(tsla), true, 9_999_999, 10, type(uint256).max);
        vm.prank(mallory2);
        perps.open(offer, address(tsla), true, 10 * USD, 10, type(uint256).max);
    }

    /// @notice F-11: an insolvent position (nothing left for a penalty) still pays its liquidator a
    ///         flat 1 USDG from insurance, so bad debt gets cleared. The top-up is drawn against the epoch's
    ///         cover cap, ahead of the shortfall's cover (R2-02).
    function test_F11_fixed_insolventLiquidationPaysKeeper() public {
        _seedInsurance(100 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1000 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 290e18); // nobody liquidates on the way
        perps.advanceFunding(address(tsla));
        assertLt(perps.takerClaimAt(id, 290e18), 0);
        uint256 ins = perps.insurance();
        vm.prank(liquidator);
        uint256 reward = perps.liquidate(id);
        assertEq(reward, 1 * USD);
        assertEq(_bal(liquidator, usdg), 1 * USD);
        (,, uint256 budget,, uint256 cap, uint256 drawn,,) = perps.coverEpochs(perps.currentCoverEpoch());
        assertEq(drawn - budget, 1 * USD, "top-up drawn against the cap");
        assertEq(drawn, cap, "the rest of the cap reserved for the maker's claim");
        assertEq(ins - perps.insurance(), drawn);
        _assertPerpsSolvent();
    }

    /// @notice F-11: the top-up is half the full 1% penalty, capped at 1 USDG, so dust cannot farm it.
    function test_F11_fixed_keeperTopUpScalesWithSize() public {
        _seedInsurance(100 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 100 * USD);
        uint256 id = _open(alice, offer, true, 50 * USD, 10);
        _movePriceTo(address(tsla), 290e18);
        vm.prank(liquidator);
        uint256 reward = perps.liquidate(id);
        uint256 fullPenalty = ((_pos(id).qty * 290e18 + 1e30 - 1) / 1e30 * 100 + 9999) / 10_000;
        assertEq(reward, fullPenalty / 2);
        assertLt(reward, 1 * USD);
    }

    /// @notice F-12 regression: closing against an insolvent maker used to cap the taker at the pool and
    ///         forfeit cover. Now the close settles as a liquidation and the shortfall is claimed.
    function test_F12_fixed_closeAgainstInsolventMakerKeepsCoverClaim() public {
        _seedInsurance(2000 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1001 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 2); // 1x: maker posts 200
        _movePriceTo(address(tsla), 520e18);
        perps.advanceFunding(address(tsla));
        int256 claim = perps.takerClaimAt(id, 520e18);
        uint256 pool = 1200 * USD;
        assertGt(claim, int256(pool));
        uint256 epoch = perps.currentCoverEpoch();
        vm.prank(alice);
        assertEq(perps.close(id, 1), pool);
        assertEq(perps.coverClaims(epoch, alice), uint256(claim) - pool);
        vm.warp((epoch + 1) * 1 hours);
        uint256 before = _bal(alice, usdg);
        perps.claimCover(epoch, alice);
        assertEq(_bal(alice, usdg) - before, uint256(claim) - pool, "covered (under the 10% cap)");
        _assertPerpsSolvent();
    }

    /// @notice F-12: an insolvent taker closing no longer strips the maker of its cover claim.
    function test_F12_fixed_insolventTakerCloseKeepsMakerClaim() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1000 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 300e18);
        perps.advanceFunding(address(tsla));
        int256 claim = perps.takerClaimAt(id, 300e18);
        assertLt(claim, 0);
        uint256 bobBefore = _bal(bob, usdg);
        vm.prank(alice);
        assertEq(perps.close(id, 1), 0);
        assertEq(_bal(bob, usdg) - bobBefore, 400 * USD);
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), bob), uint256(-claim));
    }

    // ------------------------------------------------------------ I-1 and event / error nits

    /// @notice I-1 regression: a deposit credited to a module (stranded before) is refused.
    function test_I1_fixed_depositToModuleRejected() public {
        usdg.mint(carol, 100 * USD);
        vm.startPrank(carol);
        usdg.approve(address(vault), 100 * USD);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.ModuleRecipient.selector, address(perps)));
        vault.deposit(address(usdg), 100 * USD, address(perps));
        vm.stopPrank();
        assertEq(_bal(address(perps), usdg), perps.totalMargin() + perps.insurance() + perps.coverReserved());
    }

    /// @notice PositionSettled.fee reports the liquidation penalty (was 0).
    function test_nit_fixed_liquidationSettledFeeIsPenalty() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1000 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 345e18);
        vm.recordLogs();
        vm.prank(liquidator);
        perps.liquidate(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 penalty;
        uint256 fee = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == PerpsBase.Liquidated.selector) {
                (,, penalty,,) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256));
            } else if (logs[i].topics[0] == PerpsBase.PositionSettled.selector) {
                (,,, fee,,) = abi.decode(logs[i].data, (uint256, int256, int256, uint256, uint256, uint256));
            }
        }
        assertGt(penalty, 0);
        assertEq(fee, penalty);
    }

    /// @notice A dead-oracle forced exit used to reset the rate without accruing (and the round-1 nit removed the
    ///         FundingAdvanced that claimed the index was current). Since IA-02 the dead exit settles funding up to
    ///         the last valid time and nothing over the dead period, so the index IS current: FundingAdvanced
    ///         reports it unchanged over the dead period, with the reset rate.
    function test_nit_IA02_fixed_deadOracleSettlementReportsIndexFrozenOverDeadPeriod() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1000 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offer, true, 1000 * USD, 4);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 15 days);
        assertTrue(oracle.isDead(address(tsla)));
        int256 idx = _fundingIndex();
        vm.expectEmit(address(perps));
        emit PerpsBase.FundingAdvanced(address(tsla), 0, idx, block.timestamp);
        perps.settleForcedExit(id);
        assertEq(_fundingIndex(), idx, "no accrual over the dead period");
        assertEq(_fundingRate(), 0, "rate reset");
    }

    function test_nit_fixed_removeMarginOversizeError() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1000 * USD);
        uint256 id = _open(alice, offer, true, 500 * USD, 4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.ExceedsMargin.selector, 251 * USD, 250 * USD));
        perps.removeMargin(id, 251 * USD);
    }
}

/// @notice F-10 residual: self-paired positions can still fill a side's open-interest cap, but only by
///         locking 40% of the capped notional as margin and paying the fee; caps must be sized with that
///         in mind (README, known limitations).
contract AuditOiCapPoC is VelumBase {
    function _oiCap() internal pure override returns (uint256) {
        return 150e18;
    }

    function test_F10_residual_oiCapGriefingLocksCapital() public {
        address m1 = makeAddr("m1");
        address m2 = makeAddr("m2");
        _fund(m1, usdg, 60_000 * USD);
        vm.prank(m1);
        uint256 offer =
            book.postOffer(address(tsla), 60_000 * USD, 60_000 * USD, 2, 0, uint64(block.timestamp + 1 days));
        _fund(m2, usdg, 20_000 * USD);
        vm.startPrank(m2);
        perps.open(offer, address(tsla), true, 39_000 * USD, 10, type(uint256).max); // ~99.6 TSLA
        perps.open(offer, address(tsla), true, 19_500 * USD, 10, type(uint256).max); // ~49.8 TSLA
        vm.stopPrank();
        assertEq(perps.totalMargin(), (39_000 + 19_500) * USD * 2 / 5, "40% of the notional locked");
        assertEq(perps.insurance(), (39_000 + 19_500) * USD * 6 / 10_000, "fees paid");

        _fund(alice, usdg, 1000 * USD);
        uint256 honest = _postOffer(10_000 * USD, 10_000 * USD, 5, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.OpenInterestCap.selector, address(tsla)));
        perps.open(honest, address(tsla), true, 500 * USD, 4, type(uint256).max);
    }
}

/// @notice F-04 (deploy): the testnet deploy refuses a missing or deployer-owned price-relay key, and
///         mainnet entirely.
contract AuditDeployPoC is Test {
    function test_F04_fixed_deployRefusesSharedRelayerKey() public {
        Deploy d = new Deploy();
        address deployer = makeAddr("deployer");
        address relay = makeAddr("relay");
        vm.expectRevert(bytes("Velum: set PRICE_RELAYER to the dedicated price-relay key"));
        d.checkRelayer(46_630, false, deployer, deployer);
        vm.expectRevert(bytes("Velum: set PRICE_RELAYER to the dedicated price-relay key"));
        d.checkRelayer(46_630, true, address(0), deployer);
        vm.expectRevert(bytes("Velum: PRICE_RELAYER must not be the deployer key"));
        d.checkRelayer(46_630, true, deployer, deployer);
        d.checkRelayer(46_630, true, relay, deployer);
        d.checkRelayer(31_337, false, deployer, deployer); // anvil may use the deployer
        vm.expectRevert(bytes("Velum: refusing Robinhood Chain mainnet (4663)"));
        d.checkRelayer(4663, true, relay, deployer);
    }

    /// @notice F-07 (round 2): the guardian stays off by default, but the deploy script now says loudly that
    ///         without GUARDIAN the split/dividend procedure is unavailable.
    function test_F07_fixed_deployWarnsWithoutGuardian() public {
        Deploy d = new Deploy();
        string memory none = d.guardianNotice(address(0));
        assertTrue(vm.contains(none, "WARNING"));
        assertTrue(vm.contains(none, "GUARDIAN is not set"));
        assertTrue(vm.contains(none, "split / dividend procedure"));
        assertTrue(vm.contains(none, "UNAVAILABLE"));
        string memory set = d.guardianNotice(makeAddr("guardian"));
        assertFalse(vm.contains(set, "WARNING"));
        assertTrue(vm.contains(set, "corporate-actions procedure available"));
    }

    function test_F04_fixed_deployRefusesMainnet() public {
        Deploy d = new Deploy();
        vm.chainId(4663);
        vm.expectRevert(
            bytes(
                "Velum: refusing Robinhood Chain mainnet (4663). Mainnet needs the Phase 5 external audit of contracts and circuits."
            )
        );
        d.run();
    }
}

/// @notice Chainlink-sourced market with an L2 sequencer-uptime feed (production path): F-03, F-05.
contract AuditChainlinkPoC is Test {
    uint256 internal constant USD = 1e6;
    MockERC20 internal usdg;
    MockERC20 internal tsla;
    VelumVault internal vault;
    OracleAdapter internal oracle;
    MakerBook internal book;
    PerpsMarkets internal perps;
    MockAggregator internal feed;
    MockAggregator internal sequencer;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        vault = new VelumVault();
        oracle = new OracleAdapter();
        book = new MakerBook(IVelumVault(address(vault)), address(usdg));
        perps = new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );
        feed = new MockAggregator(8);
        feed.set(391.65e8, block.timestamp);
        sequencer = new MockAggregator(0);
        sequencer.set(0, block.timestamp - 1 days); // up for a day

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(tsla);
        address[] memory modules = new address[](2);
        modules[0] = address(book);
        modules[1] = address(perps);
        address[] memory blocked = new address[](1);
        blocked[0] = address(oracle);
        vault.setup(tokens, modules, blocked);

        address[] memory stocks = new address[](1);
        stocks[0] = address(tsla);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint128[] memory mins = new uint128[](1);
        uint128[] memory maxs = new uint128[](1);
        mins[0] = 1e18;
        maxs[0] = 100_000e18;
        oracle.setup(stocks, feeds, mins, maxs, address(0), address(sequencer));
        book.setup(address(perps), stocks);
        uint256[] memory caps = new uint256[](1);
        caps[0] = 10_000e18;
        perps.setup(stocks, caps, address(0));
    }

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(vault), amount);
        vault.deposit(address(usdg), amount, who);
        vault.setApproval(address(book), true);
        vault.setApproval(address(perps), true);
        vm.stopPrank();
    }

    function _offer() internal returns (uint256 offer) {
        _fund(bob, 10_000 * USD);
        vm.prank(bob);
        offer = book.postOffer(address(tsla), 10_000 * USD, 10_000 * USD, 5, 5, uint64(block.timestamp + 60 days));
    }

    function _openLong(address who, uint256 offer, uint8 levHalf) internal returns (uint256 id) {
        _fund(who, 1000 * USD);
        vm.prank(who);
        id = perps.open(offer, address(tsla), true, 1000 * USD, levHalf, type(uint256).max);
    }

    // ------------------------------------------------------------ F-03

    /// @notice F-03 regression: one failed feed read made `isDead` true at once, so a matured forced exit
    ///         settled at the entry price (here ~80 USDG better for the losing taker). Now the failure is
    ///         only stale: settlement waits for a valid price and then uses it.
    function test_F03_fixed_transientFeedFailureIsStaleNotDead() public {
        uint256 offer = _offer();
        vm.deal(alice, 1 ether);
        uint256 id = _openLong(alice, offer, 10);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);

        vm.warp(block.timestamp + 7 days);
        feed.set(360.3e8, block.timestamp); // -8%: alice is losing ~80 USDG
        perps.advanceFunding(address(tsla)); // the first recording after the silence moves 5% (rate limit)
        vm.warp(block.timestamp + 5 minutes);
        feed.set(360.3e8, block.timestamp);
        perps.advanceFunding(address(tsla)); // caught up
        assertFalse(oracle.lagging(address(tsla)));
        assertEq(oracle.lastValidAt(address(tsla)), block.timestamp, "perps accrual records the reading");
        uint256 atEntry = uint256(perps.takerClaimAt(id, perps.getPosition(id).entry));

        vm.warp(block.timestamp + 1);
        feed.setBroken(true);
        assertFalse(oracle.isDead(address(tsla)), "stale, not dead");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        perps.settleForcedExit(id);

        feed.setBroken(false);
        feed.set(360.3e8, block.timestamp);
        perps.advanceFunding(address(tsla));
        // alice requested the exit, so it settles like her plain close (IA-01): the 5 bps close spread and the fee
        uint256 exit = (360.3e18 * (10_000 - 5)) / 10_000;
        int256 claimAtExit = perps.takerClaimAt(id, exit);
        uint256 fee = (perps.getPosition(id).qty * exit * 6 + 1e34 - 1) / 1e34;
        uint256 before = vault.balanceOf(alice, address(usdg));
        vm.prank(alice);
        perps.settleForcedExit(id);
        uint256 got = vault.balanceOf(alice, address(usdg)) - before;
        assertEq(got, uint256(claimAtExit) - fee, "settled at the oracle");
        assertLt(got + 75 * USD, atEntry, "not at the entry price");
    }

    /// @notice F-03 regression: a zero answer is stale, not dead; dead only 14 days after the last valid price.
    ///         IA-06 refined what is valid: an out-of-bounds answer is a live reading (clamped to the bound), so a
    ///         feed that keeps publishing one keeps the token alive. A really dead feed is still dead.
    function test_F03_fixed_invalidAnswerIsStaleNotDead() public {
        assertTrue(oracle.poke(address(tsla)));
        feed.set(0.5e8, block.timestamp); // below the 1 USDG bound (e.g. after a split or a bad round)
        assertTrue(oracle.poke(address(tsla)), "IA-06: a live, clamped reading");
        uint256 t0 = block.timestamp;
        assertEq(oracle.lastValidAt(address(tsla)), t0);
        feed.set(0, block.timestamp);
        assertFalse(oracle.isDead(address(tsla)));
        assertFalse(oracle.poke(address(tsla)), "zero answer: invalid, records nothing");
        vm.warp(t0 + 14 days);
        assertFalse(oracle.isDead(address(tsla)));
        vm.warp(t0 + 14 days + 1);
        assertTrue(oracle.isDead(address(tsla)), "a really dead feed still counts as dead");
        feed.set(0.5e8, block.timestamp); // publishing again, even out of bounds: alive
        assertFalse(oracle.isDead(address(tsla)));
        feed.set(0.5e8, t0); // a stuck feed repeating an old round is not fresh: dead
        assertTrue(oracle.isDead(address(tsla)));
    }

    // ------------------------------------------------------------ F-05

    /// @notice F-05 regression: while the L2 sequencer is down and for an hour after it returns, opens,
    ///         liquidations and margin removal are blocked; closing and adding margin still work.
    function test_F05_fixed_sequencerDownBlocksOpensAndLiquidations() public {
        uint256 offer = _offer();
        uint256 a = _openLong(alice, offer, 10);
        uint256 b = _openLong(carol, offer, 10);
        // walk the feed down 15% (5% per 5-minute recording): both 5x longs below maintenance, still solvent
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            feed.set(332.9e8, block.timestamp);
            assertTrue(oracle.poke(address(tsla)));
        }
        assertFalse(oracle.lagging(address(tsla)));
        assertTrue(perps.isLiquidatable(a));

        sequencer.set(1, block.timestamp); // sequencer down
        assertFalse(perps.isLiquidatable(a));
        vm.prank(keeper);
        vm.expectRevert(PerpsBase.SequencerDown.selector);
        perps.liquidate(a);
        _fund(alice, 1000 * USD);
        vm.prank(alice);
        vm.expectRevert(PerpsBase.SequencerDown.selector);
        perps.open(offer, address(tsla), true, 500 * USD, 4, type(uint256).max);
        vm.prank(alice);
        perps.addMargin(a, 1 * USD); // adding margin works
        vm.prank(alice);
        vm.expectRevert(PerpsBase.SequencerDown.selector); // removing it does not
        perps.removeMargin(a, 1 * USD);
        vm.prank(carol);
        perps.close(b, 1); // closing works (a plain close: no liquidation while the sequencer is down)
        assertFalse(perps.getPosition(b).open);

        vm.warp(block.timestamp + 30 minutes);
        sequencer.set(0, block.timestamp); // back up: grace period starts
        vm.warp(block.timestamp + 1 hours);
        feed.set(332.9e8, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(PerpsBase.SequencerDown.selector);
        perps.liquidate(a);
        vm.prank(alice);
        vm.expectRevert(PerpsBase.SequencerDown.selector);
        perps.open(offer, address(tsla), true, 500 * USD, 4, type(uint256).max);

        vm.warp(block.timestamp + 1);
        feed.set(332.9e8, block.timestamp);
        assertTrue(oracle.sequencerReady());
        vm.prank(keeper);
        perps.liquidate(a);
        vm.prank(alice);
        perps.open(offer, address(tsla), true, 500 * USD, 4, type(uint256).max);
    }
}
