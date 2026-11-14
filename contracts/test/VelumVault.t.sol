// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {VelumVault} from "../src/VelumVault.sol";
import {MockERC20, FeeOnTransferToken} from "./mocks/MockERC20.sol";

contract VelumVaultTest is VelumBase {
    function test_setup_onlyDeployerOnce() public {
        VelumVault v = new VelumVault();
        address[] memory none = new address[](0);
        vm.prank(alice);
        vm.expectRevert(VelumVault.NotDeployer.selector);
        v.setup(none, none, none);
        v.setup(none, none, none);
        assertTrue(v.locked());
        vm.expectRevert(VelumVault.AlreadySetUp.selector);
        v.setup(none, none, none);
    }

    function test_setup_rejectsZeroAddresses() public {
        VelumVault v = new VelumVault();
        address[] memory bad = new address[](1);
        address[] memory none = new address[](0);
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        v.setup(bad, none, none);
        VelumVault v2 = new VelumVault();
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        v2.setup(none, bad, none);
        VelumVault v3 = new VelumVault();
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        v3.setup(none, none, bad);
    }

    function test_deposit_beforeSetupReverts() public {
        VelumVault v = new VelumVault();
        vm.expectRevert(VelumVault.NotSetUp.selector);
        v.deposit(address(usdg), 1, alice);
    }

    function test_deposit_credits() public {
        usdg.mint(alice, 1000 * USD);
        vm.startPrank(alice);
        usdg.approve(address(vault), type(uint256).max);
        vm.expectEmit(address(vault));
        emit VelumVault.Deposited(alice, carol, address(usdg), 1000 * USD);
        uint256 got = vault.deposit(address(usdg), 1000 * USD, carol);
        vm.stopPrank();
        assertEq(got, 1000 * USD);
        assertEq(_bal(carol, usdg), 1000 * USD);
        assertEq(vault.totalInternal(address(usdg)), 1000 * USD);
        assertEq(usdg.balanceOf(address(vault)), 1000 * USD);
    }

    function test_deposit_rejects() public {
        MockERC20 other = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.UnknownToken.selector, address(other)));
        vault.deposit(address(other), 1, alice);
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        vault.deposit(address(usdg), 1, address(0));
        vm.expectRevert(VelumVault.ZeroAmount.selector);
        vault.deposit(address(usdg), 0, alice);
    }

    /// @notice Audit I-1: a deposit credited to a module would be stranded, so it is refused.
    function test_deposit_toModuleRejected() public {
        usdg.mint(alice, 300 * USD);
        vm.startPrank(alice);
        usdg.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.ModuleRecipient.selector, address(perps)));
        vault.deposit(address(usdg), 100 * USD, address(perps));
        vm.expectRevert(abi.encodeWithSelector(VelumVault.ModuleRecipient.selector, address(book)));
        vault.deposit(address(usdg), 100 * USD, address(book));
        vm.expectRevert(abi.encodeWithSelector(VelumVault.ModuleRecipient.selector, address(pools)));
        vault.deposit(address(usdg), 100 * USD, address(pools));
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice), 300 * USD);
    }

    function test_deposit_feeOnTransferCreditsReceived() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        VelumVault v = new VelumVault();
        address[] memory tokens = new address[](1);
        tokens[0] = address(fee);
        v.setup(tokens, new address[](0), new address[](0));
        fee.mint(alice, 1000e18);
        vm.startPrank(alice);
        fee.approve(address(v), type(uint256).max);
        uint256 got = v.deposit(address(fee), 1000e18, alice);
        vm.stopPrank();
        assertEq(got, 990e18);
        assertEq(v.balanceOf(alice, address(fee)), 990e18);
        assertEq(v.totalInternal(address(fee)), fee.balanceOf(address(v)));
    }

    function test_withdraw() public {
        _fund(alice, usdg, 500 * USD);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VelumVault.InsufficientBalance.selector, alice, address(usdg), 500 * USD, 501 * USD)
        );
        vault.withdraw(address(usdg), 501 * USD, alice);
        vm.prank(alice);
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        vault.withdraw(address(usdg), 1, address(0));
        vm.prank(alice);
        vm.expectRevert(VelumVault.ZeroAmount.selector);
        vault.withdraw(address(usdg), 0, alice);
        vm.prank(alice);
        vault.withdraw(address(usdg), 200 * USD, carol);
        assertEq(usdg.balanceOf(carol), 200 * USD);
        assertEq(_bal(alice, usdg), 300 * USD);
        assertEq(vault.totalInternal(address(usdg)), 300 * USD);
    }

    function test_setApproval_onlyModules() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotModule.selector, carol));
        vault.setApproval(carol, true);
        vm.prank(alice);
        vault.setApproval(address(pools), true);
        assertTrue(vault.approved(alice, address(pools)));
        vm.prank(alice);
        vault.setApproval(address(pools), false);
        assertFalse(vault.approved(alice, address(pools)));
    }

    function test_transferInternal_permissions() public {
        usdg.mint(alice, 100 * USD);
        vm.startPrank(alice);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(address(usdg), 100 * USD, alice);
        vm.stopPrank();

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotModule.selector, carol));
        vault.transferInternal(address(usdg), alice, carol, 1);

        vm.prank(address(pools));
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotApproved.selector, alice, address(pools)));
        vault.transferInternal(address(usdg), alice, carol, 1);

        vm.prank(alice);
        vault.setApproval(address(pools), true);
        vm.prank(address(pools));
        vault.transferInternal(address(usdg), alice, address(pools), 40 * USD);
        assertEq(_bal(address(pools), usdg), 40 * USD);

        // a module can move its own balance without approval, but not another module's
        vm.prank(address(pools));
        vault.transferInternal(address(usdg), address(pools), carol, 10 * USD);
        assertEq(_bal(carol, usdg), 10 * USD);
        vm.prank(address(book));
        vm.expectRevert(abi.encodeWithSelector(VelumVault.NotApproved.selector, address(pools), address(book)));
        vault.transferInternal(address(usdg), address(pools), carol, 1);

        vm.prank(address(pools));
        vm.expectRevert(VelumVault.ZeroAddress.selector);
        vault.transferInternal(address(usdg), address(pools), address(0), 1);

        vm.prank(address(pools));
        vm.expectRevert(
            abi.encodeWithSelector(
                VelumVault.InsufficientBalance.selector, address(pools), address(usdg), 30 * USD, 31 * USD
            )
        );
        vault.transferInternal(address(usdg), address(pools), carol, 31 * USD);

        // zero amount is a no-op
        vm.prank(address(pools));
        vault.transferInternal(address(usdg), address(pools), carol, 0);
        assertEq(vault.totalInternal(address(usdg)), 100 * USD);
    }

    function testFuzz_depositWithdrawConserves(uint96 a, uint96 b, uint96 w) public {
        vm.assume(a > 0 && b > 0);
        _fund(alice, usdg, a);
        _fund(carol, usdg, b);
        uint256 out = bound(w, 1, a);
        vm.prank(alice);
        vault.withdraw(address(usdg), out, alice);
        assertEq(vault.totalInternal(address(usdg)), uint256(a) + b - out);
        assertEq(usdg.balanceOf(address(vault)), vault.totalInternal(address(usdg)));
        assertEq(_bal(alice, usdg) + _bal(carol, usdg), vault.totalInternal(address(usdg)));
    }
}
