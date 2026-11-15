// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumBase} from "../Base.t.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Final internal audit (2026-11-15) proofs of concept, inverted into regressions (`*_fixed`). Each test keeps
///         the auditor's scenario and asserts the fixed behaviour; the numbers before the fix are in the comments.
///
/// FA-01  A recording that sees the same source value at an unchanged price no longer restarts the rate-limit clock
///        (and a catch-up recording only uses up the time its move needed), so third-party pokes and reads cannot
///        keep prices lagging. The limit per recording is unchanged.
/// FA-02  Funding runs on the oracle's live clock: a gap of more than DEAD_AFTER between valid prices is never
///        charged, and a shorter one costs at most 3.36% of the price, under the 10% - 5% cushion.
/// FA-03  The same rule covers a token that stays dead after a dead-oracle exit and revives later.
/// FA-04  Forced-exit settlement needs a price at most OPEN_MAX_AGE (10 s) old.
/// FA-05  Spot pools refuse zero minimums.
/// FA-06  Withdrawals refuse the same recipients as deposits.
/// FA-07  Feeds are read with a length-checked staticcall; setup refuses unreadable feeds.
contract FinalAuditPoC is VelumBase {
    /// @dev Relay push at the current timestamp (no warp).
    function _pushNow(uint256 p) internal {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = p;
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    function _band() internal view returns (uint256 last, uint256 lastAt) {
        (uint128 l, uint64 at,) = oracle.bands(address(tsla));
        return (l, at);
    }

    // ------------------------------------------------------------------ FA-01

    /// @notice FA-01 (Medium). PoC: the relay pushes every 8 s and moves the price 0.10% (inside 8 s x 1/6000 =
    ///         0.133%). A `poke` by a third party one second before the push restarted the clock, so the push was
    ///         lagging and open/close reverted; with a poke every second it stayed lagging 4 more seconds. Now the poke
    ///         sees the same source value at an unchanged price and writes nothing: the push is in the limit, open
    ///         and close work, and nothing lags.
    function test_FA01_pokeOneSecondBeforePushNoLongerMakesInLimitMoveLagging_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 5000 * USD);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 10);
        uint256 t0 = block.timestamp;
        uint256 p1 = (TSLA_PRICE * 10_010) / 10_000; // +0.10%

        // (a) nobody records between the pushes
        uint256 snap = vm.snapshotState();
        vm.warp(t0 + 8);
        _pushNow(p1);
        assertFalse(oracle.lagging(address(tsla)), "in-limit push: not lagging");
        vm.prank(alice);
        perps.open(offerId, address(tsla), true, 500 * USD, 10, type(uint256).max);
        vm.prank(alice);
        perps.close(id, 1);
        vm.revertToState(snap);

        // (b) a third party pokes one second before the push: it writes nothing
        vm.warp(t0 + 7);
        (uint256 last, uint256 lastAt) = _band();
        vm.prank(makeAddr("griefer"));
        assertTrue(oracle.poke(address(tsla)));
        (uint256 last2, uint256 lastAt2) = _band();
        assertEq(last2, last, "price unchanged");
        assertEq(lastAt2, lastAt, "clock not restarted by a poke that changes nothing");
        vm.warp(t0 + 8);
        _pushNow(p1);
        assertFalse(oracle.lagging(address(tsla)), "same push: still not lagging (was lagging)");
        vm.prank(alice);
        perps.open(offerId, address(tsla), true, 500 * USD, 10, type(uint256).max);
        vm.prank(alice);
        perps.close(id, 1);
        // and a poke every second afterwards keeps it that way (was: lagging 4 more seconds)
        uint256 lagged;
        for (uint256 s = 1; s <= 8; ++s) {
            vm.warp(t0 + 8 + s);
            oracle.poke(address(tsla));
            if (oracle.lagging(address(tsla))) lagged++;
        }
        assertEq(lagged, 0, "nothing lags");
    }

    /// @notice FA-01, sustained (the auditor's simulation, unchanged): 30 minutes of a TSLA-like random walk
    ///         (|move| uniform in 0..0.12% per 6-s push), counting the seconds at which an open or close would see a
    ///         lagging price. Before the fix: 64 s with recordings only at pushes, 905 s (50%) with a poke every
    ///         second. A poke one second before each push is the best timing against a clock that restarts on every
    ///         price change; it is measured too.
    function test_FA01_sustainedPokingNoLongerMakesPricesLag_fixed() public {
        uint256 quiet = _simulate(0);
        uint256 everySecond = _simulate(1);
        uint256 beforePush = _simulate(2);
        uint256 random = _simulate(3);
        emit log_named_uint("seconds lagging of 1800, recordings only at pushes   (before: 64)", quiet);
        emit log_named_uint("seconds lagging of 1800, poke every second           (before: 905)", everySecond);
        emit log_named_uint("seconds lagging of 1800, poke one second before push", beforePush);
        emit log_named_uint("seconds lagging of 1800, poke at random seconds      ", random);
        assertEq(quiet, 64, "recordings only at pushes: unchanged");
        // What is left: a catch-up recording rounds the time its move used up to the next whole second, so a poke
        // can cost at most one second of allowance per pushed value that lagged, whenever it comes.
        assertLe(everySecond, quiet + quiet / 2, "poking every second: within half the quiet count");
        assertLe(beforePush, quiet + quiet / 2, "poking before each push: within half the quiet count");
        assertLe(random, quiet + quiet / 2, "poking at random: within half the quiet count");
    }

    /// @dev strategy 0: no recordings between pushes; 1: a poke every second; 2: a poke one second before each push
    ///      (the best timing against a clock that restarts at every price change: 489 s lagging); 3: a poke in a
    ///      random half of the seconds.
    function _simulate(uint256 strategy) internal returns (uint256 laggingSeconds) {
        uint256 snap = vm.snapshotState();
        uint256 p = TSLA_PRICE;
        uint256 t0 = block.timestamp;
        for (uint256 s = 1; s <= 1800; ++s) {
            vm.warp(t0 + s);
            if (s % 6 == 0) {
                uint256 r = uint256(keccak256(abi.encode("walk", s)));
                uint256 move = (p * (r % 13)) / 10_000; // 0..12 bp per push
                p = (r >> 128) % 2 == 0 ? p + move : p - move;
                _pushNow(p);
            } else if (
                strategy == 1 || (strategy == 2 && s % 6 == 5)
                    || (strategy == 3 && uint256(keccak256(abi.encode("poke", s))) % 2 == 0)
            ) {
                oracle.poke(address(tsla));
            }
            if (oracle.lagging(address(tsla))) laggingSeconds++;
        }
        vm.revertToState(snap);
    }
}

/// @notice FA-02. Before the fix, a market whose relay was silent for 30 days and then came back (no dead-oracle exit)
///         charged the whole silence's funding in one accrual (7.2% of the price) on top of the first recording's
///         price move (5%): a long that keepers saw above maintenance (99.80 USDG claim) went straight to -6.74 USDG,
///         with no liquidatable-and-solvent window, and the maker's shortfall became a cover claim on insurance.
contract FinalAuditFundingGapPoC is VelumBase {
    function test_FA02_longSilenceFundingNoLongerSkipsKeeperWindow_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 5000 * USD);
        _fund(carol, usdg, 1000 * USD);
        vm.prank(carol);
        perps.fundInsurance(1000 * USD);
        // one-sided book: long takers pay the capped +0.01%/h
        uint256 id = _open(alice, offerId, true, 1000 * USD, 10); // 5x long, 200 USDG margin
        // price walks down 10% while the relay is alive; the long stays above maintenance (~11% of notional)
        _movePriceTo(address(tsla), (TSLA_PRICE * 9000) / 10_000);
        perps.advanceFunding(address(tsla));
        uint256 px = _effectivePrice(address(tsla));
        int256 claim = perps.takerClaimAt(id, px);
        uint256 notional = (perps.getPosition(id).qty * px + 1e30 - 1) / 1e30;
        assertGt(claim * 10_000, int256(notional) * 1000, "above maintenance (10%)");
        assertFalse(perps.isLiquidatable(id));
        (int256 idx0,,) = _index();

        // relay silent for 30 days (dead after 14); nobody requests a forced exit. It comes back 5% lower.
        vm.warp(block.timestamp + 30 days);
        assertTrue(oracle.isDead(address(tsla)));
        _pushPrice(address(tsla), (px * 9500) / 10_000);
        perps.advanceFunding(address(tsla));
        uint256 px2 = _effectivePrice(address(tsla));
        int256 claim2 = perps.takerClaimAt(id, px2);
        (int256 idx1,,) = _index();
        emit log_named_decimal_int("long claim before the gap (USDG)                   ", claim, 6);
        emit log_named_decimal_int("long claim after the first accrual (USDG, was -6.74)", claim2, 6);
        // Only the second since the relay came back is live time; the 30 silent days are dead time.
        assertLe(idx1 - idx0, int256(px2 / 1e10), "no funding for the dead gap");
        assertGt(claim2, 0, "solvent after the first accrual: the keeper window is back");
        assertTrue(perps.isLiquidatable(id), "liquidatable and solvent");
        uint256 epoch = perps.currentCoverEpoch();
        vm.prank(liquidator);
        perps.liquidate(id);
        assertEq(perps.coverClaims(epoch, bob), 0, "no shortfall, no cover claim on insurance");
        _assertPerpsSolvent();
    }

    function _index() internal view returns (int256 index, int256 rate, uint64 at) {
        (,,,, index, rate, at) = perps.markets(address(tsla));
    }

    /// @dev The claim of the taker (`takerSide`) or the maker of `id`, and its maintenance requirement, at the effective
    ///      price.
    function _side(uint256 id, bool takerSide) internal view returns (int256 claim, int256 mm) {
        uint256 px = _effectivePrice(address(tsla));
        PerpsBase.Position memory p = perps.getPosition(id);
        int256 taker = perps.takerClaimAt(id, px);
        claim = takerSide ? taker : int256(p.takerMargin + p.makerMargin) - taker;
        mm = int256((((p.qty * px + 1e30 - 1) / 1e30) * 1000 + 9999) / 10_000);
    }

    /// @notice FA-02, the keeper-window guarantee after any silence. A 5x side that pays the funding and loses on the
    ///         price move is taken to just above maintenance (funding settled) when the relay goes quiet:
    ///           mode 0: a long taker alone (pays the capped rate), the price falls;
    ///           mode 1: a short taker alone (pays the capped rate), the price rises;
    ///           mode 2: a short taker against a larger long book (receives, so its maker pays), the price falls.
    ///         It is still solvent at the first accrual after the relay returns, whatever the silence (1 s to 60 days)
    ///         and the first price (up to 5% either way). A gap over 14 days charges nothing; a shorter one at most
    ///         14 days x 0.01%/h = 3.36% of the price, which with the 5% move (8.53% of notional at most) stays under
    ///         the 10% cushion. Before the fix gaps from about 21 days made it insolvent in that one step.
    function testFuzz_FA02_firstAccrualAfterAnySilenceKeepsTheSideSolvent_fixed(
        uint8 mode,
        uint256 moveBps,
        uint256 silence,
        uint256 backBps,
        bool adverse
    ) public {
        mode = uint8(bound(mode, 0, 2));
        uint256 offerId = _postOffer(40_000 * USD, 40_000 * USD, 2, 0);
        if (mode == 2) {
            _fund(carol, usdg, 21_000 * USD);
            _open(carol, offerId, true, 20_000 * USD, 2); // 1x long book: longs pay, the short below receives
        }
        _fund(alice, usdg, 5000 * USD);
        uint256 id = _open(alice, offerId, mode == 0, 1000 * USD, 10);
        bool takerSide = mode != 2; // the side that pays
        bool falls = mode != 1; // the move that hurts it
        // the price moves until that side is just above maintenance; funding is settled there
        moveBps = bound(moveBps, 800, 1000);
        _movePriceTo(address(tsla), (TSLA_PRICE * (falls ? 10_000 - moveBps : 10_000 + moveBps)) / 10_000);
        perps.advanceFunding(address(tsla));
        (int256 claim, int256 mm) = _side(id, takerSide);
        if (claim < mm) return; // a keeper liquidates here
        uint256 px = _effectivePrice(address(tsla));
        vm.warp(block.timestamp + bound(silence, 1, 60 days) - 1);
        backBps = bound(backBps, 0, 500);
        bool down = adverse == falls;
        _pushPrice(address(tsla), down ? (px * (10_000 - backBps)) / 10_000 : (px * (10_000 + backBps)) / 10_000);
        perps.advanceFunding(address(tsla));
        (claim,) = _side(id, takerSide);
        assertGe(claim, 0, "solvent at the first accrual: liquidatable and solvent, never insolvent in one step");
    }

    /// @notice FA-02 / FA-03: what the live clock charges. With longs only (+0.01%/h): a 10-day silence (under 14 days)
    ///         is charged in full at the next accrual, as before; two separate silences of 15 days around one day of
    ///         relayed prices (nobody accrues in between) charge exactly that one day.
    function test_FA02_liveClockChargesOnlyLiveTime() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 5000 * USD);
        _open(alice, offerId, true, 1000 * USD, 2);
        (int256 i0, int256 rate,) = _index();
        assertEq(rate, 1e14);
        uint256 t0 = block.timestamp;

        // (a) 10 days without prices: charged in full (the 14-day threshold is the oracle's DEAD_AFTER)
        vm.warp(t0 + 10 days - 1);
        _pushPrice(address(tsla), TSLA_PRICE);
        perps.advanceFunding(address(tsla));
        (int256 i1,,) = _index();
        assertEq(i1 - i0, (rate * int256(TSLA_PRICE * 10 days)) / (3600 * 1e18), "10 days charged");
        assertEq(oracle.deadTime(address(tsla)), 0);

        // (b) 15 dead days, one day of hourly pushes nobody accrues, 15 dead days again: one day charged
        uint256 t1 = block.timestamp;
        vm.warp(t1 + 15 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        uint256 revived = block.timestamp;
        for (uint256 h; h < 24; ++h) {
            vm.warp(block.timestamp + 1 hours - 1);
            _pushPrice(address(tsla), TSLA_PRICE);
        }
        uint256 lastAlive = block.timestamp;
        vm.warp(lastAlive + 15 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        assertEq(oracle.deadTime(address(tsla)), (revived - t1) + (block.timestamp - lastAlive), "both gaps booked");
        perps.advanceFunding(address(tsla));
        (int256 i2,,) = _index();
        assertEq(lastAlive - revived, 1 days);
        assertEq(i2 - i1, (rate * int256(TSLA_PRICE * 1 days)) / (3600 * 1e18), "only the live day is charged");
    }
}

/// @notice FA-04 (Info), FA-05 (Info), FA-06 (Info).
contract FinalAuditInfoPoC is VelumBase {
    /// @notice FA-04. Before the fix a matured forced exit (here the maker's request: no spread, no fee) settled at a
    ///         price up to 60 s old at a moment the settler picked. Now settlement needs OPEN_MAX_AGE (10 s), on either
    ///         side's request; a liquidatable position is still liquidated at 60 s through `liquidate`.
    function test_FA04_forcedExitSettlementNeedsOpenFreshness_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 50);
        _fund(alice, usdg, 5000 * USD);
        uint256 makerReq = _open(alice, offerId, true, 1000 * USD, 2);
        uint256 takerReq = _open(alice, offerId, false, 1000 * USD, 2);
        uint256 deep = _open(alice, offerId, true, 1000 * USD, 10);
        vm.deal(bob, 1 ether);
        vm.deal(alice, 1 ether);
        vm.prank(bob);
        perps.requestForcedExit{value: 0.001 ether}(makerReq);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(takerReq);
        vm.prank(bob);
        perps.requestForcedExit{value: 0.001 ether}(deep);
        vm.warp(block.timestamp + 7 days);
        _movePriceTo(address(tsla), (TSLA_PRICE * 8800) / 10_000); // the 5x long is now liquidatable
        uint256 pushedAt = block.timestamp;

        vm.warp(pushedAt + 11); // 11 s old: was accepted (up to 60 s)
        for (uint256 k; k < 3; ++k) {
            uint256 id = k == 0 ? makerReq : (k == 1 ? takerReq : deep);
            vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), pushedAt));
            perps.settleForcedExit(id);
        }
        vm.warp(pushedAt + 30);
        vm.prank(liquidator);
        perps.liquidate(deep); // liquidations keep 60 s
        assertFalse(perps.getPosition(deep).open);

        _pushPrice(address(tsla), (TSLA_PRICE * 8800) / 10_000);
        vm.warp(block.timestamp + perps.OPEN_MAX_AGE()); // 10 s old: fine
        perps.settleForcedExit(makerReq);
        perps.settleForcedExit(takerReq);
        assertFalse(perps.getPosition(makerReq).open);
        assertFalse(perps.getPosition(takerReq).open);
    }

    /// @notice FA-05. `minOut`, `minShares`, `minStock` and `minUsdg` of 0 (no slippage protection) used to be accepted.
    function test_FA05_zeroMinimumsRefused_fixed() public {
        _fund(carol, tsla, 100 * TOKEN);
        _fund(carol, usdg, 100_000 * USD);
        uint256 dl = block.timestamp;
        vm.startPrank(carol);
        vm.expectRevert(SpotPools.NoMinimum.selector);
        pools.addLiquidity(address(tsla), 10 * TOKEN, 3916 * USD, 0, dl);
        (uint256 shares,,) = pools.addLiquidity(address(tsla), 10 * TOKEN, 3916 * USD, 1, dl);
        vm.expectRevert(SpotPools.NoMinimum.selector);
        pools.swap(address(usdg), address(tsla), 100 * USD, 0, dl);
        pools.swap(address(usdg), address(tsla), 100 * USD, 1, dl);
        vm.expectRevert(SpotPools.NoMinimum.selector);
        pools.removeLiquidity(address(tsla), shares / 2, 0, 1, dl);
        vm.expectRevert(SpotPools.NoMinimum.selector);
        pools.removeLiquidity(address(tsla), shares / 2, 1, 0, dl);
        pools.removeLiquidity(address(tsla), shares / 2, 1, 1, dl);
        vm.stopPrank();
    }

    /// @notice FA-06. `withdraw` used to accept a module, a listed token or the oracle as recipient (only the vault was
    ///         refused): none of them can move the tokens, which were stranded. It now applies the deposit's checks.
    function test_FA06_withdrawRefusesProtocolRecipients_fixed() public {
        _fund(alice, usdg, 100 * USD);
        address[7] memory refused = [
            address(pools), address(book), address(perps), address(vault), address(usdg), address(tsla), address(oracle)
        ];
        vm.startPrank(alice);
        for (uint256 i; i < refused.length; ++i) {
            bool module = i < 3;
            vm.expectRevert(
                abi.encodeWithSelector(
                    module ? VelumVault.ModuleRecipient.selector : VelumVault.ProtocolRecipient.selector, refused[i]
                )
            );
            vault.withdraw(address(usdg), 1 * USD, refused[i]);
        }
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        vault.withdraw(address(usdg), 1 * USD, address(0));
        vault.withdraw(address(usdg), 1 * USD, carol); // any other address is fine
        vm.stopPrank();
        assertEq(usdg.balanceOf(carol), 1 * USD);
    }
}

/// @notice FA-07 (Info). Before the fix, a sequencer-uptime feed address without code was accepted by `setup`, and
///         `sequencerStatus()` then reverted (try/catch cannot catch the failed return-data decoding), freezing every
///         open, removeMargin, liquidation and close for good.
contract FinalAuditSequencerFeedPoC is Test {
    function _args(address feed)
        internal
        returns (address[] memory toks, address[] memory feeds, uint128[] memory mn, uint128[] memory mx)
    {
        toks = new address[](1);
        toks[0] = makeAddr("tsla");
        feeds = new address[](1);
        feeds[0] = feed;
        mn = new uint128[](1);
        mx = new uint128[](1);
        mn[0] = 1e18;
        mx[0] = 100_000e18;
    }

    function test_FA07_codelessSequencerFeedRefusedAtSetup_fixed() public {
        OracleAdapter o = new OracleAdapter();
        (address[] memory toks, address[] memory feeds, uint128[] memory mn, uint128[] memory mx) = _args(address(0));
        address noCode = makeAddr("not-a-contract");
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeed.selector, noCode));
        o.setup(toks, feeds, mn, mx, makeAddr("relayer"), noCode); // was accepted
        // a contract that is not an aggregator (here: one that returns two words) is refused too
        ShortFeed short = new ShortFeed();
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeed.selector, address(short)));
        o.setup(toks, feeds, mn, mx, makeAddr("relayer"), address(short));
        // a price feed passed by mistake as the sequencer feed (answer neither 0 nor 1) would read as down forever
        MockAggregator priceFeed = new MockAggregator(8);
        priceFeed.set(400e8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeed.selector, address(priceFeed)));
        o.setup(toks, feeds, mn, mx, makeAddr("relayer"), address(priceFeed));
        // a codeless price feed is refused with the same clear error (it used to revert while decoding decimals())
        (toks, feeds, mn, mx) = _args(noCode);
        MockAggregator seq = new MockAggregator(0);
        seq.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeed.selector, noCode));
        o.setup(toks, feeds, mn, mx, address(0), address(seq));
    }

    /// @notice A feed that breaks after setup (loses its code or starts returning malformed data) reads as failed:
    ///         the sequencer reads as down, the price as missing, and `poke` still never reverts.
    function test_FA07_feedBrokenAfterSetupReadsAsDownNeverReverts_fixed() public {
        vm.warp(1_800_000_000);
        MockAggregator seq = new MockAggregator(0);
        seq.set(0, block.timestamp - 2 hours);
        MockAggregator feed = new MockAggregator(8);
        feed.set(400e8, block.timestamp);
        (address[] memory toks, address[] memory feeds, uint128[] memory mn, uint128[] memory mx) = _args(address(feed));
        OracleAdapter o = new OracleAdapter();
        o.setup(toks, feeds, mn, mx, address(0), address(seq));
        (bool up, bool ready) = o.sequencerStatus();
        assertTrue(up && ready);
        assertTrue(o.poke(toks[0]));

        bytes memory shortCode = address(new ShortFeed()).code;
        vm.etch(address(seq), shortCode); // malformed answer
        (up, ready) = o.sequencerStatus();
        assertFalse(up || ready, "malformed sequencer feed: down, no revert");
        vm.etch(address(seq), ""); // no code at all
        (up, ready) = o.sequencerStatus();
        assertFalse(up || ready, "codeless sequencer feed: down, no revert (was a revert)");
        assertFalse(o.sequencerReady());

        vm.etch(address(feed), shortCode);
        assertFalse(o.poke(toks[0]), "malformed price feed: poke returns false");
        vm.etch(address(feed), "");
        assertFalse(o.poke(toks[0]), "codeless price feed: poke returns false, never reverts");
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, toks[0]));
        o.price(toks[0]);
        assertFalse(o.isDead(toks[0]), "a failed read is stale, not dead");
    }
}

/// @notice A contract whose latestRoundData() returns two words instead of five.
contract ShortFeed {
    fallback() external {
        assembly {
            mstore(0, 0)
            mstore(0x20, 1)
            return(0, 0x40)
        }
    }
}

/// @notice FA-03 (Low; IA-02 fix incomplete). IA-02's scenario with one change: the oracle stays dead for another 15
///         days after the dead-oracle exit, then the relay returns. Before the fix the first accrual after the revival
///         charged the rate reset by the exit (+0.01%/h, only the long left) over those 15 days: 35.99 USDG, the same
///         amount IA-02 removed. Now that time is dead time on the live clock.
contract FinalAuditDeadFundingPoC is VelumBase {
    function test_FA03_deadPeriodAfterADeadExitNotCharged_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 2000 * USD);
        _fund(carol, usdg, 2000 * USD);
        uint256 longId = _open(alice, offerId, true, 1000 * USD, 10);
        uint256 shortId = _open(carol, offerId, false, 1000 * USD, 10);
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        perps.requestForcedExit{value: 0.001 ether}(shortId);
        vm.warp(block.timestamp + 15 days);
        assertTrue(oracle.isDead(address(tsla)));
        perps.settleForcedExit(shortId); // IA-02 path: nothing accrued for the first 15 dead days, rate -> +0.01%/h
        int256 claimBefore = perps.takerClaimAt(longId, TSLA_PRICE);

        vm.warp(block.timestamp + 15 days); // still no price at all
        assertTrue(oracle.isDead(address(tsla)));
        _pushPrice(address(tsla), TSLA_PRICE); // the relay returns at the same price
        perps.advanceFunding(address(tsla));
        int256 charged = claimBefore - perps.takerClaimAt(longId, TSLA_PRICE);
        emit log_named_decimal_int("funding charged to the long for 15 days without any price (was 35.99)", charged, 6);
        assertGe(charged, 0);
        assertLt(charged, int256(USD / 1000), "one second of funding, not 15 days");
    }
}

/// @notice FA-01: the share of seconds at which an open or close would see a lagging price, by relay push interval,
///         with recordings only at pushes and with a poke every second (as in any busy market: trades, keepers,
///         indexers). The source follows a random walk, one step per second, uniform in +-a ppm with a = 424 ppm
///         (about 0.19% per minute, TSLA-like) or 848 ppm (twice that); the relay pushes its latest value every k
///         seconds. The numbers are in contracts/README.md ("Lagging in normal markets").
contract FinalAuditLaggingTable is VelumBase {
    function _pushNow(uint256 p) internal {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = p;
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    function _simulate(uint256 stepPpm, uint256 interval, bool poke) internal returns (uint256 lagging) {
        uint256 snap = vm.snapshotState();
        uint256 source = TSLA_PRICE;
        uint256 t0 = block.timestamp;
        for (uint256 s = 1; s <= 1800; ++s) {
            vm.warp(t0 + s);
            uint256 r = uint256(keccak256(abi.encode("source", s)));
            uint256 step = (source * (r % (stepPpm + 1))) / 1e6;
            source = (r >> 128) % 2 == 0 ? source + step : source - step;
            if (s % interval == 0) _pushNow(source);
            else if (poke) oracle.poke(address(tsla));
            if (oracle.lagging(address(tsla))) lagging++;
        }
        vm.revertToState(snap);
    }

    function test_FA01_laggingShareByPushInterval() public {
        uint256[6] memory intervals = [uint256(1), 2, 5, 6, 8, 10];
        uint256[2] memory steps = [uint256(424), 848];
        for (uint256 v; v < 2; ++v) {
            for (uint256 i; i < intervals.length; ++i) {
                uint256 quiet = _simulate(steps[v], intervals[i], false);
                uint256 busy = _simulate(steps[v], intervals[i], true);
                emit log_string(string.concat(
                        v == 0 ? "0.19%/min" : "0.38%/min",
                        " push every ",
                        vm.toString(intervals[i]),
                        " s: lagging permille quiet ",
                        vm.toString((quiet * 1000) / 1800),
                        ", poked every second ",
                        vm.toString((busy * 1000) / 1800)
                    ));
                // The pokes cost at most the rounding of one second per pushed value that lagged (before the fix, a poke
                // every second took 6-s pushes at 0.19%/min from 2.8% to 38% of seconds lagging).
                assertLe(busy, 2 * quiet + 18, "pokes at most double the quiet lag (+1% of seconds)");
            }
        }
    }
}
