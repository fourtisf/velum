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
/// Every variable is read strictly (independent guard audit D-01): unset or empty means "not given" (the
///   default), and any other value must parse, or the script stops. An address must have 40 hex digits and,
///   when written in mixed case, a correct EIP-55 checksum. `vm.envOr` would read a malformed value as unset.
/// Anvil with no env: deploys mock USDG (6 dp), TSLA and AMZN (18 dp), uses the deployer as relayer and
///   pushes starting prices.
///
/// Optional launch guard (contracts/README.md, Guarded launch). Off unless GUARD_ADMIN is set; off is the
/// testnet default. With GUARD_ADMIN set, every listed token needs both caps, as token amounts: whole tokens or
/// decimals up to the token's decimals() (USDG 6, stock tokens 18), e.g. 1000 or 250.5; the script converts them
/// to base units. 0 blocks that token until the admin raises it (printed as BLOCKED). Caps without GUARD_ADMIN are
/// refused, so a deployment is never believed to be guarded when it is not.
///   # GUARD_ADMIN=                  owner multisig: allowlists addresses, raises caps, calls liftCaps() and then
///   #                               openToPublic() (one-way), hands the role over in two steps. Must not be
///   #                               PRICE_RELAYER, nor the deployer outside anvil; a warning is printed when it has
///   #                               no code (a plain key, not a multisig).
///   # GUARD_ACCOUNT_CAP_<SYMBOL>=   per-account cap on net deposits, token amount, for USDG and every stock symbol
///   # GUARD_GLOBAL_CAP_<SYMBOL>=    cap on the vault's total holdings of the token, token amount (>= account cap).
///   #                               Each allowlisted address needs one account cap of it (G-01): global / account
///   #                               is how many addresses can be allowlisted before the global cap is raised.
///   # GUARD_ALLOW_SMALL_USDG_CAP=   true to accept a USDG account cap below 10 USDG (the minimum position size; 0
///   #                               blocks USDG, the margin and quote asset). Refused without it.
///   # e.g. GUARD_ACCOUNT_CAP_USDG=1000 GUARD_GLOBAL_CAP_USDG=50000 GUARD_ACCOUNT_CAP_TSLA=2 GUARD_GLOBAL_CAP_TSLA=100
contract Deploy is Script {
    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46_630;
    uint256 internal constant ANVIL = 31_337;
    string internal constant CONFIG = "../packages/config/robinhood-testnet.json";
    /// @dev The smallest USDG account cap accepted without GUARD_ALLOW_SMALL_USDG_CAP: the minimum position size
    ///      (`PerpsBase.minPositionSize`, 10 USDG), in whole USDG.
    uint256 internal constant MIN_USDG_ACCOUNT_CAP = 10;

    struct Tokens {
        address usdg;
        address[] stocks;
        string[] symbols;
    }

    /// @dev Launch guard. Symbols, decimals and caps follow the vault's token order: USDG, then the stocks.
    ///      Caps are in base units; both arrays are empty when `admin` is zero (unguarded). `adminHasCode`: the
    ///      admin address has contract code (a multisig) on the target chain. `allowSmallUsdgCap`:
    ///      GUARD_ALLOW_SMALL_USDG_CAP=true.
    struct Guard {
        address admin;
        bool adminHasCode;
        bool allowSmallUsdgCap;
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
        (bool relayerSet, address relayer) = envAddressStrict("PRICE_RELAYER");
        if (!relayerSet) relayer = deployer;
        checkRelayer(block.chainid, relayerSet, relayer, deployer);
        (, address guardian) = envAddressStrict("GUARDIAN");
        console2.log(guardianNotice(guardian));
        Tokens memory t = _tokens();
        Guard memory g = _guard(t);
        checkGuard(g, block.chainid, deployer, relayer);
        console2.log(guardNotice(g));
        uint256 startBlock = block.number;
        Deployed memory d = _deploy(t);
        _wire(d, t, relayer, guardian, g);
        if (block.chainid == ANVIL && relayer == deployer) _seedPrices(d.oracle, t.stocks);
        vm.stopBroadcast();

        _write(t, d, relayer, guardian, g.admin, startBlock);
        console2.log(guardNotice(g));
        // Repeated after the addresses so it is the last thing the operator sees (internal audit F-07).
        console2.log(guardianNotice(guardian));
    }

    /// @notice What the operator must know about the launch guard: who holds it, what it can and cannot do, whether
    ///         it is a plain key, the caps per token (token amounts and base units, BLOCKED for a zero account cap)
    ///         and how many addresses the caps leave room for (G-01).
    function guardNotice(Guard memory g) public pure returns (string memory out) {
        if (g.admin == address(0)) {
            return string.concat(
                "Velum: launch guard OFF (GUARD_ADMIN not set): anyone can deposit, with no caps, from the start. ",
                "That is the testnet default; a guarded beta needs GUARD_ADMIN and caps (contracts/README.md, Guarded launch)."
            );
        }
        out = string.concat(
            "\nVelum: launch guard ON. Guard admin ",
            vm.toString(g.admin),
            " can only allowlist addresses, raise caps, call liftCaps() and then openToPublic() (one-way) and hand",
            " the role over in two steps. It cannot move, freeze or redirect funds, block withdrawals, remove an",
            " address, lower a cap or use up anyone's deposit room. Until openToPublic() only allowlisted addresses",
            " can deposit or approve modules; withdrawals, closes, liquidations and forced exits are never blocked."
        );
        if (!g.adminHasCode) {
            out = string.concat(
                out,
                "\n!!! WARNING Velum: GUARD_ADMIN ",
                vm.toString(g.admin),
                " has no code on this chain: it is a plain key, not a multisig. One stolen key then controls the",
                " allowlist and the caps. Use the owner multisig for a real beta (contracts/README.md, Guarded launch). !!!"
            );
        }
        out = string.concat(
            out, "\nCaps until liftCaps() (per account on net deposits / global on the vault's holdings):"
        );
        for (uint256 i; i < g.symbols.length; ++i) {
            out = string.concat(out, "\n  ", g.symbols[i], ": ", _capLine(g, i));
        }
        out = string.concat(out, _roomLine(g), "\n");
    }

    /// @dev "1000 / 50000 tokens (base units ...)", or BLOCKED when the account cap is zero.
    function _capLine(Guard memory g, uint256 i) internal pure returns (string memory) {
        string memory units =
            string.concat("(base units ", vm.toString(g.accountCaps[i]), " / ", vm.toString(g.globalCaps[i]), ")");
        string memory amounts = string.concat(
            formatUnits(g.accountCaps[i], g.decimals[i]), " / ", formatUnits(g.globalCaps[i], g.decimals[i]), " tokens "
        );
        if (g.accountCaps[i] != 0) return string.concat(amounts, units);
        return string.concat("BLOCKED: no deposits until the admin raises the account cap; ", amounts, units);
    }

    /// @dev G-01: each allowlisted address needs a whole account cap of every token's global cap, so the allowlist can
    ///      hold at most min(global / account) addresses (tokens with a zero account cap set no limit).
    function _roomLine(Guard memory g) internal pure returns (string memory) {
        uint256 room = type(uint256).max;
        string memory by;
        for (uint256 i; i < g.symbols.length; ++i) {
            if (g.accountCaps[i] == 0) continue;
            uint256 r = g.globalCaps[i] / g.accountCaps[i];
            if (r < room) (room, by) = (r, g.symbols[i]);
        }
        if (room == type(uint256).max) {
            return "\nAllowlist room: no limit while every account cap is zero (each raise needs global >= account x allowlisted).";
        }
        return string.concat(
            "\nAllowlist room: at most ",
            vm.toString(room),
            " addresses at these caps (global / account cap, lowest for ",
            by,
            "). Every allowlisted address keeps its full account cap; to add more, raise the global caps first (G-01)."
        );
    }

    /// @notice The launch-guard admin is a cold owner key: never the hot price-relay key, and outside anvil never the
    ///         deployer key (independent guard audit I-01). Caps must be consistent (the vault refuses them too, with a
    ///         less helpful error), none may be given without an admin, and a USDG account cap below the minimum
    ///         position size (10 USDG; 0 blocks the margin and quote asset) needs GUARD_ALLOW_SMALL_USDG_CAP=true (I-02).
    ///         `g.accountCaps[0]` is USDG's, as in the vault's token order.
    function checkGuard(Guard memory g, uint256 chainId, address deployer, address relayer) public pure {
        require(g.accountCaps.length == g.globalCaps.length, "Velum: guard caps differ in length");
        if (g.admin == address(0)) {
            require(g.accountCaps.length == 0, "Velum: guard caps given but GUARD_ADMIN is not set");
            return;
        }
        require(g.admin != relayer, "Velum: GUARD_ADMIN must not be the price-relay key");
        require(
            chainId == ANVIL || g.admin != deployer,
            "Velum: GUARD_ADMIN must not be the deployer key outside anvil; use the owner multisig"
        );
        for (uint256 i; i < g.accountCaps.length; ++i) {
            require(g.accountCaps[i] <= g.globalCaps[i], "Velum: a GUARD_ACCOUNT_CAP is above its GUARD_GLOBAL_CAP");
        }
        require(g.accountCaps.length != 0 && g.decimals.length != 0, "Velum: guard caps missing for USDG");
        require(
            g.allowSmallUsdgCap || g.accountCaps[0] >= MIN_USDG_ACCOUNT_CAP * 10 ** uint256(g.decimals[0]),
            "Velum: GUARD_ACCOUNT_CAP_USDG is below 10 USDG (the minimum position size; 0 blocks USDG, the margin and quote asset), so nobody could trade. Set GUARD_ALLOW_SMALL_USDG_CAP=true if that is intended"
        );
    }

    /// @dev Reads GUARD_ADMIN and, when it is set, GUARD_ACCOUNT_CAP_<SYMBOL> / GUARD_GLOBAL_CAP_<SYMBOL> (token
    ///      amounts) for USDG and every stock. Without GUARD_ADMIN any of those variables is refused.
    function _guard(Tokens memory t) internal view returns (Guard memory g) {
        (, g.admin) = envAddressStrict("GUARD_ADMIN");
        g.adminHasCode = g.admin.code.length != 0;
        g.allowSmallUsdgCap = envBoolStrict("GUARD_ALLOW_SMALL_USDG_CAP");
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
                    !_envGiven(string.concat("GUARD_ACCOUNT_CAP_", g.symbols[i]))
                        && !_envGiven(string.concat("GUARD_GLOBAL_CAP_", g.symbols[i])),
                    "Velum: a GUARD_*_CAP_* variable is set but GUARD_ADMIN is not; set GUARD_ADMIN or unset the caps"
                );
            }
            return g;
        }
        g.accountCaps = new uint256[](n);
        g.globalCaps = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            g.accountCaps[i] = _cap(string.concat("GUARD_ACCOUNT_CAP_", g.symbols[i]), g.decimals[i]);
            g.globalCaps[i] = _cap(string.concat("GUARD_GLOBAL_CAP_", g.symbols[i]), g.decimals[i]);
        }
    }

    /// @dev A required cap, as a token amount converted to base units.
    function _cap(string memory name, uint8 decimals) internal view returns (uint256) {
        require(
            _envGiven(name),
            string.concat("Velum: GUARD_ADMIN is set, so ", name, " (a token amount, e.g. 1000 or 250.5) is required")
        );
        return parseUnits(name, vm.envString(name), decimals);
    }

    // ---------------------------------------------------------------- strict environment reads (D-01)

    /// @dev Set to a non-empty value. Unset and empty both mean "not given" (.env.example: empty = unguarded).
    function _envGiven(string memory name) internal view returns (bool) {
        return vm.envExists(name) && bytes(vm.envString(name)).length != 0;
    }

    /// @notice An optional address variable: `(false, 0)` when unset or empty; otherwise it must be an address (40 hex
    ///         digits, with a correct EIP-55 checksum when written in mixed case) or the script stops. Independent
    ///         guard audit D-01: `vm.envOr` read a malformed GUARD_ADMIN as unset and deployed without the guard.
    function envAddressStrict(string memory name) public view returns (bool set, address value) {
        if (!_envGiven(name)) return (false, address(0));
        string memory raw = vm.envString(name);
        try vm.envAddress(name) returns (address a) {
            value = a;
        } catch {
            revert(string.concat("Velum: ", name, "=", raw, " is not an address (40 hex digits)"));
        }
        require(
            checksumOk(raw, value),
            string.concat("Velum: ", name, "=", raw, " has a wrong EIP-55 checksum (expected ", vm.toString(value), ")")
        );
        return (true, value);
    }

    /// @notice An optional whole-number variable: `dflt` when unset or empty, otherwise it must parse (D-01).
    function envUintStrict(string memory name, uint256 dflt) public view returns (uint256) {
        if (!_envGiven(name)) return dflt;
        try vm.envUint(name) returns (uint256 v) {
            return v;
        } catch {
            revert(string.concat("Velum: ", name, "=", vm.envString(name), " is not a whole number"));
        }
    }

    /// @notice An optional flag: false when unset or empty, otherwise it must be true or false (D-01).
    function envBoolStrict(string memory name) public view returns (bool) {
        if (!_envGiven(name)) return false;
        try vm.envBool(name) returns (bool v) {
            return v;
        } catch {
            revert(string.concat("Velum: ", name, "=", vm.envString(name), " is not true or false"));
        }
    }

    /// @notice True unless `raw` mixes upper- and lower-case hex letters without matching `a`'s EIP-55 checksum
    ///         (all-lower or all-upper carries no checksum). `raw` is `a` as parsed: its last 40 characters (after
    ///         trailing spaces) are the hex digits, preceded by an optional 0x prefix.
    function checksumOk(string memory raw, address a) public pure returns (bool) {
        bytes memory r = bytes(raw);
        bytes memory c = bytes(vm.toString(a)); // "0x" + checksummed hex
        uint256 end = r.length;
        while (end != 0 && r[end - 1] == " ") --end;
        if (end < 40) return false;
        uint256 off = end - 40;
        bool upper;
        bool lower;
        for (uint256 i; i < 40; ++i) {
            bytes1 ch = r[off + i];
            if (ch >= "A" && ch <= "F") upper = true;
            else if (ch >= "a" && ch <= "f") lower = true;
        }
        if (!(upper && lower)) return true;
        for (uint256 i; i < 40; ++i) {
            if (r[off + i] != c[2 + i]) return false;
        }
        return true;
    }

    /// @notice "250.5" with `decimals` 6 is 250_500_000: digits with at most one decimal point and at most `decimals`
    ///         digits after it. Anything else (empty, signs, exponents, separators, spaces, hex) stops the script
    ///         naming `name` (independent guard audit I-02: caps were whole tokens only).
    function parseUnits(string memory name, string memory s, uint8 decimals) public pure returns (uint256 v) {
        bytes memory b = bytes(s);
        string memory bad = string.concat(
            "Velum: ",
            name,
            "=",
            s,
            " is not a token amount (digits, optionally a decimal point and at most ",
            vm.toString(uint256(decimals)),
            " decimals)"
        );
        uint256 dot = b.length;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == ".") {
                require(dot == b.length && i != 0 && i + 1 < b.length, bad);
                dot = i;
            } else {
                require(b[i] >= "0" && b[i] <= "9", bad);
            }
        }
        require(b.length != 0, bad);
        uint256 fraction = dot == b.length ? 0 : b.length - dot - 1;
        require(fraction <= decimals, bad);
        for (uint256 i; i < b.length; ++i) {
            if (i == dot) continue;
            uint256 d = uint8(b[i]) - 48;
            require(v <= (type(uint256).max - d) / 10, bad);
            v = v * 10 + d;
        }
        uint256 scale = 10 ** (decimals - fraction);
        require(v <= type(uint256).max / scale, bad);
        v *= scale;
    }

    /// @notice `units` base units as a token amount: 250_500_000 with 6 decimals is "250.5".
    function formatUnits(uint256 units, uint8 decimals) public pure returns (string memory) {
        uint256 one = 10 ** uint256(decimals);
        string memory whole = vm.toString(units / one);
        uint256 frac = units % one;
        if (frac == 0) return whole;
        uint256 digits = decimals;
        while (frac % 10 == 0) {
            frac /= 10;
            --digits;
        }
        bytes memory f = bytes(vm.toString(frac));
        bytes memory pad = new bytes(digits - f.length);
        for (uint256 i; i < pad.length; ++i) {
            pad[i] = "0";
        }
        return string.concat(whole, ".", string(pad), string(f));
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
        uint256 minP = envUintStrict("PRICE_MIN_USD", 1) * 1e18;
        uint256 maxP = envUintStrict("PRICE_MAX_USD", 100_000) * 1e18;
        uint256 oiCap = envUintStrict("OI_CAP_TOKENS", 10_000) * 1e18;
        require(maxP <= type(uint128).max, "Velum: PRICE_MAX_USD too large");
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            mins[i] = uint128(minP);
            // forge-lint: disable-next-line(unsafe-typecast)
            maxs[i] = uint128(maxP);
            caps[i] = oiCap;
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
        (bool usdgSet, address usdgAddr) = envAddressStrict("USDG_ADDRESS");
        if (usdgSet) {
            t.usdg = usdgAddr;
            t.stocks = vm.envAddress("STOCK_ADDRESSES", ",");
            t.symbols = vm.envString("STOCK_SYMBOLS", ",");
            require(t.stocks.length == t.symbols.length, "Velum: STOCK_ADDRESSES and STOCK_SYMBOLS differ in length");
            string[] memory raw = vm.envString("STOCK_ADDRESSES", ",");
            for (uint256 i; i < raw.length; ++i) {
                require(
                    checksumOk(raw[i], t.stocks[i]), "Velum: an address in STOCK_ADDRESSES has a wrong EIP-55 checksum"
                );
            }
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
