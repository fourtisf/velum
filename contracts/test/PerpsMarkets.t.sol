// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {PerpsMarkets} from "../src/PerpsMarkets.sol";
import {PerpsBase} from "../src/perps/PerpsBase.sol";
import {MakerBook} from "../src/MakerBook.sol";
import {IVelumVault} from "../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../src/interfaces/IMakerBook.sol";

/// @notice Accepts ETH only while `accept` is true (bond-refund failure path).
contract Rejecter {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    receive() external payable {
        require(accept, "no ETH");
    }
}

/// @notice Independent re-implementation of the spec formulas, used to check the contract to the wei.
abstract contract PerpsRef {
    uint256 internal constant SCALE = 1e30; // qty(1e18) * price(1e18) / 1e30 = USDG (6 decimals)

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _floorDivS(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a < 0) q -= 1;
    }

    function _ceilDivS(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && a > 0) q += 1;
    }

    function _refEntry(uint256 p, bool isLong, uint256 openBps) internal pure returns (uint256) {
        return isLong ? _ceilDiv(p * (10_000 + openBps), 10_000) : p * (10_000 - openBps) / 10_000;
    }

    function _refExit(uint256 p, bool isLong, uint256 closeBps) internal pure returns (uint256) {
        return isLong ? p * (10_000 - closeBps) / 10_000 : _ceilDiv(p * (10_000 + closeBps), 10_000);
    }

    function _refPnl(bool isLong, uint256 qty, uint256 entry, uint256 price) internal pure returns (int256) {
        int256 diff = int256(price) - int256(entry);
        if (!isLong) diff = -diff;
        return _floorDivS(diff * int256(qty), int256(SCALE));
    }

    function _refFunding(bool isLong, uint256 qty, int256 dIdx) internal pure returns (int256) {
        if (!isLong) dIdx = -dIdx;
        return _ceilDivS(dIdx * int256(qty), int256(SCALE));
    }
}

contract PerpsMarketsTest is VelumBase, PerpsRef {
    uint256 internal offerId;

    function setUp() public virtual override {
        super.setUp();
        _fund(alice, usdg, 100_000 * USD);
        _fund(carol, usdg, 100_000 * USD);
        offerId = _postOffer(50_000 * USD, 50_000 * USD, 5, 5);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function _pos(uint256 id) internal view returns (PerpsBase.Position memory) {
        return perps.getPosition(id);
    }

    function _fundingIndex() internal view returns (int256 idx) {
        (,,,, idx,,) = perps.markets(address(tsla));
    }

    function _fundingRate() internal view returns (int256 rate) {
        (,,,,, rate,) = perps.markets(address(tsla));
    }

    function _offerBacking(uint256 id) internal view returns (uint256 b) {
        (,, b,,,,,) = book.offers(id);
    }

    // ------------------------------------------------------------ setup

    function test_setup_guards() public {
        PerpsMarkets p = new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );
        address[] memory m = new address[](1);
        uint256[] memory c = new uint256[](1);
        m[0] = address(tsla);
        c[0] = 1;
        vm.prank(alice);
        vm.expectRevert(PerpsBase.NotDeployer.selector);
        p.setup(m, c, address(0));
        vm.expectRevert(PerpsBase.LengthMismatch.selector);
        p.setup(m, new uint256[](2), address(0));
        m[0] = address(0);
        vm.expectRevert(PerpsBase.ZeroAddress.selector);
        p.setup(m, c, address(0));
        m[0] = address(tsla);
        p.setup(m, c, address(0));
        assertEq(p.marketCount(), 1);
        assertEq(p.valueScale(), 1e30);
        assertEq(p.minPositionSize(), 10 * USD);
        assertEq(p.keeperRewardCap(), 1 * USD);
        assertEq(p.guardian(), address(0));
        vm.expectRevert(PerpsBase.AlreadySetUp.selector);
        p.setup(m, c, address(0));
        vm.expectRevert(PerpsBase.ZeroAddress.selector);
        new PerpsMarkets(
            IVelumVault(address(0)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );
        vm.expectRevert(PerpsBase.ZeroAddress.selector);
        new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(0), 6
        );
    }

    function test_parameters_matchSpec() public view {
        assertEq(perps.MAX_LEVERAGE(), 5);
        assertEq(perps.IM_BPS(), 2000); // 1 / maxL
        assertEq(perps.MM_BPS(), 1000); // 0.5 / maxL
        assertEq(perps.TAKER_FEE_BPS(), 6);
        assertEq(perps.LIQUIDATION_PENALTY_BPS(), 100);
        assertEq(perps.MAX_POSITION_QTY(), 100e18);
        assertEq(perps.MAX_FUNDING_RATE_PER_HOUR(), 1e14); // 0.01% / h
        assertEq(perps.FORCED_EXIT_DELAY(), 7 days);
        assertEq(perps.FORCED_EXIT_BOND(), 0.001 ether);
        assertEq(pools.FEE_BPS(), 30);
        assertEq(oracle.MAX_AGE(), 60);
        assertEq(oracle.DEAD_AFTER(), 14 days);
        // audit hardening (docs/audit/2026-11-internal.md)
        assertEq(perps.OPEN_MAX_AGE(), 10);
        assertEq(perps.MAX_PRICE_AGE(), 60);
        assertEq(perps.COVER_EPOCH(), 1 hours);
        assertEq(perps.COVER_CAP_BPS(), 1000);
        assertEq(perps.minPositionSize(), 10 * USD);
        assertEq(perps.keeperRewardCap(), 1 * USD);
        assertEq(book.MIN_OPEN_SPREAD_BPS(), 2);
        assertEq(oracle.MAX_MOVE_BPS(), 500);
        assertEq(oracle.MOVE_WINDOW(), 5 minutes);
        assertEq(oracle.SEQUENCER_GRACE(), 1 hours);
    }

    // ------------------------------------------------------------ open

    function test_open_exactValues() public {
        uint256 size = 500 * USD;
        uint256 aliceBefore = _bal(alice, usdg);
        uint256 id = _open(alice, offerId, true, size, 4); // 2x long

        PerpsBase.Position memory p = _pos(id);
        uint256 entry = _refEntry(TSLA_PRICE, true, 5);
        assertEq(p.entry, entry);
        assertEq(p.qty, size * SCALE / entry);
        assertEq(p.takerMargin, 250 * USD);
        assertEq(p.makerMargin, 100 * USD); // size / maxL
        assertEq(p.taker, alice);
        assertEq(p.maker, bob);
        assertEq(p.closeSpreadBps, 5);
        assertTrue(p.open && p.isLong);
        uint256 fee = _ceilDiv(size * 6, 10_000);
        assertEq(fee, 300_000); // 0.30 USDG, as in the prototype ticket
        assertEq(aliceBefore - _bal(alice, usdg), 250 * USD + fee);
        assertEq(perps.insurance(), fee);
        assertEq(_offerBacking(offerId), 50_000 * USD - 100 * USD);
        (,, uint256 longOI, uint256 shortOI,,,) = perps.markets(address(tsla));
        assertEq(longOI, p.qty);
        assertEq(shortOI, 0);
        assertEq(_fundingRate(), 1e14); // all longs: capped rate
        _assertPerpsSolvent();
    }

    function test_open_shortEntryRoundsDown() public {
        uint256 id = _open(alice, offerId, false, 1000 * USD, 10); // 5x short
        PerpsBase.Position memory p = _pos(id);
        assertEq(p.entry, _refEntry(TSLA_PRICE, false, 5));
        assertEq(p.takerMargin, 200 * USD);
        assertEq(_fundingRate(), -1e14);
    }

    function test_open_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.UnknownMarket.selector, address(usdg)));
        perps.open(offerId, address(usdg), true, 1, 4, 0);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PositionTooSmall.selector, 0, 10 * USD));
        perps.open(offerId, address(tsla), true, 0, 4, 0);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PositionTooSmall.selector, 10 * USD - 1, 10 * USD));
        perps.open(offerId, address(tsla), true, 10 * USD - 1, 4, 0);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.BadLeverage.selector, 1));
        perps.open(offerId, address(tsla), true, 100 * USD, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.BadLeverage.selector, 11));
        perps.open(offerId, address(tsla), true, 100 * USD, 11, 0);
        uint256 entry = _refEntry(TSLA_PRICE, true, 5);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLimit.selector, entry, entry - 1));
        perps.open(offerId, address(tsla), true, 100 * USD, 4, entry - 1);
        // 50,000 USDG at ~392 is ~127 tokens > 100-token limit
        uint256 qty = uint256(50_000 * USD) * SCALE / entry;
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.BadQuantity.selector, qty));
        perps.open(offerId, address(tsla), true, 50_000 * USD, 10, 0);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(PerpsBase.SelfTrade.selector);
        perps.open(offerId, address(tsla), true, 100 * USD, 4, 0);

        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        vm.expectRevert(); // OracleAdapter.StalePrice
        perps.open(offerId, address(tsla), true, 100 * USD, 4, 0);
    }

    function test_open_respectsOfferLimits() public {
        uint256 small = _postOffer(1000 * USD, 600 * USD, 2, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.FillTooLarge.selector, 700 * USD, 600 * USD));
        perps.open(small, address(tsla), true, 700 * USD, 4, 0);
        vm.prank(bob);
        book.withdrawOffer(small);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.OfferInactive.selector, small));
        perps.open(small, address(tsla), true, 100 * USD, 4, 0);
    }

    // ------------------------------------------------------------ close

    /// @dev Reference split of a closing position: (taker out, fee paid, pool).
    function _refClose(PerpsBase.Position memory p, uint256 price, int256 idxNow)
        internal
        pure
        returns (uint256 expTaker, uint256 feePaid, uint256 pool)
    {
        uint256 exit = _refExit(price, p.isLong, p.closeSpreadBps);
        int256 gross = int256(p.takerMargin) + _refPnl(p.isLong, p.qty, p.entry, exit)
            - _refFunding(p.isLong, p.qty, idxNow - p.fundingIndexAtOpen);
        uint256 fee = _ceilDiv(p.qty * exit * 6, SCALE * 10_000);
        pool = p.takerMargin + p.makerMargin;
        if (gross > 0) {
            feePaid = fee < uint256(gross) ? fee : uint256(gross);
            expTaker = uint256(gross) - feePaid;
            if (expTaker > pool - feePaid) expTaker = pool - feePaid;
        }
    }

    function _checkClose(uint256 id, uint256 price) internal {
        PerpsBase.Position memory p = _pos(id);
        uint256 aliceBefore = _bal(alice, usdg);
        uint256 bobBefore = _bal(bob, usdg);
        uint256 insBefore = perps.insurance();
        vm.prank(alice);
        uint256 takerOut = perps.close(id, 0);
        (uint256 expTaker, uint256 feePaid, uint256 pool) = _refClose(p, price, _fundingIndex());
        assertEq(takerOut, expTaker, "taker out");
        assertEq(_bal(alice, usdg) - aliceBefore, expTaker);
        assertEq(_bal(bob, usdg) - bobBefore, pool - feePaid - expTaker, "maker out");
        assertEq(perps.insurance() - insBefore, feePaid);
        assertFalse(_pos(id).open);
        _assertPerpsSolvent();
    }

    function test_close_longProfit() public {
        uint256 id = _open(alice, offerId, true, 500 * USD, 4);
        _movePriceTo(address(tsla), 411.23e18); // +5% (one rate-limit window)
        _checkClose(id, 411.23e18);
    }

    function test_close_longLoss() public {
        uint256 id = _open(alice, offerId, true, 2000 * USD, 2);
        _movePriceTo(address(tsla), 380e18);
        _checkClose(id, 380e18);
    }

    function test_close_shortProfitAndLoss() public {
        uint256 id = _open(alice, offerId, false, 1000 * USD, 6);
        _movePriceTo(address(tsla), 370e18);
        _checkClose(id, 370e18);
        uint256 id2 = _open(alice, offerId, false, 1000 * USD, 6);
        _movePriceTo(address(tsla), 395e18);
        _checkClose(id2, 395e18);
    }

    /// @notice 1x long, maker posts 20%: a +33% move owes the taker more than the pool holds. Closing
    ///         settles as a liquidation of the insolvent maker (audit F-12): the taker gets the whole pool
    ///         now and the rest becomes a deferred cover claim instead of being forfeited.
    function test_close_againstInsolventMakerLiquidatesAndFilesClaim() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2);
        _movePriceTo(address(tsla), 520e18); // walks through the band; nobody liquidates on the way
        perps.advanceFunding(address(tsla));
        PerpsBase.Position memory p = _pos(id);
        uint256 pool = p.takerMargin + p.makerMargin;
        int256 claim = int256(p.takerMargin) + _refPnl(true, p.qty, p.entry, 520e18)
            - _refFunding(true, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        assertGt(claim, int256(pool));
        uint256 ins = perps.insurance();
        uint256 bobBefore = _bal(bob, usdg);
        uint256 aliceBefore = _bal(alice, usdg);
        vm.prank(alice);
        uint256 out = perps.close(id, 0);
        assertEq(out, pool, "whole pool to the taker");
        assertEq(_bal(bob, usdg), bobBefore, "insolvent maker gets nothing");
        // keeper top-up: min(half the 1% penalty, 1 USDG, the epoch's cap of 10% of the fund)
        assertEq(_bal(alice, usdg) - aliceBefore, pool + ins / 10);
        assertEq(perps.insurance(), ins - ins / 10, "the cap is used up by the top-up");
        assertEq(perps.coverClaims(perps.currentCoverEpoch(), alice), uint256(claim) - pool, "shortfall claimed");
        assertFalse(_pos(id).open);
        _assertPerpsSolvent();
    }

    function test_close_guards() public {
        uint256 id = _open(alice, offerId, true, 500 * USD, 4);
        vm.prank(carol);
        vm.expectRevert(PerpsBase.NotTaker.selector);
        perps.close(id, 0);
        uint256 exit = _refExit(TSLA_PRICE, true, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLimit.selector, exit, exit + 1));
        perps.close(id, exit + 1);
        vm.prank(alice);
        perps.close(id, exit);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotOpen.selector, id));
        perps.close(id, 0);
    }

    function test_close_shortPriceLimit() public {
        uint256 id = _open(alice, offerId, false, 500 * USD, 4);
        uint256 exit = _refExit(TSLA_PRICE, false, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.PriceLimit.selector, exit, exit - 1));
        perps.close(id, exit - 1);
    }

    // ------------------------------------------------------------ funding

    function test_funding_accruesAtCappedRate() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 4);
        int256 idx0 = _fundingIndex();
        vm.warp(block.timestamp + 1 hours - 1);
        _pushPrice(address(tsla), TSLA_PRICE); // +1s, exactly one hour later
        perps.advanceFunding(address(tsla));
        int256 expected = idx0 + int256(TSLA_PRICE) * 1e14 * 3600 / (3600 * 1e18);
        assertEq(_fundingIndex(), expected);
        // the long taker owes about 0.01% of notional for the hour
        int256 owed = _refFunding(true, _pos(id).qty, _fundingIndex() - idx0);
        assertApproxEqAbs(owed, 100_000, 100); // 0.10 USDG on 1,000 USDG
        _checkClose(id, TSLA_PRICE);
    }

    function test_funding_skewRate() public {
        _open(alice, offerId, true, 2000 * USD, 4);
        _open(carol, offerId, false, 1000 * USD, 4);
        (,, uint256 longOI, uint256 shortOI,,,) = perps.markets(address(tsla));
        int256 expected = (1e14 * (int256(longOI) - int256(shortOI))) / int256(longOI + shortOI);
        assertEq(_fundingRate(), expected);
        assertGt(expected, 0);
        assertLt(expected, 1e14);
    }

    function test_funding_shortReceives() public {
        uint256 id = _open(carol, offerId, false, 1000 * USD, 4); // only shorts: rate negative, shorts pay
        vm.warp(block.timestamp + 2 hours);
        _pushPrice(address(tsla), TSLA_PRICE);
        perps.advanceFunding(address(tsla));
        int256 owed = _refFunding(false, _pos(id).qty, _fundingIndex() - _pos(id).fundingIndexAtOpen);
        assertGt(owed, 0); // short pays when shorts dominate
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.UnknownMarket.selector, address(usdg)));
        perps.advanceFunding(address(usdg));
    }

    // ------------------------------------------------------------ margin

    function test_addMargin() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 4);
        _fund(bob, usdg, 30 * USD); // bob's free balance is all in the offer
        vm.prank(alice);
        perps.addMargin(id, 50 * USD);
        vm.prank(bob);
        perps.addMargin(id, 30 * USD);
        assertEq(_pos(id).takerMargin, 550 * USD);
        assertEq(_pos(id).makerMargin, 230 * USD);
        vm.prank(carol);
        vm.expectRevert(PerpsBase.NotParty.selector);
        perps.addMargin(id, 1);
        vm.prank(alice);
        vm.expectRevert(PerpsBase.ZeroAmount.selector);
        perps.addMargin(id, 0);
        _assertPerpsSolvent();
    }

    function test_removeMargin() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 2); // 1x: 1,000 margin, IM is ~200
        vm.prank(bob);
        vm.expectRevert(PerpsBase.NotTaker.selector);
        perps.removeMargin(id, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.ExceedsMargin.selector, 1001 * USD, 1000 * USD));
        perps.removeMargin(id, 1001 * USD);
        vm.prank(alice);
        vm.expectRevert(PerpsBase.ZeroAmount.selector);
        perps.removeMargin(id, 0);
        vm.prank(alice);
        vm.expectRevert(); // BelowInitialMargin
        perps.removeMargin(id, 900 * USD);
        uint256 before = _bal(alice, usdg);
        vm.prank(alice);
        perps.removeMargin(id, 700 * USD);
        assertEq(_bal(alice, usdg) - before, 700 * USD);
        assertEq(_pos(id).takerMargin, 300 * USD);
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidate_takerBelowMaintenance() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 10); // 5x: 200 margin each side
        assertFalse(perps.isLiquidatable(id));
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotLiquidatable.selector, id));
        perps.liquidate(id);

        _movePriceTo(address(tsla), 356e18); // -9.1%: claim ~108.5 still above 10% of ~908.5 notional
        assertFalse(perps.isLiquidatable(id));
        _movePriceTo(address(tsla), 345e18); // claim ~80 < ~88 maintenance
        perps.advanceFunding(address(tsla)); // so the expected claim below uses the same index
        assertTrue(perps.isLiquidatable(id));
        PerpsBase.Position memory p = _pos(id);
        uint256 insBefore = perps.insurance();
        uint256 bobBefore = _bal(bob, usdg);
        vm.prank(liquidator);
        uint256 reward = perps.liquidate(id);

        int256 claim = int256(p.takerMargin) + _refPnl(true, p.qty, p.entry, 345e18)
            - _refFunding(true, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        uint256 notional = _ceilDiv(p.qty * 345e18, SCALE);
        uint256 penalty = _ceilDiv(notional * 100, 10_000);
        assertGt(claim, int256(penalty));
        assertEq(reward, penalty / 2);
        assertEq(_bal(liquidator, usdg), penalty / 2);
        assertEq(_bal(alice, usdg), 100_000 * USD - 200 * USD - 600_000 + uint256(claim) - penalty);
        assertEq(perps.insurance() - insBefore, penalty - penalty / 2);
        uint256 pool = p.takerMargin + p.makerMargin;
        assertEq(_bal(bob, usdg) - bobBefore, pool - uint256(claim));
        _assertPerpsSolvent();
    }

    function test_liquidate_makerBelowMaintenance() public {
        uint256 id = _open(alice, offerId, false, 1000 * USD, 2); // short 1x; maker (long) has 200
        _movePriceTo(address(tsla), 340e18); // maker loses ~131 > 200 - 10% of notional
        perps.advanceFunding(address(tsla));
        PerpsBase.Position memory p = _pos(id);
        uint256 aliceBefore = _bal(alice, usdg);
        vm.prank(liquidator);
        perps.liquidate(id);
        int256 takerClaim = int256(p.takerMargin) + _refPnl(false, p.qty, p.entry, 340e18)
            - _refFunding(false, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 makerClaim = pool - uint256(takerClaim);
        uint256 penalty = _ceilDiv(_ceilDiv(p.qty * 340e18, SCALE) * 100, 10_000);
        assertEq(_bal(alice, usdg) - aliceBefore, uint256(takerClaim)); // winner gets its full claim
        assertEq(_bal(liquidator, usdg), penalty / 2);
        assertEq(_bal(bob, usdg), 50_000 * USD - 50_000 * USD + makerClaim - penalty); // bob's free balance
        _assertPerpsSolvent();
    }

    /// @dev 5x long walked to `target` with nobody liquidating on the way; returns the (negative) claim.
    function _insolventLong(uint256 target) internal returns (uint256 id, int256 claim) {
        id = _open(alice, offerId, true, 1000 * USD, 10); // 200 margin
        _movePriceTo(address(tsla), target);
        perps.advanceFunding(address(tsla));
        PerpsBase.Position memory p = _pos(id);
        claim = int256(p.takerMargin) + _refPnl(true, p.qty, p.entry, target)
            - _refFunding(true, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        assertLt(claim, 0);
    }

    /// @notice A shortfall is no longer paid from insurance at once (audit F-02): the winner gets the
    ///         pool, the shortfall is filed as a claim, and the claim is paid after the epoch ends.
    function test_liquidate_shortfallBecomesDeferredClaim() public {
        _fund(carol, usdg, 1000 * USD);
        vm.prank(carol);
        perps.fundInsurance(1000 * USD);
        (uint256 id, int256 claim) = _insolventLong(300e18); // -23%: taker claim ~ -33
        PerpsBase.Position memory p = _pos(id);
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 insBefore = perps.insurance();
        uint256 bobBefore = _bal(bob, usdg);
        uint256 epoch = perps.currentCoverEpoch();
        vm.prank(liquidator);
        uint256 reward = perps.liquidate(id);
        assertEq(reward, 1 * USD, "insolvent: flat keeper reward from insurance (audit F-11)");
        assertEq(_bal(bob, usdg) - bobBefore, pool, "winner gets the pool now, no cover yet");
        assertEq(perps.coverClaims(epoch, bob), uint256(-claim));
        assertEq(perps.coverReserved(), uint256(-claim), "cover reserved at once (under the 10% cap)");
        assertEq(insBefore - perps.insurance(), reward + uint256(-claim));
        _assertPerpsSolvent();

        vm.expectRevert(abi.encodeWithSelector(PerpsBase.EpochNotOver.selector, epoch));
        perps.claimCover(epoch, bob);
        vm.warp((epoch + 1) * 1 hours);
        uint256 insAtSettle = perps.insurance();
        perps.claimCover(epoch, bob); // anyone may trigger; paid to bob
        assertEq(_bal(bob, usdg) - bobBefore, pool + uint256(-claim), "fully covered: under the 10% cap");
        assertEq(perps.insurance(), insAtSettle, "paid from the reserve");
        assertEq(perps.coverReserved(), 0);
        _assertPerpsSolvent();
    }

    /// @notice One epoch's top-ups plus cover are capped at 10% of the fund at its first draw; the rest is a
    ///         haircut to the winner.
    function test_liquidate_shortfallCoverCappedAtTenPercent() public {
        _fund(carol, usdg, 500 * USD);
        vm.prank(carol);
        perps.fundInsurance(500 * USD);
        (uint256 id, int256 claim) = _insolventLong(250e18);
        PerpsBase.Position memory p = _pos(id);
        uint256 epoch = perps.currentCoverEpoch();
        uint256 bobBefore = _bal(bob, usdg);
        uint256 insBefore = perps.insurance();
        vm.prank(liquidator);
        perps.liquidate(id); // keeper top-up of 1 USDG drawn first
        uint256 budget = insBefore / 10 - 1 * USD;
        assertLt(budget, uint256(-claim));
        assertEq(perps.coverReserved(), budget);
        assertEq(perps.insurance(), insBefore - insBefore / 10);
        vm.warp((epoch + 1) * 1 hours);
        uint256 ins = perps.insurance();
        assertEq(perps.settleCoverEpoch(epoch), budget);
        perps.claimCover(epoch, bob);
        assertEq(_bal(bob, usdg) - bobBefore, p.takerMargin + p.makerMargin + budget); // pool + capped cover
        assertEq(perps.insurance(), ins);
        assertEq(perps.coverReserved(), 0);
        _assertPerpsSolvent();
    }

    function test_isLiquidatable_closedIsFalse() public {
        uint256 id = _open(alice, offerId, true, 500 * USD, 4);
        vm.prank(alice);
        perps.close(id, 0);
        assertFalse(perps.isLiquidatable(id));
        assertEq(perps.takerClaimAt(id, TSLA_PRICE), 0); // closed positions have no claim
    }

    // ------------------------------------------------------------ forced exit

    function test_forcedExit_guards() public {
        uint256 id = _open(alice, offerId, true, 500 * USD, 4);
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        vm.expectRevert(PerpsBase.NotParty.selector);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.prank(alice);
        vm.expectRevert(PerpsBase.BadBond.selector);
        perps.requestForcedExit{value: 0.002 ether}(id);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.NotRequested.selector, id));
        perps.settleForcedExit(id);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.AlreadyRequested.selector, id));
        perps.requestForcedExit{value: 0.001 ether}(id);
        uint256 after_ = block.timestamp + 7 days;
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.TooEarly.selector, after_));
        perps.settleForcedExit(id);
    }

    function test_forcedExit_settlesAtOracleWithoutSpreadOrFee() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 4);
        vm.prank(bob); // the maker can request too
        perps.requestForcedExit{value: 0.001 ether}(id);
        assertEq(bob.balance, 1 ether - 0.001 ether);
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), 400e18);
        PerpsBase.Position memory p = _pos(id);
        uint256 aliceBefore = _bal(alice, usdg);
        uint256 insBefore = perps.insurance();
        vm.prank(carol); // anyone can settle
        perps.settleForcedExit(id);
        int256 claim = int256(p.takerMargin) + _refPnl(true, p.qty, p.entry, 400e18)
            - _refFunding(true, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        assertEq(_bal(alice, usdg) - aliceBefore, uint256(claim));
        assertEq(perps.insurance(), insBefore); // no fee, no penalty
        assertEq(perps.bondRefunds(bob), 0.001 ether); // refund recorded, never pushed (audit F-01)
        vm.prank(bob);
        perps.claimBond();
        assertEq(bob.balance, 1 ether);
        assertEq(perps.bondRefunds(bob), 0);
        _assertPerpsSolvent();
    }

    function test_forcedExit_deadOracleSettlesAtEntry() public {
        uint256 id = _open(alice, offerId, true, 1000 * USD, 4);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 15 days); // no price for 15 days: dead
        assertTrue(oracle.isDead(address(tsla)));
        PerpsBase.Position memory p = _pos(id);
        int256 funding = _refFunding(true, p.qty, _fundingIndex() - p.fundingIndexAtOpen);
        uint256 aliceBefore = _bal(alice, usdg);
        perps.settleForcedExit(id);
        assertEq(int256(_bal(alice, usdg) - aliceBefore), int256(p.takerMargin) - funding); // pnl 0 at entry
        assertEq(perps.bondRefunds(alice), 0.001 ether);
        vm.prank(alice);
        perps.claimBond();
        assertEq(alice.balance, 1 ether);
    }

    function test_forcedExit_bondRefundedOnCloseAndDeferredIfRejected() public {
        Rejecter r = new Rejecter();
        _fund(address(r), usdg, 10_000 * USD);
        vm.deal(address(r), 1 ether);
        vm.prank(address(r));
        uint256 id = perps.open(offerId, address(tsla), true, 500 * USD, 4, 0);
        vm.prank(address(r));
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.prank(address(r));
        perps.close(id, 0); // refund fails -> deferred
        assertEq(perps.bondRefunds(address(r)), 0.001 ether);
        vm.prank(address(r));
        vm.expectRevert(PerpsBase.RefundFailed.selector);
        perps.claimBond();
        r.setAccept(true);
        vm.prank(address(r));
        perps.claimBond();
        assertEq(address(r).balance, 1 ether);
        vm.prank(address(r));
        vm.expectRevert(PerpsBase.NothingToClaim.selector);
        perps.claimBond();
    }

    // ------------------------------------------------------------ insurance

    function test_fundInsurance() public {
        vm.prank(carol);
        vm.expectRevert(PerpsBase.ZeroAmount.selector);
        perps.fundInsurance(0);
        vm.prank(carol);
        perps.fundInsurance(10 * USD);
        assertEq(perps.insurance(), 10 * USD);
        _assertPerpsSolvent();
    }

    // ------------------------------------------------------------ fuzz

    /// @notice Any open/close round trip conserves USDG: taker + maker + insurance changes net to zero.
    function testFuzz_roundTripConserves(uint256 size, uint8 levHalf, bool isLong, uint256 movePct, bool up) public {
        size = bound(size, 10 * USD, 20_000 * USD);
        levHalf = uint8(bound(levHalf, 2, 10));
        movePct = bound(movePct, 0, 9);
        uint256 before = _bal(alice, usdg) + _bal(bob, usdg) + book.totalBacking() + perps.insurance();
        uint256 id = _open(alice, offerId, isLong, size, levHalf);
        uint256 price = up ? TSLA_PRICE * (100 + movePct) / 100 : TSLA_PRICE * (100 - movePct) / 100;
        _movePriceTo(address(tsla), price);
        if (perps.isLiquidatable(id)) {
            vm.prank(liquidator);
            perps.liquidate(id);
        } else {
            vm.prank(alice);
            perps.close(id, 0);
        }
        uint256 after_ =
            _bal(alice, usdg) + _bal(bob, usdg) + book.totalBacking() + perps.insurance() + _bal(liquidator, usdg);
        assertEq(after_, before, "value created or destroyed");
        assertEq(perps.totalMargin(), 0);
        _assertPerpsSolvent();
    }
}

/// @notice Open-interest cap enforcement with a tiny cap.
contract PerpsOiCapTest is VelumBase {
    function _oiCap() internal pure override returns (uint256) {
        return 3e18;
    }

    function test_openInterestCap() public {
        _fund(alice, usdg, 10_000 * USD);
        _fund(carol, usdg, 10_000 * USD);
        uint256 offer = _postOffer(10_000 * USD, 5000 * USD, 5, 5);
        _open(alice, offer, true, 780 * USD, 4); // ~1.99 TSLA
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.OpenInterestCap.selector, address(tsla)));
        perps.open(offer, address(tsla), true, 780 * USD, 4, 0);
        _open(carol, offer, false, 780 * USD, 4); // the other side has its own cap
    }
}
