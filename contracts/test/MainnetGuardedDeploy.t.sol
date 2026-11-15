// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice script/Deploy.s.sol on Robinhood Chain mainnet (4663): the guarded beta only (owner decision before the
///         Phase 5 external audit). Every refusal of the mainnet gate has a test here: the pure checks one by one, and
///         `run()` itself on chain 4663 walking through the gate in order (docs/07-mainnet-guarded-beta.md).
///         `run()` is called from ONE test only (test_run_gateInOrder) and nothing else in the suite calls it: the
///         process environment that vm.setEnv changes is shared by tests running in parallel.
contract MainnetGuardedDeployTest is Test {
    uint256 internal constant MAINNET = 4663;
    string internal constant PREFIX = "Velum: refusing Robinhood Chain mainnet (4663)";

    Deploy internal d;
    address internal admin = makeAddr("owner-multisig");
    address internal relay = makeAddr("price-relay");
    address internal deployer = makeAddr("deployer");
    address internal guardian = makeAddr("guardian");

    function setUp() public {
        d = new Deploy();
    }

    function _syms() internal pure returns (string[] memory s) {
        s = new string[](2);
        (s[0], s[1]) = ("TSLA", "NVDA");
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory v) {
        v = new uint256[](2);
        (v[0], v[1]) = (a, b);
    }

    // ---------------------------------------------------------------- the confirmation phrase

    function test_phrase_namesChainAdminAndRelayer() public view {
        string memory p = d.mainnetPhrase(MAINNET, admin, relay);
        assertTrue(vm.contains(p, "4663"));
        assertTrue(vm.contains(p, vm.toString(admin)), "checksummed guard admin");
        assertTrue(vm.contains(p, vm.toString(relay)), "checksummed price relayer");
        assertTrue(vm.contains(p, "unaudited"));
        // Any other chain, admin or relayer gives another phrase.
        assertNotEq(keccak256(bytes(p)), keccak256(bytes(d.mainnetPhrase(46_630, admin, relay))));
        assertNotEq(keccak256(bytes(p)), keccak256(bytes(d.mainnetPhrase(MAINNET, relay, admin))));
        assertNotEq(keccak256(bytes(p)), keccak256(bytes(d.mainnetPhrase(MAINNET, admin, deployer))));
    }

    function test_confirm_requiredForBroadcast() public {
        string memory p = d.mainnetPhrase(MAINNET, admin, relay);
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX, ": set VELUM_MAINNET_GUARDED_CONFIRM to the exact phrase the simulation printed: ", p
                )
            )
        );
        d.checkMainnetConfirm("", p, true);
        d.checkMainnetConfirm("", p, false); // the simulation may run without it
        d.checkMainnetConfirm(p, p, true);
    }

    /// @notice The docs' example (placeholders), the right phrase for another admin or relayer, testnet's chain id, a
    ///         changed case or a trailing space: all refused, in the simulation as well as in the broadcast.
    function test_confirm_copyPasteFromDocsRefused() public {
        string memory p = d.mainnetPhrase(MAINNET, admin, relay);
        string[6] memory wrong = [
            "deploy unaudited Velum guarded beta to chain 4663 with guard admin <GUARD_ADMIN> and price relayer <PRICE_RELAYER>",
            d.mainnetPhrase(MAINNET, makeAddr("someone-else"), relay),
            d.mainnetPhrase(MAINNET, admin, makeAddr("other-relay")),
            d.mainnetPhrase(46_630, admin, relay),
            string.concat(p, " "),
            vm.toLowercase(p)
        ];
        for (uint256 i; i < wrong.length; ++i) {
            for (uint256 req; req < 2; ++req) {
                vm.expectRevert(
                    bytes(
                        string.concat(
                            PREFIX,
                            ": VELUM_MAINNET_GUARDED_CONFIRM does not match this deployment's chain id, guard admin and price relayer. Expected exactly: ",
                            p
                        )
                    )
                );
                d.checkMainnetConfirm(wrong[i], p, req == 1);
            }
        }
    }

    // ---------------------------------------------------------------- roles

    function test_roles_guardRequired() public {
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    " without the launch guard. Before the Phase 5 external audit mainnet is allowed only as the guarded beta: set GUARD_ADMIN (the owner multisig) and every GUARD_ACCOUNT_CAP_<SYMBOL> / GUARD_GLOBAL_CAP_<SYMBOL> (docs/07-mainnet-guarded-beta.md)"
                )
            )
        );
        d.checkMainnetRoles(true, relay, deployer, address(0), address(0));
    }

    function test_roles_relayerRequiredAndDedicated() public {
        string memory unset = string.concat(
            PREFIX,
            ": set PRICE_RELAYER to the signer's PRICE_RELAY key address (deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY, before this deployment)"
        );
        vm.expectRevert(bytes(unset));
        d.checkMainnetRoles(false, deployer, deployer, admin, address(0));
        vm.expectRevert(bytes(unset));
        d.checkMainnetRoles(true, address(0), deployer, admin, address(0));
        vm.expectRevert(bytes(string.concat(PREFIX, ": PRICE_RELAYER is the deployer key")));
        d.checkMainnetRoles(true, deployer, deployer, admin, address(0));
        vm.expectRevert(bytes(string.concat(PREFIX, ": PRICE_RELAYER is GUARD_ADMIN")));
        d.checkMainnetRoles(true, admin, deployer, admin, address(0));
        // checkRelayer applies the same relayer rule on mainnet (it used to refuse 4663 outright).
        vm.expectRevert(bytes(unset));
        d.checkRelayer(MAINNET, false, deployer, deployer);
        vm.expectRevert(bytes(string.concat(PREFIX, ": PRICE_RELAYER is the deployer key")));
        d.checkRelayer(MAINNET, true, deployer, deployer);
        d.checkRelayer(MAINNET, true, relay, deployer);
    }

    function test_roles_adminNotDeployerAndGuardianCold() public {
        vm.expectRevert(bytes(string.concat(PREFIX, ": GUARD_ADMIN is the deployer key")));
        d.checkMainnetRoles(true, relay, deployer, deployer, address(0));
        string memory cold =
            string.concat(PREFIX, ": GUARDIAN must be a cold owner key, not the price-relay or deployer key");
        vm.expectRevert(bytes(cold));
        d.checkMainnetRoles(true, relay, deployer, admin, relay);
        vm.expectRevert(bytes(cold));
        d.checkMainnetRoles(true, relay, deployer, admin, deployer);
        d.checkMainnetRoles(true, relay, deployer, admin, address(0)); // no guardian: allowed (with a warning)
        d.checkMainnetRoles(true, relay, deployer, admin, guardian);
        d.checkMainnetRoles(true, relay, deployer, admin, admin); // the owner multisig may hold both roles
    }

    // ---------------------------------------------------------------- tokens

    function test_tokens_verifiedListMatchesConfigFile() public view {
        Deploy.Tokens memory v = d.mainnetTokens();
        assertEq(v.stocks.length, 10);
        string memory json = vm.readFile("../packages/config/robinhood-mainnet.json");
        assertEq(vm.parseJsonAddress(json, ".tokens.USDG.address"), v.usdg);
        assertEq(vm.parseJsonUint(json, ".tokens.USDG.decimals"), 6);
        for (uint256 i; i < v.stocks.length; ++i) {
            string memory k = string.concat(".tokens.", v.symbols[i]);
            assertEq(vm.parseJsonAddress(json, string.concat(k, ".address")), v.stocks[i], v.symbols[i]);
            assertEq(vm.parseJsonUint(json, string.concat(k, ".decimals")), 18, v.symbols[i]);
        }
        assertEq(vm.parseJsonKeys(json, ".tokens").length, 11);
        d.checkMainnetTokenList(v);
    }

    function test_tokens_anyDifferenceFromTheVerifiedListRefused() public {
        string memory differs = string.concat(
            PREFIX,
            ": packages/config/robinhood-mainnet.json does not list exactly the verified mainnet tokens of script/Deploy.s.sol (mainnetTokens)"
        );
        Deploy.Tokens memory t = d.mainnetTokens();
        t.usdg = makeAddr("fake-usdg");
        vm.expectRevert(bytes(differs));
        d.checkMainnetTokenList(t);

        t = d.mainnetTokens();
        t.stocks[3] = makeAddr("fake-nvda"); // a lookalike NVDA
        vm.expectRevert(bytes(differs));
        d.checkMainnetTokenList(t);

        t = d.mainnetTokens();
        (t.symbols[0], t.symbols[1]) = (t.symbols[1], t.symbols[0]); // TSLA's address under AMZN's name
        vm.expectRevert(bytes(differs));
        d.checkMainnetTokenList(t);

        t = d.mainnetTokens();
        address[] memory fewer = new address[](9);
        for (uint256 i; i < 9; ++i) {
            fewer[i] = t.stocks[i];
        }
        t.stocks = fewer;
        vm.expectRevert(bytes(differs));
        d.checkMainnetTokenList(t);
    }

    /// @dev Puts a token with `decimals` at `at` (a MockERC20's runtime code; decimals is immutable in it) and answers
    ///      symbol() with `symbol`.
    function _token(address at, string memory symbol, uint8 decimals) internal {
        MockERC20 m = new MockERC20("mock", symbol, decimals);
        vm.etch(at, address(m).code);
        vm.mockCall(at, abi.encodeWithSignature("symbol()"), abi.encode(symbol));
    }

    function _allTokens() internal {
        Deploy.Tokens memory t = d.mainnetTokens();
        _token(t.usdg, "USDG", 6);
        for (uint256 i; i < t.stocks.length; ++i) {
            _token(t.stocks[i], t.symbols[i], 18);
        }
    }

    function test_tokens_onChainCodeDecimalsAndSymbolChecked() public {
        Deploy.Tokens memory t = d.mainnetTokens();
        string memory usdg = string.concat(PREFIX, ": the USDG token ", vm.toString(t.usdg), " ");
        vm.expectRevert(bytes(string.concat(usdg, "has no code on this chain")));
        d.checkMainnetTokenContracts(t);

        _allTokens();
        d.checkMainnetTokenContracts(t);

        _token(t.usdg, "USDG", 18);
        vm.expectRevert(bytes(string.concat(usdg, "has other decimals than expected")));
        d.checkMainnetTokenContracts(t);
        _token(t.usdg, "USDG", 6);

        string memory meta = string.concat(PREFIX, ": the META token ", vm.toString(t.stocks[7]), " ");
        vm.mockCall(t.stocks[7], abi.encodeWithSignature("symbol()"), abi.encode("METAx"));
        vm.expectRevert(bytes(string.concat(meta, "reports another symbol()")));
        d.checkMainnetTokenContracts(t);
        vm.mockCallRevert(t.stocks[7], abi.encodeWithSignature("symbol()"), "");
        vm.expectRevert(bytes(string.concat(meta, "has no readable symbol()")));
        d.checkMainnetTokenContracts(t);
    }

    // ---------------------------------------------------------------- reference prices and bounds

    function test_bounds_referencePriceRequired() public {
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    ": set MAINNET_REF_PRICE_NVDA to the token's current price in USDG (deploy/deploy-contracts.sh reads it from Robinhood's quote API)"
                )
            )
        );
        d.checkMainnetBounds(_syms(), _two(391.65e18, 0), 1e18, 100_000e18);
        vm.expectRevert(bytes(string.concat(PREFIX, ": MAINNET_REF_PRICE_TSLA is implausibly large")));
        d.checkMainnetBounds(_syms(), _two(1e27, 155e18), 1e18, type(uint128).max);
    }

    function test_bounds_fiveXOnEachSide() public {
        d.checkMainnetBounds(_syms(), _two(391.65e18, 155.12e18), 1e18, 100_000e18); // the defaults
        d.checkMainnetBounds(_syms(), _two(391.65e18, 155e18), 31e18, 1958.25e18); // exactly 5x: 155/5 = 31, 391.65x5
        // min x 5 above NVDA's 155: an 80% fall would leave the bounds.
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    ": the oracle bounds [32, 100000] leave less than 5x on a side of NVDA's reference price 155 (set PRICE_MIN_USD / PRICE_MAX_USD; the bounds are immutable)"
                )
            )
        );
        d.checkMainnetBounds(_syms(), _two(391.65e18, 155e18), 32e18, 100_000e18);
        // max below 5x TSLA.
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    ": the oracle bounds [1, 1958] leave less than 5x on a side of TSLA's reference price 391.65 (set PRICE_MIN_USD / PRICE_MAX_USD; the bounds are immutable)"
                )
            )
        );
        d.checkMainnetBounds(_syms(), _two(391.65e18, 155e18), 1e18, 1958e18);
        vm.expectRevert(bytes("Velum: reference prices differ in length"));
        d.checkMainnetBounds(_syms(), new uint256[](1), 1e18, 100_000e18);
    }

    // ---------------------------------------------------------------- the two-step flow: simulation, then broadcast

    function test_plan_requiredMatchingAndFresh() public {
        bytes32 h = keccak256("config");
        uint256 nowSec = 1_800_000_000;
        d.checkPlan(true, MAINNET, h, nowSec - 3600, h, nowSec); // exactly 1 h old
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    ": no simulation plan (deployments/4663.plan.json). Run the same command WITHOUT --broadcast first, check its summary, then broadcast within 1 hour"
                )
            )
        );
        d.checkPlan(false, 0, bytes32(0), 0, h, nowSec);
        vm.expectRevert(bytes(string.concat(PREFIX, ": the plan is for another chain")));
        d.checkPlan(true, 46_630, h, nowSec, h, nowSec);
        vm.expectRevert(
            bytes(
                string.concat(
                    PREFIX,
                    ": the settings, the build or the deployer's nonce differ from the simulation. Simulate again (without --broadcast) and check the new summary"
                )
            )
        );
        d.checkPlan(true, MAINNET, keccak256("other config"), nowSec, h, nowSec);
        vm.expectRevert(bytes(string.concat(PREFIX, ": the simulation plan is dated in the future")));
        d.checkPlan(true, MAINNET, h, nowSec + 1, h, nowSec);
        vm.expectRevert(
            bytes(
                string.concat(PREFIX, ": the simulation is more than 1 hour old. Simulate again (without --broadcast)")
            )
        );
        d.checkPlan(true, MAINNET, h, nowSec - 3601, h, nowSec);
    }

    /// @notice The plan hash binds every input: a different relayer, guardian, guard admin, cap, bound, open-interest
    ///         cap, reference price or deployer nonce gives another hash (and therefore a refused broadcast).
    function test_plan_hashBindsEveryInput() public {
        vm.chainId(MAINNET);
        (Deploy.Mainnet memory m, Deploy.Tokens memory t, Deploy.Guard memory g, Deploy.Params memory p) = _config();
        bytes32 h = d.planHash(m, t, g, p);
        assertEq(d.planHash(m, t, g, p), h, "deterministic");
        m.deployerNonce += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "nonce");
        (m, t, g, p) = _config();
        m.relayer = makeAddr("x");
        assertNotEq(d.planHash(m, t, g, p), h, "relayer");
        (m, t, g, p) = _config();
        m.guardian = address(0);
        assertNotEq(d.planHash(m, t, g, p), h, "guardian");
        (m, t, g, p) = _config();
        g.admin = makeAddr("x");
        assertNotEq(d.planHash(m, t, g, p), h, "guard admin");
        (m, t, g, p) = _config();
        g.accountCaps[3] += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "account cap");
        (m, t, g, p) = _config();
        g.globalCaps[0] += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "global cap");
        (m, t, g, p) = _config();
        p.maxPrice += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "bound");
        (m, t, g, p) = _config();
        p.oiCap += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "open-interest cap");
        (m, t, g, p) = _config();
        m.refPrices[9] += 1;
        assertNotEq(d.planHash(m, t, g, p), h, "reference price");
        (m, t, g, p) = _config();
        vm.chainId(46_630);
        assertNotEq(d.planHash(m, t, g, p), h, "chain");
    }

    function _config()
        internal
        view
        returns (Deploy.Mainnet memory m, Deploy.Tokens memory t, Deploy.Guard memory g, Deploy.Params memory p)
    {
        t = d.mainnetTokens();
        m.deployer = deployer;
        m.deployerNonce = 7;
        m.relayerSet = true;
        m.relayer = relay;
        m.guardian = guardian;
        m.refPrices = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            m.refPrices[i] = (100 + i) * 1e18;
        }
        g.admin = admin;
        g.accountCaps = new uint256[](11);
        g.globalCaps = new uint256[](11);
        for (uint256 i; i < 11; ++i) {
            (g.accountCaps[i], g.globalCaps[i]) = (1e18, 50e18);
        }
        p = Deploy.Params({minPrice: 1e18, maxPrice: 100_000e18, oiCap: 10_000e18});
    }

    function test_summary_namesEverythingTheOperatorChecks() public {
        vm.chainId(MAINNET);
        (Deploy.Mainnet memory m, Deploy.Tokens memory t, Deploy.Guard memory g, Deploy.Params memory p) = _config();
        m.planHash = keccak256("plan");
        string memory s = d.mainnetSummary(m, t, g, p);
        assertTrue(vm.contains(s, "UNAUDITED"));
        assertTrue(vm.contains(s, "MAINNET (4663)"));
        assertTrue(vm.contains(s, vm.toString(deployer)));
        assertTrue(vm.contains(s, "nonce 7"));
        assertTrue(vm.contains(s, vm.toString(relay)));
        assertTrue(vm.contains(s, "FIXED FOREVER"));
        assertTrue(vm.contains(s, vm.toString(admin)));
        assertTrue(vm.contains(s, "NO CODE: a plain key"), "admin without code flagged");
        assertTrue(vm.contains(s, vm.toString(guardian)));
        assertTrue(vm.contains(s, "bounds [1, 100000]"));
        assertTrue(vm.contains(s, "COIN 0x6330D8C3178a418788dF01a47479c0ce7CCF450b (18 decimals) reference price 109"));
        assertTrue(vm.contains(s, vm.toString(m.planHash)));
        assertTrue(vm.contains(s, d.mainnetPhrase(MAINNET, admin, relay)));
        m.guardian = address(0);
        assertTrue(vm.contains(d.mainnetSummary(m, t, g, p), "Guardian:      none"));
    }

    // ---------------------------------------------------------------- run() on chain 4663, in the gate's order

    function _set(string memory name, string memory value) internal {
        vm.setEnv(name, value);
    }

    function _clear() internal {
        string[7] memory names = [
            "GUARD_ADMIN",
            "PRICE_RELAYER",
            "GUARDIAN",
            "USDG_ADDRESS",
            "STOCK_ADDRESSES",
            "STOCK_SYMBOLS",
            "VELUM_MAINNET_GUARDED_CONFIRM"
        ];
        for (uint256 i; i < names.length; ++i) {
            vm.setEnv(names[i], "");
        }
        Deploy.Tokens memory t = d.mainnetTokens();
        vm.setEnv("GUARD_ACCOUNT_CAP_USDG", "");
        vm.setEnv("GUARD_GLOBAL_CAP_USDG", "");
        for (uint256 i; i < t.symbols.length; ++i) {
            vm.setEnv(string.concat("GUARD_ACCOUNT_CAP_", t.symbols[i]), "");
            vm.setEnv(string.concat("GUARD_GLOBAL_CAP_", t.symbols[i]), "");
            vm.setEnv(string.concat("MAINNET_REF_PRICE_", t.symbols[i]), "");
        }
        vm.setEnv("PRICE_MIN_USD", "");
        vm.setEnv("PRICE_MAX_USD", "");
    }

    /// @dev run() must revert with `reason`. Its vm.startBroadcast() stays active after the revert (cheatcode state is
    ///      not rolled back), so it is stopped here before the next call.
    function _runReverts(bytes memory reason) internal {
        vm.expectRevert(reason);
        d.run();
        vm.stopBroadcast();
    }

    /// @notice One test walks run() through every mainnet refusal in order (the environment is process-wide: see the
    ///         contract's NatSpec). It never gets past the plan check, so nothing is deployed or written.
    function test_run_gateInOrder() public {
        vm.chainId(MAINNET);
        _clear();
        // A plan file a local simulation may have left would change the last step's answer.
        if (vm.isFile(d.MAINNET_PLAN())) vm.removeFile(d.MAINNET_PLAN());
        (, address sender,) = vm.readCallers();

        // 1. Unguarded (the old outright refusal is now this one).
        _set("PRICE_RELAYER", vm.toString(relay));
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    " without the launch guard. Before the Phase 5 external audit mainnet is allowed only as the guarded beta: set GUARD_ADMIN (the owner multisig) and every GUARD_ACCOUNT_CAP_<SYMBOL> / GUARD_GLOBAL_CAP_<SYMBOL> (docs/07-mainnet-guarded-beta.md)"
                )
            )
        );

        // 2. No price relayer, then the deployer as price relayer.
        _set("GUARD_ADMIN", vm.toString(admin));
        _set("PRICE_RELAYER", "");
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    ": set PRICE_RELAYER to the signer's PRICE_RELAY key address (deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY, before this deployment)"
                )
            )
        );
        _set("PRICE_RELAYER", vm.toString(sender));
        _runReverts(bytes(string.concat(PREFIX, ": PRICE_RELAYER is the deployer key")));

        // 3. A hot guardian.
        _set("PRICE_RELAYER", vm.toString(relay));
        _set("GUARDIAN", vm.toString(relay));
        _runReverts(
            bytes(string.concat(PREFIX, ": GUARDIAN must be a cold owner key, not the price-relay or deployer key"))
        );
        _set("GUARDIAN", vm.toString(guardian));

        // 4. Token overrides, each one.
        string memory noOverrides = string.concat(
            PREFIX,
            ": USDG_ADDRESS, STOCK_ADDRESSES and STOCK_SYMBOLS are not accepted on mainnet; it deploys only against the verified token list"
        );
        string[3] memory overrides = ["USDG_ADDRESS", "STOCK_ADDRESSES", "STOCK_SYMBOLS"];
        string[3] memory values = [vm.toString(makeAddr("usdg")), vm.toString(makeAddr("tsla")), "TSLA"];
        for (uint256 i; i < 3; ++i) {
            _set(overrides[i], values[i]);
            _runReverts(bytes(noOverrides));
            _set(overrides[i], "");
        }

        // 5. The verified tokens must exist on the chain (here: no code until the mocks are etched).
        Deploy.Tokens memory t = d.mainnetTokens();
        _runReverts(
            bytes(string.concat(PREFIX, ": the USDG token ", vm.toString(t.usdg), " has no code on this chain"))
        );
        _allTokens();

        // 6. Every cap is required once GUARD_ADMIN is set.
        _runReverts(
            bytes(
                "Velum: GUARD_ADMIN is set, so GUARD_ACCOUNT_CAP_USDG (a token amount, e.g. 1000 or 250.5) is required"
            )
        );
        _set("GUARD_ACCOUNT_CAP_USDG", "1000");
        _set("GUARD_GLOBAL_CAP_USDG", "50000");
        for (uint256 i; i < t.symbols.length - 1; ++i) {
            _set(string.concat("GUARD_ACCOUNT_CAP_", t.symbols[i]), "1");
            _set(string.concat("GUARD_GLOBAL_CAP_", t.symbols[i]), "50");
        }
        _runReverts(
            bytes(
                "Velum: GUARD_ADMIN is set, so GUARD_ACCOUNT_CAP_COIN (a token amount, e.g. 1000 or 250.5) is required"
            )
        );
        _set("GUARD_ACCOUNT_CAP_COIN", "1");
        _set("GUARD_GLOBAL_CAP_COIN", "50");

        // 7. Reference prices, then bounds.
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    ": set MAINNET_REF_PRICE_TSLA to the token's current price in USDG (deploy/deploy-contracts.sh reads it from Robinhood's quote API)"
                )
            )
        );
        for (uint256 i; i < t.symbols.length; ++i) {
            _set(string.concat("MAINNET_REF_PRICE_", t.symbols[i]), i == 3 ? "155.12" : "391.65");
        }
        _set("PRICE_MIN_USD", "40");
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    ": the oracle bounds [40, 100000] leave less than 5x on a side of NVDA's reference price 155.12 (set PRICE_MIN_USD / PRICE_MAX_USD; the bounds are immutable)"
                )
            )
        );
        _set("PRICE_MIN_USD", "");
        _set("MAINNET_REF_PRICE_AMD", "1,000");
        _runReverts(
            bytes(
                "Velum: MAINNET_REF_PRICE_AMD=1,000 is not a token amount (digits, optionally a decimal point and at most 18 decimals)"
            )
        );
        _set("MAINNET_REF_PRICE_AMD", "391.65");

        // 8. The broadcast needs the exact phrase (forge test is not a dry run, so it is held to the broadcast rules).
        string memory phrase = d.mainnetPhrase(MAINNET, admin, relay);
        _runReverts(
            bytes(
                string.concat(
                    PREFIX, ": set VELUM_MAINNET_GUARDED_CONFIRM to the exact phrase the simulation printed: ", phrase
                )
            )
        );
        _set(
            "VELUM_MAINNET_GUARDED_CONFIRM",
            "deploy unaudited Velum guarded beta to chain 4663 with guard admin <GUARD_ADMIN> and price relayer <PRICE_RELAYER>"
        );
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    ": VELUM_MAINNET_GUARDED_CONFIRM does not match this deployment's chain id, guard admin and price relayer. Expected exactly: ",
                    phrase
                )
            )
        );

        // 9. ...and the simulation's plan.
        _set("VELUM_MAINNET_GUARDED_CONFIRM", phrase);
        _runReverts(
            bytes(
                string.concat(
                    PREFIX,
                    ": no simulation plan (deployments/4663.plan.json). Run the same command WITHOUT --broadcast first, check its summary, then broadcast within 1 hour"
                )
            )
        );

        _clear();
    }

    /// @notice Any chain but testnet, anvil and mainnet is still refused, before anything is read.
    function test_run_otherChainsRefused() public {
        vm.chainId(1);
        vm.expectRevert(
            bytes(
                "Velum: deploy only to Robinhood Chain testnet (46630), a local anvil (31337) or, as the guarded beta, Robinhood Chain mainnet (4663)"
            )
        );
        d.run();
    }
}
