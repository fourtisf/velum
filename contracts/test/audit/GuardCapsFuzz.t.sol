// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice A module that moves internal balances between any two approving accounts (stands in for trading).
contract MoverModule {
    VelumVault internal immutable vault;

    constructor(VelumVault v) {
        vault = v;
    }

    function move(address token, address from, address to, uint256 amount) external {
        vault.transferInternal(token, from, to, amount);
    }
}

/// @notice Independent guard audit (P2), kept as a regression for G-01: whatever deposits, withdrawals (to anyone),
///         value moves between accounts (trading, keeper rewards to an outsider), cap raises and allowlistings happen,
///         while caps are active:
///           - every account's netDeposited <= accountCap and totalInternal <= globalCap;
///           - totalInternal <= sum of netDeposited (cycling cannot create room), and only allowlisted accounts ever
///             have netDeposited > 0;
///           - G-01: globalCap >= accountCap x allowlistedCount, so the global cap never refuses a deposit (a deposit
///             within the account cap always goes through; refusals are the account cap's) and a raise or an
///             allowlisting that would break the rule is refused with `Oversubscribed`;
///           - withdrawals never revert.
///         Accounts 0-2 start allowlisted; 3 is an outsider (receives value only through the module, like a keeper);
///         4 is a fresh address the admin tries to allowlist (it fits only after the global cap is raised).
contract GuardCapsFuzzTest is Test {
    VelumVault internal vault;
    MoverModule internal mover;
    MockERC20 internal usdg;
    address internal admin = makeAddr("admin");
    address[5] internal acct;

    function setUp() public {
        usdg = new MockERC20("USDG", "USDG", 6);
        vault = new VelumVault();
        mover = new MoverModule(vault);
        address[] memory t = new address[](1);
        t[0] = address(usdg);
        address[] memory m = new address[](1);
        m[0] = address(mover);
        uint256[] memory a = new uint256[](1);
        uint256[] memory g = new uint256[](1);
        (a[0], g[0]) = (1000e6, 3000e6); // exactly three account caps (the auditor's 2,000 is now refused)
        vault.setup(t, m, new address[](0), admin, a, g);
        address[] memory l = new address[](3);
        for (uint256 i; i < 5; ++i) {
            acct[i] = makeAddr(string.concat("acct-", vm.toString(i)));
            usdg.mint(acct[i], 1e15);
            vm.startPrank(acct[i]);
            usdg.approve(address(vault), type(uint256).max);
            vm.stopPrank();
            if (i < 3) l[i] = acct[i];
        }
        vm.prank(admin);
        vault.addToAllowlist(l);
        for (uint256 i; i < 3; ++i) {
            vm.prank(acct[i]);
            vault.setApproval(address(mover), true);
        }
        vm.prank(acct[3]);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, acct[3]));
        vault.setApproval(address(mover), true);
    }

    function testFuzz_capsAndHoldingsBound(uint256 seed) public {
        for (uint256 step; step < 60; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 6;
            address x = acct[(r >> 8) % 5];
            address y = acct[(r >> 16) % 5];
            uint256 amt = ((r >> 24) % 1500e6) + 1;
            if (op <= 1) {
                _deposit(x, op == 0 ? x : y, amt);
            } else if (op == 2) {
                uint256 bal = vault.balanceOf(x, address(usdg));
                if (bal != 0) {
                    vm.prank(x);
                    vault.withdraw(address(usdg), amt % bal + 1, y); // must never revert
                }
            } else if (op == 3) {
                uint256 bal = vault.balanceOf(x, address(usdg));
                if (bal != 0 && vault.approved(x, address(mover))) mover.move(address(usdg), x, y, amt % bal + 1);
            } else if (op == 4 && (r >> 40) % 4 == 0) {
                _raise(r);
            } else if (op == 5 && (r >> 40) % 8 == 0) {
                _allowlistFresh();
            }
            _check();
        }
    }

    /// @dev Account cap up by up to 300 USDG, global by up to 900; half the time the global cap is lifted to cover
    ///      every allowlisted address, otherwise an uncovered raise must be refused.
    function _raise(uint256 r) internal {
        uint256 ac = vault.accountCap(address(usdg)) + (r >> 48) % 300e6;
        uint256 gc = vault.globalCap(address(usdg)) + (r >> 48) % 900e6;
        uint256 count = vault.allowlistedCount();
        if (gc < ac * count && (r >> 120) % 2 == 0) gc = ac * count;
        if (gc < ac) gc = ac;
        bytes memory err = abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), ac, gc, count);
        vm.prank(admin);
        if (gc < ac * count) vm.expectRevert(err);
        vault.raiseCaps(address(usdg), ac, gc);
    }

    /// @dev The admin tries to allowlist the fresh address 4: refused unless the global cap covers one more account cap.
    function _allowlistFresh() internal {
        address fresh = acct[4];
        if (vault.isAllowlisted(fresh)) return;
        uint256 count = vault.allowlistedCount() + 1;
        uint256 ac = vault.accountCap(address(usdg));
        uint256 gc = vault.globalCap(address(usdg));
        address[] memory l = new address[](1);
        l[0] = fresh;
        vm.prank(admin);
        if (ac * count > gc) {
            vm.expectRevert(abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), ac, gc, count));
        }
        vault.addToAllowlist(l);
        if (vault.isAllowlisted(fresh)) {
            vm.prank(fresh);
            vault.setApproval(address(mover), true);
        }
    }

    /// @dev A deposit goes through exactly when the payer and the credited account are allowlisted and the credited
    ///      account's own room covers it; a refusal is never the global cap's.
    function _deposit(address from, address to, uint256 amt) internal {
        bool listed = vault.isAllowlisted(from) && vault.isAllowlisted(to);
        bool fits = vault.netDeposited(to, address(usdg)) + amt <= vault.accountCap(address(usdg));
        vm.prank(from);
        try vault.deposit(address(usdg), amt, to) {
            assertTrue(listed && fits, "deposit the guard should have refused");
        } catch (bytes memory err) {
            assertFalse(listed && fits, "G-01: a deposit within the account room was refused");
            assertTrue(bytes4(err) != VelumVault.GlobalCapExceeded.selector, "G-01: the global cap refused a deposit");
        }
    }

    function _check() internal view {
        uint256 sumNd;
        uint256 listed;
        for (uint256 i; i < 5; ++i) {
            uint256 nd = vault.netDeposited(acct[i], address(usdg));
            assertLe(nd, vault.accountCap(address(usdg)), "account cap");
            if (!vault.isAllowlisted(acct[i])) assertEq(nd, 0, "net deposits outside the allowlist");
            if (vault.isAllowlisted(acct[i])) ++listed;
            sumNd += nd;
        }
        assertEq(vault.allowlistedCount(), listed, "allowlisted count");
        assertGe(vault.globalCap(address(usdg)), vault.accountCap(address(usdg)) * listed, "G-01 room");
        uint256 total = vault.totalInternal(address(usdg));
        assertLe(total, vault.globalCap(address(usdg)), "global cap");
        assertLe(total, sumNd, "holdings above the sum of net deposits");
        assertEq(total, usdg.balanceOf(address(vault)), "holdings");
    }
}
