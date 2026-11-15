// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

contract OracleAdapterTest is VelumBase {
    MockAggregator internal feed;
    MockAggregator internal sequencer;
    OracleAdapter internal cl; // chainlink-sourced adapter for tsla, relay for amzn

    function setUp() public override {
        super.setUp();
        feed = new MockAggregator(8);
        feed.set(39_165_000_000, block.timestamp); // 391.65 at 8 decimals
        sequencer = new MockAggregator(0);
        sequencer.set(0, block.timestamp - 2 hours); // up for two hours
        cl = new OracleAdapter();
        address[] memory tokens = _stocks();
        address[] memory feeds = new address[](2);
        feeds[0] = address(feed);
        uint128[] memory mins = new uint128[](2);
        uint128[] memory maxs = new uint128[](2);
        mins[0] = 1e18;
        mins[1] = 1e18;
        maxs[0] = 10_000e18;
        maxs[1] = 10_000e18;
        cl.setup(tokens, feeds, mins, maxs, relayer, address(sequencer));
    }

    function _setupArgs(uint256 n)
        internal
        pure
        returns (address[] memory t, address[] memory f, uint128[] memory mn, uint128[] memory mx)
    {
        t = new address[](n);
        f = new address[](n);
        mn = new uint128[](n);
        mx = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            t[i] = address(uint160(0x1000 + i));
            mn[i] = 1;
            mx[i] = 2;
        }
    }

    function _push(OracleAdapter o, address token, uint256 p) internal {
        vm.warp(block.timestamp + 1);
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = token;
        v[0] = p;
        vm.prank(relayer);
        o.pushPrices(t, v);
    }

    // ------------------------------------------------------------ setup

    function test_setup_guards() public {
        OracleAdapter o = new OracleAdapter();
        (address[] memory t, address[] memory f, uint128[] memory mn, uint128[] memory mx) = _setupArgs(1);
        vm.prank(alice);
        vm.expectRevert(OracleAdapter.NotDeployer.selector);
        o.setup(t, f, mn, mx, relayer, address(0));

        vm.expectRevert(OracleAdapter.LengthMismatch.selector);
        o.setup(t, new address[](2), mn, mx, relayer, address(0));

        mn[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadBounds.selector, t[0]));
        o.setup(t, f, mn, mx, relayer, address(0));
        mn[0] = 2;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadBounds.selector, t[0]));
        o.setup(t, f, mn, mx, relayer, address(0));
        mn[0] = 1;

        vm.expectRevert(OracleAdapter.ZeroAddress.selector); // relay-sourced without a relayer
        o.setup(t, f, mn, mx, address(0), address(0));

        f[0] = address(new MockAggregator(8));
        vm.expectRevert(OracleAdapter.SequencerFeedRequired.selector); // audit F-05
        o.setup(t, f, mn, mx, relayer, address(0));

        f[0] = address(new MockAggregator(19));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeedDecimals.selector, f[0]));
        o.setup(t, f, mn, mx, relayer, address(sequencer));

        t[0] = address(0);
        f[0] = address(0);
        vm.expectRevert(OracleAdapter.ZeroAddress.selector);
        o.setup(t, f, mn, mx, relayer, address(0));

        (t, f, mn, mx) = _setupArgs(1);
        o.setup(t, f, mn, mx, relayer, address(0));
        assertEq(o.setupAt(), block.timestamp);
        assertEq(o.sequencerFeed(), address(0));
        vm.expectRevert(OracleAdapter.AlreadySetUp.selector);
        o.setup(t, f, mn, mx, relayer, address(0));
    }

    // ------------------------------------------------------------ relay

    function test_relay_pushAndRead() public view {
        assertEq(oracle.price(address(tsla)), TSLA_PRICE);
        (uint256 p, uint256 at) = oracle.latest(address(tsla));
        assertEq(p, TSLA_PRICE);
        assertEq(at, block.timestamp - 1); // setUp pushes TSLA one second before AMZN
        assertFalse(oracle.lagging(address(tsla)));
        assertFalse(oracle.atBound(address(tsla)));
        assertEq(oracle.lastValidAt(address(tsla)), at);
        (uint256 lastPrice, uint256 validAt) = oracle.lastRecorded(address(tsla));
        assertEq(lastPrice, TSLA_PRICE);
        assertEq(validAt, at);
    }

    function test_relay_guards() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = 400e18;

        vm.expectRevert(OracleAdapter.NotRelayer.selector);
        oracle.pushPrices(t, v);

        vm.startPrank(relayer);
        vm.expectRevert(OracleAdapter.LengthMismatch.selector);
        oracle.pushPrices(t, new uint256[](2));

        t[0] = address(amzn);
        v[0] = 234e18;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.TooSoon.selector, address(amzn)));
        oracle.pushPrices(t, v); // AMZN was pushed in this same second

        // Out-of-bounds prices are accepted and clamped when recorded (IA-06); zero and > uint128 are malformed.
        t[0] = address(tsla);
        v[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceOutOfBounds.selector, address(tsla), 0));
        oracle.pushPrices(t, v);
        v[0] = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceOutOfBounds.selector, address(tsla), v[0]));
        oracle.pushPrices(t, v);

        t[0] = address(usdg);
        v[0] = 1e18;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.UnknownToken.selector, address(usdg)));
        oracle.pushPrices(t, v);
        vm.stopPrank();
    }

    function test_relay_refusesFeedSourcedToken() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = 391e18;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NotRelaySourced.selector, address(tsla)));
        cl.pushPrices(t, v);
    }

    // ------------------------------------------------------------ rate limit (audit F-04, F-02, R2-01)

    /// @dev The range a recording at `t` may report after `last` was recorded at `lastAt`, exactly as
    ///      OracleAdapter._limit computes it (5% x min(dt, 5 min) / 5 min, rounded toward `last`).
    function _range(uint256 last, uint256 lastAt, uint256 t) internal pure returns (uint256 lo, uint256 hi) {
        uint256 dt = t - lastAt;
        if (dt > 5 minutes) dt = 5 minutes;
        uint256 m = (last * 500 * dt) / (10_000 * 5 minutes);
        return (last - m, last + m);
    }

    function _bandOf(OracleAdapter o, address token) internal view returns (uint256 last, uint256 lastAt) {
        (uint128 l, uint64 at,) = o.bands(token);
        return (l, at);
    }

    function test_limit_clampsPerSecondAndFlagsLagging() public {
        (uint256 last, uint256 at) = _bandOf(oracle, address(tsla));
        assertEq(last, TSLA_PRICE);
        (, uint256 hi) = _range(last, at, block.timestamp + 1);
        assertEq(hi, TSLA_PRICE + TSLA_PRICE / 3000, "two seconds: 2/6000");
        vm.expectEmit(address(oracle));
        emit OracleAdapter.PriceRelayed(address(tsla), 431e18, hi, block.timestamp + 1);
        _pushPrice(address(tsla), 431e18); // +10% in one push
        assertEq(oracle.price(address(tsla)), hi);
        assertTrue(oracle.lagging(address(tsla)));
        // each further second moves at most 1/6000 from the last recorded price, either way
        uint256 prev = hi;
        _pushPrice(address(tsla), 1e18);
        assertEq(oracle.price(address(tsla)), prev - prev / 6000);
        prev = prev - prev / 6000;
        // a price inside the allowance is taken as is: not lagging
        _pushPrice(address(tsla), prev + prev / 7000);
        assertEq(oracle.price(address(tsla)), prev + prev / 7000);
        assertFalse(oracle.lagging(address(tsla)));
    }

    function test_limit_firstUpdateAfterSilenceCappedAtFivePercent() public {
        vm.warp(block.timestamp + 16 hours); // e.g. overnight, relay silent
        _pushPrice(address(tsla), (TSLA_PRICE * 70) / 100); // -30% gap
        assertEq(oracle.price(address(tsla)), (TSLA_PRICE * 95) / 100, "capped at -5%");
        assertTrue(oracle.lagging(address(tsla)));
    }

    function test_limit_sameSecondCannotMove() public {
        assertTrue(cl.poke(address(tsla)));
        vm.warp(block.timestamp + 1 hours);
        feed.set(30_000_000_000, block.timestamp); // 300
        assertTrue(cl.poke(address(tsla)));
        uint256 p = cl.price(address(tsla));
        assertEq(p, (391.65e18 * 95) / 100);
        feed.set(20_000_000_000, block.timestamp); // a second update in the same second
        assertTrue(cl.poke(address(tsla)));
        assertEq(cl.price(address(tsla)), p, "no time passed: no move");
    }

    function test_limit_walksFivePercentPerWindow() public {
        uint256 target = TSLA_PRICE * 2;
        uint256 expected = TSLA_PRICE;
        for (uint256 i; i < 14; ++i) {
            _nextWindowPush(address(tsla), target);
            expected += expected / 20;
            assertEq(_effectivePrice(address(tsla)), expected);
            assertTrue(oracle.lagging(address(tsla)));
        }
        _nextWindowPush(address(tsla), target);
        assertEq(_effectivePrice(address(tsla)), target, "15 windows (75 min) to double");
        assertFalse(oracle.lagging(address(tsla)));
    }

    /// @notice A poke is a recording like a push or a read, under the same limit: poked every second or not
    ///         at all, the price after t seconds stays within (1 + 1/6000)^t of where it was (what a relayer
    ///         pushing every second could reach anyway), and one recording never moves it more than 5%.
    ///         There is no window phase to pick any more.
    function test_limit_pokeStaysWithinCompoundingLimit() public {
        _pushPrice(address(tsla), 1000e18);
        (uint256 last0, uint256 t0) = _bandOf(oracle, address(tsla));
        uint256 snap = vm.snapshotState();
        vm.warp(t0 + 10 minutes);
        assertTrue(oracle.poke(address(tsla)));
        uint256 quiet = _effectivePrice(address(tsla));
        vm.revertToState(snap);
        for (uint256 i; i < 600; ++i) {
            vm.warp(block.timestamp + 1);
            assertTrue(oracle.poke(address(tsla)));
        }
        uint256 busy = _effectivePrice(address(tsla));
        assertEq(last0, TSLA_PRICE + TSLA_PRICE / 3000, "two seconds after the last recording");
        assertEq(quiet, last0 + last0 / 20, "one recording after a silence: +5%");
        assertLe(busy, (last0 * 110_518) / 100_000, "every second: at most e^0.1");
        assertGt(busy, quiet);
    }

    /// @notice The view price is what the next recording would report.
    function test_band_viewMatchesRead() public {
        _pushPrice(address(tsla), 600e18);
        vm.warp(block.timestamp + 10 minutes);
        _pushPrice(address(tsla), 600e18);
        uint256 viewed = oracle.price(address(tsla));
        (uint256 p, bool lag) = oracle.read(address(tsla), 60);
        assertEq(p, viewed);
        assertTrue(lag);
    }

    function test_limit_chainlinkGapIsClamped() public {
        assertTrue(cl.poke(address(tsla))); // first valid price is taken as is
        vm.warp(block.timestamp + 16 hours);
        feed.set(27_415_500_000, block.timestamp); // -30%
        uint256 lo = 372.0675e18; // 391.65 x 0.95
        assertEq(cl.price(address(tsla)), lo);
        assertTrue(cl.lagging(address(tsla)));
        (uint256 p, bool lag) = cl.read(address(tsla), 60);
        assertEq(p, lo);
        assertTrue(lag);
    }

    /// @notice Whatever mix of pushes, pokes and reads, at whatever spacing: every recording lies between the
    ///         last price and the source price, within the per-recording limit, and over the whole run the
    ///         price stays within (1 + 1/6000)^t of where it started.
    function testFuzz_limit_everyRecordingWithinLimit(uint256[12] memory ops) public {
        (uint256 start, uint256 t0) = _bandOf(oracle, address(tsla));
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + bound(ops[i] >> 160, 1, 15 minutes));
            (uint256 last, uint256 at) = _bandOf(oracle, address(tsla));
            (uint256 lo, uint256 hi) = _range(last, at, block.timestamp);
            uint256 kind = (ops[i] >> 128) % 3;
            if (kind == 0) {
                uint256 raw = bound(uint128(ops[i]), 1e18, 100_000e18);
                vm.prank(relayer);
                address[] memory t = new address[](1);
                uint256[] memory v = new uint256[](1);
                t[0] = address(tsla);
                v[0] = raw;
                oracle.pushPrices(t, v);
            } else if (kind == 1) {
                assertTrue(oracle.poke(address(tsla)));
            } else {
                (, uint256 updatedAt) = oracle.latest(address(tsla));
                if (block.timestamp > updatedAt + 60) continue;
                oracle.read(address(tsla), 60);
            }
            (uint256 now_, uint256 nowAt) = _bandOf(oracle, address(tsla));
            assertEq(nowAt, block.timestamp);
            assertGe(now_, lo);
            assertLe(now_, hi);
        }
        // compounding bound over the run: (1 + 1/6000)^t <= e^(t/6000)
        uint256 elapsed = block.timestamp - t0;
        uint256 p = _effectivePrice(address(tsla));
        uint256 capHi = start;
        for (uint256 s; s < elapsed; s += 60) {
            capHi = (capHi * 10_101) / 10_000; // >= (1 + 1/6000)^60 per started minute
        }
        assertLe(p, capHi);
    }

    // ------------------------------------------------------------ freshness

    function test_staleness() public {
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 60);
        assertEq(oracle.price(address(tsla)), TSLA_PRICE);
        vm.warp(at + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        oracle.price(address(tsla));
    }

    function test_read_maxAge() public {
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 10);
        (uint256 p,) = oracle.read(address(tsla), 10);
        assertEq(p, TSLA_PRICE);
        vm.warp(at + 11);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        oracle.read(address(tsla), 10);
        // maxAge is capped at MAX_AGE
        vm.warp(at + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        oracle.read(address(tsla), 1 days);
    }

    // ------------------------------------------------------------ liveness (audit F-03)

    function test_noPriceAndDead() public {
        // amzn on `cl` is relay-sourced and was never pushed: no price, but only dead 14 days after setup
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(amzn)));
        cl.price(address(amzn));
        assertFalse(cl.isDead(address(amzn)));
        assertTrue(oracle.isDead(address(usdg))); // not configured at all
        assertFalse(oracle.isDead(address(tsla)));
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 14 days);
        assertFalse(oracle.isDead(address(tsla)));
        vm.warp(at + 14 days + 1);
        assertTrue(oracle.isDead(address(tsla)));
        vm.warp(cl.setupAt() + 14 days + 1);
        assertTrue(cl.isDead(address(amzn)));
    }

    function test_poke_recordsLastValidAt() public {
        assertEq(cl.lastValidAt(address(tsla)), 0);
        uint256 t0 = block.timestamp;
        assertTrue(cl.poke(address(tsla)));
        assertEq(cl.lastValidAt(address(tsla)), t0);
        // a valid but older round never moves lastValidAt back
        feed.set(39_165_000_000, t0 - 100);
        assertTrue(cl.poke(address(tsla)));
        assertEq(cl.lastValidAt(address(tsla)), t0);
        // invalid reads record nothing and never revert
        feed.setBroken(true);
        assertFalse(cl.poke(address(tsla)));
        feed.setBroken(false);
        vm.warp(t0 + 1);
        feed.set(0, block.timestamp); // zero answer
        assertFalse(cl.poke(address(tsla)));
        assertFalse(cl.poke(address(usdg))); // unknown token
        assertEq(cl.lastValidAt(address(tsla)), t0);
        // an out-of-bounds answer is a valid reading, recorded clamped and rate-limited (IA-06)
        feed.set(5_000_000, block.timestamp); // 0.05 < the 1 USDG floor
        assertTrue(cl.poke(address(tsla)));
        assertEq(cl.lastValidAt(address(tsla)), t0 + 1);
        assertEq(cl.price(address(tsla)), 391.65e18 - 391.65e18 / 6000, "one second toward the floor");
        assertTrue(cl.lagging(address(tsla)));
    }

    function test_isDead_failedReadsAreStaleUntilFourteenDays() public {
        assertTrue(cl.poke(address(tsla)));
        uint256 t0 = block.timestamp;
        feed.setBroken(true);
        assertFalse(cl.isDead(address(tsla)), "one failed read is stale, not dead");
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));
        vm.warp(t0 + 14 days);
        assertFalse(cl.isDead(address(tsla)));
        vm.warp(t0 + 14 days + 1);
        assertTrue(cl.isDead(address(tsla)));
        // a valid price revives it
        feed.setBroken(false);
        feed.set(39_165_000_000, block.timestamp);
        assertFalse(cl.isDead(address(tsla)));
    }

    function test_isDead_usesCurrentValidReadWithoutPoke() public {
        // nobody poked, but the feed itself has a recent valid round
        vm.warp(block.timestamp + 20 days);
        feed.set(39_165_000_000, block.timestamp - 1 days);
        assertFalse(cl.isDead(address(tsla)));
        feed.set(5_000_000, block.timestamp); // out of bounds now: still a live reading (IA-06)
        assertFalse(cl.isDead(address(tsla)));
        feed.set(0, block.timestamp); // invalid now: falls back to lastValidAt / setup
        assertTrue(cl.isDead(address(tsla)));
    }

    // ------------------------------------------------------------ chainlink

    function test_chainlink_scalesAndChecks() public {
        assertEq(cl.price(address(tsla)), 391.65e18);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), block.timestamp - 61));
        cl.price(address(tsla));

        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));
        assertFalse(cl.isDead(address(tsla)));

        feed.set(39_165_000_000, block.timestamp + 10); // updatedAt in the future
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));

        feed.set(5_000_000, block.timestamp); // 0.05 < min bound: clamped to the bound (IA-06), lagging
        assertEq(cl.price(address(tsla)), 1e18, "first recording: the clamped price as is");
        assertTrue(cl.lagging(address(tsla)));
        assertTrue(cl.atBound(address(tsla)));
        assertFalse(cl.isDead(address(tsla)));

        feed.set(39_165_000_000, block.timestamp);
        feed.setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));
        assertFalse(cl.isDead(address(tsla)));
    }

    function testFuzz_chainlinkScaling(uint64 answer, uint8 dec) public {
        dec = uint8(bound(dec, 0, 18));
        MockAggregator f = new MockAggregator(dec);
        OracleAdapter o = new OracleAdapter();
        address[] memory t = new address[](1);
        address[] memory fs = new address[](1);
        uint128[] memory mn = new uint128[](1);
        uint128[] memory mx = new uint128[](1);
        t[0] = address(tsla);
        fs[0] = address(f);
        mn[0] = 1;
        mx[0] = type(uint128).max;
        o.setup(t, fs, mn, mx, address(0), address(sequencer));
        vm.assume(answer > 0);
        f.set(int256(uint256(answer)), block.timestamp);
        assertEq(o.price(address(tsla)), uint256(answer) * 10 ** (18 - dec));
    }

    // ------------------------------------------------------------ sequencer (audit F-05)

    function test_sequencer_readyStates() public {
        assertTrue(oracle.sequencerReady(), "no sequencer feed: relay only, always ready");
        assertTrue(cl.sequencerReady());
        sequencer.set(1, block.timestamp - 3 hours); // down
        assertFalse(cl.sequencerReady());
        (bool up, bool ready) = cl.sequencerStatus();
        assertFalse(up || ready, "down: neither");
        sequencer.set(0, block.timestamp - 1 hours); // back up exactly one hour ago: still in grace
        assertFalse(cl.sequencerReady());
        (up, ready) = cl.sequencerStatus();
        assertTrue(up && !ready, "grace: up, not ready (IA-07)");
        sequencer.set(0, block.timestamp - 1 hours - 1);
        assertTrue(cl.sequencerReady());
        (up, ready) = cl.sequencerStatus();
        assertTrue(up && ready);
        (up, ready) = oracle.sequencerStatus();
        assertTrue(up && ready, "no feed: always up and ready");
        sequencer.set(0, 0); // round not initialised
        assertFalse(cl.sequencerReady());
        sequencer.set(0, block.timestamp + 1); // from the future
        assertFalse(cl.sequencerReady());
        sequencer.set(0, block.timestamp - 2 hours);
        sequencer.setBroken(true); // unreadable: fail closed
        assertFalse(cl.sequencerReady());
        (up, ready) = cl.sequencerStatus();
        assertFalse(up || ready);
    }
}
