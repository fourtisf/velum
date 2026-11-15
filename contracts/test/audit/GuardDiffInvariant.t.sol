// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {IVelumVault} from "../../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../../src/interfaces/IMakerBook.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {GuardDiffHandler, Sys} from "./GuardDiffHandler.sol";

/// @notice Independent audit (launch guard, commit 074ae11): differential invariants for properties 1-4.
///         P1 nobody outside an active allowlist deposits, approves or uses a module (outsiders try every action);
///         P2 active caps hold against an independent ghost model, and never go down;
///         P3 no withdrawal or exit is ever refused by the guard, and every non-guard action has exactly the outcome it
///            has in an unguarded mirror holding the same state;
///         P4 guard-admin actions never change funds or approvals, non-admins hold no admin power, handover cannot be
///            hijacked, and the role clears once both switches are off.
///         Kept as a regression for the G-01 fix: while caps are active the global caps cover account cap x allowlisted
///         (ghost count), holdings never exceed the sum of net deposits, the global cap never refuses a deposit, and
///         caps never apply without the allowlist. The guarded caps (USDG 6,000 / 30,000, stocks 15 / 75) cover the
///         five actors the admin may allowlist (the auditor's 15,000 / 40 global caps for three are now refused).
contract GuardDiffInvariantTest is StdInvariant, Test {
    GuardDiffHandler internal handler;
    MockERC20 internal usdg;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    address internal relayer = makeAddr("relayer");
    address internal admin = makeAddr("guard-admin");
    Sys internal g;
    Sys internal u;

    function _deploy(bool guarded) internal returns (Sys memory s) {
        s.vault = new VelumVault();
        s.oracle = new OracleAdapter();
        s.pools = new SpotPools(IVelumVault(address(s.vault)), address(usdg));
        s.book = new MakerBook(IVelumVault(address(s.vault)), address(usdg));
        s.perps = new PerpsMarkets(
            IVelumVault(address(s.vault)),
            IOracleAdapter(address(s.oracle)),
            IMakerBook(address(s.book)),
            address(usdg),
            6
        );
        address[] memory tokens = new address[](3);
        (tokens[0], tokens[1], tokens[2]) = (address(usdg), address(tsla), address(amzn));
        address[] memory modules = new address[](3);
        (modules[0], modules[1], modules[2]) = (address(s.pools), address(s.book), address(s.perps));
        address[] memory blocked = new address[](1);
        blocked[0] = address(s.oracle);
        if (guarded) {
            uint256[] memory a = new uint256[](3);
            uint256[] memory gl = new uint256[](3);
            (a[0], gl[0]) = (6000e6, 30_000e6);
            (a[1], gl[1]) = (15e18, 75e18);
            (a[2], gl[2]) = (15e18, 75e18);
            s.vault.setup(tokens, modules, blocked, admin, a, gl);
        } else {
            s.vault.setup(tokens, modules, blocked, address(0), new uint256[](0), new uint256[](0));
        }
        address[] memory stocks = new address[](2);
        (stocks[0], stocks[1]) = (address(tsla), address(amzn));
        uint128[] memory mins = new uint128[](2);
        uint128[] memory maxs = new uint128[](2);
        (mins[0], mins[1], maxs[0], maxs[1]) = (1e18, 1e18, 100_000e18, 100_000e18);
        s.oracle.setup(stocks, new address[](2), mins, maxs, relayer, address(0));
        s.pools.setup(stocks);
        s.book.setup(address(s.perps), stocks);
        uint256[] memory caps = new uint256[](2);
        (caps[0], caps[1]) = (10_000e18, 10_000e18);
        s.perps.setup(stocks, caps, address(0));
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        amzn = new MockERC20("Amazon", "AMZN", 18);
        g = _deploy(true);
        u = _deploy(false);
        handler = new GuardDiffHandler(g, u, usdg, [tsla, amzn], relayer);
        // actors 0-2 start allowlisted and approve every module, in both systems
        address[] memory l = new address[](3);
        for (uint256 i; i < 3; ++i) {
            l[i] = handler.actors(i);
        }
        vm.prank(admin);
        g.vault.addToAllowlist(l);
        for (uint256 i; i < 3; ++i) {
            _approveAll(g, l[i]);
            _approveAll(u, l[i]);
        }
        handler.refresh();
        handler.seedState();
        require(bytes(handler.violation()).length == 0, handler.violation());
        targetContract(address(handler));
        bytes4[] memory s = new bytes4[](30);
        s[0] = GuardDiffHandler.deposit.selector;
        s[1] = GuardDiffHandler.deposit.selector;
        s[2] = GuardDiffHandler.depositEdge.selector;
        s[3] = GuardDiffHandler.withdraw.selector;
        s[4] = GuardDiffHandler.withdraw.selector;
        s[5] = GuardDiffHandler.approve.selector;
        s[6] = GuardDiffHandler.postOffer.selector;
        s[7] = GuardDiffHandler.postOffer.selector;
        s[8] = GuardDiffHandler.open.selector;
        s[9] = GuardDiffHandler.open.selector;
        s[10] = GuardDiffHandler.open.selector;
        s[11] = GuardDiffHandler.addMargin.selector;
        s[12] = GuardDiffHandler.fundInsurance.selector;
        s[13] = GuardDiffHandler.addLiquidity.selector;
        s[14] = GuardDiffHandler.swap.selector;
        s[15] = GuardDiffHandler.withdrawOffer.selector;
        s[16] = GuardDiffHandler.close.selector;
        s[17] = GuardDiffHandler.removeMargin.selector;
        s[18] = GuardDiffHandler.liquidate.selector;
        s[19] = GuardDiffHandler.liquidate.selector;
        s[20] = GuardDiffHandler.forcedExit.selector;
        s[21] = GuardDiffHandler.removeLiquidity.selector;
        s[22] = GuardDiffHandler.claimCover.selector;
        s[23] = GuardDiffHandler.movePrice.selector;
        s[24] = GuardDiffHandler.movePrice.selector;
        s[25] = GuardDiffHandler.gap.selector;
        s[26] = GuardDiffHandler.adminAllowlist.selector;
        s[27] = GuardDiffHandler.adminRaiseCaps.selector;
        s[28] = GuardDiffHandler.adminSwitch.selector;
        s[29] = GuardDiffHandler.adminHandover.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
        // a second, rarer target for the non-admin attempts
        bytes4[] memory s2 = new bytes4[](3);
        s2[0] = GuardDiffHandler.attackAdmin.selector;
        s2[1] = GuardDiffHandler.passTime.selector;
        s2[2] = GuardDiffHandler.claimBond.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s2}));
    }

    function _approveAll(Sys memory s, address a) internal {
        vm.startPrank(a);
        s.vault.setApproval(address(s.pools), true);
        s.vault.setApproval(address(s.book), true);
        s.vault.setApproval(address(s.perps), true);
        vm.stopPrank();
    }

    function invariant_noViolation() public view {
        assertEq(handler.violation(), "", handler.violation());
    }

    /// P3/P4: the guarded system holds exactly the state of the unguarded mirror.
    function invariant_mirrorsUnguarded() public view {
        assertEq(handler.stateHash(true), handler.stateHash(false), "guarded state diverged from the unguarded mirror");
    }

    /// P1/P2/P4 against the ghost model.
    function invariant_guardModel() public view {
        assertEq(g.vault.allowlistActive(), handler.ghostAllowlistActive(), "allowlist switch");
        assertEq(g.vault.capsActive(), handler.ghostCapsActive(), "caps switch");
        bool guarded = handler.ghostAllowlistActive() || handler.ghostCapsActive();
        assertEq(g.vault.guardAdmin() != address(0), guarded, "admin iff guarded");
        if (!guarded) assertEq(g.vault.pendingGuardAdmin(), address(0), "no pending admin once inert");
        address[3] memory toks = [address(usdg), address(tsla), address(amzn)];
        for (uint256 j; j < handler.actorCount(); ++j) {
            address a = handler.actors(j);
            assertEq(g.vault.isAllowlisted(a), handler.ghostAllow(a), "allowlist flag");
            for (uint256 m; m < 3; ++m) {
                if (handler.ghostAllowlistActive() && !handler.ghostAllow(a)) {
                    assertFalse(
                        g.vault.approved(a, m == 0 ? address(g.pools) : m == 1 ? address(g.book) : address(g.perps))
                    );
                }
            }
        }
        assertEq(g.vault.allowlistedCount(), handler.ghostAllowCount(), "allowlisted count");
        if (handler.ghostCapsActive()) {
            assertTrue(handler.ghostAllowlistActive(), "G-01 caps never apply without the allowlist");
            assertTrue(
                handler.ghostRoomFor(handler.ghostAllowCount()), "G-01 global cap below account cap x allowlisted"
            );
        }
        for (uint256 i; i < 3; ++i) {
            address t = toks[i];
            assertEq(g.vault.accountCap(t), handler.lastAccountCap(t), "account cap");
            assertEq(g.vault.globalCap(t), handler.lastGlobalCap(t), "global cap");
            if (!handler.ghostCapsActive()) continue;
            assertLe(g.vault.totalInternal(t), g.vault.globalCap(t), "global cap exceeded");
            uint256 sum;
            for (uint256 j; j < handler.actorCount(); ++j) {
                address a = handler.actors(j);
                assertEq(g.vault.netDeposited(a, t), handler.ghostNd(a, t), "net deposits");
                assertLe(g.vault.netDeposited(a, t), g.vault.accountCap(t), "account cap exceeded");
                if (!handler.ghostAllow(a)) assertEq(handler.ghostNd(a, t), 0, "net deposits outside the allowlist");
                sum += handler.ghostNd(a, t);
            }
            assertLe(g.vault.totalInternal(t), sum, "G-01 holdings above the sum of net deposits");
        }
    }

    /// P3: everything winds down and every account withdraws everything, whatever the guard state.
    function afterInvariant() public {
        emit log_named_string(
            "diff run",
            string.concat(
                "opens=",
                vm.toString(handler.opens()),
                " liquidations=",
                vm.toString(handler.liquidations()),
                " outsiderAttempts=",
                vm.toString(handler.outsiderAttempts()),
                " guardRefusals=",
                vm.toString(handler.guardRefusals()),
                " adminActions=",
                vm.toString(handler.adminActions()),
                " roomRefusals=",
                vm.toString(handler.roomRefusals()),
                " withdrawals=",
                vm.toString(handler.withdrawals()),
                " allowlist=",
                g.vault.allowlistActive() ? "on" : "off",
                " caps=",
                g.vault.capsActive() ? "on" : "off"
            )
        );
        if (vm.envOr("GUARD_DIFF_STATS", false)) {
            vm.writeLine(
                "deployments/diff-stats.txt",
                string.concat(
                    vm.toString(handler.opens()),
                    ",",
                    vm.toString(handler.openTries()),
                    ",",
                    vm.toString(handler.liquidations()),
                    ",",
                    vm.toString(handler.outsiderAttempts()),
                    ",",
                    vm.toString(handler.guardRefusals()),
                    ",",
                    vm.toString(handler.withdrawals()),
                    ",",
                    vm.toString(handler.adminActions()),
                    ",",
                    vm.toString(handler.lastOpenErr()),
                    ",",
                    g.vault.allowlistActive() ? "on" : "off",
                    ",",
                    g.vault.capsActive() ? "on" : "off"
                )
            );
        }
        handler.windDown();
        assertEq(g.perps.totalMargin(), 0, "margins left (guarded)");
        assertEq(u.perps.totalMargin(), 0, "margins left (unguarded)");
        handler.withdrawEverything();
        assertEq(handler.violation(), "", handler.violation());
        assertEq(handler.stateHash(true), handler.stateHash(false), "diverged after wind-down");
        for (uint256 j; j < handler.actorCount(); ++j) {
            address a = handler.actors(j);
            assertEq(g.vault.balanceOf(a, address(usdg)), 0, "usdg left");
            assertEq(g.vault.balanceOf(a, address(tsla)), 0, "tsla left");
            assertEq(g.vault.balanceOf(a, address(amzn)), 0, "amzn left");
        }
    }
}
