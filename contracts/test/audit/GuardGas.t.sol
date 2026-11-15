// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Independent guard audit: gas of deposit / withdraw / setApproval, unguarded, guard active, guard retired.
///         Run with --isolate so every top-level call is its own transaction (cold storage as on chain), e.g.
///         `forge test --isolate --match-contract GuardGasTest -vvvv`. The G-01 fix adds nothing to these paths (the
///         room check runs only in `addToAllowlist` and `raiseCaps`); the retired guard now switches caps off first.
contract GuardGasTest is Test {
    MockERC20 internal usdg = new MockERC20("USDG", "USDG", 6);
    address internal user = makeAddr("user");
    address internal admin = makeAddr("admin");
    address internal module = makeAddr("module");

    function _vault(bool guarded) internal returns (VelumVault v) {
        v = new VelumVault();
        address[] memory t = new address[](1);
        t[0] = address(usdg);
        address[] memory m = new address[](1);
        m[0] = module;
        uint256[] memory c = new uint256[](guarded ? 1 : 0);
        if (guarded) c[0] = 1e30;
        v.setup(t, m, new address[](0), guarded ? admin : address(0), c, c);
        if (guarded) {
            address[] memory l = new address[](1);
            l[0] = user;
            vm.prank(admin);
            v.addToAllowlist(l);
        }
        usdg.mint(user, 1e12);
        vm.prank(user);
        usdg.approve(address(v), type(uint256).max);
    }

    function _measure(VelumVault v, string memory tag) internal {
        vm.prank(user);
        v.deposit(address(usdg), 1e9, user); // first deposit
        vm.prank(user);
        v.deposit(address(usdg), 1e9, user); // second deposit
        vm.prank(user);
        v.withdraw(address(usdg), 5e8, user);
        vm.prank(user);
        v.setApproval(module, true);
        tag;
    }

    function test_gas_unguarded() public {
        _measure(_vault(false), "unguarded");
    }

    function test_gas_guardActive() public {
        _measure(_vault(true), "active");
    }

    function test_gas_guardRetired() public {
        VelumVault v = _vault(true);
        vm.startPrank(admin);
        v.liftCaps(); // openToPublic needs the caps lifted first (G-01)
        v.openToPublic();
        vm.stopPrank();
        assertEq(v.guardAdmin(), address(0));
        _measure(v, "retired");
    }
}
