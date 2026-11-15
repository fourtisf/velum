// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "../Base.t.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {VelumVault} from "../../src/VelumVault.sol";

/// @notice Second-round audit (2026-11) regressions. The round-2 proofs of concept passed while their issue
///         existed; each is inverted here (test_R2_xx*_fixed*) and asserts that the attack now fails.
///
/// R2-01  The price band let one push move the reported price by +22% within a 10-minute window, and two
///        records around an attacker-timed roll by +21%. Now the price is rate-limited against the last
///        recorded price: at most 5% x dt / 5 min per recording (1%/min, never more than 5% at once).
///        Guarantees proven below: no side of a 5x pair opened at ANY non-lagging price goes below zero
///        within 12 minutes; a side that is not liquidatable survives the next recording; a compromised
///        relayer moves a maker's claim by at most ~5.5% of its margin per minute.
/// R2-02  Keeper top-ups now draw on the epoch's 10% cover cap.
/// R2-03  The cap is fixed at the epoch's first draw (not by whoever settles), so two epochs take <= 19%.
/// R2-04  close() refuses a lagging price on both routes; keepers still liquidate.
/// R2-05  Deposits to the vault, tokens and the oracle are refused.
/// R2-07  (documented) a close that settles as a liquidation pays the penalty, not the close spread.
contract Round2PoC is VelumBase {
    uint256 internal constant W = 5 minutes; // OracleAdapter.MOVE_WINDOW
    uint256 internal constant MAX_RAW = 100_000e18; // oracle bound in VelumBase
    uint256 internal constant MIN_RAW = 1e18;

    address internal mallory = makeAddr("mallory"); // attacker: maker address
    address internal mallory2 = makeAddr("mallory2"); // attacker: taker address

    // ------------------------------------------------------------ helpers

    function _offerAs(address maker, uint256 backing, uint16 openBps, uint16 closeBps) internal returns (uint256 id) {
        _fund(maker, usdg, backing);
        vm.prank(maker);
        id = book.postOffer(address(tsla), backing, backing, openBps, closeBps, uint64(block.timestamp + 365 days));
    }

    function _seedInsurance(uint256 amount) internal {
        _fund(carol, usdg, amount);
        vm.prank(carol);
        perps.fundInsurance(amount);
    }

    function _total(address a, address b) internal view returns (uint256) {
        return _bal(a, usdg) + _bal(b, usdg);
    }

    function _backing(uint256 offer) internal view returns (uint256 b) {
        (,, b,,,,,) = book.offers(offer);
    }

    function _band() internal view returns (uint256 last, uint256 lastAt) {
        (uint128 l, uint64 at,) = oracle.bands(address(tsla));
        return (l, at);
    }

    /// @dev What a recording now may report, exactly as OracleAdapter._limit computes it.
    function _range() internal view returns (uint256 lo, uint256 hi) {
        (uint256 last, uint256 at) = _band();
        uint256 dt = block.timestamp - at;
        if (dt > W) dt = W;
        uint256 m = (last * 500 * dt) / (10_000 * W);
        return (last - m, last + m);
    }

    /// @dev Relayer push in the current second (no warp).
    function _pushNow(address token, uint256 p) internal {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = token;
        v[0] = p;
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    function _makerClaim(uint256 id, uint256 price) internal view returns (int256) {
        PerpsBase.Position memory p = perps.getPosition(id);
        return int256(p.takerMargin + p.makerMargin) - perps.takerClaimAt(id, price);
    }

    /// @dev Both claims at the effective price (funding accrued by the caller) are at least zero.
    function _assertBothSolvent(uint256 id) internal view {
        uint256 p = _effectivePrice(address(tsla));
        assertGe(perps.takerClaimAt(id, p), 0, "taker below zero");
        assertGe(_makerClaim(id, p), 0, "maker below zero");
    }

    function _penalty(uint256 qty, uint256 price) internal pure returns (uint256) {
        uint256 notional = (qty * price + 1e30 - 1) / 1e30;
        return (notional * 100 + 9999) / 10_000;
    }

    // ------------------------------------------------------------ R2-01: the guarantee

    /// @notice The guarantee R2-01 asked for, at ARBITRARY open prices: after any price history, a pair
    ///         opened at any price the next recording may report (so not lagging), with any leverage, side,
    ///         size and open spread the book allows (2-500 bps), has both claims >= 0 at every recorded price
    ///         for 12 minutes, whatever the source reports (extremes, arbitrary prices, any spacing).
    function testFuzz_R2_01_fixed_noSideInsolventWithin12MinOfAnyNonLaggingOpen(
        uint256[4] memory pre,
        uint256 openRaw,
        uint256 size,
        uint8 levHalf,
        bool isLong,
        uint16 openBps,
        uint256[10] memory path
    ) public {
        uint256 offer = _offerAs(bob, 100_000 * USD, uint16(bound(openBps, 2, 500)), 5);
        // 1. Any history: the open price is not tied to any reference.
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + bound(pre[i] >> 128, 0, 2 * W));
            _pushPrice(address(tsla), bound(uint128(pre[i]), MIN_RAW, MAX_RAW));
        }
        // 2. The source reports any price the limit allows now, so the open is not lagging.
        vm.warp(block.timestamp + 1);
        (uint256 lo, uint256 hi) = _range();
        openRaw = bound(openRaw, lo, hi);
        _pushNow(address(tsla), openRaw);
        assertFalse(oracle.lagging(address(tsla)));
        uint256 maxSize = (openRaw * 94) / 1e12; // 94 tokens at the source price: <= 99 after a 5% spread
        size = bound(size, 10 * USD, maxSize < 30_000 * USD ? maxSize : 30_000 * USD);
        levHalf = uint8(bound(levHalf, 2, 10));
        _fund(alice, usdg, size + size / 100);
        uint256 id = _open(alice, offer, isLong, size, levHalf);

        // 3. Any source path for 12 minutes.
        uint256 end = block.timestamp + 12 minutes;
        for (uint256 i; i < 10 && block.timestamp < end; ++i) {
            uint256 wait = bound(path[i] >> 128, 1, 2 * W);
            if (block.timestamp + wait > end) wait = end - block.timestamp;
            vm.warp(block.timestamp + wait);
            uint256 k = uint128(path[i]) % 3;
            uint256 raw = k == 0 ? MIN_RAW : (k == 1 ? MAX_RAW : bound(uint128(path[i]), MIN_RAW, MAX_RAW));
            _pushNow(address(tsla), raw);
            perps.advanceFunding(address(tsla));
            _assertBothSolvent(id);
        }
    }

    /// @dev Open a 5x 30,000 USDG pair at the current price with `openBps`, run the extreme path, check.
    function _extremePath(bool isLong, uint16 openBps, bool up) internal {
        uint256 offer = _offerAs(bob, 100_000 * USD, openBps, 5);
        _fund(alice, usdg, 31_000 * USD);
        uint256 id = _open(alice, offer, isLong, 30_000 * USD, 10);
        uint256 t0 = block.timestamp;
        if (up) {
            // Fastest rise: a recording every second compounds to (1 + 1/6000)^720 ~ e^0.12.
            for (uint256 i; i < 720; ++i) {
                _pushPrice(address(tsla), MAX_RAW);
            }
            assertApproxEqRel(_effectivePrice(address(tsla)), (TSLA_PRICE * 11_275) / 10_000, 0.0005e18);
        } else {
            // Fastest fall: as few recordings as possible, each worth at most 5 minutes (0.95 x 0.95 x 0.98).
            vm.warp(t0 + W);
            _pushNow(address(tsla), MIN_RAW);
            vm.warp(t0 + 2 * W);
            _pushNow(address(tsla), MIN_RAW);
            vm.warp(t0 + 12 minutes);
            _pushNow(address(tsla), MIN_RAW);
        }
        assertEq(block.timestamp - t0, 12 minutes);
        perps.advanceFunding(address(tsla));
        _assertBothSolvent(id);
    }

    /// @notice The extreme paths behind the 12-minute guarantee, for both sides at the smallest and largest
    ///         open spread: 5x pairs stay solvent.
    function test_R2_01_fixed_extremePathsKeepFiveXSolventFor12Min() public {
        for (uint256 k; k < 8; ++k) {
            uint256 snap = vm.snapshotState();
            _extremePath(k & 1 == 0, k & 2 == 0 ? 2 : 500, k & 4 == 0);
            vm.revertToState(snap);
        }
    }

    /// @notice The bound is tight: the worst allowed case (5x short at a 5% open spread) goes below zero after
    ///         ~13 minutes of the fastest rise; at the 2 bps floor it takes ~18 minutes.
    function test_R2_01_fixed_worstCaseInsolvencyTime() public {
        uint16[2] memory spreads = [uint16(500), uint16(2)];
        uint256[2] memory minTime = [uint256(12 minutes), uint256(18 minutes)];
        uint256[2] memory maxTime = [uint256(14 minutes), uint256(19 minutes)];
        for (uint256 k; k < 2; ++k) {
            uint256 snap = vm.snapshotState();
            uint256 offer = _offerAs(bob, 100_000 * USD, spreads[k], 5);
            _fund(alice, usdg, 31_000 * USD);
            uint256 id = _open(alice, offer, false, 30_000 * USD, 10);
            uint256 t0 = block.timestamp;
            while (true) {
                _pushPrice(address(tsla), MAX_RAW);
                if (perps.takerClaimAt(id, _effectivePrice(address(tsla))) < 0) break;
            }
            emit log_named_uint("seconds from open to insolvency at the fastest rise", block.timestamp - t0);
            assertGe(block.timestamp - t0, minTime[k]);
            assertLe(block.timestamp - t0, maxTime[k]);
            vm.revertToState(snap);
        }
    }

    /// @notice FA-01 (final audit) worst case for the same bound. An open whose read sees the same source value at an
    ///         unchanged price no longer restarts the rate-limit clock, so the clock may have started up to OPEN_MAX_AGE
    ///         (10 s) before the open: the relay pushes at t, the open comes at t + 10 (the oldest price an open
    ///         accepts), then the fastest rise. Insolvency comes 10 s sooner than when the open restarted the clock
    ///         (787 s and 1,093 s before the fix), still well over 12 and 18 minutes.
    function test_R2_01_fixed_worstCaseInsolvencyTimeOpenTenSecondsAfterThePush() public {
        uint16[2] memory spreads = [uint16(500), uint16(2)];
        uint256[2] memory expected = [uint256(777), uint256(1083)];
        for (uint256 k; k < 2; ++k) {
            uint256 snap = vm.snapshotState();
            uint256 offer = _offerAs(bob, 100_000 * USD, spreads[k], 5);
            _fund(alice, usdg, 31_000 * USD);
            _pushPrice(address(tsla), TSLA_PRICE); // the clock starts here
            uint256 pushedAt = block.timestamp;
            vm.warp(pushedAt + perps.OPEN_MAX_AGE());
            uint256 id = _open(alice, offer, false, 30_000 * USD, 10);
            (, uint256 clockAt) = _band();
            assertEq(clockAt, pushedAt, "the open did not restart the clock");
            uint256 t0 = block.timestamp;
            while (perps.takerClaimAt(id, _effectivePrice(address(tsla))) >= 0) {
                _pushPrice(address(tsla), MAX_RAW);
            }
            emit log_named_uint("seconds from open to insolvency, open 10 s after the push", block.timestamp - t0);
            assertEq(block.timestamp - t0, expected[k], "10 s sooner than with the clock restarted at the open");
            assertGe(block.timestamp - t0, k == 0 ? 12 minutes : 18 minutes);
            vm.revertToState(snap);
        }
    }

    /// @notice FA-01 worst case for the compromised-relay-key bound (test_R2_01_fixed_relayerExtractionPerMinuteBounded:
    ///         526 s before the fix): with the open 10 s after the relay's last push, an honest 5x maker still cannot be
    ///         made liquidatable within 8.5 minutes.
    function test_R2_01_fixed_relayerLiquidatableTimeOpenTenSecondsAfterThePush() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(mallory2, usdg, 2100 * USD);
        _pushPrice(address(tsla), TSLA_PRICE);
        vm.warp(block.timestamp + perps.OPEN_MAX_AGE());
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 10_000 * USD, 10, type(uint256).max);
        uint256 t0 = block.timestamp;
        while (!perps.isLiquidatable(id)) {
            _pushPrice(address(tsla), MAX_RAW);
        }
        emit log_named_uint(
            "seconds until the honest maker is liquidatable, open 10 s after the push", block.timestamp - t0
        );
        assertEq(block.timestamp - t0, 516, "10 s sooner than with the clock restarted at the open (526 s)");
        assertGe(block.timestamp - t0, 8.5 minutes);
    }

    /// @notice Keeper window: a side that is not liquidatable at a recorded price is still solvent at the
    ///         next recording, whatever the source reports and however long it was silent (one recording
    ///         moves at most 5%; the maintenance cushion is 10%).
    function testFuzz_R2_01_fixed_notLiquidatableSurvivesAnyNextRecording(
        uint256 size,
        uint8 levHalf,
        bool isLong,
        uint16 openBps,
        uint256[3] memory walk,
        uint256 wait,
        uint256 raw
    ) public {
        uint256 offer = _offerAs(bob, 100_000 * USD, uint16(bound(openBps, 2, 500)), 5);
        size = bound(size, 10 * USD, 30_000 * USD);
        levHalf = uint8(bound(levHalf, 2, 10));
        _fund(alice, usdg, size + size / 100);
        uint256 id = _open(alice, offer, isLong, size, levHalf);
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + bound(walk[i] >> 128, 0, 2 * W));
            _pushPrice(address(tsla), bound(uint128(walk[i]), MIN_RAW, MAX_RAW));
            if (perps.isLiquidatable(id)) return; // a keeper would act here
        }
        perps.advanceFunding(address(tsla));
        vm.warp(block.timestamp + bound(wait, 1, 1 days));
        _pushNow(address(tsla), bound(raw, MIN_RAW, MAX_RAW));
        perps.advanceFunding(address(tsla));
        _assertBothSolvent(id);
    }

    /// @notice A compromised relay key pushing at the maximum rate moves an honest 5x maker's claim by at most
    ///         5.5% of its margin in the first minute, cannot make it liquidatable for 8.5 minutes, and by then
    ///         an accomplice has taken under half its margin (5.5% per minute plus the 0.5% keeper reward).
    function test_R2_01_fixed_relayerExtractionPerMinuteBounded() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(mallory2, usdg, 2100 * USD);
        uint256 start = _bal(mallory2, usdg);
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 10_000 * USD, 10, type(uint256).max);
        uint256 makerMargin = perps.getPosition(id).makerMargin;
        uint256 t0 = block.timestamp;
        for (uint256 i; i < 60; ++i) {
            _pushPrice(address(tsla), MAX_RAW);
        }
        perps.advanceFunding(address(tsla));
        int256 lost = int256(makerMargin) - _makerClaim(id, _effectivePrice(address(tsla)));
        emit log_named_decimal_int("maker claim lost in the first minute (margin 2,000)", lost, 6);
        assertLe(lost, int256((makerMargin * 55) / 1000), "<= 5.5% of the maker margin per minute");

        while (!perps.isLiquidatable(id)) {
            _pushPrice(address(tsla), MAX_RAW);
        }
        uint256 elapsed = block.timestamp - t0;
        emit log_named_uint("seconds until the honest maker is liquidatable", elapsed);
        assertGe(elapsed, 8.5 minutes);
        vm.prank(mallory2);
        perps.liquidate(id);
        uint256 gain = _bal(mallory2, usdg) - start;
        emit log_named_decimal_uint("accomplice gain (maker margin 2,000)", gain, 6);
        assertLe(gain, (makerMargin * (55 * elapsed / 60 + 30)) / 1000, "5.5%/min plus the keeper half");
        assertLt(gain, makerMargin / 2);
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), mallory2), 0, "maker still solvent");
    }

    // ------------------------------------------------------------ R2-01 (a): F-04 bypass, inverted

    /// @notice The round-2 attack: within one old band window the relayer alternated the band bottom and top,
    ///         an accomplice opened a 5x long at the bottom and took the honest maker's whole backing through
    ///         close() in 10 seconds. Now each push moves the price by at most 1/6000 per second: opens and
    ///         closes at the jumped prices are refused as lagging, the maker never becomes liquidatable, and
    ///         the accomplice only pays spreads and fees.
    function test_R2_01a_fixed_relayerOscillationCannotDrainHonestMaker() public {
        _seedInsurance(1000 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5); // honest maker
        _fund(mallory2, usdg, 2100 * USD);
        uint256 makerStart = _bal(bob, usdg) + _backing(offer);
        uint256 before = _bal(mallory2, usdg);
        uint256 insBefore = perps.insurance();
        uint256 lo = (TSLA_PRICE * 9000) / 10_000; // the old band bottom
        uint256 hi = (TSLA_PRICE * 11_000) / 10_000; // the old band top
        uint256 t0 = block.timestamp;

        for (uint256 i; i < 5; ++i) {
            _pushPrice(address(tsla), lo);
            assertTrue(oracle.lagging(address(tsla)), "a -10% push is clamped");
            assertGe(_effectivePrice(address(tsla)), (TSLA_PRICE * 9990) / 10_000);
            vm.prank(mallory2);
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
            perps.open(offer, address(tsla), true, 10_000 * USD, 10, type(uint256).max);
            // to open at all, the relayer must report the effective price itself
            (uint256 last,) = _band();
            _pushPrice(address(tsla), last);
            vm.prank(mallory2);
            uint256 id = perps.open(offer, address(tsla), true, 10_000 * USD, 10, type(uint256).max);

            _pushPrice(address(tsla), hi); // +22% vs the old bottom
            assertTrue(oracle.lagging(address(tsla)));
            perps.advanceFunding(address(tsla));
            assertGt(_makerClaim(id, _effectivePrice(address(tsla))), int256(1900 * USD), "maker barely moved");
            assertFalse(perps.isLiquidatable(id));
            vm.prank(mallory2);
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
            perps.close(id, 1);
            vm.prank(mallory2);
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
            perps.liquidate(id);
            (last,) = _band();
            _pushPrice(address(tsla), last);
            vm.prank(mallory2);
            perps.close(id, 1);
        }

        assertLt(block.timestamp - t0, 30);
        int256 pnl = int256(_bal(mallory2, usdg)) - int256(before);
        emit log_named_decimal_int("accomplice P&L after 5 rounds (was +9,900 in 10 s)", pnl, 6);
        assertLt(pnl, 0, "the accomplice pays spreads and fees");
        assertGe(_bal(bob, usdg) + _backing(offer), makerStart, "the honest maker loses nothing");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), mallory2), 0, "no cover claims");
        assertGt(perps.insurance(), insBefore, "insurance only gains fees: no top-ups");
        _assertPerpsSolvent();
    }

    /// @notice Inverts the round-2 counterexample: a position opened at a non-lagging price far from any
    ///         earlier price, followed by a push to the opposite extreme after any wait up to 5 minutes, keeps
    ///         both sides solvent (and the maker above maintenance) whatever the leverage, size or spread.
    function testFuzz_R2_01_fixed_openAnywhereThenOppositeExtremeStaysSolvent(
        uint256 size,
        uint8 levHalf,
        uint16 openBps,
        uint256 walk,
        uint256 wait
    ) public {
        uint256 offer = _offerAs(bob, 100_000 * USD, uint16(bound(openBps, 2, 500)), 5);
        // walk down to an arbitrary non-lagging price up to ~23% below the start
        uint256 target = bound(walk, (TSLA_PRICE * 77) / 100, TSLA_PRICE);
        _movePriceTo(address(tsla), target);
        size = bound(size, 10 * USD, 25_000 * USD);
        levHalf = uint8(bound(levHalf, 2, 10));
        _fund(alice, usdg, size + size / 100);
        uint256 id = _open(alice, offer, true, size, levHalf);
        vm.warp(block.timestamp + bound(wait, 1, W));
        _pushNow(address(tsla), MAX_RAW);
        perps.advanceFunding(address(tsla));
        _assertBothSolvent(id);
        PerpsBase.Position memory p = perps.getPosition(id);
        uint256 eff = _effectivePrice(address(tsla));
        assertGe(_makerClaim(id, eff), int256((p.qty * eff) / 1e30 / 10), "maker still above maintenance");
    }

    // ------------------------------------------------------------ R2-01 (b): F-02 straddle, inverted

    /// @notice The round-2 attack: in a quiet market the attacker pokes to fix the band window, a +30% gap
    ///         arrives one second before the roll, and one second later close() liquidates the insolvent
    ///         self-pair for cover. Now poke only records, one recording moves at most 5%, close() refuses
    ///         the lagging price, and from the first second the pair is liquidatable keepers have more than
    ///         9 minutes before it could go insolvent. Liquidated at the first chance, the straddle loses.
    function test_R2_01b_fixed_gapNearOldWindowRollStraddleUnprofitable() public {
        _seedInsurance(20_000 * USD);
        uint256 offer = _offerAs(mallory, 20_000 * USD, 2, 0);
        _fund(mallory2, usdg, 5000 * USD);
        uint256 start = _total(mallory, mallory2) + book.totalBacking();
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 20_000 * USD, 10, type(uint256).max);
        uint256 gap = (TSLA_PRICE * 13) / 10;

        (, uint256 at) = _band();
        vm.warp(at + 1000);
        assertTrue(oracle.poke(address(tsla)));
        assertEq(_effectivePrice(address(tsla)), TSLA_PRICE, "poke records, nothing else");
        vm.warp(block.timestamp + W - 1);
        _pushNow(address(tsla), gap);
        assertLe(_effectivePrice(address(tsla)), (TSLA_PRICE * 10_500) / 10_000, "at most 5% per recording");
        assertFalse(perps.isLiquidatable(id));
        vm.warp(block.timestamp + 1);
        vm.prank(mallory2);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.close(id, 1);
        vm.prank(mallory2);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
        perps.liquidate(id);

        // The honest source keeps reporting the gap every second; the price walks at 1% per minute.
        while (!perps.isLiquidatable(id)) {
            _pushPrice(address(tsla), gap);
        }
        uint256 t1 = block.timestamp;
        perps.advanceFunding(address(tsla));
        assertGt(_makerClaim(id, _effectivePrice(address(tsla))), 0, "solvent when first liquidatable");

        // Counterfactual: keepers stay away. Insolvency comes no sooner than 9 minutes later.
        uint256 snap = vm.snapshotState();
        while (_makerClaim(id, _effectivePrice(address(tsla))) >= 0) {
            _pushPrice(address(tsla), gap);
            perps.advanceFunding(address(tsla));
        }
        emit log_named_uint("seconds a keeper had (liquidatable, solvent)", block.timestamp - t1);
        assertGe(block.timestamp - t1, 9 minutes);
        vm.revertToState(snap);

        // Best case for the attacker: it liquidates itself at the first chance. It still loses.
        uint256 epoch = perps.currentCoverEpoch();
        vm.prank(mallory2);
        perps.liquidate(id);
        assertEq(perps.coverClaims(epoch, mallory2), 0, "solvent: no cover claim");
        vm.prank(mallory);
        book.withdrawOffer(offer);
        int256 pnl = int256(_total(mallory, mallory2)) - int256(start);
        emit log_named_decimal_int("straddle P&L (was +150 or more)", pnl, 6);
        assertLt(pnl, -int256(12 * USD), "loses more than the open fee");
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ R2-02: keeper top-ups inside the cap

    /// @notice The round-2 attack: 30 small insolvent self-pairs each paid the 1 USDG keeper top-up at once,
    ///         outside the 10% cover cap (30% of the fund immediately, 35%+ in total). Now top-ups and cover
    ///         draw on the same per-epoch cap: the whole event takes at most a tenth of the fund.
    function test_R2_02_fixed_keeperTopUpsCountAgainstEpochCap() public {
        _seedInsurance(100 * USD);
        uint256 offer = _offerAs(mallory, 2000 * USD, 2, 0);
        _fund(mallory2, usdg, 1300 * USD);
        uint256 start = _total(mallory, mallory2) + book.totalBacking();
        uint256 n = 30;
        uint256[] memory ids = new uint256[](n);
        vm.startPrank(mallory2);
        for (uint256 i; i < n; ++i) {
            ids[i] = perps.open(offer, address(tsla), true, 200 * USD, 10, type(uint256).max); // fee 0.12 each
        }
        vm.stopPrank();

        // Keepers stay away while the price walks +30% (the F-02 worst case): every pair ends insolvent.
        _movePriceTo(address(tsla), (TSLA_PRICE * 13) / 10);
        uint256 insBefore = perps.insurance();
        uint256 epoch = perps.currentCoverEpoch();
        vm.startPrank(mallory2);
        for (uint256 i; i < n; ++i) {
            perps.close(ids[i], 1); // each insolvent: liquidation, attacker is the keeper
        }
        vm.stopPrank();
        (,, uint256 budget,, uint256 cap, uint256 drawn,,) = perps.coverEpochs(epoch);
        uint256 topUps = drawn - budget;
        emit log_named_decimal_uint("insurance before the event", insBefore, 6);
        emit log_named_decimal_uint("keeper top-ups paid at once (was 30)", topUps, 6);
        assertEq(cap, insBefore / 10, "cap fixed at the epoch's first draw");
        assertLe(drawn, cap);
        assertEq(insBefore - perps.insurance(), drawn, "everything the event took went through the cap");
        assertEq(perps.coverReserved(), budget);

        vm.warp((epoch + 1) * 1 hours);
        assertEq(perps.settleCoverEpoch(epoch), budget);
        uint256 cover = perps.claimCover(epoch, mallory2);
        vm.prank(mallory);
        book.withdrawOffer(offer);
        emit log_named_decimal_uint("total taken by one event (was 35%+ of the fund)", topUps + cover, 6);
        assertLe(topUps + cover, insBefore / 10, "a tenth of the fund at most");
        int256 pnl = int256(_total(mallory, mallory2)) - int256(start);
        emit log_named_decimal_int("attacker P&L (was +30 or more)", pnl, 6);
        assertLt(pnl, int256(insBefore / 10), "bounded by the cap minus fees");
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ R2-03: deterministic, straddle-bounded cap

    /// @dev 5x long against bob, walked to -30% with keepers away: insolvent.
    function _twoInsolventLongs() internal returns (uint256 a, uint256 b) {
        uint256 offer = _offerAs(bob, 20_000 * USD, 5, 5);
        _fund(alice, usdg, 3000 * USD);
        a = _open(alice, offer, true, 10_000 * USD, 10);
        b = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), (TSLA_PRICE * 70) / 100);
    }

    /// @notice The epoch cap is fixed when the epoch first draws on the fund, so the budget no longer depends
    ///         on who settles first or when (here a 100,000 USDG donation before settling changes nothing), and
    ///         an event that spans two epochs takes at most 10% + 10% of the remaining 90% = 19% of the fund.
    function test_R2_03_fixed_capFixedAtFirstDrawAndTwoEpochsAtMost19Percent() public {
        _seedInsurance(1000 * USD);
        (uint256 a, uint256 b) = _twoInsolventLongs();
        uint256 fund = perps.insurance();
        uint256 e1 = perps.currentCoverEpoch();
        vm.prank(liquidator);
        perps.liquidate(a);
        (,, uint256 budget1,, uint256 cap1, uint256 drawn1,,) = perps.coverEpochs(e1);
        assertEq(cap1, fund / 10);
        assertEq(drawn1, cap1, "large claim: the whole cap is drawn");

        // The same event continues into the next epoch.
        vm.warp((e1 + 1) * 1 hours);
        _pushPrice(address(tsla), (TSLA_PRICE * 70) / 100);
        uint256 fund2 = perps.insurance();
        assertEq(fund2, fund - drawn1, "the first epoch's draw left the fund at once");
        vm.prank(liquidator);
        perps.liquidate(b);
        (,,,, uint256 cap2, uint256 drawn2,,) = perps.coverEpochs(e1 + 1);
        assertEq(cap2, fund2 / 10);
        assertLe(drawn2, cap2);
        emit log_named_decimal_uint("fund before the event", fund, 6);
        emit log_named_decimal_uint("taken over two epochs", drawn1 + drawn2, 6);
        assertLe(drawn1 + drawn2, fund / 10 + (fund - fund / 10) / 10, "<= 19% of the fund");

        // Settling late, after the fund grew, does not change the budget.
        _seedInsurance(100_000 * USD);
        vm.warp((e1 + 3) * 1 hours);
        assertEq(perps.settleCoverEpoch(e1), budget1);
        uint256 bobBefore = _bal(bob, usdg);
        perps.claimCover(e1, bob);
        assertEq(_bal(bob, usdg) - bobBefore, budget1, "sole claimant gets the whole budget");
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ R2-04: no close at a lagging price

    /// @notice The round-2 issue: close() routed a liquidatable position to liquidation before the lagging
    ///         check, so the losing taker itself exited at the stale, favourable price. Now close() refuses a
    ///         lagging price on both routes; third-party keepers still liquidate at the effective price, and
    ///         what the loser keeps relative to the source price stays under the documented 9% of notional.
    function test_R2_04_fixed_closeRefusedAtLaggingPriceKeepersStillLiquidate() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 2100 * USD);
        uint256 id = _open(alice, offer, false, 10_000 * USD, 10); // 5x short
        vm.warp(block.timestamp + 1 hours);
        uint256 raw = (TSLA_PRICE * 13) / 10;
        _pushPrice(address(tsla), raw); // +5%: the first recording after a silence
        _nextWindowPush(address(tsla), raw); // +10.25%
        assertTrue(oracle.lagging(address(tsla)));
        assertTrue(perps.isLiquidatable(id), "liquidatable at the effective price");
        perps.advanceFunding(address(tsla));
        uint256 eff = _effectivePrice(address(tsla));
        int256 claimAtEff = perps.takerClaimAt(id, eff);
        assertGt(claimAtEff, 0);
        assertLt(perps.takerClaimAt(id, raw), 0, "insolvent at the source price");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.close(id, type(uint256).max);

        uint256 qty = perps.getPosition(id).qty;
        uint256 before = _bal(alice, usdg);
        vm.prank(liquidator);
        uint256 reward = perps.liquidate(id);
        uint256 kept = _bal(alice, usdg) - before;
        uint256 penalty = _penalty(qty, eff);
        assertEq(kept, uint256(claimAtEff) - penalty, "loser settled at the effective price");
        assertEq(reward, penalty / 2, "the keeper, not the loser, gets the reward");
        assertLt(kept, (qty * eff) / 1e30 * 9 / 100, "documented bound: under 9% of notional");
        _assertPerpsSolvent();
    }

    /// @notice With close() refused at a lagging price, a winning taker facing an insolvent maker keeps its
    ///         cover claim (F-12) by calling liquidate() itself.
    function test_R2_04_fixed_winnerAtLaggingPriceKeepsCoverThroughLiquidate() public {
        _seedInsurance(2000 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(alice, usdg, 1001 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 2); // 1x: maker posts 200
        _movePriceTo(address(tsla), 520e18); // keepers away: maker insolvent
        _pushPrice(address(tsla), 700e18); // source jumps on: lagging
        assertTrue(oracle.lagging(address(tsla)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.close(id, 1);
        perps.advanceFunding(address(tsla));
        int256 claim = perps.takerClaimAt(id, _effectivePrice(address(tsla)));
        uint256 epoch = perps.currentCoverEpoch();
        vm.prank(alice);
        perps.liquidate(id);
        assertEq(perps.coverClaims(epoch, alice), uint256(claim) - 1200 * USD, "shortfall claimed, not forfeited");
    }

    // ------------------------------------------------------------ R2-05: deposits nobody can withdraw

    /// @notice The round-2 issue: deposits credited to the vault itself or the oracle were accepted and
    ///         stranded. Now the vault, every listed token and the protocol addresses fixed at setup (the
    ///         oracle) are refused, and a withdrawal to the vault itself is refused too.
    function test_R2_05_fixed_depositToProtocolContractsRefused() public {
        usdg.mint(carol, 500 * USD);
        vm.startPrank(carol);
        usdg.approve(address(vault), 500 * USD);
        address[4] memory denied = [address(vault), address(oracle), address(usdg), address(tsla)];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(abi.encodeWithSelector(VelumVault.ProtocolRecipient.selector, denied[i]));
            vault.deposit(address(usdg), 100 * USD, denied[i]);
        }
        vault.deposit(address(usdg), 100 * USD, carol);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.ProtocolRecipient.selector, address(vault)));
        vault.withdraw(address(usdg), 100 * USD, address(vault));
        vm.stopPrank();
        assertTrue(vault.isBlockedRecipient(address(oracle)));
        assertEq(_bal(address(vault), usdg) + _bal(address(oracle), usdg), 0);
        assertEq(_bal(carol, usdg), 100 * USD);
    }

    // ------------------------------------------------------------ R2-07 (Info): documented close behaviour

    /// @notice A close that settles as a liquidation pays at the oracle price with no close spread or fee; a
    ///         losing taker pays the 1% penalty and gets the keeper half back. priceLimit is checked against
    ///         the spread-adjusted exit only (README, perps model).
    function test_R2_07_closeAsLiquidationPaysPenaltyNotSpread() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 500); // 5% close spread
        _fund(alice, usdg, 1000 * USD);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 345e18);
        perps.advanceFunding(address(tsla));
        assertTrue(perps.isLiquidatable(id));
        int256 claim = perps.takerClaimAt(id, 345e18);
        uint256 penalty = _penalty(perps.getPosition(id).qty, 345e18);
        uint256 exit = (345e18 * 9500) / 10_000;
        uint256 before = _bal(alice, usdg);
        uint256 insBefore = perps.insurance();
        vm.prank(alice);
        perps.close(id, exit); // the limit is the spread-adjusted exit: accepted
        assertEq(_bal(alice, usdg) - before, uint256(claim) - penalty + penalty / 2, "penalty, half refunded");
        assertEq(perps.insurance() - insBefore, penalty - penalty / 2, "no close fee");
    }
}
