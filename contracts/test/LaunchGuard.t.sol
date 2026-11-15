// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {VelumBase} from "./Base.t.sol";
import {VelumVault} from "../src/VelumVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice Launch guard (contracts/README.md, Guarded launch): allowlist and caps on the vault's deposit path, a guard
///         admin limited to adding addresses, raising caps, the two one-way switches and a two-step handover.
///         USDG caps 1,000 per account / 2,500 global, TSLA 2 / 5 tokens, AMZN 0 / 0 (no deposits until raised).
///         alice, bob and carol are allowlisted; dave and keeper never are.
contract LaunchGuardTest is VelumBase {
    uint256 internal constant USDG_ACCOUNT = 1000 * USD;
    uint256 internal constant USDG_GLOBAL = 2500 * USD;
    uint256 internal constant TSLA_ACCOUNT = 2e18;
    uint256 internal constant TSLA_GLOBAL = 5e18;

    address internal admin = makeAddr("guard-admin");
    address internal dave = makeAddr("dave");
    address internal keeper = makeAddr("keeper");

    function _guardConfig() internal view override returns (address, uint256[] memory a, uint256[] memory g) {
        (a, g) = _caps();
        return (admin, a, g);
    }

    function _caps() internal pure returns (uint256[] memory a, uint256[] memory g) {
        a = new uint256[](3);
        g = new uint256[](3);
        a[0] = USDG_ACCOUNT;
        g[0] = USDG_GLOBAL;
        a[1] = TSLA_ACCOUNT;
        g[1] = TSLA_GLOBAL;
    }

    function setUp() public override {
        super.setUp();
        address[] memory list = new address[](3);
        list[0] = alice;
        list[1] = bob;
        list[2] = carol;
        vm.prank(admin);
        vault.addToAllowlist(list);
        vm.deal(alice, 1 ether);
    }

    // ------------------------------------------------------------ helpers

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _mintApprove(address who, MockERC20 token, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, MockERC20 token, uint256 amount) internal {
        _mintApprove(who, token, amount);
        vm.prank(who);
        vault.deposit(address(token), amount, who);
    }

    function _withdrawAll(address who, MockERC20 token) internal {
        uint256 bal = _bal(who, token);
        if (bal == 0) return;
        vm.prank(who);
        vault.withdraw(address(token), bal, who);
    }

    function _freshVault() internal returns (VelumVault v, address[] memory tokens) {
        v = new VelumVault();
        tokens = new address[](3);
        tokens[0] = address(usdg);
        tokens[1] = address(tsla);
        tokens[2] = address(amzn);
    }

    function _openToPublic() internal {
        vm.prank(admin);
        vault.openToPublic();
    }

    function _liftCaps() internal {
        vm.prank(admin);
        vault.liftCaps();
    }

    // ------------------------------------------------------------ setup

    function test_setup_guardState() public view {
        assertEq(vault.guardAdmin(), admin);
        assertEq(vault.pendingGuardAdmin(), address(0));
        assertTrue(vault.allowlistActive());
        assertTrue(vault.capsActive());
        assertTrue(vault.guarded());
        assertEq(vault.accountCap(address(usdg)), USDG_ACCOUNT);
        assertEq(vault.globalCap(address(usdg)), USDG_GLOBAL);
        assertEq(vault.accountCap(address(tsla)), TSLA_ACCOUNT);
        assertEq(vault.globalCap(address(tsla)), TSLA_GLOBAL);
        assertEq(vault.accountCap(address(amzn)), 0);
        assertEq(vault.globalCap(address(amzn)), 0);
        assertTrue(vault.isAllowlisted(alice));
        assertFalse(vault.isAllowlisted(dave));
    }

    function test_setup_emitsGuardSetup() public {
        (VelumVault v, address[] memory tokens) = _freshVault();
        (uint256[] memory a, uint256[] memory g) = _caps();
        vm.expectEmit(address(v));
        emit VelumVault.GuardSetup(admin, a, g);
        v.setup(tokens, new address[](0), new address[](0), admin, a, g);
        assertEq(v.guardAdmin(), admin);
    }

    function test_setup_rejectsBadGuardConfig() public {
        (VelumVault v, address[] memory tokens) = _freshVault();
        (uint256[] memory a, uint256[] memory g) = _caps();
        address[] memory none = new address[](0);
        uint256[] memory noCaps = new uint256[](0);
        address[] memory mods = _list(address(pools));
        address[] memory blocked = _list(address(oracle));

        // caps without an admin: refused, so a deployment is never believed to be guarded when it is not
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, none, none, address(0), a, noCaps);
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, none, none, address(0), noCaps, g);
        // an admin needs one cap of each kind per token
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, none, none, admin, noCaps, g);
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, none, none, admin, a, new uint256[](2));
        // an admin that could never act: the vault, a token, a module, a blocked protocol address
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, mods, blocked, address(v), a, g);
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, mods, blocked, address(usdg), a, g);
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, mods, blocked, address(pools), a, g);
        vm.expectRevert(VelumVault.BadGuardConfig.selector);
        v.setup(tokens, mods, blocked, address(oracle), a, g);
        // account cap above the global cap
        a[1] = TSLA_GLOBAL + 1;
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.BadCaps.selector, address(tsla), TSLA_GLOBAL + 1, TSLA_GLOBAL)
        );
        v.setup(tokens, none, none, admin, a, g);
        // a token listed twice would have two sets of caps
        address[] memory dup = new address[](2);
        dup[0] = address(usdg);
        dup[1] = address(usdg);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.DuplicateToken.selector, address(usdg)));
        v.setup(dup, none, none, address(0), noCaps, noCaps);
        assertFalse(v.locked(), "every refusal reverted the whole setup");
    }

    // ------------------------------------------------------------ allowlist

    function test_deposit_notAllowlistedReverts() public {
        _mintApprove(dave, usdg, 100 * USD);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, dave));
        vault.deposit(address(usdg), 100 * USD, dave);
        assertEq(usdg.balanceOf(dave), 100 * USD);
        assertEq(vault.totalInternal(address(usdg)), 0);
    }

    function test_deposit_payerAndRecipientMustBothBeAllowlisted() public {
        _mintApprove(alice, usdg, 300 * USD);
        _mintApprove(dave, usdg, 100 * USD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, dave));
        vault.deposit(address(usdg), 100 * USD, dave);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, dave));
        vault.deposit(address(usdg), 100 * USD, alice);
        vm.prank(alice);
        vault.deposit(address(usdg), 100 * USD, bob);
        assertEq(_bal(bob, usdg), 100 * USD);
        assertEq(vault.netDeposited(bob, address(usdg)), 100 * USD, "counts against the credited account");
        assertEq(vault.netDeposited(alice, address(usdg)), 0);
    }

    function test_addToAllowlist_onlyAdminBatchAndEvents() public {
        address[] memory list = new address[](3);
        list[0] = dave;
        list[1] = keeper;
        list[2] = dave;
        vm.prank(alice);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.addToAllowlist(list);

        vm.recordLogs();
        vm.prank(admin);
        vault.addToAllowlist(list);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "one event per new address");
        assertEq(logs[0].topics[0], VelumVault.Allowlisted.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(dave))));
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(keeper))));
        assertTrue(vault.isAllowlisted(dave) && vault.isAllowlisted(keeper));

        vm.recordLogs();
        vm.prank(admin);
        vault.addToAllowlist(_list(alice)); // already listed: skipped
        assertEq(vm.getRecordedLogs().length, 0);

        address[] memory bad = new address[](2);
        bad[0] = makeAddr("erin");
        vm.prank(admin);
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        vault.addToAllowlist(bad);
        assertFalse(vault.isAllowlisted(bad[0]), "the whole batch reverted");
    }

    function test_setApproval_needsAllowlistWhileGuarded() public {
        vm.startPrank(dave);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, dave));
        vault.setApproval(address(perps), true);
        vault.setApproval(address(perps), false); // revoking is always allowed
        vm.stopPrank();
        vm.prank(alice);
        vault.setApproval(address(perps), true);
        assertTrue(vault.approved(alice, address(perps)));

        _openToPublic();
        vm.prank(dave);
        vault.setApproval(address(perps), true);
        assertTrue(vault.approved(dave, address(perps)));
    }

    /// @notice A keeper that is not allowlisted can liquidate and withdraw its reward, but cannot use it in a module
    ///         while the allowlist is active (no approval), so it cannot open, post offers, add liquidity or swap.
    function test_notAllowlistedKeeper_liquidatesAndWithdrawsButCannotTrade() public {
        _fund(alice, usdg, USDG_ACCOUNT);
        uint256 offer = _postOffer(USDG_ACCOUNT, USDG_ACCOUNT, 5, 5);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 345e18);
        vm.prank(keeper);
        uint256 reward = perps.liquidate(id);
        assertGt(reward, 0);
        assertEq(_bal(keeper, usdg), reward);

        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, keeper));
        vault.setApproval(address(book), true);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotApproved.selector, keeper, address(book)));
        book.postOffer(address(tsla), reward, reward, 5, 5, uint64(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotApproved.selector, keeper, address(pools)));
        pools.swap(address(usdg), address(tsla), reward, 1, block.timestamp);
        vault.withdraw(address(usdg), reward, keeper);
        vm.stopPrank();
        assertEq(usdg.balanceOf(keeper), reward);
    }

    // ------------------------------------------------------------ caps

    function test_caps_perAccount() public {
        _deposit(alice, usdg, USDG_ACCOUNT);
        assertEq(vault.netDeposited(alice, address(usdg)), USDG_ACCOUNT);
        _mintApprove(alice, usdg, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VelumVault.AccountCapExceeded.selector, alice, address(usdg), USDG_ACCOUNT + 1, USDG_ACCOUNT
            )
        );
        vault.deposit(address(usdg), 1, alice);
    }

    function test_caps_global() public {
        address erin = makeAddr("erin");
        vm.prank(admin);
        vault.addToAllowlist(_list(erin));
        _deposit(alice, usdg, USDG_ACCOUNT);
        _deposit(bob, usdg, USDG_ACCOUNT);
        _deposit(carol, usdg, USDG_GLOBAL - 2 * USDG_ACCOUNT);
        assertEq(vault.totalInternal(address(usdg)), USDG_GLOBAL);
        _mintApprove(erin, usdg, 1);
        vm.prank(erin);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.GlobalCapExceeded.selector, address(usdg), USDG_GLOBAL + 1, USDG_GLOBAL)
        );
        vault.deposit(address(usdg), 1, erin);
        // a withdrawal frees global room at once
        vm.prank(alice);
        vault.withdraw(address(usdg), 10 * USD, alice);
        _deposit(erin, usdg, 10 * USD);
        assertEq(vault.totalInternal(address(usdg)), USDG_GLOBAL);
    }

    /// @notice Net of withdrawals: cycling deposits and withdrawals never takes an account above its cap.
    function test_caps_netOfWithdrawals_cyclingCannotBypass() public {
        _deposit(alice, usdg, USDG_ACCOUNT);
        vm.prank(alice);
        vault.withdraw(address(usdg), 400 * USD, alice);
        assertEq(vault.netDeposited(alice, address(usdg)), 600 * USD);
        vm.prank(alice);
        vault.deposit(address(usdg), 400 * USD, alice);
        for (uint256 i; i < 5; ++i) {
            vm.startPrank(alice);
            vault.withdraw(address(usdg), USDG_ACCOUNT, alice);
            vault.deposit(address(usdg), USDG_ACCOUNT, alice);
            vm.stopPrank();
        }
        assertEq(vault.netDeposited(alice, address(usdg)), USDG_ACCOUNT);
        assertEq(_bal(alice, usdg), USDG_ACCOUNT);
        _mintApprove(alice, usdg, 1);
        vm.prank(alice);
        vm.expectPartialRevert(VelumVault.AccountCapExceeded.selector);
        vault.deposit(address(usdg), 1, alice);
    }

    /// @notice Funds locked in a module still count: the cap is on net deposits, not on the free balance.
    function test_caps_lockedFundsStillCount() public {
        _fund(bob, usdg, USDG_ACCOUNT);
        vm.prank(bob);
        book.postOffer(address(tsla), USDG_ACCOUNT, USDG_ACCOUNT, 5, 5, uint64(block.timestamp + 1 days));
        assertEq(_bal(bob, usdg), 0);
        _mintApprove(bob, usdg, 1);
        vm.prank(bob);
        vm.expectPartialRevert(VelumVault.AccountCapExceeded.selector);
        vault.deposit(address(usdg), 1, bob);
    }

    /// @notice Withdrawing more than was deposited (profits) leaves zero, not credit: the account can bring at most
    ///         its cap again.
    function test_caps_profitWithdrawalFloorsAtZero() public {
        _fund(alice, usdg, USDG_ACCOUNT);
        uint256 offer = _postOffer(USDG_ACCOUNT, USDG_ACCOUNT, 5, 0);
        uint256 id = _open(alice, offer, true, 1000 * USD, 10);
        _movePriceTo(address(tsla), 411e18);
        vm.prank(alice);
        perps.close(id, 1);
        uint256 bal = _bal(alice, usdg);
        assertGt(bal, USDG_ACCOUNT, "alice made a profit");
        _withdrawAll(alice, usdg);
        assertEq(vault.netDeposited(alice, address(usdg)), 0);
        _deposit(alice, usdg, USDG_ACCOUNT);
        _mintApprove(alice, usdg, 1);
        vm.prank(alice);
        vm.expectPartialRevert(VelumVault.AccountCapExceeded.selector);
        vault.deposit(address(usdg), 1, alice);
    }

    /// @notice Caps are per token, in the token's own base units (USDG 6 decimals, stock tokens 18).
    function test_caps_perTokenDecimals() public {
        _deposit(alice, tsla, TSLA_ACCOUNT);
        _mintApprove(alice, tsla, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VelumVault.AccountCapExceeded.selector, alice, address(tsla), TSLA_ACCOUNT + 1, TSLA_ACCOUNT
            )
        );
        vault.deposit(address(tsla), 1, alice);
        _deposit(alice, usdg, USDG_ACCOUNT); // USDG has its own cap
        assertEq(vault.netDeposited(alice, address(tsla)), TSLA_ACCOUNT);
        assertEq(vault.netDeposited(alice, address(usdg)), USDG_ACCOUNT);
    }

    /// @notice A zero cap blocks deposits of that token until the admin raises it.
    function test_caps_zeroCapBlocksTokenUntilRaised() public {
        _mintApprove(alice, amzn, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.GlobalCapExceeded.selector, address(amzn), 1e18, 0));
        vault.deposit(address(amzn), 1e18, alice);
        vm.prank(admin);
        vault.raiseCaps(address(amzn), 1e18, 3e18);
        vm.prank(alice);
        vault.deposit(address(amzn), 1e18, alice);
        assertEq(_bal(alice, amzn), 1e18);
    }

    function test_withdraw_neverBlockedByCaps() public {
        _deposit(alice, usdg, USDG_ACCOUNT);
        _deposit(bob, usdg, USDG_ACCOUNT);
        _deposit(carol, usdg, USDG_GLOBAL - 2 * USDG_ACCOUNT); // global cap full
        vm.prank(alice);
        vault.withdraw(address(usdg), 1, alice);
        vm.prank(bob);
        vault.withdraw(address(usdg), USDG_ACCOUNT, carol); // to anyone
        _withdrawAll(alice, usdg);
        _withdrawAll(carol, usdg);
        assertEq(vault.totalInternal(address(usdg)), 0);
        assertEq(vault.netDeposited(alice, address(usdg)), 0);
        assertEq(vault.netDeposited(bob, address(usdg)), 0);
        assertEq(vault.netDeposited(carol, address(usdg)), 0);
    }

    // ------------------------------------------------------------ raiseCaps

    function test_raiseCaps() public {
        vm.prank(alice);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.raiseCaps(address(usdg), USDG_ACCOUNT, USDG_GLOBAL);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.UnknownToken.selector, address(oracle)));
        vault.raiseCaps(address(oracle), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.CapDecrease.selector, address(usdg)));
        vault.raiseCaps(address(usdg), USDG_ACCOUNT - 1, USDG_GLOBAL);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.CapDecrease.selector, address(usdg)));
        vault.raiseCaps(address(usdg), USDG_ACCOUNT, USDG_GLOBAL - 1);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.BadCaps.selector, address(usdg), USDG_GLOBAL + 1, USDG_GLOBAL)
        );
        vault.raiseCaps(address(usdg), USDG_GLOBAL + 1, USDG_GLOBAL);
        vm.expectEmit(address(vault));
        emit VelumVault.CapsRaised(address(usdg), 2 * USDG_ACCOUNT, 3 * USDG_GLOBAL);
        vault.raiseCaps(address(usdg), 2 * USDG_ACCOUNT, 3 * USDG_GLOBAL);
        vault.raiseCaps(address(usdg), 2 * USDG_ACCOUNT, 3 * USDG_GLOBAL); // unchanged is allowed
        vm.stopPrank();
        assertEq(vault.accountCap(address(usdg)), 2 * USDG_ACCOUNT);
        assertEq(vault.globalCap(address(usdg)), 3 * USDG_GLOBAL);
        _deposit(alice, usdg, 2 * USDG_ACCOUNT);
    }

    function test_raiseCaps_afterLiftReverts() public {
        _liftCaps();
        vm.prank(admin);
        vm.expectRevert(VelumVault.CapsInactive.selector);
        vault.raiseCaps(address(usdg), USDG_GLOBAL, USDG_GLOBAL);
    }

    // ------------------------------------------------------------ one-way switches

    function test_openToPublic() public {
        vm.prank(alice);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.openToPublic();
        vm.expectEmit(address(vault));
        emit VelumVault.OpenedToPublic();
        _openToPublic();
        assertFalse(vault.allowlistActive());
        assertTrue(vault.guarded(), "caps still active");
        assertEq(vault.guardAdmin(), admin, "admin keeps the caps");
        assertTrue(vault.isAllowed(dave));

        _deposit(dave, usdg, USDG_ACCOUNT); // anyone, caps still apply
        _mintApprove(dave, usdg, 1);
        vm.prank(dave);
        vm.expectPartialRevert(VelumVault.AccountCapExceeded.selector);
        vault.deposit(address(usdg), 1, dave);

        vm.startPrank(admin);
        vm.expectRevert(VelumVault.AllowlistInactive.selector);
        vault.openToPublic();
        vm.expectRevert(VelumVault.AllowlistInactive.selector);
        vault.addToAllowlist(_list(keeper));
        vm.stopPrank();
    }

    function test_liftCaps() public {
        vm.prank(bob);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.liftCaps();
        _deposit(alice, usdg, USDG_ACCOUNT);
        vm.expectEmit(address(vault));
        emit VelumVault.CapsLifted();
        _liftCaps();
        assertFalse(vault.capsActive());
        assertTrue(vault.guarded(), "allowlist still active");

        _deposit(alice, usdg, 10 * USDG_GLOBAL);
        assertEq(vault.netDeposited(alice, address(usdg)), USDG_ACCOUNT, "no tracking once caps are lifted");
        _withdrawAll(alice, usdg);
        assertEq(vault.netDeposited(alice, address(usdg)), USDG_ACCOUNT, "withdrawals leave it alone too");
        _mintApprove(dave, usdg, 1);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotAllowlisted.selector, dave));
        vault.deposit(address(usdg), 1, dave);

        vm.prank(admin);
        vm.expectRevert(VelumVault.CapsInactive.selector);
        vault.liftCaps();
    }

    /// @notice Both switches off (either order): the admin role is cleared, any pending handover too, and the vault
    ///         behaves exactly like an unguarded deployment.
    function test_bothOff_retiresAdmin() public {
        _retireCheck(true);
    }

    function test_bothOff_retiresAdmin_otherOrder() public {
        _retireCheck(false);
    }

    function _retireCheck(bool publicFirst) internal {
        address next = makeAddr("next-admin");
        vm.prank(admin);
        vault.transferGuardAdmin(next);
        if (publicFirst) _openToPublic();
        else _liftCaps();
        vm.expectEmit(address(vault));
        emit VelumVault.GuardAdminTransferred(admin, address(0));
        if (publicFirst) _liftCaps();
        else _openToPublic();
        assertEq(vault.guardAdmin(), address(0));
        assertEq(vault.pendingGuardAdmin(), address(0));
        assertFalse(vault.guarded());
        assertEq(vault.depositLimit(dave, address(usdg)), type(uint256).max);

        vm.startPrank(admin);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.addToAllowlist(_list(dave));
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.raiseCaps(address(usdg), USDG_GLOBAL, USDG_GLOBAL);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.openToPublic();
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.liftCaps();
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.transferGuardAdmin(admin);
        vm.stopPrank();
        vm.prank(next);
        vm.expectRevert(VelumVault.NotPendingGuardAdmin.selector);
        vault.acceptGuardAdmin();

        _deposit(dave, usdg, 10 * USDG_GLOBAL);
        vm.prank(dave);
        vault.setApproval(address(perps), true);
    }

    // ------------------------------------------------------------ admin handover

    function test_transferGuardAdmin_twoStep() public {
        address next = makeAddr("next-admin");
        vm.prank(alice);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.transferGuardAdmin(next);

        vm.expectEmit(address(vault));
        emit VelumVault.GuardAdminTransferStarted(admin, next);
        vm.prank(admin);
        vault.transferGuardAdmin(next);
        assertEq(vault.pendingGuardAdmin(), next);
        assertEq(vault.guardAdmin(), admin, "nothing changes before acceptance");

        vm.prank(alice);
        vm.expectRevert(VelumVault.NotPendingGuardAdmin.selector);
        vault.acceptGuardAdmin();

        vm.expectEmit(address(vault));
        emit VelumVault.GuardAdminTransferred(admin, next);
        vm.prank(next);
        vault.acceptGuardAdmin();
        assertEq(vault.guardAdmin(), next);
        assertEq(vault.pendingGuardAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(VelumVault.NotGuardAdmin.selector);
        vault.addToAllowlist(_list(dave));
        vm.prank(next);
        vault.addToAllowlist(_list(dave));
        assertTrue(vault.isAllowlisted(dave));
    }

    function test_transferGuardAdmin_cancel() public {
        address next = makeAddr("next-admin");
        vm.startPrank(admin);
        vault.transferGuardAdmin(next);
        vault.transferGuardAdmin(address(0));
        vm.stopPrank();
        vm.prank(next);
        vm.expectRevert(VelumVault.NotPendingGuardAdmin.selector);
        vault.acceptGuardAdmin();
        // nobody can accept a zero proposal, not even a call from address zero
        vm.prank(address(0));
        vm.expectRevert(VelumVault.NotPendingGuardAdmin.selector);
        vault.acceptGuardAdmin();
        assertEq(vault.guardAdmin(), admin);
    }

    // ------------------------------------------------------------ views

    function test_views() public {
        assertTrue(vault.isAllowed(alice));
        assertFalse(vault.isAllowed(dave));
        assertEq(vault.depositLimit(alice, address(usdg)), USDG_ACCOUNT);
        assertEq(vault.depositLimit(alice, address(tsla)), TSLA_ACCOUNT);
        assertEq(vault.depositLimit(alice, address(amzn)), 0);
        assertEq(vault.depositLimit(dave, address(usdg)), 0, "not allowlisted");
        assertEq(vault.depositLimit(alice, address(oracle)), 0, "not a listed token");
        _deposit(alice, usdg, 600 * USD);
        assertEq(vault.depositLimit(alice, address(usdg)), 400 * USD);
        _deposit(bob, usdg, USDG_ACCOUNT);
        _deposit(carol, usdg, 800 * USD);
        assertEq(vault.depositLimit(alice, address(usdg)), 100 * USD, "global room is smaller");
        assertEq(vault.depositLimit(carol, address(usdg)), 100 * USD);
        vm.prank(carol);
        vault.withdraw(address(usdg), 800 * USD, carol);
        assertEq(vault.depositLimit(carol, address(usdg)), 900 * USD, "global room again");
        assertEq(vault.depositLimit(alice, address(usdg)), 400 * USD);

        _openToPublic();
        assertTrue(vault.isAllowed(dave));
        assertEq(vault.depositLimit(dave, address(usdg)), 900 * USD);
        // addresses that can never receive a deposit
        assertEq(vault.depositLimit(address(perps), address(usdg)), 0);
        assertEq(vault.depositLimit(address(oracle), address(usdg)), 0);
        assertEq(vault.depositLimit(address(vault), address(usdg)), 0);
        assertEq(vault.depositLimit(address(tsla), address(usdg)), 0);
        assertEq(vault.depositLimit(address(0), address(usdg)), 0);
        _liftCaps();
        assertEq(vault.depositLimit(dave, address(amzn)), type(uint256).max);
        assertEq(new VelumVault().depositLimit(dave, address(usdg)), 0, "not set up");
    }

    // ------------------------------------------------------------ exits are never blocked

    /// @notice Every way out works for everyone with the guard fully active and every cap used up: withdrawals,
    ///         closes, offer withdrawals, liquidity removal, liquidations and forced exits by an address that is not
    ///         allowlisted, and cover/bond claims.
    function test_exitsNeverBlocked() public {
        _fund(alice, usdg, USDG_ACCOUNT);
        _fund(bob, usdg, USDG_ACCOUNT);
        _fund(carol, usdg, USDG_GLOBAL - 2 * USDG_ACCOUNT);
        _fund(carol, tsla, TSLA_ACCOUNT);
        assertEq(vault.depositLimit(carol, address(usdg)), 0);
        vm.prank(bob);
        uint256 offer = book.postOffer(address(tsla), 800 * USD, 800 * USD, 5, 5, uint64(block.timestamp + 30 days));
        uint256 a = _open(alice, offer, true, 800 * USD, 10);
        uint256 b = _open(alice, offer, false, 800 * USD, 10);
        vm.prank(carol);
        pools.addLiquidity(address(tsla), 1e18, 400 * USD, 1, block.timestamp);

        vm.prank(alice);
        perps.requestForcedExit{value: 0.001 ether}(b);
        _movePriceTo(address(tsla), 345e18); // long a becomes liquidatable
        vm.prank(keeper);
        perps.liquidate(a);
        vm.warp(block.timestamp + 7 days);
        _pushPrice(address(tsla), 345e18);
        vm.prank(keeper);
        perps.settleForcedExit(b);
        vm.prank(alice);
        perps.claimBond();
        vm.prank(bob);
        book.withdrawOffer(offer);
        uint256 shares = pools.sharesOf(address(tsla), carol);
        vm.prank(carol);
        pools.removeLiquidity(address(tsla), shares, 1, 1, block.timestamp);

        address[5] memory everyone = [alice, bob, carol, keeper, address(liquidator)];
        for (uint256 i; i < everyone.length; ++i) {
            _withdrawAll(everyone[i], usdg);
            _withdrawAll(everyone[i], tsla);
        }
        assertEq(_bal(keeper, usdg), 0);
        assertGt(usdg.balanceOf(keeper), 0, "the keeper withdrew its rewards");
        assertEq(vault.totalInternal(address(usdg)), _bal(address(perps), usdg) + _bal(address(pools), usdg));
        assertEq(perps.totalMargin(), 0);
    }

    // ------------------------------------------------------------ fuzz

    /// @dev Ghost copy of `netDeposited` for the sequence fuzz test (fresh for every run).
    mapping(address account => mapping(address token => uint256)) internal _ghostNet;

    function _fuzzActors() internal view returns (address[5] memory) {
        return [alice, bob, carol, dave, keeper];
    }

    /// @notice A random sequence of deposits (to self and to others), withdrawals, cap raises and the two switches by
    ///         allowlisted and other accounts: caps are never exceeded while active, nobody outside the allowlist ever
    ///         adds funds while it is active, withdrawals never revert, and net deposits follow a ghost copy.
    function testFuzz_guardSequence(uint256 seed) public {
        for (uint256 step; step < 40; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            _fuzzStep(seed);
            _checkCaps();
        }
        address[5] memory who = _fuzzActors();
        for (uint256 i; i < 5; ++i) {
            _withdrawAll(who[i], usdg);
            _withdrawAll(who[i], tsla);
        }
        assertEq(vault.totalInternal(address(usdg)), 0);
        assertEq(vault.totalInternal(address(tsla)), 0);
    }

    function _fuzzStep(uint256 seed) internal {
        address[5] memory who = _fuzzActors();
        uint256 op = seed % 16;
        address a = who[(seed >> 8) % 5];
        MockERC20 t = (seed >> 32) % 2 == 0 ? usdg : tsla;
        uint256 amount = ((seed >> 40) % 1200 + 1) * (t == usdg ? USD : 1e16);
        if (op < 7) {
            _fuzzDeposit(a, (seed >> 16) % 4 == 0 ? who[(seed >> 24) % 5] : a, t, amount);
        } else if (op < 12) {
            uint256 bal = _bal(a, t);
            if (bal == 0) return;
            amount = amount % bal + 1;
            vm.prank(a);
            vault.withdraw(address(t), amount, a); // must never revert
            if (vault.capsActive()) {
                uint256 g = _ghostNet[a][address(t)];
                _ghostNet[a][address(t)] = g > amount ? g - amount : 0;
            }
        } else if (op == 12 && vault.capsActive()) {
            uint256 accountNext = vault.accountCap(address(t)) + amount;
            uint256 globalNext = vault.globalCap(address(t)) + 2 * amount;
            vm.prank(admin);
            vault.raiseCaps(address(t), accountNext, globalNext);
        } else if (op == 13 && vault.allowlistActive() && (seed >> 48) % 4 == 0) {
            _openToPublic();
        } else if (op == 14 && vault.capsActive() && (seed >> 48) % 4 == 0) {
            _liftCaps();
        } else if (op == 15 && vault.allowlistActive()) {
            vm.prank(admin);
            vault.addToAllowlist(_list(a));
        }
    }

    function _checkCaps() internal view {
        assertEq(vault.guardAdmin() != address(0), vault.guarded(), "admin exists iff guarded");
        if (!vault.capsActive()) return;
        address[5] memory who = _fuzzActors();
        address[2] memory tok = [address(usdg), address(tsla)];
        for (uint256 j; j < 2; ++j) {
            assertLe(vault.totalInternal(tok[j]), vault.globalCap(tok[j]), "global cap");
            for (uint256 i; i < 5; ++i) {
                uint256 net = vault.netDeposited(who[i], tok[j]);
                assertEq(net, _ghostNet[who[i]][tok[j]], "net deposits");
                assertLe(net, vault.accountCap(tok[j]), "account cap");
            }
        }
    }

    function _fuzzDeposit(address a, address to, MockERC20 t, uint256 amount) internal {
        _mintApprove(a, t, amount);
        bool listed = !vault.allowlistActive() || (vault.isAllowlisted(a) && vault.isAllowlisted(to));
        bool capped = vault.capsActive()
            && (vault.netDeposited(to, address(t)) + amount > vault.accountCap(address(t))
                || vault.totalInternal(address(t)) + amount > vault.globalCap(address(t)));
        uint256 before = vault.totalInternal(address(t));
        vm.prank(a);
        try vault.deposit(address(t), amount, to) {
            assertTrue(listed && !capped, "deposit the guard should have refused");
            if (vault.capsActive()) _ghostNet[to][address(t)] += amount;
        } catch (bytes memory err) {
            assertFalse(listed && !capped, "deposit refused for no guard reason");
            bytes4 sel = bytes4(err);
            assertTrue(
                sel == VelumVault.NotAllowlisted.selector || sel == VelumVault.AccountCapExceeded.selector
                    || sel == VelumVault.GlobalCapExceeded.selector,
                "refused with a guard error"
            );
            assertEq(vault.totalInternal(address(t)), before);
        }
    }

    /// @notice No admin action changes any balance, internal or token, in any state of the guard.
    function testFuzz_adminCannotChangeBalances(uint8 op, uint256 amount, bool openFirst, bool liftFirst) public {
        _fund(alice, usdg, 700 * USD);
        _fund(bob, tsla, 1e18);
        uint256 offer = _postOffer(600 * USD, 600 * USD, 5, 5);
        _open(alice, offer, true, 500 * USD, 6);
        if (openFirst) _openToPublic();
        if (liftFirst && vault.capsActive()) _liftCaps();
        bytes32 before = _snapshot();
        amount = bound(amount, 0, 1e30);
        vm.startPrank(admin);
        uint256 k = op % 6;
        if (k == 0) {
            try vault.addToAllowlist(_list(dave)) {} catch {}
        } else if (k == 1) {
            try vault.raiseCaps(address(usdg), USDG_ACCOUNT + amount, USDG_GLOBAL + amount) {} catch {}
        } else if (k == 2) {
            try vault.openToPublic() {} catch {}
        } else if (k == 3) {
            try vault.liftCaps() {} catch {}
        } else if (k == 4) {
            try vault.transferGuardAdmin(dave) {} catch {}
        } else {
            try vault.raiseCaps(address(tsla), TSLA_ACCOUNT + amount, TSLA_GLOBAL + amount) {} catch {}
        }
        vm.stopPrank();
        assertEq(_snapshot(), before, "an admin action moved funds");
    }

    function _snapshot() internal view returns (bytes32 h) {
        address[8] memory accts =
            [alice, bob, carol, dave, address(vault), address(perps), address(book), address(pools)];
        MockERC20[3] memory toks = [usdg, tsla, amzn];
        for (uint256 i; i < accts.length; ++i) {
            for (uint256 j; j < 3; ++j) {
                h = keccak256(abi.encode(h, vault.balanceOf(accts[i], address(toks[j])), toks[j].balanceOf(accts[i])));
            }
        }
        for (uint256 j; j < 3; ++j) {
            h = keccak256(abi.encode(h, vault.totalInternal(address(toks[j]))));
        }
        h = keccak256(abi.encode(h, perps.totalMargin(), perps.insurance(), book.totalBacking()));
    }
}

/// @notice An unguarded deployment (guard admin zero, the testnet default): open to everyone with no caps, no admin.
contract LaunchGuardUnguardedTest is VelumBase {
    address internal dave = makeAddr("dave");

    function test_unguarded_stateAndViews() public view {
        assertEq(vault.guardAdmin(), address(0));
        assertFalse(vault.allowlistActive());
        assertFalse(vault.capsActive());
        assertFalse(vault.guarded());
        assertTrue(vault.isAllowed(dave));
        assertEq(vault.depositLimit(dave, address(usdg)), type(uint256).max);
    }

    function test_unguarded_anyoneDepositsAnyAmountWithoutTracking() public {
        _fund(dave, usdg, 10_000_000 * USD);
        assertEq(_bal(dave, usdg), 10_000_000 * USD);
        assertEq(vault.netDeposited(dave, address(usdg)), 0);
        vm.prank(dave);
        vault.withdraw(address(usdg), 1, dave);
    }

    function test_unguarded_noAdminPowers() public {
        address[] memory list = new address[](1);
        list[0] = dave;
        // not even a call from address zero (which an unguarded vault stores as its admin) gets through
        address[2] memory callers = [dave, address(0)];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(VelumVault.NotGuardAdmin.selector);
            vault.addToAllowlist(list);
            vm.expectRevert(VelumVault.NotGuardAdmin.selector);
            vault.raiseCaps(address(usdg), 1, 1);
            vm.expectRevert(VelumVault.NotGuardAdmin.selector);
            vault.openToPublic();
            vm.expectRevert(VelumVault.NotGuardAdmin.selector);
            vault.liftCaps();
            vm.expectRevert(VelumVault.NotGuardAdmin.selector);
            vault.transferGuardAdmin(dave);
            vm.expectRevert(VelumVault.NotPendingGuardAdmin.selector);
            vault.acceptGuardAdmin();
            vm.stopPrank();
        }
    }

    function test_unguarded_emitsGuardSetupWithZeroAdmin() public {
        VelumVault v = new VelumVault();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        uint256[] memory none = new uint256[](0);
        vm.expectEmit(address(v));
        emit VelumVault.GuardSetup(address(0), none, none);
        v.setup(tokens, new address[](0), new address[](0), address(0), none, none);
    }
}

/// @notice Deploy script: guard configuration checks, the operator notice, and the mainnet refusal with a guard set.
contract LaunchGuardDeployTest is Test {
    function _caps(uint256 a0, uint256 g0, uint256 a1, uint256 g1)
        internal
        pure
        returns (uint256[] memory a, uint256[] memory g)
    {
        a = new uint256[](2);
        g = new uint256[](2);
        (a[0], g[0], a[1], g[1]) = (a0, g0, a1, g1);
    }

    function test_checkGuard() public {
        Deploy d = new Deploy();
        address admin = makeAddr("owner-multisig");
        address relay = makeAddr("relay");
        (uint256[] memory a, uint256[] memory g) = _caps(1000e6, 50_000e6, 2e18, 100e18);
        d.checkGuard(admin, relay, a, g);
        d.checkGuard(address(0), relay, new uint256[](0), new uint256[](0)); // unguarded
        vm.expectRevert(bytes("Velum: guard caps given but GUARD_ADMIN is not set"));
        d.checkGuard(address(0), relay, a, g);
        vm.expectRevert(bytes("Velum: GUARD_ADMIN must not be the price-relay key"));
        d.checkGuard(relay, relay, a, g);
        vm.expectRevert(bytes("Velum: guard caps differ in length"));
        d.checkGuard(admin, relay, a, new uint256[](1));
        (a, g) = _caps(1000e6, 50_000e6, 101e18, 100e18);
        vm.expectRevert(bytes("Velum: a GUARD_ACCOUNT_CAP is above its GUARD_GLOBAL_CAP"));
        d.checkGuard(admin, relay, a, g);
    }

    function test_guardNotice() public {
        Deploy d = new Deploy();
        string[] memory symbols = new string[](2);
        symbols[0] = "USDG";
        symbols[1] = "TSLA";
        uint8[] memory decimals = new uint8[](2);
        decimals[0] = 6;
        decimals[1] = 18;
        string memory off = d.guardNotice(address(0), symbols, decimals, new uint256[](0), new uint256[](0));
        assertTrue(vm.contains(off, "launch guard OFF"));
        assertTrue(vm.contains(off, "testnet default"));

        address admin = makeAddr("owner-multisig");
        (uint256[] memory a, uint256[] memory g) = _caps(1000e6, 50_000e6, 2e18, 100e18);
        string memory on = d.guardNotice(admin, symbols, decimals, a, g);
        assertTrue(vm.contains(on, "launch guard ON"));
        assertTrue(vm.contains(on, vm.toString(admin)));
        assertTrue(vm.contains(on, "cannot move, freeze or redirect funds, block withdrawals"));
        assertTrue(vm.contains(on, "USDG: 1000 / 50000 tokens (base units 1000000000 / 50000000000)"));
        assertTrue(vm.contains(on, "TSLA: 2 / 100 tokens (base units 2000000000000000000 / 100000000000000000000)"));
    }

    /// @notice A guard configuration does not get the script past the mainnet refusal (it is the first check).
    function test_deployStillRefusesMainnetWithGuard() public {
        Deploy d = new Deploy();
        vm.setEnv("GUARD_ADMIN", vm.toString(makeAddr("owner-multisig")));
        vm.chainId(4663);
        vm.expectRevert(
            bytes(
                "Velum: refusing Robinhood Chain mainnet (4663). Mainnet needs the Phase 5 external audit of contracts and circuits."
            )
        );
        d.run();
    }
}
