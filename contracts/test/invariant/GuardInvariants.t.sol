// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VelumBase} from "../Base.t.sol";
import {Handler} from "./Handler.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Launch guard under random sequences (contracts/README.md, Guarded launch). The shared handler runs
///         deposits (to self and to others, including the keeper), withdrawals, offers, opens, closes, liquidity,
///         liquidations and forced exits by allowlisted actors (0-3) and others (actor 4, the keeper), mixed with
///         every guard-admin action: allowlisting, cap raises, two-step handovers, approvals, `openToPublic` and
///         `liftCaps`. The caps are tight, so they bind often (deposits are up to 200,000 USDG / 500 tokens).
///         Invariants: nobody outside an active allowlist ever adds funds or approves a module; active caps are
///         never exceeded (net deposits per account against a ghost copy, holdings per token); no withdrawal or exit
///         is blocked; the guard admin never changes a balance; vault accounting holds; and at the end every account
///         withdraws everything, whatever the guard's state.
contract GuardInvariantsTest is StdInvariant, VelumBase {
    Handler internal handler;

    function _guardConfig() internal override returns (address, uint256[] memory, uint256[] memory) {
        return _guardCaps(makeAddr("guard-admin"), 150_000e6, 400_000e6, 300e18, 800e18);
    }

    function setUp() public override {
        super.setUp();
        handler = new Handler(
            vault, oracle, pools, book, perps, usdg, tsla, amzn, relayer, guardian, MockAggregator(address(0))
        );
        targetContract(address(handler));
        bytes4[] memory s = new bytes4[](33);
        s[0] = Handler.deposit.selector;
        s[1] = Handler.deposit.selector;
        s[2] = Handler.deposit.selector;
        s[3] = Handler.depositFor.selector;
        s[4] = Handler.depositFor.selector;
        s[5] = Handler.withdraw.selector;
        s[6] = Handler.withdraw.selector;
        s[7] = Handler.postOffer.selector;
        s[8] = Handler.withdrawOffer.selector;
        s[9] = Handler.openPosition.selector;
        s[10] = Handler.openPosition.selector;
        s[11] = Handler.closePosition.selector;
        s[12] = Handler.closePosition.selector;
        s[13] = Handler.addLiquidity.selector;
        s[14] = Handler.removeLiquidity.selector;
        s[15] = Handler.swap.selector;
        s[16] = Handler.addMargin.selector;
        s[17] = Handler.liquidate.selector;
        s[18] = Handler.movePrice.selector;
        s[19] = Handler.passTime.selector;
        s[20] = Handler.requestForcedExit.selector;
        s[21] = Handler.settleForcedExits.selector;
        s[22] = Handler.guardAllowlist.selector;
        s[23] = Handler.guardRaiseCaps.selector;
        s[24] = Handler.guardOpenToPublic.selector;
        s[25] = Handler.guardLiftCaps.selector;
        s[26] = Handler.guardHandover.selector;
        s[27] = Handler.approveModules.selector;
        s[28] = Handler.approveModules.selector;
        s[29] = Handler.claimCover.selector;
        s[30] = Handler.gap.selector;
        s[31] = Handler.movePrice.selector;
        s[32] = Handler.closeLiquidatable.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
    }

    function _tokens() internal view returns (MockERC20[3] memory t) {
        t[0] = usdg;
        t[1] = tsla;
        t[2] = amzn;
    }

    /// Nobody outside an active allowlist adds funds, active caps hold, no exit is blocked, the admin moves nothing.
    function invariant_launchGuard() public view {
        handler.checkLaunchGuard();
    }

    /// Vault holdings equal net deposits; internal balances sum to holdings.
    function invariant_vaultAccounting() public view {
        MockERC20[3] memory t = _tokens();
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            assertEq(t[i].balanceOf(address(vault)), handler.deposited(a) - handler.withdrawn(a), "net deposits");
            assertEq(vault.totalInternal(a), t[i].balanceOf(address(vault)), "total internal");
            uint256 sum = vault.balanceOf(handler.liquidator(), a) + vault.balanceOf(address(pools), a)
                + vault.balanceOf(address(book), a) + vault.balanceOf(address(perps), a);
            for (uint256 j; j < handler.actorCount(); ++j) {
                sum += vault.balanceOf(handler.actors(j), a);
            }
            assertEq(sum, vault.totalInternal(a), "sum of accounts");
        }
    }

    /// Wind everything down (closes, offer withdrawals, liquidity removal, cover claims), then every account withdraws
    /// everything: nothing is trapped, whatever the guard's state, and only module balances remain.
    function afterInvariant() public {
        string memory line = string.concat(
            "opens=",
            vm.toString(handler.opens()),
            " closes=",
            vm.toString(handler.closes()),
            " liquidations=",
            vm.toString(handler.liquidations()),
            " guardRefusals=",
            vm.toString(handler.guardRefusals()),
            " guardAdminActions=",
            vm.toString(handler.guardAdminActions()),
            " allowlist=",
            vault.allowlistActive() ? "on" : "off",
            " caps=",
            vault.capsActive() ? "on" : "off"
        );
        if (vm.envOr("VELUM_INV_STATS", false)) {
            vm.writeLine("deployments/inv-stats.txt", string.concat("guard ", line));
        }
        emit log_named_string("guard run", line);
        handler.windDown();
        assertEq(perps.totalMargin(), 0, "margins left");
        assertEq(book.totalBacking(), 0, "backing left");
        handler.withdrawEverything();
        handler.checkLaunchGuard();
        MockERC20[3] memory t = _tokens();
        for (uint256 i; i < 3; ++i) {
            address a = address(t[i]);
            uint256 modules = vault.balanceOf(address(pools), a) + vault.balanceOf(address(perps), a);
            assertEq(t[i].balanceOf(address(vault)), modules, "only module balances remain");
            assertEq(vault.totalInternal(a), modules, "total internal after withdrawals");
        }
    }
}
