// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VelumBase} from "../Base.t.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {IVelumVault} from "../../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../../src/interfaces/IMakerBook.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Final internal audit: fuzz tests for the logic changed in f1ad8dd (relay-sourced setup).
contract FinalAuditFuzzRelay is VelumBase {
    struct D {
        int256 taker;
        int256 maker;
        int256 ins; // insurance + reserved cover
        int256 settler;
        int256 bobClaims;
    }

    function _snap(address settler) internal view returns (D memory d) {
        d = D(
            int256(_bal(alice, usdg)),
            int256(_bal(bob, usdg)),
            int256(perps.insurance() + perps.coverReserved()),
            int256(_bal(settler, usdg)),
            int256(perps.coverClaims(perps.currentCoverEpoch(), bob))
        );
    }

    function _delta(D memory b, address settler) internal view returns (D memory d) {
        D memory a = _snap(settler);
        d = D(a.taker - b.taker, a.maker - b.maker, a.ins - b.ins, a.settler - b.settler, a.bobClaims - b.bobClaims);
    }

    /// @notice IA-01 at a LIVE price: a taker-requested forced exit settles exactly like the plain close the taker
    ///         could have sent at the same moment (same price, funding, spread, fee), for every side, leverage,
    ///         spread, size, holding time and price move; when liquidatable both take the liquidation route and
    ///         differ only in who receives the keeper reward.
    function testFuzz_FA_IA01_takerForcedExitEqualsPlainCloseAtLivePrice(
        uint16 openBps,
        uint16 closeBps,
        bool isLong,
        uint8 lev,
        uint256 size,
        uint256 moveBps,
        bool up,
        uint256 holdDays
    ) public {
        openBps = uint16(bound(openBps, 2, 500));
        closeBps = uint16(bound(closeBps, 0, 500));
        lev = uint8(bound(lev, 2, 10));
        size = bound(size, 10 * USD, 2000 * USD);
        moveBps = bound(moveBps, 0, 1800);
        holdDays = bound(holdDays, 7, 40);
        uint256 offerId = _postOffer(20_000 * USD, 20_000 * USD, openBps, closeBps);
        _fund(alice, usdg, 5000 * USD);
        _fund(carol, usdg, 100 * USD);
        vm.prank(carol);
        perps.fundInsurance(100 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offerId, isLong, size, lev);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + holdDays * 1 days);
        uint256 move = (TSLA_PRICE * moveBps) / 10_000;
        _movePriceTo(address(tsla), up ? TSLA_PRICE + move : TSLA_PRICE - move);
        bool liq = perps.isLiquidatable(id);

        uint256 s = vm.snapshotState();
        D memory b = _snap(alice);
        vm.prank(alice);
        perps.close(id, isLong ? 1 : type(uint256).max);
        D memory viaClose = _delta(b, alice);
        vm.revertToState(s);

        b = _snap(carol);
        vm.prank(carol);
        perps.settleForcedExit(id);
        D memory viaForced = _delta(b, carol);

        assertEq(viaForced.maker, viaClose.maker, "maker");
        assertEq(viaForced.ins, viaClose.ins, "insurance");
        assertEq(viaForced.bobClaims, viaClose.bobClaims, "maker cover claim");
        if (!liq) {
            assertEq(viaForced.taker, viaClose.taker, "taker: exactly a plain close");
            assertEq(viaForced.settler, 0, "no reward for settling a non-liquidatable exit");
        } else {
            assertEq(viaForced.taker + viaForced.settler, viaClose.taker, "liquidation: only the keeper differs");
        }
        assertFalse(perps.getPosition(id).open);
        _assertPerpsSolvent();
    }

    /// @notice IA-06 clamping, per recording, for any sequence of relay pushes in or far outside the bounds:
    ///         the effective price stays in [min, max], moves at most 5% x min(dt, 300) / 300 from the last
    ///         recording, `lagging` == (effective != source), and `atBound` <=> source outside the bounds and the
    ///         effective price equal to the clamped source.
    function testFuzz_FA_IA06_clampRateLimitAndAtBoundConsistent(uint256[16] memory steps) public {
        uint256 minP = 1e18;
        uint256 maxP = 100_000e18;
        for (uint256 i; i < steps.length; ++i) {
            uint256 r = steps[i];
            uint256 dt = 1 + (r % 600);
            uint256 kind = (r >> 16) % 8;
            (uint128 last, uint64 lastAt,) = oracle.bands(address(tsla));
            uint256 target;
            if (kind == 0) target = 1 + ((r >> 32) % minP); // below the floor
            else if (kind == 1) target = maxP + 1 + ((r >> 32) % (1e30)); // above the cap
            else if (kind == 2) target = minP; // exactly at a bound
            else if (kind == 3) target = maxP;
            else target = (uint256(last) * (9000 + ((r >> 32) % 2001))) / 10_000; // +-10% around the last price
            if (target == 0) target = 1;
            vm.warp(block.timestamp + dt - 1); // _pushPrice adds the last second
            _pushPrice(address(tsla), target);
            (uint128 eff,,) = oracle.bands(address(tsla));
            assertGe(eff, minP, "floor");
            assertLe(eff, maxP, "cap");
            uint256 cappedDt = block.timestamp - lastAt; // time since the last recording
            if (cappedDt > 300) cappedDt = 300;
            uint256 maxMove = (uint256(last) * 500 * cappedDt) / (10_000 * 300);
            uint256 diff = eff > last ? eff - last : last - eff;
            assertLe(diff, maxMove, "rate limit");
            uint256 c = target < minP ? minP : (target > maxP ? maxP : target);
            assertEq(oracle.lagging(address(tsla)), eff != target, "lagging == effective != source");
            assertEq(oracle.atBound(address(tsla)), c != target && eff == c, "atBound");
            assertEq(oracle.price(address(tsla)), eff, "price() == recorded price in the same second");
        }
    }

    /// @notice IA-06 forced exit: a matured maker-requested exit on a 1x long settles exactly when the price is
    ///         not lagging, or lagging only because the source is beyond a bound that the effective price has
    ///         reached; it then settles at that effective price (the bound). Otherwise it is refused as lagging.
    function testFuzz_FA_IA06_forcedExitSettlesOnlyInLimitOrAtBound(uint256[8] memory steps, bool below) public {
        uint256 offerId = _postOffer(20_000 * USD, 20_000 * USD, 2, 0);
        _fund(alice, usdg, 5000 * USD);
        vm.deal(bob, 1 ether);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2); // 1x: never liquidatable on the way down
        vm.prank(bob);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 7 days);
        for (uint256 i; i < steps.length; ++i) {
            uint256 r = steps[i];
            uint256 target = r % 3 == 0 ? (below ? 0.5e18 : 150_000e18) : _effectivePrice(address(tsla));
            if (r % 3 == 1) target = (target * (9500 + ((r >> 8) % 1001))) / 10_000;
            vm.warp(block.timestamp + ((r >> 32) % 400));
            _pushPrice(address(tsla), target);
            bool lagging = oracle.lagging(address(tsla));
            bool atB = oracle.atBound(address(tsla));
            bool liq = perps.isLiquidatable(id);
            uint256 eff = oracle.price(address(tsla));
            uint256 s = vm.snapshotState();
            vm.recordLogs();
            try perps.settleForcedExit(id) {
                assertTrue(!lagging || atB || liq, "settled at a lagging price that is not the bound");
                if (lagging && !liq) {
                    assertTrue(eff == 1e18 || eff == 100_000e18, "lagging settlement only at a bound");
                }
                Vm.Log[] memory logs = vm.getRecordedLogs();
                bytes32 sig = keccak256("ForcedExitSettled(uint256,uint256,bool)");
                for (uint256 j; j < logs.length; ++j) {
                    if (logs[j].topics[0] == sig) {
                        (uint256 px,) = abi.decode(logs[j].data, (uint256, bool));
                        assertEq(px, eff, "settled at the effective price");
                    }
                }
            } catch (bytes memory err) {
                assertTrue(lagging && !atB && !liq, "refused although in limit or at the bound");
                assertEq(bytes4(err), PerpsBase.PriceLagging.selector);
            }
            vm.revertToState(s);
        }
    }

    /// @notice IA-02: a dead-oracle exit accrues exactly rate x lastPrice x (lastValidAt - lastFundingUpdate) and
    ///         nothing for the dead period, whatever the skew, the time prices kept coming after the last trade and
    ///         the length of the silence.
    function testFuzz_FA_IA02_deadExitFundingExact(
        uint256 longSize,
        uint256 shortSize,
        uint256 aliveFor,
        uint256 deadFor
    ) public {
        longSize = bound(longSize, 10 * USD, 2000 * USD);
        shortSize = bound(shortSize, 0, 2000 * USD);
        aliveFor = bound(aliveFor, 0, 10 days);
        deadFor = bound(deadFor, 14 days + 1, 120 days);
        uint256 offerId = _postOffer(20_000 * USD, 20_000 * USD, 2, 0);
        _fund(alice, usdg, 5000 * USD);
        _fund(carol, usdg, 5000 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offerId, true, longSize, 10);
        if (shortSize >= 10 * USD) _open(carol, offerId, false, shortSize, 10);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        (,,,, int256 idx0, int256 rate, uint64 t0) = perps.markets(address(tsla));
        // prices keep arriving (relay pushes only, no trade) for `aliveFor`
        uint256 validAt = block.timestamp;
        uint256 p = TSLA_PRICE;
        for (uint256 tt = 600; tt <= aliveFor; tt += 1 days) {
            vm.warp(t0 + tt);
            p = (p * 1001) / 1000;
            _pushPrice(address(tsla), p);
            validAt = block.timestamp;
        }
        if (block.timestamp < t0 + 7 days) vm.warp(t0 + 7 days);
        vm.warp(validAt + deadFor);
        assertTrue(oracle.isDead(address(tsla)));
        (uint256 lastP,) = oracle.lastRecorded(address(tsla));
        perps.settleForcedExit(id);
        (,,,, int256 idx1,, uint64 t1) = perps.markets(address(tsla));
        int256 num = rate * int256(lastP * (validAt - t0));
        int256 expected = num / int256(3600 * 1e18);
        if (num < 0 && num % int256(3600 * 1e18) != 0) expected -= 1;
        assertEq(idx1 - idx0, validAt > t0 ? expected : int256(0), "old rate up to the last valid time only");
        assertEq(t1, block.timestamp, "clock moved to now");
        _assertPerpsSolvent();
    }
}

/// @notice IA-07 grace-period rule with a Chainlink-sourced market and an L2 sequencer-uptime feed.
contract FinalAuditFuzzGrace is Test {
    uint256 internal constant USD = 1e6;
    MockERC20 internal usdg;
    MockERC20 internal tsla;
    VelumVault internal vault;
    OracleAdapter internal oracle;
    MakerBook internal book;
    PerpsMarkets internal perps;
    MockAggregator internal feed;
    MockAggregator internal seq;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        vault = new VelumVault();
        oracle = new OracleAdapter();
        SpotPools pools = new SpotPools(IVelumVault(address(vault)), address(usdg));
        book = new MakerBook(IVelumVault(address(vault)), address(usdg));
        perps = new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );
        address[] memory toks = new address[](2);
        toks[0] = address(usdg);
        toks[1] = address(tsla);
        address[] memory mods = new address[](3);
        mods[0] = address(pools);
        mods[1] = address(book);
        mods[2] = address(perps);
        address[] memory blocked = new address[](1);
        blocked[0] = address(oracle);
        vault.setup(toks, mods, blocked, address(0), new uint256[](0), new uint256[](0));
        feed = new MockAggregator(8);
        seq = new MockAggregator(0);
        seq.set(0, block.timestamp - 2 hours);
        feed.set(400e8, block.timestamp);
        address[] memory st = new address[](1);
        st[0] = address(tsla);
        address[] memory fs = new address[](1);
        fs[0] = address(feed);
        uint128[] memory mn = new uint128[](1);
        uint128[] memory mx = new uint128[](1);
        mn[0] = 1e18;
        mx[0] = 100_000e18;
        oracle.setup(st, fs, mn, mx, address(0), address(seq));
        pools.setup(st);
        book.setup(address(perps), st);
        uint256[] memory caps = new uint256[](1);
        caps[0] = 10_000e18;
        perps.setup(st, caps, address(0));
        oracle.poke(address(tsla));
        _fund(bob, 20_000 * USD);
        _fund(alice, 5000 * USD);
        _fund(keeper, 1000 * USD);
        vm.prank(keeper);
        perps.fundInsurance(1000 * USD);
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

    /// @notice During the grace hour: liquidate succeeds iff the loser's claim < MM/2; between MM/2 and MM it reverts
    ///         SequencerDown (and a close is a plain close); at or above MM it reverts NotLiquidatable.
    function testFuzz_FA_IA07_graceRuleExact(
        bool isLong,
        bool againstTaker,
        uint8 lev,
        uint16 closeBps,
        uint256[30] memory path
    ) public {
        // drift: three steps in four go against the taker (taker side liquidations) or for it (maker side)
        bool down = isLong == againstTaker;
        uint256 id = _openAndWalk(isLong, down, uint8(bound(lev, 2, 10)), uint16(bound(closeBps, 0, 500)), path);
        (int256 loser, int256 mm, int256 half) = _loserAndBounds(id);
        if (vm.envOr("FA_STATS", false)) {
            vm.writeLine("deployments/fa-ia07.txt", loser >= mm ? "healthy" : (loser >= half ? "protected" : "deep"));
        }
        uint256 s = vm.snapshotState();
        vm.prank(keeper);
        if (loser >= mm) {
            vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
            perps.liquidate(id);
        } else if (loser >= half) {
            assertFalse(perps.isLiquidatable(id));
            vm.expectRevert(PerpsBase.SequencerDown.selector);
            perps.liquidate(id);
        } else {
            assertTrue(perps.isLiquidatable(id));
            perps.liquidate(id);
            assertFalse(perps.getPosition(id).open);
        }
        vm.revertToState(s);
        // the taker's close takes the liquidation route exactly when liquidate would succeed
        if (!oracle.lagging(address(tsla))) assertEq(_closeLiquidates(id, isLong), loser < half, "close route");
    }

    function _openAndWalk(bool isLong, bool down, uint8 lev, uint16 closeBps, uint256[30] memory path)
        internal
        returns (uint256 id)
    {
        vm.prank(bob);
        uint256 offerId =
            book.postOffer(address(tsla), 20_000 * USD, 20_000 * USD, 2, closeBps, uint64(block.timestamp + 60 days));
        vm.prank(alice);
        id = perps.open(offerId, address(tsla), isLong, 1000 * USD, lev, isLong ? type(uint256).max : 1);
        seq.set(0, block.timestamp); // sequencer just came back: grace hour
        uint256 p = 400e8;
        for (uint256 i; i < path.length; ++i) {
            uint256 r = path[i];
            vm.warp(block.timestamp + 1 + (r % 110));
            uint256 mv = (p * ((r >> 8) % 301)) / 10_000; // up to 3% per step (the rate limit walks it)
            bool withDrift = (r >> 64) % 4 != 0;
            p = (withDrift != down) ? p + mv : p - mv;
            feed.set(int256(p), block.timestamp);
            oracle.poke(address(tsla));
        }
        (bool up, bool ready) = oracle.sequencerStatus();
        assertTrue(up && !ready, "still in grace");
        perps.advanceFunding(address(tsla));
    }

    function _loserAndBounds(uint256 id) internal view returns (int256 loser, int256 mm, int256 half) {
        uint256 px = oracle.price(address(tsla));
        PerpsBase.Position memory pos = perps.getPosition(id);
        int256 takerClaim = perps.takerClaimAt(id, px);
        int256 makerClaim = int256(pos.takerMargin + pos.makerMargin) - takerClaim;
        uint256 notional = (pos.qty * px + 1e30 - 1) / 1e30;
        mm = int256((notional * 1000 + 9999) / 10_000);
        half = int256((notional * 1000 + 19_999) / 20_000);
        loser = takerClaim <= makerClaim ? takerClaim : makerClaim;
    }

    function _closeLiquidates(uint256 id, bool isLong) internal returns (bool liquidated) {
        vm.recordLogs();
        vm.prank(alice);
        perps.close(id, isLong ? 1 : type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Liquidated(uint256,address,bool,uint256,uint256,uint256,uint256)");
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] == sig) liquidated = true;
        }
    }
}
