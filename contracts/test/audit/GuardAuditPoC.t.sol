// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "../Base.t.sol";
import {VelumVault} from "../../src/VelumVault.sol";

/// @notice Independent audit of the launch guard: the liveness findings G-01 and G-02, as regressions. Each test runs
///         the auditor's scenario (alice taker, bob maker, carol and dave other beta users, all allowlisted) against
///         the fixed vault. The auditor's caps (USDG 3,000 per account / 6,000 global for four addresses) are now
///         refused; the scenarios run at USDG 3,000 / 12,000 and TSLA 2 / 8 tokens, the smallest global caps that cover
///         four account caps (G-01: globalCap >= accountCap x allowlisted).
contract GuardAuditPoC is VelumBase {
    address internal admin = makeAddr("guard-admin");
    address internal dave = makeAddr("dave");

    function _guardConfig() internal view override returns (address, uint256[] memory, uint256[] memory) {
        return _guardCaps(admin, 3000 * USD, 12_000 * USD, 2e18, 8e18);
    }

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        vault.addToAllowlist(_four());
    }

    function _four() internal view returns (address[] memory l) {
        l = new address[](4);
        (l[0], l[1], l[2], l[3]) = (alice, bob, carol, dave);
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _mintApprove(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.prank(who);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        _mintApprove(who, amount);
        vm.prank(who);
        vault.deposit(address(usdg), amount, who);
    }

    /// @dev bob deposits 2,000 and posts a 1,950 USDG offer; alice deposits 400 and opens a 1,900 USDG 5x long
    ///      (margin 380, fee 1.14).
    function _openNearCap() internal returns (uint256 pid) {
        _fund(bob, usdg, 2000 * USD);
        uint256 offer = _postOffer(1950 * USD, 1950 * USD, 2, 0);
        _fund(alice, usdg, 400 * USD);
        pid = _open(alice, offer, true, 1900 * USD, 10);
    }

    /// @dev alice deposits 200, adds it as margin, and the price falls to 347: she survives.
    function _topUpSurvives(uint256 pid) internal {
        _mintApprove(alice, 200 * USD);
        vm.startPrank(alice);
        vault.deposit(address(usdg), 200 * USD, alice);
        perps.addMargin(pid, 200 * USD);
        vm.stopPrank();
        _movePriceTo(address(tsla), 347e18);
        assertFalse(perps.isLiquidatable(pid), "the top-up went through and saved the position");
    }

    // ------------------------------------------------------------------ G-01

    /// @notice G-01 (Medium), fixed: the auditor's configuration (four addresses on 6,000 USDG of global room at 3,000
    ///         each) is refused at allowlisting, so the global cap can no longer be one room the accounts share.
    function test_G01_oversubscribedConfigurationRefused_fixed() public {
        VelumVault v = new VelumVault();
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdg), address(tsla));
        uint256[] memory a = new uint256[](2);
        uint256[] memory g = new uint256[](2);
        (a[0], g[0], a[1], g[1]) = (3000 * USD, 6000 * USD, 2e18, 5e18);
        v.setup(tokens, new address[](0), new address[](0), admin, a, g);
        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), 3000 * USD, 6000 * USD, 4)
        );
        v.addToAllowlist(_four());
        address[] memory two = new address[](2);
        (two[0], two[1]) = (alice, bob);
        v.addToAllowlist(two); // two fit in 6,000 USDG and 5 TSLA
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), 3000 * USD, 6000 * USD, 3)
        );
        v.addToAllowlist(_one(carol));
        vm.stopPrank();
        assertEq(v.allowlistedCount(), 2);
    }

    /// @notice G-01, front-run variant, fixed: bob (the maker on the other side) fills ALL of his remaining room right
    ///         before alice's top-up, and dave and carol fill theirs too; alice's top-up still goes through and saves
    ///         the position. Her room never depended on anyone else's deposits.
    function test_G01_frontRunCannotBlockMarginTopUp_fixed() public {
        uint256 pid = _openNearCap();
        _deposit(carol, 3000 * USD); // organic usage
        _movePriceTo(address(tsla), 352e18);
        assertFalse(perps.isLiquidatable(pid), "not yet liquidatable");
        assertEq(vault.depositLimit(alice, address(usdg)), 2600 * USD, "alice's own room");

        uint256 bobRoom = vault.depositLimit(bob, address(usdg));
        assertEq(bobRoom, 1000 * USD);
        _deposit(bob, bobRoom); // the front-run: everything bob can deposit
        _deposit(dave, 3000 * USD);
        assertEq(vault.depositLimit(bob, address(usdg)), 0);
        assertEq(vault.depositLimit(alice, address(usdg)), 2600 * USD, "unchanged by everyone else's deposits");

        _topUpSurvives(pid);
        assertEq(vault.depositLimit(alice, address(usdg)), 2400 * USD, "alice keeps the rest of her room");
    }

    /// @notice G-01, organic variant, fixed: every other account at its full cap (the normal state of a popular capped
    ///         beta) and alice can still add margin.
    function test_G01b_fullBetaCannotBlockTopUp_fixed() public {
        uint256 pid = _openNearCap();
        _deposit(bob, 1000 * USD);
        _deposit(carol, 3000 * USD);
        _deposit(dave, 3000 * USD);
        _movePriceTo(address(tsla), 352e18);
        _topUpSurvives(pid);
    }

    /// @notice G-01, admin variant, fixed: the guard admin cannot allowlist an address of its own without first raising
    ///         the global cap by a whole account cap, which is exactly the room the new address can take. Filling it
    ///         leaves alice's room untouched; a second sybil needs another raise.
    function test_G01c_adminSybilCannotFillOthersRoom_fixed() public {
        uint256 pid = _openNearCap();
        address sybil = makeAddr("admin-sybil");
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), 3000 * USD, 12_000 * USD, 5)
        );
        vault.addToAllowlist(_one(sybil));

        vm.startPrank(admin);
        vault.raiseCaps(address(usdg), 3000 * USD, 15_000 * USD);
        vault.raiseCaps(address(tsla), 2e18, 10e18);
        vault.raiseCaps(address(amzn), 2e18, 10e18);
        vault.addToAllowlist(_one(sybil));
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.Oversubscribed.selector, address(usdg), 3000 * USD, 15_000 * USD, 6)
        );
        vault.addToAllowlist(_one(makeAddr("admin-sybil-2")));
        vm.stopPrank();
        _deposit(sybil, 3000 * USD); // everything the sybil can take
        assertEq(vault.depositLimit(sybil, address(usdg)), 0);
        assertEq(vault.depositLimit(alice, address(usdg)), 2600 * USD);

        _movePriceTo(address(tsla), 352e18);
        _topUpSurvives(pid);
    }

    /// @notice G-01: the global check never refuses while the allowlist is on. Whatever the other accounts did, every
    ///         allowlisted account can deposit exactly its own remaining account room, and not one unit more (refused by
    ///         its own account cap, never by the global cap).
    function testFuzz_G01_accountRoomAlwaysAvailable_fixed(uint256[4] memory amounts, uint8 who) public {
        address[] memory l = _four();
        for (uint256 i; i < 4; ++i) {
            uint256 room = vault.depositLimit(l[i], address(usdg));
            uint256 amt = bound(amounts[i], 0, room);
            if (amt != 0) _deposit(l[i], amt);
        }
        address x = l[who % 4];
        uint256 left = vault.depositLimit(x, address(usdg));
        assertEq(left, 3000 * USD - vault.netDeposited(x, address(usdg)), "room is the account room");
        if (left != 0) _deposit(x, left);
        _mintApprove(x, 1);
        vm.prank(x);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.AccountCapExceeded.selector, x, address(usdg), 3000 * USD + 1, 3000 * USD)
        );
        vault.deposit(address(usdg), 1, x);
    }

    /// @notice G-01: caps never apply without the allowlist. `openToPublic` is refused while caps are active (open to
    ///         everyone, the global cap would again be room anyone, sybils included, could fill); after `liftCaps` it
    ///         opens and retires the guard.
    function test_G01_openToPublicNeedsCapsLifted_fixed() public {
        vm.prank(admin);
        vm.expectRevert(VelumVault.CapsStillActive.selector);
        vault.openToPublic();
        vm.startPrank(admin);
        vault.liftCaps();
        vault.openToPublic();
        vm.stopPrank();
        assertFalse(vault.guarded());
        assertEq(vault.guardAdmin(), address(0));
    }

    // ------------------------------------------------------------------ G-02

    /// @notice G-02 (Low), documented (no code change; contracts/README.md, Guarded launch): room is tracked as lifetime
    ///         net deposits, so losses never give it back. An account that deposited up to its cap and lost more than
    ///         half of it cannot deposit a single unit, although what it still holds is under half its cap; after it
    ///         leaves with what remains its room stays cut. The winning counterparty withdraws its gains and gets its
    ///         full cap back at once. Operators size account caps at least 2x the margin a tester is expected to need,
    ///         and the UI shows `depositLimit`.
    function test_G02_lossesNeverRestoreRoomWinnersResetToZero_fixed() public {
        _fund(bob, usdg, 3000 * USD);
        uint256 offer = _postOffer(2950 * USD, 2950 * USD, 2, 0);
        _fund(alice, usdg, 3000 * USD); // alice at her account cap
        uint256 pid = _open(alice, offer, true, 2900 * USD, 2); // 1x long, margin 2,900

        _movePriceTo(address(tsla), 180e18); // -54%
        assertFalse(perps.isLiquidatable(pid));
        int256 claim = perps.takerClaimAt(pid, _effectivePrice(address(tsla)));
        uint256 holds = uint256(claim) + _bal(alice, usdg);
        assertLt(holds, 1500 * USD, "alice holds under half her cap");
        assertEq(vault.depositLimit(alice, address(usdg)), 0, "but she cannot deposit anything");
        assertGt(vault.globalCap(address(usdg)) - vault.totalInternal(address(usdg)), 0, "global room is not the issue");
        _mintApprove(alice, 1 * USD);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.AccountCapExceeded.selector, alice, address(usdg), 3001 * USD, 3000 * USD)
        );
        vault.deposit(address(usdg), 1 * USD, alice);

        vm.prank(alice);
        perps.close(pid, 1);
        vm.prank(bob);
        book.withdrawOffer(offer);
        // Everyone leaves with everything they have.
        uint256 aliceLeft = _bal(alice, usdg);
        vm.prank(alice);
        vault.withdraw(address(usdg), aliceLeft, alice);
        uint256 bobLeft = _bal(bob, usdg);
        vm.prank(bob);
        vault.withdraw(address(usdg), bobLeft, bob);

        assertEq(vault.netDeposited(bob, address(usdg)), 0, "winner: full room back");
        assertEq(vault.depositLimit(bob, address(usdg)), 3000 * USD);
        assertGt(vault.netDeposited(alice, address(usdg)), 1500 * USD, "loser holds nothing, room cut by over half");
        assertLt(vault.depositLimit(alice, address(usdg)), 1500 * USD);
        // the admin can give everyone more room by raising the account cap (with the global room it needs)
        vm.prank(admin);
        vault.raiseCaps(address(usdg), 6000 * USD, 24_000 * USD);
        assertGe(vault.depositLimit(alice, address(usdg)), 3000 * USD);
    }
}
