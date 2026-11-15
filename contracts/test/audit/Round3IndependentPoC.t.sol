// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumBase} from "../Base.t.sol";
import {PerpsRef} from "../PerpsMarkets.t.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {IVelumVault} from "../../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../../src/interfaces/IMakerBook.sol";
import {FixedMath} from "../../src/libraries/FixedMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Independent audit (round 3, 2026-11) proofs of concept, inverted into regressions. Each test keeps the
///         auditor's scenario and numbers and asserts the fixed behaviour (`*_fixed`). IA-05 and IA-08 are
///         documented behaviours (contracts/README.md), not code changes: their tests pin what is documented.
///
/// IA-01  A taker's forced exit now costs exactly a plain close (committed close spread + close fee); a maker's
///        forced exit keeps no-spread, no-fee economics (the maker gains nothing over a close).
/// IA-02  A dead-oracle exit accrues funding at the old rate up to the last valid time and nothing over the
///        dead period, so the reset rate is never applied retroactively.
/// IA-03  removeMargin needs the open freshness (10 s).
/// IA-04  FixedMath.sqrt is a true floor sqrt for every input.
/// IA-06  Out-of-bounds source prices are clamped to the bound and rate-limited (liquidations go on), keep the
///        feed alive, and a forced exit settles at the bound once the effective price has reached it.
/// IA-07  During the sequencer grace hour, positions below half the maintenance margin can be liquidated.
/// IA-10  open/close refuse a zero price limit.
contract Round3IndependentPoC is VelumBase, PerpsRef {
    struct Outcome {
        uint256 taker;
        uint256 maker;
        uint256 insurance;
    }

    function _balances() internal view returns (Outcome memory o) {
        o = Outcome(_bal(alice, usdg), _bal(bob, usdg), perps.insurance());
    }

    function _since(Outcome memory b) internal view returns (Outcome memory d) {
        d = Outcome(_bal(alice, usdg) - b.taker, _bal(bob, usdg) - b.maker, perps.insurance() - b.insurance);
    }

    function _market() internal view returns (int256 index, int256 rate, uint64 updatedAt) {
        (,,,, index, rate, updatedAt) = perps.markets(address(tsla));
    }

    /// @dev Warp 7 days, refresh the price and settle `id`'s forced exit from `settler`.
    function _settleAfterWeek(uint256 id, address settler) internal returns (Outcome memory d) {
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        Outcome memory b = _balances();
        vm.prank(settler);
        perps.settleForcedExit(id);
        d = _since(b);
    }

    // ------------------------------------------------------------------ IA-01

    /// @notice IA-01 (Medium). PoC: on 1,000 USDG (1x long, 5% close spread, unchanged price, 7 days) a plain close
    ///         returned 932.44 USDG and a forced exit requested at open 983.00 USDG (no spread, no fee). Now a
    ///         forced exit on the taker's request settles exactly like the plain close, whoever triggers it.
    function test_IA01_takerForcedExitCostsExactlyAPlainClose_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 500); // 5% close spread
        _fund(alice, usdg, 2000 * USD);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2); // 1x long, 1,000 USDG
        vm.deal(alice, 1 ether);

        uint256 snap = vm.snapshotState();
        // (a) plain close after 7 days at an unchanged price
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        Outcome memory b = _balances();
        vm.prank(alice);
        perps.close(id, 1);
        Outcome memory viaClose = _since(b);
        vm.revertToState(snap);

        // (b) the same position, forced exit requested at open, settled after 7 days by the taker ...
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        uint256 snap2 = vm.snapshotState();
        Outcome memory viaForced = _settleAfterWeek(id, alice);
        vm.revertToState(snap2);
        // (c) ... or by anyone else
        Outcome memory viaOther = _settleAfterWeek(id, carol);

        emit log_named_decimal_uint("taker out via close              ", viaClose.taker, 6);
        emit log_named_decimal_uint("taker out via forced exit (taker)", viaForced.taker, 6);
        emit log_named_decimal_uint("taker out via forced exit (other)", viaOther.taker, 6);
        emit log_named_decimal_uint("close fee to insurance           ", viaClose.insurance, 6);
        assertApproxEqAbs(viaClose.taker, 932.44e6, 0.01e6, "PoC number: plain close");
        assertEq(viaForced.taker, viaClose.taker, "taker pays the committed close spread and the fee");
        assertEq(viaForced.maker, viaClose.maker, "maker keeps its committed spread");
        assertEq(viaForced.insurance, viaClose.insurance, "close fee paid to insurance");
        assertEq(viaOther.taker, viaClose.taker, "same whoever settles");
        assertEq(viaOther.maker, viaClose.maker);
        assertEq(viaOther.insurance, viaClose.insurance);
        assertGt(viaClose.insurance, 0);
        vm.prank(alice);
        perps.claimBond();
        assertEq(alice.balance, 1 ether, "bond refunded: the escape hatch stays");
        _assertPerpsSolvent();
    }

    /// @notice IA-01 with a moving price (final audit: the regressions only used an unchanged price). The price walks
    ///         +6% during the week and is still moving when the exit is settled (pushes in the last two seconds, inside
    ///         the rate limit); the taker's forced exit settles exactly like the plain close the taker could send at
    ///         that moment: same exit (oracle - committed close spread), same fee, same funding, whoever settles.
    function test_IA01_takerForcedExitEqualsPlainCloseAtAMovingPrice_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 200); // 2% close spread
        _fund(alice, usdg, 2000 * USD);
        _fund(carol, usdg, 2000 * USD);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 4); // 2x long
        _open(carol, offerId, false, 500 * USD, 4); // some skew so funding is not zero
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 7 days);
        _movePriceTo(address(tsla), (TSLA_PRICE * 10_600) / 10_000);
        uint256 px = _effectivePrice(address(tsla));
        _pushPrice(address(tsla), (px * 10_001) / 10_000); // still moving: +0.01% in one second...
        _pushPrice(address(tsla), (px * 10_002) / 10_000); // ...and again, inside 1/6000 per second
        assertFalse(oracle.lagging(address(tsla)), "settled at a fresh, non-lagging, moving price");
        uint256 settlePx = _effectivePrice(address(tsla));
        assertGt(settlePx, (TSLA_PRICE * 10_600) / 10_000);

        uint256 snap = vm.snapshotState();
        Outcome memory b = _balances();
        vm.prank(alice);
        perps.close(id, 1);
        Outcome memory viaClose = _since(b);
        vm.revertToState(snap);

        PerpsBase.Position memory p = perps.getPosition(id);
        b = _balances();
        vm.prank(carol);
        perps.settleForcedExit(id);
        Outcome memory viaForced = _since(b);
        assertEq(viaForced.taker, viaClose.taker, "taker: exactly a plain close at the moving price");
        assertEq(viaForced.maker, viaClose.maker, "maker");
        assertEq(viaForced.insurance, viaClose.insurance, "close fee");
        uint256 exit = _refExit(settlePx, true, 200);
        assertEq(viaForced.insurance, _ceilDiv(p.qty * exit * 6, SCALE * 10_000), "fee on the spread-adjusted exit");
        assertGt(viaForced.taker, 1000 * USD / 2, "a winning long: margin plus the move, less spread and fee");
        _assertPerpsSolvent();
    }

    /// @notice IA-01, the other direction: a maker's forced exit keeps the no-spread, no-fee settlement. Against the
    ///         plain close (the only exit the taker controls) the maker gives up its close spread and the taker
    ///         pays nothing extra, so the maker cannot use it to escape anything it owes; the pool is the same.
    function test_IA01_makerForcedExitGainsMakerNothingOverAPlainClose_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 500);
        _fund(alice, usdg, 2000 * USD);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2);
        vm.deal(bob, 1 ether);

        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        Outcome memory b = _balances();
        vm.prank(alice);
        perps.close(id, 1);
        Outcome memory viaClose = _since(b);
        vm.revertToState(snap);

        vm.prank(bob);
        perps.requestForcedExit{value: 0.001 ether}(id);
        Outcome memory viaMaker = _settleAfterWeek(id, carol);
        emit log_named_decimal_uint("maker out via close      ", viaClose.maker, 6);
        emit log_named_decimal_uint("maker out via its request", viaMaker.maker, 6);
        assertLt(viaMaker.maker, viaClose.maker, "the maker forgoes its close spread");
        assertGt(viaMaker.taker, viaClose.taker, "the taker pays no spread and no fee");
        assertEq(viaMaker.insurance, 0, "no fee charged to a taker who did not ask to leave");
        assertEq(viaMaker.taker + viaMaker.maker, viaClose.taker + viaClose.maker + viaClose.insurance, "same pool");
    }

    /// @notice IA-01 at a dead oracle (entry price): the taker's request still pays the close spread and the fee,
    ///         as a plain close at the entry price would, capped at what its claim holds. Whatever funding has
    ///         eaten (up to 90 days of the capped rate at 5x), the settlement never reverts and the spread and
    ///         fee are never a gain for the taker.
    function testFuzz_IA01_takerForcedExitAtDeadOracleCappedNeverAGain_fixed(
        uint256 holdDays,
        uint16 closeBps,
        bool isLong
    ) public {
        holdDays = bound(holdDays, 0, 90);
        closeBps = uint16(bound(closeBps, 0, 500));
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, closeBps);
        _fund(alice, usdg, 2000 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offerId, isLong, 1000 * USD, 10); // 5x: 200 USDG margin
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        // held (one side only: the capped rate runs against it), then the relay goes quiet for 15 days
        vm.warp(block.timestamp + holdDays * 1 days);
        _pushPrice(address(tsla), TSLA_PRICE);
        perps.advanceFunding(address(tsla));
        vm.warp(block.timestamp + 15 days);
        assertTrue(oracle.isDead(address(tsla)));

        PerpsBase.Position memory p = perps.getPosition(id);
        (int256 idx,,) = _market();
        Outcome memory b = _balances();
        perps.settleForcedExit(id);
        Outcome memory d = _since(b);

        uint256 exit = _refExit(p.entry, isLong, closeBps);
        int256 funding = _refFunding(isLong, p.qty, idx - p.fundingIndexAtOpen);
        int256 gross = int256(p.takerMargin) + _refPnl(isLong, p.qty, p.entry, exit) - funding;
        uint256 fee = _ceilDiv(p.qty * exit * 6, SCALE * 10_000);
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 expTaker;
        uint256 expFee;
        if (gross > 0) {
            expFee = fee < uint256(gross) ? fee : uint256(gross);
            expTaker = uint256(gross) - expFee;
        }
        assertEq(d.taker, expTaker, "a plain close at the entry price");
        assertEq(d.insurance, expFee, "fee capped at the claim");
        assertEq(d.taker + d.maker + d.insurance, pool, "pool conserved");
        int256 noSpreadNoFee = int256(p.takerMargin) - funding; // what the entry price alone gives back
        assertLe(int256(d.taker), noSpreadNoFee > 0 ? noSpreadNoFee : int256(0), "spread and fee are never a gain");
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------------ IA-02

    /// @notice IA-02 (Low). PoC: balanced book, the short force-exits at a dead oracle, the rate resets to +0.01%/h
    ///         without accruing and the next accrual charged the remaining long 35.99 USDG for the 15 dead days.
    ///         Now the dead exit settles funding up to the last valid time and skips the dead period.
    function test_IA02_deadOracleExitChargesNoRetroactiveFunding_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 2000 * USD);
        _fund(carol, usdg, 2000 * USD);
        uint256 longId = _open(alice, offerId, true, 1000 * USD, 10); // 5x long
        uint256 shortId = _open(carol, offerId, false, 1000 * USD, 10); // 5x short
        (,, uint256 lOI, uint256 sOI,, int256 rate0,) = perps.markets(address(tsla));
        assertApproxEqRel(lOI, sOI, 0.001e18);
        assertLt(rate0 < 0 ? -rate0 : rate0, 1e11, "book (almost) balanced: rate ~0");

        vm.deal(carol, 1 ether);
        vm.prank(carol);
        perps.requestForcedExit{value: 0.001 ether}(shortId);

        // the relay goes quiet for 15 days: the TSLA oracle is dead
        vm.warp(block.timestamp + 15 days);
        assertTrue(oracle.isDead(address(tsla)));
        int256 claimBefore = perps.takerClaimAt(longId, TSLA_PRICE);
        (int256 idxBefore,,) = _market();
        perps.settleForcedExit(shortId); // at entry; rate reset to +0.01%/h (only longs left)
        (int256 idxAfter, int256 rate1, uint64 at1) = _market();
        assertEq(idxAfter, idxBefore, "nothing accrued over the dead period");
        assertEq(rate1, 1e14);
        assertEq(at1, block.timestamp, "the funding clock skips the dead period");

        // the relay comes back at the same price; the first accrual covers one second, not 15 days
        _pushPrice(address(tsla), TSLA_PRICE);
        perps.advanceFunding(address(tsla));
        int256 charged = claimBefore - perps.takerClaimAt(longId, TSLA_PRICE);
        emit log_named_decimal_int("funding charged to the long for the dead period", charged, 6);
        assertGe(charged, 0);
        assertLt(charged, int256(USD / 1000), "was 35.99 USDG; now one second of funding");
    }

    /// @notice IA-02: what the dead exit does accrue. With longs only (+0.01%/h) and prices still arriving for 5 days
    ///         after the last trade, funding runs at the old rate for those 5 days (at the last recorded price) and
    ///         stops at the last valid price: the 15 dead days are not charged.
    function test_IA02_deadExitAccruesOldRateOnlyToLastValidTime_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 2000 * USD);
        _fund(carol, usdg, 2000 * USD);
        _open(alice, offerId, true, 1000 * USD, 10);
        uint256 c = _open(carol, offerId, true, 1000 * USD, 10);
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        perps.requestForcedExit{value: 0.001 ether}(c);
        (int256 idx0, int256 rate, uint64 t0) = _market();
        assertEq(rate, 1e14, "longs only: capped rate");

        vm.warp(block.timestamp + 5 days);
        _pushPrice(address(tsla), TSLA_PRICE); // nobody trades, but the price is valid
        uint256 validAt = block.timestamp;
        vm.warp(block.timestamp + 15 days);
        assertTrue(oracle.isDead(address(tsla)));
        perps.settleForcedExit(c);
        (int256 idx1,, uint64 t1) = _market();
        int256 expected = (rate * int256(TSLA_PRICE * (validAt - t0))) / (3600 * 1e18);
        assertEq(idx1 - idx0, expected, "old rate up to the last valid time, at the last recorded price");
        assertEq(t1, block.timestamp);
        // 5 days of the capped rate is 1.2% of the price, not the 4.8% that 20 days would be
        assertApproxEqRel(uint256(idx1 - idx0), (TSLA_PRICE * 12) / 1000, 0.001e18);
    }

    // ------------------------------------------------------------------ IA-03

    /// @notice IA-03 (Low). PoC: with a 55 s old price an open was refused but removeMargin re-levered the taker
    ///         from 1x to ~5x. Now removeMargin needs the same 10 s freshness as an open.
    function test_IA03_removeMarginNeedsOpenFreshness_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 0);
        _fund(alice, usdg, 3000 * USD);
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2); // 1x: 1,000 USDG margin
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(block.timestamp + 55); // relay late: price 55 s old
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        perps.open(offerId, address(tsla), true, 1000 * USD, 2, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        perps.removeMargin(id, 795 * USD);
        assertEq(perps.getPosition(id).takerMargin, 1000 * USD, "still 1x");
        // with a fresh price the same removal is fine
        _pushPrice(address(tsla), TSLA_PRICE);
        vm.prank(alice);
        perps.removeMargin(id, 795 * USD);
        assertLt(perps.getPosition(id).takerMargin, 210 * USD);
    }

    // ------------------------------------------------------------------ IA-04

    /// @notice IA-04 (Info). PoC: FixedMath.sqrt(2) returned 2.
    function test_IA04_sqrtOfTwo_fixed() public pure {
        assertEq(FixedMath.sqrt(0), 0);
        assertEq(FixedMath.sqrt(1), 1);
        assertEq(FixedMath.sqrt(2), 1, "floor sqrt of 2");
        assertEq(FixedMath.sqrt(3), 1);
        assertEq(FixedMath.sqrt(4), 2);
        assertEq(FixedMath.sqrt(type(uint256).max), type(uint128).max);
    }

    /// @notice IA-04: a true floor sqrt for every input (the PoC's fuzz excluded 0..2).
    function testFuzz_IA04_sqrtIsFloor_fixed(uint256 x) public pure {
        uint256 r = FixedMath.sqrt(x);
        assertLe(r, type(uint128).max);
        assertLe(r * r, x);
        if (r < type(uint128).max) assertGt((r + 1) * (r + 1), x);
    }

    // ------------------------------------------------------------------ IA-05 (documented)

    /// @notice IA-05 (Info, documented in contracts/README.md "Maker offers"). An offer's `backing` bounds the maker
    ///         MARGIN (S / maxL per fill), not the notional: one offer with largestFill == backing can be filled
    ///         for 5x its backing in notional, all on one side.
    function test_IA05_offerBackingCapsMarginNotNotional_fixed() public {
        uint256 offerId = _postOffer(1000 * USD, 1000 * USD, 2, 0);
        _fund(alice, usdg, 10_000 * USD);
        uint256 notional;
        for (uint256 i; i < 5; ++i) {
            _open(alice, offerId, true, 1000 * USD, 10);
            notional += 1000 * USD;
        }
        (,, uint256 backing,,,,,) = book.offers(offerId);
        assertEq(backing, 0);
        assertEq(notional, 5000 * USD, "5,000 USDG of one-sided exposure on a 1,000 USDG offer");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.InsufficientBacking.selector, 0, 200 * USD));
        perps.open(offerId, address(tsla), true, 1000 * USD, 10, type(uint256).max);
    }

    // ------------------------------------------------------------------ IA-06 (relay path)

    /// @notice IA-06 on the relay path: a pushed price outside the bounds is accepted, clamped to the bound and
    ///         rate-limited (it used to revert, so the price went stale and, after 14 days, dead).
    function test_IA06_relayOutOfBoundsPushClampedNotRefused_fixed() public {
        _pushPrice(address(tsla), 0.5e18); // below the 1 USDG floor, two seconds after the last recording
        assertEq(oracle.price(address(tsla)), TSLA_PRICE - TSLA_PRICE / 3000, "rate-limited toward the floor");
        assertTrue(oracle.lagging(address(tsla)));
        assertFalse(oracle.atBound(address(tsla)));
        for (uint256 i; i < 200 && !oracle.atBound(address(tsla)); ++i) {
            _nextWindowPush(address(tsla), 0.5e18);
        }
        assertTrue(oracle.atBound(address(tsla)));
        assertEq(oracle.price(address(tsla)), 1e18, "stops at the floor");
        assertTrue(oracle.lagging(address(tsla)));
        vm.warp(block.timestamp + 14 days);
        _pushPrice(address(tsla), 0.5e18);
        assertFalse(oracle.isDead(address(tsla)), "fresh out-of-bounds answers keep the token alive");
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        vm.warp(block.timestamp + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceOutOfBounds.selector, address(tsla), 0));
        oracle.pushPrices(t, v); // zero is still malformed
    }

    // ------------------------------------------------------------------ IA-10

    /// @notice IA-10 (Info). `priceLimit = 0` used to disable slippage protection on open and close; now refused.
    function test_IA10_zeroPriceLimitRefused_fixed() public {
        uint256 offerId = _postOffer(10_000 * USD, 10_000 * USD, 2, 5);
        _fund(alice, usdg, 3000 * USD);
        vm.startPrank(alice);
        vm.expectRevert(PerpsBase.NoPriceLimit.selector);
        perps.open(offerId, address(tsla), true, 1000 * USD, 10, 0);
        vm.expectRevert(PerpsBase.NoPriceLimit.selector);
        perps.open(offerId, address(tsla), false, 1000 * USD, 10, 0);
        uint256 id = perps.open(offerId, address(tsla), false, 1000 * USD, 10, 1); // any non-zero limit
        vm.expectRevert(PerpsBase.NoPriceLimit.selector);
        perps.close(id, 0);
        perps.close(id, type(uint256).max);
        vm.stopPrank();
        assertFalse(perps.getPosition(id).open);
    }
}

/// @notice IA-08 (Low, documented in contracts/README.md "Token requirements"): the vault's internal ledger cannot
///         follow token-level balance changes. There is deliberately no sweep (it would be an admin power), so only
///         non-rebasing tokens may be listed. This pins the documented consequences.
contract Round3TokenMechanicsPoC is VelumBase {
    function test_IA08_rebaseAndAirdropToVaultStrandedOrShort_fixed() public {
        _fund(alice, tsla, 10e18);
        _fund(carol, tsla, 10e18);
        // a 2-for-1 split delivered as an airdrop/rebase to every holder, including the vault
        tsla.mint(address(vault), 20e18);
        assertEq(tsla.balanceOf(address(vault)), 40e18);
        assertEq(vault.totalInternal(address(tsla)), 20e18, "20 TSLA belong to nobody: stranded, no sweep");
        assertEq(_bal(alice, tsla), 10e18, "internal balances do not follow the rebase");

        // a negative rebase / issuer wipe of the vault's balance leaves the last withdrawer short
        deal(address(tsla), address(vault), 15e18);
        vm.prank(alice);
        vault.withdraw(address(tsla), 10e18, alice);
        vm.prank(carol);
        vm.expectRevert(); // ERC20 balance too low
        vault.withdraw(address(tsla), 10e18, carol);
    }
}

/// @notice IA-06 and IA-07 need a Chainlink-sourced oracle with an L2 sequencer-uptime feed (production wiring).
contract Round3ChainlinkPoC is Test {
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
        seq.set(0, block.timestamp - 2 hours); // sequencer up for 2 h
        feed.set(400e8, block.timestamp);
        address[] memory st = new address[](1);
        st[0] = address(tsla);
        address[] memory fs = new address[](1);
        fs[0] = address(feed);
        uint128[] memory mn = new uint128[](1);
        uint128[] memory mx = new uint128[](1);
        mn[0] = 100e18; // bounds a deployer might pick for a ~400 USD stock
        mx[0] = 2000e18;
        oracle.setup(st, fs, mn, mx, address(0), address(seq));
        pools.setup(st);
        book.setup(address(perps), st);
        uint256[] memory caps = new uint256[](1);
        caps[0] = 10_000e18;
        perps.setup(st, caps, address(0));
        oracle.poke(address(tsla));
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

    /// @dev Feed answer `p` (8 dp) published now, after `dt` seconds.
    function _feed(uint256 dt, int256 p) internal {
        vm.warp(block.timestamp + dt);
        feed.set(p, block.timestamp);
    }

    function _openLong(uint8 levHalf) internal returns (uint256 id) {
        _fund(bob, 10_000 * USD);
        vm.prank(bob);
        uint256 offerId =
            book.postOffer(address(tsla), 10_000 * USD, 10_000 * USD, 2, 0, uint64(block.timestamp + 60 days));
        _fund(alice, 2000 * USD);
        _fund(keeper, 1000 * USD);
        vm.prank(keeper);
        perps.fundInsurance(1000 * USD);
        vm.prank(alice);
        id = perps.open(offerId, address(tsla), true, 1000 * USD, levHalf, type(uint256).max); // long at ~400
    }

    function _claimAndBounds(uint256 id)
        internal
        view
        returns (int256 claim, int256 maintenance, int256 halfMaintenance)
    {
        uint256 px = oracle.price(address(tsla));
        claim = perps.takerClaimAt(id, px);
        uint256 notional = (perps.getPosition(id).qty * px + 1e30 - 1) / 1e30;
        maintenance = int256((notional * 1000 + 9999) / 10_000);
        halfMaintenance = int256((notional * 1000 + 19_999) / 20_000);
    }

    // ------------------------------------------------------------------ IA-06

    /// @notice IA-06 (Low). PoC: a gap below the 100 USDG floor reverted every read (liquidations frozen); the feed
    ///         kept publishing fresh out-of-bounds prices, the token counted as dead after 14 days and the forced
    ///         exit settled the deeply insolvent 5x long at its ENTRY price (it got > 190 USDG back). Now the
    ///         price is clamped and rate-limited: the feed stays alive, the forced exit is refused at the lagging
    ///         price, and keepers liquidate the position while it is still solvent.
    function test_IA06_outOfBoundsCrashLiquidatedNotRefundedAtEntry_fixed() public {
        uint256 id = _openLong(10);
        uint256 aliceStart = vault.balanceOf(alice, address(usdg));
        // weekend gap: the feed reopens 75% lower, below the 100 USD floor
        _feed(2 days, 99e8);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id)); // readable: -5% so far
        perps.liquidate(id);
        assertTrue(oracle.lagging(address(tsla)));
        // the losing taker asks for a forced exit; the feed keeps publishing (fresh) out-of-bounds prices
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        for (uint256 d; d < 15; ++d) {
            _feed(1 days, 95e8);
        }
        assertFalse(oracle.isDead(address(tsla)), "fresh out-of-bounds answers keep the feed alive");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.settleForcedExit(id); // no exit at a known-wrong price, and no entry-price refund

        // keepers record the clamped price as it walks down (5% per recording) and liquidate on the way
        while (!perps.isLiquidatable(id)) {
            _feed(5 minutes, 95e8);
            assertTrue(oracle.poke(address(tsla)));
        }
        perps.advanceFunding(address(tsla));
        (int256 claim,,) = _claimAndBounds(id);
        uint256 px = oracle.price(address(tsla));
        assertGt(px, 100e18, "liquidated before the effective price reached the floor");
        assertGt(claim, 0, "still solvent");
        vm.prank(keeper);
        perps.settleForcedExit(id); // a liquidatable position settles as a liquidation (F-08)
        uint256 aliceBack = vault.balanceOf(alice, address(usdg)) - aliceStart;
        emit log_named_decimal_uint("loser (5x long, source price -76%) gets back", aliceBack, 6);
        uint256 penalty = (((perps.getPosition(id).qty * px + 1e30 - 1) / 1e30) * 100 + 9999) / 10_000;
        assertEq(aliceBack, uint256(claim) - penalty, "claim minus the penalty at the effective price");
        assertLt(aliceBack, 100 * USD, "was > 190 USDG (entry-price refund)");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), bob), 0, "no shortfall");
    }

    /// @notice IA-01 at the bound (final audit): a forced exit the TAKER requested also settles at the bound once the
    ///         source stays outside it (IA-06), and it still costs what a plain close at that price would (the committed
    ///         close spread and the 0.06% fee on the exit). A plain close itself is refused there (lagging price).
    function test_IA01_takerForcedExitAtTheBoundPaysSpreadAndFee_fixed() public {
        _fund(bob, 10_000 * USD);
        vm.prank(bob);
        uint256 offerId =
            book.postOffer(address(tsla), 10_000 * USD, 10_000 * USD, 2, 100, uint64(block.timestamp + 60 days)); // 1%
        _fund(alice, 2000 * USD);
        vm.prank(alice);
        uint256 id = perps.open(offerId, address(tsla), true, 1000 * USD, 2, type(uint256).max); // 1x long
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id); // the taker's request
        _feed(7 days, 50e8); // half the 100 USDG floor
        for (uint256 i; i < 60 && !oracle.atBound(address(tsla)); ++i) {
            _feed(5 minutes, 50e8);
            assertTrue(oracle.poke(address(tsla)));
        }
        assertTrue(oracle.atBound(address(tsla)));
        assertEq(oracle.price(address(tsla)), 100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.close(id, 1);

        perps.advanceFunding(address(tsla));
        PerpsBase.Position memory p = perps.getPosition(id);
        uint256 exit = (100e18 * (10_000 - 100)) / 10_000; // the bound less the 1% committed close spread
        int256 gross = perps.takerClaimAt(id, exit); // margin + pnl at the exit - funding
        uint256 fee = (p.qty * exit * 6 + 1e30 * 10_000 - 1) / (1e30 * 10_000);
        uint256 before = vault.balanceOf(alice, address(usdg));
        uint256 insBefore = perps.insurance();
        vm.expectEmit(address(perps));
        emit PerpsBase.ForcedExitSettled(id, 100e18, false);
        perps.settleForcedExit(id);
        assertGt(gross, int256(fee));
        assertEq(vault.balanceOf(alice, address(usdg)) - before, uint256(gross) - fee, "spread and fee, at the bound");
        assertEq(perps.insurance() - insBefore, fee, "close fee to insurance");
        assertFalse(perps.getPosition(id).open);
    }

    /// @notice IA-06, settling at the bound: a 1x long cannot be liquidated at the floor, and a source that stays
    ///         below the floor keeps the price lagging for good. The forced exit is refused until the effective
    ///         price has reached the floor, then settles there (the market is never stuck and never dead).
    function test_IA06_forcedExitSettlesAtTheBound_fixed() public {
        uint256 id = _openLong(2); // 1x
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        perps.requestForcedExit{value: 0.001 ether}(id); // maker's request: no spread, no fee
        _feed(7 days, 50e8); // half the floor
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLagging.selector, address(tsla)));
        perps.settleForcedExit(id);
        for (uint256 i; i < 60 && !oracle.atBound(address(tsla)); ++i) {
            _feed(5 minutes, 50e8);
            assertTrue(oracle.poke(address(tsla)));
        }
        assertTrue(oracle.atBound(address(tsla)));
        assertEq(oracle.price(address(tsla)), 100e18);
        assertFalse(perps.isLiquidatable(id));
        perps.advanceFunding(address(tsla));
        int256 claim = perps.takerClaimAt(id, 100e18);
        uint256 before = vault.balanceOf(alice, address(usdg));
        vm.expectEmit(address(perps));
        emit PerpsBase.ForcedExitSettled(id, 100e18, false);
        perps.settleForcedExit(id);
        assertEq(vault.balanceOf(alice, address(usdg)) - before, uint256(claim), "settled at the floor");
        assertFalse(perps.getPosition(id).open);
    }

    // ------------------------------------------------------------------ IA-07

    /// @notice IA-07 (Low, design). PoC: during the 1-hour grace period after the sequencer came back, every
    ///         liquidation reverted while the price walked down 1% per minute, and the 5x long ended the hour
    ///         insolvent (shortfall claim for the maker). Now a position below half the maintenance margin
    ///         (MM / 2 = 5% of notional at 5x) can be liquidated during grace; between MM / 2 and MM it stays
    ///         protected. Here the long is liquidated solvent, inside the grace hour.
    function test_IA07_graceLiquidatesBelowHalfMaintenance_fixed() public {
        uint256 id = _openLong(10);
        seq.set(0, block.timestamp); // the sequencer was down; it is back up now (grace hour starts)
        uint256 graceStart = block.timestamp;
        uint256 p = 400e8;
        bool sawProtected;
        bool liquidated;
        for (uint256 m; m < 30 && !liquidated; ++m) {
            p = (p * 99) / 100;
            _feed(60, int256(p));
            perps.advanceFunding(address(tsla)); // records the price (like a poke) and accrues
            (int256 claim, int256 mm, int256 half) = _claimAndBounds(id);
            if (claim >= mm) continue;
            if (claim >= half) {
                sawProtected = true;
                assertFalse(perps.isLiquidatable(id), "between MM/2 and MM: protected during grace");
                vm.prank(keeper);
                vm.expectRevert(PerpsBase.SequencerDown.selector);
                perps.liquidate(id);
            } else {
                assertGt(claim, 0, "still solvent");
                assertTrue(perps.isLiquidatable(id));
                emit log_named_uint("liquidated, minutes into the grace hour", (block.timestamp - graceStart) / 60);
                emit log_named_decimal_int("taker claim at liquidation", claim, 6);
                vm.prank(keeper);
                perps.liquidate(id);
                liquidated = true;
            }
        }
        assertTrue(sawProtected, "there was a protected window");
        assertTrue(liquidated, "liquidated during grace");
        assertLt(block.timestamp - graceStart, oracle.SEQUENCER_GRACE(), "inside the grace hour");
        assertFalse(oracle.sequencerReady());
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), bob), 0, "no shortfall claim for the maker");
    }

    /// @notice IA-07: while the sequencer is actually down nothing is liquidated, however deep (unchanged F-05).
    function test_IA07_sequencerDownStillBlocksDeepLiquidation_fixed() public {
        uint256 id = _openLong(10);
        uint256 p = 400e8;
        for (uint256 i; i < 4; ++i) {
            p = (p * 95) / 100;
            _feed(5 minutes, int256(p));
            assertTrue(oracle.poke(address(tsla)));
        }
        perps.advanceFunding(address(tsla));
        (int256 claim,, int256 half) = _claimAndBounds(id);
        assertLt(claim, half, "below MM/2");
        seq.set(1, block.timestamp); // down
        assertFalse(perps.isLiquidatable(id));
        vm.prank(keeper);
        vm.expectRevert(PerpsBase.SequencerDown.selector);
        perps.liquidate(id);
        seq.set(0, block.timestamp); // back up: grace, and the position is deep
        assertTrue(perps.isLiquidatable(id));
        vm.prank(keeper);
        perps.liquidate(id);
        assertFalse(perps.getPosition(id).open);
    }
}
