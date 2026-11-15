// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VelumVault} from "../src/VelumVault.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {SpotPools} from "../src/SpotPools.sol";
import {MakerBook} from "../src/MakerBook.sol";
import {PerpsMarkets} from "../src/PerpsMarkets.sol";
import {IVelumVault} from "../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../src/interfaces/IMakerBook.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @title Deploy
/// @notice Deploys, wires and locks the Phase 3 contracts on Robinhood Chain TESTNET (46630) or a
///         local anvil (31337). Refuses mainnet: that needs the Phase 5 external audit.
///
/// Testnet (tokens default to packages/config/robinhood-testnet.json):
///   PRICE_RELAYER=<dedicated relay key address> \
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
/// Required on testnet: PRICE_RELAYER, a dedicated key that is not the deployer (internal audit F-04).
/// Optional env: GUARDIAN (close-only switch, default none: the script then warns that the split/dividend
///   procedure in contracts/README.md is unavailable), OI_CAP_TOKENS (per side, default 10000),
///   PRICE_MIN_USD / PRICE_MAX_USD (relay bounds, default 1 / 100000),
///   USDG_ADDRESS + STOCK_ADDRESSES + STOCK_SYMBOLS (comma lists) to override the config file.
/// Anvil with no env: deploys mock USDG (6 dp), TSLA and AMZN (18 dp), uses the deployer as relayer and
///   pushes starting prices.
///
/// Optional launch guard (contracts/README.md, Guarded launch). Off unless GUARD_ADMIN is set; off is the
/// testnet default. With GUARD_ADMIN set, every listed token needs both caps, in WHOLE tokens (the script
/// multiplies by the token's decimals(): USDG 6, stock tokens 18); 0 blocks that token until the admin raises
/// it. Caps without GUARD_ADMIN are refused, so a deployment is never believed to be guarded when it is not.
///   # GUARD_ADMIN=                  owner wallet or multisig: allowlists addresses, raises caps, calls
///   #                               openToPublic() / liftCaps() (one-way), hands the role over in two steps.
///   #                               Must not be PRICE_RELAYER.
///   # GUARD_ACCOUNT_CAP_<SYMBOL>=   per-account cap on net deposits, whole tokens, for USDG and every stock symbol
///   # GUARD_GLOBAL_CAP_<SYMBOL>=    cap on the vault's total holdings of the token, whole tokens (>= account cap)
///   # e.g. GUARD_ACCOUNT_CAP_USDG=1000 GUARD_GLOBAL_CAP_USDG=50000 GUARD_ACCOUNT_CAP_TSLA=2 GUARD_GLOBAL_CAP_TSLA=100
contract Deploy is Script {
    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46_630;
    uint256 internal constant ANVIL = 31_337;
    string internal constant CONFIG = "../packages/config/robinhood-testnet.json";

    struct Tokens {
        address usdg;
        address[] stocks;
        string[] symbols;
    }

    /// @dev Launch guard. Symbols, decimals and caps follow the vault's token order: USDG, then the stocks.
    ///      Caps are in base units; both arrays are empty when `admin` is zero (unguarded).
    struct Guard {
        address admin;
        string[] symbols;
        uint8[] decimals;
        uint256[] accountCaps;
        uint256[] globalCaps;
    }

    struct Deployed {
        VelumVault vault;
        OracleAdapter oracle;
        SpotPools pools;
        MakerBook book;
        PerpsMarkets perps;
    }

    function run() external {
        if (block.chainid == MAINNET) {
            revert(
                "Velum: refusing Robinhood Chain mainnet (4663). Mainnet needs the Phase 5 external audit of contracts and circuits."
            );
        }
        require(
            block.chainid == TESTNET || block.chainid == ANVIL,
            "Velum: deploy only to Robinhood Chain testnet (46630) or a local anvil (31337)"
        );

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        bool relayerSet = vm.envExists("PRICE_RELAYER");
        address relayer = relayerSet ? vm.envAddress("PRICE_RELAYER") : deployer;
        checkRelayer(block.chainid, relayerSet, relayer, deployer);
        address guardian = vm.envOr("GUARDIAN", address(0));
        console2.log(guardianNotice(guardian));
        Tokens memory t = _tokens();
        Guard memory g = _guard(t);
        checkGuard(g.admin, relayer, g.accountCaps, g.globalCaps);
        console2.log(guardNotice(g.admin, g.symbols, g.decimals, g.accountCaps, g.globalCaps));
        uint256 startBlock = block.number;
        Deployed memory d = _deploy(t);
        _wire(d, t, relayer, guardian, g);
        if (block.chainid == ANVIL && relayer == deployer) _seedPrices(d.oracle, t.stocks);
        vm.stopBroadcast();

        _write(t, d, relayer, guardian, g.admin, startBlock);
        console2.log(guardNotice(g.admin, g.symbols, g.decimals, g.accountCaps, g.globalCaps));
        // Repeated after the addresses so it is the last thing the operator sees (internal audit F-07).
        console2.log(guardianNotice(guardian));
    }

    /// @notice What the operator must know about the launch guard: who holds it, what it can and cannot do, and
    ///         the caps per token (whole tokens and base units).
    function guardNotice(
        address admin,
        string[] memory symbols,
        uint8[] memory decimals,
        uint256[] memory accountCaps,
        uint256[] memory globalCaps
    ) public pure returns (string memory out) {
        if (admin == address(0)) {
            return string.concat(
                "Velum: launch guard OFF (GUARD_ADMIN not set): anyone can deposit, with no caps, from the start. ",
                "That is the testnet default; a guarded beta needs GUARD_ADMIN and caps (contracts/README.md, Guarded launch)."
            );
        }
        out = string.concat(
            "\nVelum: launch guard ON. Guard admin ",
            vm.toString(admin),
            " can only allowlist addresses, raise caps, call openToPublic() / liftCaps() (one-way) and hand the role",
            " over in two steps. It cannot move, freeze or redirect funds, block withdrawals, remove an address or",
            " lower a cap. Until openToPublic() only allowlisted addresses can deposit or approve modules;",
            " withdrawals, closes, liquidations and forced exits are never blocked.\nCaps until liftCaps()",
            " (per account on net deposits / global on the vault's holdings):"
        );
        for (uint256 i; i < symbols.length; ++i) {
            uint256 one = 10 ** uint256(decimals[i]);
            out = string.concat(
                out,
                "\n  ",
                symbols[i],
                ": ",
                vm.toString(accountCaps[i] / one),
                " / ",
                vm.toString(globalCaps[i] / one),
                " tokens (base units ",
                vm.toString(accountCaps[i]),
                " / ",
                vm.toString(globalCaps[i]),
                ")"
            );
        }
        out = string.concat(out, "\n");
    }

    /// @notice The launch-guard admin is a cold owner key, never the hot price-relay key. Caps must be consistent
    ///         (the vault refuses them too, with a less helpful error), and none may be given without an admin.
    function checkGuard(address admin, address relayer, uint256[] memory accountCaps, uint256[] memory globalCaps)
        public
        pure
    {
        require(accountCaps.length == globalCaps.length, "Velum: guard caps differ in length");
        if (admin == address(0)) {
            require(accountCaps.length == 0, "Velum: guard caps given but GUARD_ADMIN is not set");
            return;
        }
        require(admin != relayer, "Velum: GUARD_ADMIN must not be the price-relay key");
        for (uint256 i; i < accountCaps.length; ++i) {
            require(accountCaps[i] <= globalCaps[i], "Velum: a GUARD_ACCOUNT_CAP is above its GUARD_GLOBAL_CAP");
        }
    }

    /// @dev Reads GUARD_ADMIN and, when it is set, GUARD_ACCOUNT_CAP_<SYMBOL> / GUARD_GLOBAL_CAP_<SYMBOL> (whole
    ///      tokens) for USDG and every stock. Without GUARD_ADMIN any of those variables is refused.
    function _guard(Tokens memory t) internal view returns (Guard memory g) {
        g.admin = vm.envOr("GUARD_ADMIN", address(0));
        uint256 n = t.stocks.length + 1;
        g.symbols = new string[](n);
        g.decimals = new uint8[](n);
        g.symbols[0] = "USDG";
        g.decimals[0] = IDecimals(t.usdg).decimals();
        for (uint256 i; i < t.stocks.length; ++i) {
            g.symbols[i + 1] = t.symbols[i];
            g.decimals[i + 1] = IDecimals(t.stocks[i]).decimals();
        }
        if (g.admin == address(0)) {
            for (uint256 i; i < n; ++i) {
                require(
                    !vm.envExists(string.concat("GUARD_ACCOUNT_CAP_", g.symbols[i]))
                        && !vm.envExists(string.concat("GUARD_GLOBAL_CAP_", g.symbols[i])),
                    "Velum: a GUARD_*_CAP_* variable is set but GUARD_ADMIN is not; set GUARD_ADMIN or unset the caps"
                );
            }
            return g;
        }
        g.accountCaps = new uint256[](n);
        g.globalCaps = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 one = 10 ** uint256(g.decimals[i]);
            g.accountCaps[i] = _wholeTokens(string.concat("GUARD_ACCOUNT_CAP_", g.symbols[i])) * one;
            g.globalCaps[i] = _wholeTokens(string.concat("GUARD_GLOBAL_CAP_", g.symbols[i])) * one;
        }
    }

    function _wholeTokens(string memory name) internal view returns (uint256) {
        require(
            vm.envExists(name), string.concat("Velum: GUARD_ADMIN is set, so ", name, " (whole tokens) is required")
        );
        return vm.envUint(name);
    }

    /// @notice What the operator must know about the guardian (internal audit F-07). The guardian stays
    ///         off unless GUARDIAN is set (owner sign-off); without it no market can be put in close-only,
    ///         so the corporate-actions procedure cannot run.
    function guardianNotice(address guardian) public pure returns (string memory) {
        if (guardian != address(0)) {
            return string.concat(
                "Velum: guardian ",
                vm.toString(guardian),
                " can switch markets into or out of close-only (corporate-actions procedure available)."
            );
        }
        return string.concat(
            "\n!!! WARNING Velum: GUARDIAN is not set. No market can ever be put in close-only, so the stock ",
            "split / dividend procedure (contracts/README.md, Emergency controls) is UNAVAILABLE for this ",
            "deployment. To enable it, redeploy with GUARDIAN=<address> after owner sign-off. !!!\n"
        );
    }

    /// @notice Testnet needs a dedicated price-relay key: one key controlling both deployment and every
    ///         price is refused (internal audit F-04). Anvil may use the deployer.
    function checkRelayer(uint256 chainId, bool relayerSet, address relayer, address deployer) public pure {
        if (chainId == MAINNET) revert("Velum: refusing Robinhood Chain mainnet (4663)");
        if (chainId != TESTNET) return;
        require(relayerSet && relayer != address(0), "Velum: set PRICE_RELAYER to the dedicated price-relay key");
        require(relayer != deployer, "Velum: PRICE_RELAYER must not be the deployer key");
    }

    function _deploy(Tokens memory t) internal returns (Deployed memory d) {
        d.vault = new VelumVault();
        d.oracle = new OracleAdapter();
        d.pools = new SpotPools(IVelumVault(address(d.vault)), t.usdg);
        d.book = new MakerBook(IVelumVault(address(d.vault)), t.usdg);
        d.perps = new PerpsMarkets(
            IVelumVault(address(d.vault)),
            IOracleAdapter(address(d.oracle)),
            IMakerBook(address(d.book)),
            t.usdg,
            IDecimals(t.usdg).decimals()
        );
    }

    /// @dev One-time setup of every contract; each locks itself permanently afterwards.
    function _wire(Deployed memory d, Tokens memory t, address relayer, address guardian, Guard memory g) internal {
        _wireVault(d, t, g);
        uint256 n = t.stocks.length;
        // Chainlink feeds for testnet are not verified yet, so every stock is relay-sourced.
        uint128[] memory mins = new uint128[](n);
        uint128[] memory maxs = new uint128[](n);
        uint256[] memory caps = new uint256[](n);
        uint256 minP = vm.envOr("PRICE_MIN_USD", uint256(1)) * 1e18;
        uint256 maxP = vm.envOr("PRICE_MAX_USD", uint256(100_000)) * 1e18;
        require(maxP <= type(uint128).max, "Velum: PRICE_MAX_USD too large");
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            mins[i] = uint128(minP);
            // forge-lint: disable-next-line(unsafe-typecast)
            maxs[i] = uint128(maxP);
            caps[i] = vm.envOr("OI_CAP_TOKENS", uint256(10_000)) * 1e18;
        }
        // No Chainlink feeds, so no sequencer-uptime feed either (zero = relay sources only).
        d.oracle.setup(t.stocks, new address[](n), mins, maxs, relayer, address(0));
        d.pools.setup(t.stocks);
        d.book.setup(address(d.perps), t.stocks);
        d.perps.setup(t.stocks, caps, guardian);
    }

    /// @dev Vault: tokens, modules, the protocol contracts that can never withdraw (R2-05) and the launch guard
    ///      (caps in the vault's token order: USDG, then the stocks).
    function _wireVault(Deployed memory d, Tokens memory t, Guard memory g) internal {
        uint256 n = t.stocks.length;
        address[] memory vaultTokens = new address[](n + 1);
        vaultTokens[0] = t.usdg;
        for (uint256 i; i < n; ++i) {
            vaultTokens[i + 1] = t.stocks[i];
        }
        address[] memory modules = new address[](3);
        modules[0] = address(d.pools);
        modules[1] = address(d.book);
        modules[2] = address(d.perps);
        address[] memory blocked = new address[](1);
        blocked[0] = address(d.oracle);
        d.vault.setup(vaultTokens, modules, blocked, g.admin, g.accountCaps, g.globalCaps);
    }

    function _seedPrices(OracleAdapter oracle, address[] memory stocks) internal {
        uint256[] memory prices = new uint256[](stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            prices[i] = i == 0 ? 391.65e18 : 233.4e18;
        }
        oracle.pushPrices(stocks, prices, block.timestamp);
    }

    function _tokens() internal returns (Tokens memory t) {
        if (vm.envExists("USDG_ADDRESS")) {
            t.usdg = vm.envAddress("USDG_ADDRESS");
            t.stocks = vm.envAddress("STOCK_ADDRESSES", ",");
            t.symbols = vm.envString("STOCK_SYMBOLS", ",");
            require(t.stocks.length == t.symbols.length, "Velum: STOCK_ADDRESSES and STOCK_SYMBOLS differ in length");
        } else if (block.chainid == TESTNET) {
            // Reads the verified token list (read-only permission in foundry.toml).
            // forge-lint: disable-next-line(unsafe-cheatcode)
            string memory json = vm.readFile(CONFIG);
            t.usdg = vm.parseJsonAddress(json, ".tokens.USDG.address");
            string[5] memory syms = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
            t.stocks = new address[](5);
            t.symbols = new string[](5);
            for (uint256 i; i < 5; ++i) {
                t.symbols[i] = syms[i];
                t.stocks[i] = vm.parseJsonAddress(json, string.concat(".tokens.", syms[i], ".address"));
            }
        } else {
            // local anvil: mock tokens with the real decimals (USDG 6, stocks 18)
            t.usdg = address(new MockERC20("Global Dollar (mock)", "USDG", 6));
            t.stocks = new address[](2);
            t.symbols = new string[](2);
            t.stocks[0] = address(new MockERC20("Tesla (mock)", "TSLA", 18));
            t.stocks[1] = address(new MockERC20("Amazon (mock)", "AMZN", 18));
            t.symbols[0] = "TSLA";
            t.symbols[1] = "AMZN";
        }
    }

    function _write(
        Tokens memory t,
        Deployed memory d,
        address relayer,
        address guardian,
        address guardAdmin,
        uint256 startBlock
    ) internal {
        string memory tok = "tokens";
        vm.serializeAddress(tok, "USDG", t.usdg);
        string memory tokensJson;
        for (uint256 i; i < t.stocks.length; ++i) {
            tokensJson = vm.serializeAddress(tok, t.symbols[i], t.stocks[i]);
        }
        string memory con = "contracts";
        vm.serializeAddress(con, "vault", address(d.vault));
        vm.serializeAddress(con, "oracle", address(d.oracle));
        vm.serializeAddress(con, "spotPools", address(d.pools));
        vm.serializeAddress(con, "makerBook", address(d.book));
        string memory contractsJson = vm.serializeAddress(con, "perpsMarkets", address(d.perps));

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", startBlock);
        vm.serializeAddress(root, "priceRelayer", relayer);
        vm.serializeAddress(root, "guardian", guardian);
        vm.serializeAddress(root, "guardAdmin", guardAdmin);
        vm.serializeString(root, "tokens", tokensJson);
        string memory out = vm.serializeString(root, "contracts", contractsJson);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.writeJson(out, path);
        console2.log("Velum deployed; addresses written to", path);
    }
}
