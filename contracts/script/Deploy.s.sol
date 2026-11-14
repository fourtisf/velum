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
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
/// Optional env: PRICE_RELAYER (default: deployer), OI_CAP_TOKENS (per side, default 10000),
///   PRICE_MIN_USD / PRICE_MAX_USD (relay bounds, default 1 / 100000),
///   USDG_ADDRESS + STOCK_ADDRESSES + STOCK_SYMBOLS (comma lists) to override the config file.
/// Anvil with no env: deploys mock USDG (6 dp), TSLA and AMZN (18 dp) and pushes starting prices.
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
        Tokens memory t = _tokens();
        address relayer = vm.envOr("PRICE_RELAYER", deployer);
        uint256 startBlock = block.number;
        Deployed memory d = _deploy(t);
        _wire(d, t, relayer);
        if (block.chainid == ANVIL && relayer == deployer) _seedPrices(d.oracle, t.stocks);
        vm.stopBroadcast();

        _write(t, d, relayer, startBlock);
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
    function _wire(Deployed memory d, Tokens memory t, address relayer) internal {
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
        d.vault.setup(vaultTokens, modules);

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
        d.oracle.setup(t.stocks, new address[](n), mins, maxs, relayer);
        d.pools.setup(t.stocks);
        d.book.setup(address(d.perps), t.stocks);
        d.perps.setup(t.stocks, caps);
    }

    function _seedPrices(OracleAdapter oracle, address[] memory stocks) internal {
        uint256[] memory prices = new uint256[](stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            prices[i] = i == 0 ? 391.65e18 : 233.4e18;
        }
        oracle.pushPrices(stocks, prices);
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

    function _write(Tokens memory t, Deployed memory d, address relayer, uint256 startBlock) internal {
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
        vm.serializeString(root, "tokens", tokensJson);
        string memory out = vm.serializeString(root, "contracts", contractsJson);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.writeJson(out, path);
        console2.log("Velum deployed; addresses written to", path);
    }
}
