// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VelumBase} from "../Base.t.sol";
import {Handler} from "./Handler.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Protocol-wide invariants (docs/04 §1):
///   1. No token leaves the vault except through withdraw.
///   2. Sum of internal balances (users + pools + offers + margins + insurance) == vault holdings.
///   3. A liquidation never pays out more than the posted margins plus the insurance fund; shortfall
///      cover is never paid at liquidation (only the capped keeper top-up), and one epoch's cover never
///      exceeds 10% of the fund (audit F-02).
///   4. Closing the whole book returns every unit: nothing is stuck and nothing is created.
///   5. Cover bookkeeping: reserved cover equals the unpaid budgets of settled epochs, outstanding claims
///      equal the claims recorded, and the guardian never moves funds (audit F-07).
contract InvariantsTest is StdInvariant, VelumBase {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(vault, oracle, pools, book, perps, usdg, tsla, amzn, relayer, guardian);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](30);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.deposit.selector; // weighted: more deposits
        selectors[2] = Handler.withdraw.selector;
        selectors[3] = Handler.addLiquidity.selector;
        selectors[4] = Handler.removeLiquidity.selector;
        selectors[5] = Handler.swap.selector;
        selectors[6] = Handler.postOffer.selector;
        selectors[7] = Handler.withdrawOffer.selector;
        selectors[8] = Handler.openPosition.selector;
        selectors[9] = Handler.openPosition.selector;
        selectors[10] = Handler.closePosition.selector;
        selectors[11] = Handler.addMargin.selector;
        selectors[12] = Handler.liquidate.selector;
        selectors[13] = Handler.movePrice.selector;
        selectors[14] = Handler.passTime.selector;
        selectors[15] = Handler.requestForcedExit.selector;
        selectors[16] = Handler.settleForcedExits.selector;
        selectors[17] = Handler.openPosition.selector;
        selectors[18] = Handler.postOffer.selector;
        selectors[19] = Handler.movePrice.selector;
        selectors[20] = Handler.movePrice.selector;
        selectors[21] = Handler.liquidate.selector;
        selectors[22] = Handler.claimCover.selector;
        selectors[23] = Handler.passEpoch.selector;
        selectors[24] = Handler.toggleCloseOnly.selector;
        selectors[25] = Handler.claimCover.selector;
        selectors[26] = Handler.gap.selector;
        selectors[27] = Handler.openPosition.selector;
        selectors[28] = Handler.openPosition.selector;
        selectors[29] = Handler.liquidate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
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
        assertFalse(handler.coverOverCap(), "epoch cover above 10% of the fund");
    }

    /// 5. Reserved cover == unpaid budgets of settled epochs; outstanding == recorded claims.
    function invariant_coverAccounting() public view {
        uint256 reserved;
        for (uint256 i; i < handler.claimEpochCount(); ++i) {
            uint256 e = handler.claimEpochs(i);
            (uint256 claimed, uint256 outstanding, uint256 budget, uint256 paid, bool settled) = perps.coverEpochs(e);
            uint256 sum;
            for (uint256 j; j < handler.claimantCount(e); ++j) {
                sum += perps.coverClaims(e, handler.claimant(e, j));
            }
            assertEq(outstanding, sum, "outstanding claims");
            assertLe(outstanding, claimed);
            assertLe(budget, claimed, "budget above claims");
            assertLe(paid, budget, "paid above budget");
            if (settled && outstanding != 0) reserved += budget - paid;
            if (!settled) assertEq(budget, 0);
        }
        assertEq(perps.coverReserved(), reserved, "reserved cover");
        assertFalse(handler.guardianMovedFunds(), "guardian moved funds");
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

    /// 4. Wind everything down after each run: all positions close, all offers return their
    ///    backing, and the only value left outside users is insurance plus locked pool dust.
    function afterInvariant() public {
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
            " coverPaid=",
            vm.toString(handler.coverClaimsPaid()),
            " closeOnlyToggles=",
            vm.toString(handler.closeOnlyToggles()),
            " gaps=",
            vm.toString(handler.gaps())
        );
        if (vm.envOr("VELUM_INV_STATS", false)) vm.writeLine("deployments/inv-stats.txt", line);
        emit log_named_string(
            "run",
            string.concat(
                "opens=",
                vm.toString(handler.opens()),
                " closes=",
                vm.toString(handler.closes()),
                " liquidations=",
                vm.toString(handler.liquidations()),
                " forcedExits=",
                vm.toString(handler.forcedExits()),
                " attempts=",
                vm.toString(handler.openAttempts()),
                " failures=",
                vm.toString(handler.openFailures()),
                " lastErr=",
                vm.toString(abi.encodePacked(handler.lastOpenError()))
            )
        );
        handler.windDown();
        assertEq(perps.totalMargin(), 0, "margins left");
        assertEq(perps.coverReserved(), 0, "cover left reserved");
        for (uint256 i; i < handler.claimEpochCount(); ++i) {
            (, uint256 outstanding,,,) = perps.coverEpochs(handler.claimEpochs(i));
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
    }

    function _hasOutsideLp(address st) internal view returns (bool) {
        // removeLiquidity may refuse to empty a reserve seeded at an extreme ratio; that LP keeps shares.
        for (uint256 j; j < handler.actorCount(); ++j) {
            if (pools.sharesOf(st, handler.actors(j)) != 0) return true;
        }
        return false;
    }
}
