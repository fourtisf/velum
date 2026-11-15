// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @notice Independent audit of the launch guard: the deploy-script findings, as regressions.
///         D-01 (Low): script/Deploy.s.sol read GUARD_ADMIN with `vm.envOr`, which returns the default (zero, i.e.
///         unguarded) for a value that is SET but cannot be parsed, e.g. a truncated address: the script then deployed
///         an unguarded vault and printed "launch guard OFF (GUARD_ADMIN not set)". Every variable is now read
///         strictly (`vm.envExists` + `vm.envAddress` / `vm.envUint` / `vm.envBool`): unset or empty is "not given",
///         anything else must parse, and a mixed-case address must carry a correct EIP-55 checksum.
///         I-01: the deployer key may not be the guard admin outside anvil; an admin without code (a plain key, not a
///         multisig) gets a loud warning.
///         I-02: a zero account cap prints BLOCKED; caps are token amounts with decimals (e.g. 250.5); a USDG account
///         cap below 10 USDG (the minimum position size; 0 blocks the margin and quote asset) is refused unless
///         GUARD_ALLOW_SMALL_USDG_CAP=true.
///         End to end on a local anvil (forge script): a malformed GUARD_ADMIN stops the deploy before anything is
///         broadcast (README, Guarded launch). Environment variable names here are unique to these tests: the process
///         environment is shared by tests running in parallel.
contract GuardDeployPoC is Test {
    uint256 internal constant TESTNET = 46_630;
    uint256 internal constant ANVIL = 31_337;

    function _caps(uint256 a0, uint256 g0, uint256 a1, uint256 g1)
        internal
        pure
        returns (uint256[] memory a, uint256[] memory g)
    {
        a = new uint256[](2);
        g = new uint256[](2);
        (a[0], g[0], a[1], g[1]) = (a0, g0, a1, g1);
    }

    /// @dev A guard config for USDG (6 decimals) and TSLA (18), caps in base units, admin with code.
    function _g(address admin, uint256[] memory a, uint256[] memory g) internal pure returns (Deploy.Guard memory c) {
        c.admin = admin;
        c.adminHasCode = true;
        c.symbols = new string[](2);
        (c.symbols[0], c.symbols[1]) = ("USDG", "TSLA");
        c.decimals = new uint8[](2);
        (c.decimals[0], c.decimals[1]) = (6, 18);
        c.accountCaps = a;
        c.globalCaps = g;
    }

    /// @notice I-01: a guard admin without code (a plain key, not a multisig) gets a loud warning.
    function test_I01_guardNoticeWarnsWhenAdminHasNoCode_fixed() public {
        Deploy d = new Deploy();
        address admin = makeAddr("plain-key");
        (uint256[] memory a, uint256[] memory g) = _caps(1000e6, 50_000e6, 2e18, 100e18);
        Deploy.Guard memory c = _g(admin, a, g);
        c.adminHasCode = false;
        string memory on = d.guardNotice(c);
        assertTrue(vm.contains(on, "!!! WARNING Velum: GUARD_ADMIN"));
        assertTrue(vm.contains(on, "has no code on this chain: it is a plain key, not a multisig"));
    }

    /// @notice I-02: a zero account cap prints BLOCKED; decimal caps print as token amounts; the room line names the
    ///         token that limits the allowlist.
    function test_I02_guardNoticeBlockedAndDecimals_fixed() public {
        Deploy d = new Deploy();
        (uint256[] memory a, uint256[] memory g) = _caps(250.5e6, 1002e6, 0, 0);
        string memory on = d.guardNotice(_g(makeAddr("owner-multisig"), a, g));
        assertTrue(vm.contains(on, "USDG: 250.5 / 1002 tokens (base units 250500000 / 1002000000)"));
        assertTrue(vm.contains(on, "TSLA: BLOCKED: no deposits until the admin raises the account cap; 0 / 0 tokens"));
        assertTrue(
            vm.contains(on, "Allowlist room: at most 4 addresses at these caps (global / account cap, lowest for USDG)")
        );
        (a, g) = _caps(0, 0, 0, 5e17);
        on = d.guardNotice(_g(makeAddr("owner-multisig"), a, g));
        assertTrue(vm.contains(on, "USDG: BLOCKED"));
        assertTrue(vm.contains(on, "TSLA: BLOCKED: no deposits until the admin raises the account cap; 0 / 0.5 tokens"));
        assertTrue(vm.contains(on, "Allowlist room: no limit while every account cap is zero"));
    }

    /// @notice I-02: caps are token amounts with up to the token's decimals; anything else stops the script.
    function test_I02_parseUnits_fixed() public {
        Deploy d = new Deploy();
        assertEq(d.parseUnits("X", "1000", 6), 1000e6);
        assertEq(d.parseUnits("X", "250.5", 6), 250.5e6);
        assertEq(d.parseUnits("X", "0.000001", 6), 1);
        assertEq(d.parseUnits("X", "0", 18), 0);
        assertEq(d.parseUnits("X", "007", 18), 7e18);
        assertEq(d.parseUnits("X", "0.5", 18), 5e17);
        string[11] memory bad = [
            "",
            ".5",
            "5.",
            "1.2.3",
            "1,000",
            "-1",
            "1e6",
            " 1",
            "0x10",
            "0.0000001",
            "1000000000000000000000000000000000000000000000000000000000000000000000000000"
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(
                bytes(
                    string.concat(
                        "Velum: GUARD_ACCOUNT_CAP_USDG=",
                        bad[i],
                        " is not a token amount (digits, optionally a decimal point and at most 6 decimals)"
                    )
                )
            );
            d.parseUnits("GUARD_ACCOUNT_CAP_USDG", bad[i], 6);
        }
        assertEq(d.formatUnits(250_500_000, 6), "250.5");
        assertEq(d.formatUnits(1, 6), "0.000001");
        assertEq(d.formatUnits(1000e6, 6), "1000");
        assertEq(d.formatUnits(1.05e18, 18), "1.05");
    }

    /// @notice D-01 (Low): a malformed GUARD_ADMIN used to read as unset (`vm.envOr`), i.e. an unguarded deployment
    ///         announced as "GUARD_ADMIN not set". The strict reader refuses it; unset or empty is "not given".
    ///         Variable names are unique to this test (the process environment is shared by parallel tests).
    function test_D01_malformedAddressRefused_fixed() public {
        Deploy d = new Deploy();
        string memory name = "VELUM_TEST_D01_GUARD_ADMIN";
        string memory truncated = "0x70997970C51812dc3A010C7d01b50e0d17dc79C"; // 39 hex digits: one dropped
        vm.setEnv(name, truncated);
        assertEq(vm.envOr(name, address(0)), address(0), "envOr: silently unset (the finding)");
        vm.expectRevert(bytes(string.concat("Velum: ", name, "=", truncated, " is not an address (40 hex digits)")));
        d.envAddressStrict(name);

        // a mixed-case address with one letter's case flipped: valid hex, wrong checksum
        string memory badSum = "0x70997970c51812dc3A010C7d01b50e0d17dc79C8";
        vm.setEnv(name, badSum);
        vm.expectRevert(
            bytes(
                string.concat(
                    "Velum: ",
                    name,
                    "=",
                    badSum,
                    " has a wrong EIP-55 checksum (expected 0x70997970C51812dc3A010C7d01b50e0d17dc79C8)"
                )
            )
        );
        d.envAddressStrict(name);

        address want = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        string[3] memory good = [
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            "70997970C51812dc3A010C7d01b50e0d17dc79C8"
        ];
        for (uint256 i; i < 3; ++i) {
            vm.setEnv(name, good[i]);
            (bool set, address got) = d.envAddressStrict(name);
            assertTrue(set);
            assertEq(got, want);
        }
        vm.setEnv(name, ""); // empty = not given (.env.example: "empty = unguarded")
        (bool set2, address got2) = d.envAddressStrict(name);
        assertFalse(set2);
        assertEq(got2, address(0));
        (bool set3,) = d.envAddressStrict("VELUM_TEST_D01_NEVER_SET");
        assertFalse(set3);
    }

    /// @notice D-01 applied to every variable the script reads: numbers and flags refuse malformed values too.
    function test_D01_malformedNumberAndFlagRefused_fixed() public {
        Deploy d = new Deploy();
        vm.setEnv("VELUM_TEST_D01_OI", "5,000");
        assertEq(vm.envOr("VELUM_TEST_D01_OI", uint256(10_000)), 10_000, "envOr: silently the default");
        vm.expectRevert(bytes("Velum: VELUM_TEST_D01_OI=5,000 is not a whole number"));
        d.envUintStrict("VELUM_TEST_D01_OI", 10_000);
        vm.setEnv("VELUM_TEST_D01_OI", "5000");
        assertEq(d.envUintStrict("VELUM_TEST_D01_OI", 10_000), 5000);
        assertEq(d.envUintStrict("VELUM_TEST_D01_UNSET", 10_000), 10_000);
        vm.setEnv("VELUM_TEST_D01_FLAG", "yes");
        vm.expectRevert(bytes("Velum: VELUM_TEST_D01_FLAG=yes is not true or false"));
        d.envBoolStrict("VELUM_TEST_D01_FLAG");
        vm.setEnv("VELUM_TEST_D01_FLAG", "true");
        assertTrue(d.envBoolStrict("VELUM_TEST_D01_FLAG"));
        assertFalse(d.envBoolStrict("VELUM_TEST_D01_FLAG_UNSET"));
    }

    /// @notice I-01: the deployer key may not be the guard admin outside anvil.
    function test_I01_checkGuardRefusesDeployerAsAdminOutsideAnvil_fixed() public {
        Deploy d = new Deploy();
        address deployer = makeAddr("deployer");
        (uint256[] memory a, uint256[] memory g) = _caps(1000e6, 50_000e6, 2e18, 100e18);
        vm.expectRevert(bytes("Velum: GUARD_ADMIN must not be the deployer key outside anvil; use the owner multisig"));
        d.checkGuard(_g(deployer, a, g), TESTNET, deployer, makeAddr("relay"));
        d.checkGuard(_g(deployer, a, g), ANVIL, deployer, makeAddr("relay")); // local tests may
    }

    /// @notice I-02: a USDG account cap below 10 USDG (the minimum position size; 0 blocks the margin and quote
    ///         asset) is refused unless GUARD_ALLOW_SMALL_USDG_CAP=true. Stock caps may be zero (BLOCKED).
    function test_I02_checkGuardRefusesUnusableUsdgCap_fixed() public {
        Deploy d = new Deploy();
        address admin = makeAddr("owner-multisig");
        address relay = makeAddr("relay");
        string memory err =
            "Velum: GUARD_ACCOUNT_CAP_USDG is below 10 USDG (the minimum position size; 0 blocks USDG, the margin and quote asset), so nobody could trade. Set GUARD_ALLOW_SMALL_USDG_CAP=true if that is intended";
        uint256[2] memory bad = [uint256(0), 9_999_999];
        for (uint256 i; i < 2; ++i) {
            (uint256[] memory a, uint256[] memory g) = _caps(bad[i], 50_000e6, 0, 0);
            Deploy.Guard memory c = _g(admin, a, g);
            vm.expectRevert(bytes(err));
            d.checkGuard(c, TESTNET, address(1), relay);
            c.allowSmallUsdgCap = true; // explicitly intended
            d.checkGuard(c, TESTNET, address(1), relay);
        }
        (uint256[] memory a2, uint256[] memory g2) = _caps(10e6, 50_000e6, 0, 0);
        d.checkGuard(_g(admin, a2, g2), TESTNET, address(1), relay); // exactly 10 USDG; TSLA blocked is fine
    }
}
