// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "../Base.t.sol";
import {Handler} from "../invariant/Handler.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Independent audit (round 3) extended handler: the original handler plus the paths it never drives
///         (taker margin removal, insurance donations, oracle pokes, explicit funding advances, dead-oracle
///         forced exits at the entry price) and, since IA-06, relayed prices outside the oracle bounds (clamped,
///         rate-limited, lagging until they come back). Since the final audit it also moves the L2 sequencer feed
///         (down, grace, up) and checks the payout of liquidations reached through close and settleForcedExit.
contract Round3ExtHandler is Handler {
    uint256 public marginRemovals;
    uint256 public deadExits;
    uint256 public outOfBoundsMoves;
    /// @dev A taker removed margin and was left below the initial margin at the price used.
    bool public removedBelowIM;
    /// @dev Per stock: the relayed price is outside the bounds; `saved` is the in-bounds price to return to.
    bool[2] public oob;
    uint256[2] public saved;

    constructor(
        VelumVault vault_,
        OracleAdapter oracle_,
        SpotPools pools_,
        MakerBook book_,
        PerpsMarkets perps_,
        MockERC20 usdg_,
        MockERC20 s0,
        MockERC20 s1,
        address relayer_,
        address guardian_,
        MockAggregator sequencerFeed_
    ) Handler(vault_, oracle_, pools_, book_, perps_, usdg_, s0, s1, relayer_, guardian_, sequencerFeed_) {}

    function removeMargin(uint256 idx, uint256 pct) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open) return;
        uint256 amt = (p.takerMargin * bound(pct, 1, 100)) / 100;
        if (amt == 0) return;
        vm.prank(p.taker);
        try perps.removeMargin(id, amt) {
            marginRemovals++;
            (uint256 px,) = oracle.latest(p.market);
            int256 claim = perps.takerClaimAt(id, px);
            uint256 im = (((p.qty * px + 1e30 - 1) / 1e30) * 2000 + 9999) / 10_000;
            if (claim < int256(im)) removedBelowIM = true;
        } catch {}
    }

    function fundInsurance(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 bal = vault.balanceOf(a, address(usdg));
        if (bal == 0) return;
        vm.prank(a);
        perps.fundInsurance(bound(amount, 1, bal));
    }

    function poke(uint256 s) external {
        oracle.poke(address(stocks[s % 2]));
    }

    function advance(uint256 s) external {
        try perps.advanceFunding(address(stocks[s % 2])) {} catch {}
    }

    /// @dev The relay goes quiet for 15 days (both oracles dead), every requested forced exit settles at the
    ///      entry price, then the relay resumes at the same prices.
    function deadOracleExits() external {
        vm.warp(block.timestamp + 15 days);
        for (uint256 i; i < positionIds.length; ++i) {
            PerpsBase.Position memory p = perps.getPosition(positionIds[i]);
            if (!p.open || p.exitRequestedAt == 0) continue;
            if (_settleForcedExit(positionIds[i])) deadExits++;
        }
        refreshPrices();
    }

    /// @dev IA-06: the relay pushes a price outside the [1, 100,000] USDG bounds for `windows` rate-limit windows
    ///      (the effective price walks toward the bound, 5% per window). A quarter of the time the source stays
    ///      outside after the call, until `backInBounds` or the wind-down: other actions then run against a clamped,
    ///      lagging price, and movePrice and gap leave that stock alone. Otherwise it comes back at once and the
    ///      effective price catches up as usual.
    function outOfBounds(uint256 s, bool below, uint256 windows) external {
        uint256 k = s % 2;
        if (!oob[k]) {
            saved[k] = price[k];
            oob[k] = true;
        }
        price[k] = below ? 0.5e18 : 150_000e18;
        refreshPrices();
        uint256 n = bound(windows, 0, 40);
        for (uint256 i; i < n; ++i) {
            vm.warp(block.timestamp + oracle.MOVE_WINDOW());
            refreshPrices();
            this.liquidate(i); // keepers keep liquidating at the clamped, lagging price
        }
        outOfBoundsMoves++;
        if (windows % 4 == 0) return;
        _backInBounds(k);
        for (uint256 i; i < 60 && oracle.lagging(address(stocks[k])); ++i) {
            vm.warp(block.timestamp + oracle.MOVE_WINDOW());
            refreshPrices();
            this.liquidate(i);
        }
    }

    function backInBounds(uint256 s) external {
        _backInBounds(s % 2);
    }

    function _backInBounds(uint256 k) internal {
        if (!oob[k]) return;
        price[k] = saved[k];
        oob[k] = false;
        refreshPrices();
    }

    /// @dev Bring every relayed price back inside the bounds first: a price outside them lags for good, and
    ///      closes refuse a lagging price.
    function windDown() external override {
        for (uint256 k; k < 2; ++k) {
            if (!oob[k]) continue;
            price[k] = saved[k];
            oob[k] = false;
        }
        _windDown();
    }
}

contract Round3ExtInvariantsTest is StdInvariant, VelumBase {
    Handler internal handler;
    MockAggregator internal seq;

    /// @dev Final audit: the suites now run with an L2 sequencer-uptime feed (up for two hours at the start).
    function _sequencerFeed() internal override returns (address) {
        seq = new MockAggregator(0);
        seq.set(0, block.timestamp - 2 hours);
        return address(seq);
    }

    /// @dev Launch guard (actors 0-3 allowlisted), as in the main suite: invariant 6 runs here too. The global caps
    ///      cover five account caps, one per actor (G-01).
    function _guardConfig() internal override returns (address, uint256[] memory, uint256[] memory) {
        return _guardCaps(makeAddr("guard-admin"), 600_000e6, 3_000_000e6, 1500e18, 7500e18);
    }

    function setUp() public override {
        super.setUp();
        Round3ExtHandler h =
            new Round3ExtHandler(vault, oracle, pools, book, perps, usdg, tsla, amzn, relayer, guardian, seq);
        handler = h;
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](39);
        s[0] = Handler.deposit.selector;
        s[1] = Handler.deposit.selector;
        s[2] = Handler.withdraw.selector;
        s[3] = Handler.addLiquidity.selector;
        s[4] = Handler.swap.selector;
        s[5] = Handler.postOffer.selector;
        s[6] = Handler.postOffer.selector;
        s[7] = Handler.withdrawOffer.selector;
        s[8] = Handler.openPosition.selector;
        s[9] = Handler.openPosition.selector;
        s[10] = Handler.openPosition.selector;
        s[11] = Handler.openPosition.selector;
        s[12] = Handler.closePosition.selector;
        s[13] = Handler.addMargin.selector;
        s[14] = Handler.liquidate.selector;
        s[15] = Handler.liquidate.selector;
        s[16] = Handler.movePrice.selector;
        s[17] = Handler.movePrice.selector;
        s[18] = Handler.passTime.selector;
        s[19] = Handler.requestForcedExit.selector;
        s[20] = Handler.settleForcedExits.selector;
        s[21] = Handler.claimCover.selector;
        s[22] = Handler.passEpoch.selector;
        s[23] = Handler.gap.selector;
        s[24] = Round3ExtHandler.removeMargin.selector;
        s[25] = Round3ExtHandler.removeMargin.selector;
        s[26] = Round3ExtHandler.fundInsurance.selector;
        s[27] = Round3ExtHandler.poke.selector;
        s[28] = Round3ExtHandler.advance.selector;
        s[29] = Round3ExtHandler.deadOracleExits.selector;
        s[30] = Handler.requestForcedExit.selector;
        s[31] = Handler.removeLiquidity.selector;
        s[32] = Round3ExtHandler.outOfBounds.selector;
        s[33] = Round3ExtHandler.backInBounds.selector;
        s[34] = Handler.sequencer.selector;
        s[35] = Handler.sequencer.selector;
        s[36] = Handler.closeLiquidatable.selector;
        s[37] = Handler.depositFor.selector;
        s[38] = Handler.guardAction.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    function _ext() internal view returns (Round3ExtHandler) {
        return Round3ExtHandler(address(handler));
    }

    function _tokens() internal view returns (MockERC20[3] memory t) {
        t[0] = usdg;
        t[1] = tsla;
        t[2] = amzn;
    }

    /// @dev Every account that can ever hold an internal balance.
    function _sumInternal(address token) internal view returns (uint256 sum) {
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += vault.balanceOf(handler.actors(i), token);
        }
        sum += vault.balanceOf(handler.liquidator(), token);
        sum += vault.balanceOf(address(pools), token);
        sum += vault.balanceOf(address(book), token);
        sum += vault.balanceOf(address(perps), token);
    }

    /// 1. Tokens leave only through withdraw.
    function invariant_vaultHoldsNetDeposits() public view {
        MockERC20[3] memory t = _tokens();
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            assertEq(t[i].balanceOf(address(vault)), handler.deposited(a) - handler.withdrawn(a), "net deposits");
        }
    }

    /// 2. Internal balances sum to holdings, and every module's balance matches its own books.
    function invariant_internalBalancesMatchHoldings() public view {
        MockERC20[3] memory t = _tokens();
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            assertEq(vault.totalInternal(a), t[i].balanceOf(address(vault)), "total internal");
            assertEq(_sumInternal(a), vault.totalInternal(a), "sum of accounts");
        }
        (uint256 s0, uint256 u0,,) = pools.pools(address(tsla));
        (uint256 s1, uint256 u1,,) = pools.pools(address(amzn));
        assertEq(vault.balanceOf(address(pools), address(tsla)), s0, "tsla reserve");
        assertEq(vault.balanceOf(address(pools), address(amzn)), s1, "amzn reserve");
        assertEq(vault.balanceOf(address(pools), address(usdg)), u0 + u1, "usdg reserves");
        assertEq(vault.balanceOf(address(book), address(usdg)), book.totalBacking(), "offer backing");
        assertEq(
            vault.balanceOf(address(perps), address(usdg)),
            perps.totalMargin() + perps.insurance() + perps.coverReserved(),
            "margins + insurance + reserved cover"
        );
    }

    /// 3. Liquidations never overpay, cover is deferred and capped.
    function invariant_liquidationsNeverOverpay() public view {
        assertFalse(handler.liquidationOverpaid(), "overpaid");
        assertFalse(handler.immediateCoverPaid(), "cover paid at liquidation");
        assertFalse(handler.coverOverCap(), "epoch draws above 10% of the fund at its first draw");
    }

    /// 5. Reserved cover == unpaid budgets of epochs with unpaid claims; outstanding == recorded claims.
    function invariant_coverAccounting() public view {
        uint256 reserved;
        for (uint256 i; i < handler.claimEpochCount(); ++i) {
            uint256 e = handler.claimEpochs(i);
            (uint256 claimed, uint256 outstanding, uint256 budget, uint256 paid, uint256 cap, uint256 drawn,,) =
                perps.coverEpochs(e);
            uint256 sum;
            for (uint256 j; j < handler.claimantCount(e); ++j) {
                sum += perps.coverClaims(e, handler.claimant(e, j));
            }
            assertEq(outstanding, sum, "outstanding claims");
            assertLe(outstanding, claimed);
            assertLe(budget, claimed, "budget above claims");
            assertLe(paid, budget, "paid above budget");
            assertLe(budget, drawn, "budget outside the draws");
            assertLe(drawn, cap, "draws above the epoch cap");
            if (outstanding != 0) reserved += budget - paid;
        }
        assertEq(perps.coverReserved(), reserved, "reserved cover");
        assertFalse(handler.guardianMovedFunds(), "guardian moved funds");
    }

    /// 6. Launch guard (see Handler.checkLaunchGuard).
    function invariant_launchGuard() public view {
        handler.checkLaunchGuard();
    }

    /// Open interest equals the sum of open positions per side.
    function invariant_openInterestMatchesPositions() public view {
        uint256[2] memory longQ;
        uint256[2] memory shortQ;
        uint256 margins;
        for (uint256 i; i < handler.positionCount(); ++i) {
            PerpsBase.Position memory p = perps.getPosition(handler.positionIds(i));
            if (!p.open) continue;
            uint256 k = p.market == address(tsla) ? 0 : 1;
            if (p.isLong) longQ[k] += p.qty;
            else shortQ[k] += p.qty;
            margins += p.takerMargin + p.makerMargin;
        }
        (,, uint256 l0, uint256 sh0,,,) = perps.markets(address(tsla));
        (,, uint256 l1, uint256 sh1,,,) = perps.markets(address(amzn));
        assertEq(l0, longQ[0]);
        assertEq(sh0, shortQ[0]);
        assertEq(l1, longQ[1]);
        assertEq(sh1, shortQ[1]);
        assertEq(perps.totalMargin(), margins);
    }

    /// Margin removal never leaves a taker below the initial margin at the price used (IA-03 path).
    function invariant_removeMarginKeepsInitialMargin() public view {
        assertFalse(_ext().removedBelowIM(), "margin removal left claim below IM");
    }

    /// The effective price always lies within the oracle bounds, whatever the relay pushes (IA-06).
    function invariant_effectivePriceWithinBounds() public view {
        address[2] memory st = [address(tsla), address(amzn)];
        for (uint256 k; k < 2; ++k) {
            (uint128 last,,) = oracle.bands(st[k]);
            assertGe(last, 1e18, "below the floor");
            assertLe(last, 100_000e18, "above the cap");
        }
    }

    /// 4. Wind everything down after each run: all positions close, all offers return their
    ///    backing, and the only value left outside users is insurance plus locked pool dust.
    function afterInvariant() public {
        Round3ExtHandler h = _ext();
        string memory line = string.concat(
            "opens=",
            vm.toString(handler.opens()),
            " closes=",
            vm.toString(handler.closes()),
            " liquidations=",
            vm.toString(handler.liquidations()),
            " forcedExits=",
            vm.toString(handler.forcedExits()),
            " claimEpochs=",
            vm.toString(handler.claimEpochCount()),
            " removals=",
            vm.toString(h.marginRemovals()),
            " deadExits=",
            vm.toString(h.deadExits()),
            " outOfBounds=",
            vm.toString(h.outOfBoundsMoves()),
            " closeLiqs=",
            vm.toString(handler.closeLiquidations()),
            " exitLiqs=",
            vm.toString(handler.forcedExitLiquidations()),
            " seqDown=",
            vm.toString(handler.sequencerDowns()),
            " seqGrace=",
            vm.toString(handler.sequencerGraces())
        );
        line = string.concat(
            line,
            " guardRefusals=",
            vm.toString(handler.guardRefusals()),
            " guardAdminActions=",
            vm.toString(handler.guardAdminActions())
        );
        if (vm.envOr("VELUM_INV_STATS", false)) vm.writeLine("deployments/inv-stats.txt", string.concat("ext ", line));
        emit log_named_string("ext run", line);
        handler.windDown();
        assertFalse(handler.liquidationOverpaid(), "wind-down close overpaid");
        assertFalse(handler.immediateCoverPaid(), "wind-down close paid cover");
        assertEq(perps.totalMargin(), 0, "margins left");
        assertEq(perps.coverReserved(), 0, "cover left reserved");
        for (uint256 i; i < handler.claimEpochCount(); ++i) {
            (, uint256 outstanding,,,,,,) = perps.coverEpochs(handler.claimEpochs(i));
            assertEq(outstanding, 0, "claims left unpaid");
        }
        assertEq(vault.balanceOf(address(perps), address(usdg)), perps.insurance(), "perps holds only insurance");
        assertEq(book.totalBacking(), 0, "backing left");
        assertEq(vault.balanceOf(address(book), address(usdg)), 0, "book balance");
        MockERC20[3] memory t = _tokens();
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            uint256 users;
            for (uint256 j; j < handler.actorCount(); ++j) {
                users += vault.balanceOf(handler.actors(j), a);
            }
            users += vault.balanceOf(handler.liquidator(), a);
            uint256 held = vault.balanceOf(address(pools), a) + vault.balanceOf(address(perps), a);
            assertEq(users + held, handler.deposited(a) - handler.withdrawn(a), "every unit accounted for");
        }
        // pools keep at most the share of reserves backing the locked MIN_LIQUIDITY shares
        for (uint256 k; k < 2; ++k) {
            address st = k == 0 ? address(tsla) : address(amzn);
            (,, uint256 totalShares,) = pools.pools(st);
            assertTrue(
                totalShares == 0 || totalShares == pools.MIN_LIQUIDITY() || _hasOutsideLp(st), "only dust shares"
            );
        }
        // 6. Nothing is trapped by the guard: everyone withdraws everything; only module balances remain.
        handler.withdrawEverything();
        assertFalse(handler.exitBlocked(), "a final withdrawal reverted");
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            uint256 modules = vault.balanceOf(address(pools), a) + vault.balanceOf(address(perps), a)
                + vault.balanceOf(address(book), a);
            assertEq(t[i].balanceOf(address(vault)), modules, "only module balances remain");
            assertEq(vault.totalInternal(a), modules, "total internal after withdrawals");
        }
    }

    function _hasOutsideLp(address st) internal view returns (bool) {
        // removeLiquidity may refuse to empty a reserve seeded at an extreme ratio; that LP keeps shares.
        for (uint256 j; j < handler.actorCount(); ++j) {
            if (pools.sharesOf(st, handler.actors(j)) != 0) return true;
        }
        return false;
    }
}
