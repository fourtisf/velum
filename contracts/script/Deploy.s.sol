// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
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
/// @notice Deploys, wires and locks the Phase 3 contracts on Robinhood Chain TESTNET (46630), a local anvil (31337),
///         or Robinhood Chain MAINNET (4663) as the guarded beta only (owner decision, before the Phase 5 external
///         audit: allowlisted wallets, capped deposits). Every other chain is refused.
///
/// Mainnet (4663), guarded beta only (docs/07-mainnet-guarded-beta.md; deploy/deploy-contracts.sh runs both steps):
///   Allowed only when ALL of these hold, otherwise the script stops before anything is broadcast:
///   - GUARD_ADMIN is set and every cap is given (USDG and every stock): the launch guard is on;
///   - PRICE_RELAYER is set (the signer's PRICE_RELAY key, created with deploy/new-key.sh BEFORE this deployment: the
///     oracle's relayer is fixed forever), and it is neither the deployer nor GUARD_ADMIN; GUARDIAN, if set, is neither
///     the price relayer nor the deployer;
///   - the tokens are exactly the verified mainnet list below: no USDG_ADDRESS / STOCK_ADDRESSES / STOCK_SYMBOLS
///     overrides, packages/config/robinhood-mainnet.json must list the same addresses, and each token on chain has
///     code, the expected decimals() and symbol();
///   - MAINNET_REF_PRICE_<SYMBOL> (the token's current price in USDG, e.g. 391.65) is given for every stock and the
///     oracle bounds (PRICE_MIN_USD / PRICE_MAX_USD) leave at least MAINNET_BOUND_FACTOR (5x) on both sides of it;
///   - two steps: first a simulation (`forge script` WITHOUT --broadcast) prints the full summary and writes
///     deployments/4663.plan.json (a hash of every input, the build and the deployer's nonce); then the broadcast
///     (`--broadcast`) is accepted only with a matching plan at most MAINNET_PLAN_MAX_AGE (1 h) old, and with
///     VELUM_MAINNET_GUARDED_CONFIRM equal to the exact phrase the simulation prints (`mainnetPhrase`), which names
///     the chain id, the guard admin and the price relayer, so a phrase copied from the docs never matches.
///   The plan is removed once the broadcast run has accepted it; the deployments file is written only by the broadcast.
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
    string internal constant MAINNET_CONFIG = "../packages/config/robinhood-mainnet.json";
    /// @dev The smallest USDG account cap accepted without GUARD_ALLOW_SMALL_USDG_CAP: the minimum position size
    ///      (`PerpsBase.minPositionSize`, 10 USDG), in whole USDG.
    uint256 internal constant MIN_USDG_ACCOUNT_CAP = 10;
    /// @dev Mainnet: the oracle bounds must leave at least this factor on each side of every token's reference price
    ///      (min <= ref / 5 and max >= ref x 5), so an 80% fall, a 5-for-1 split or a five-fold rise stays inside the
    ///      immutable bounds (contracts/README.md, corporate actions; IA-06: a source outside them lags at the bound).
    uint256 public constant MAINNET_BOUND_FACTOR = 5;
    /// @dev Mainnet: how long the simulation's plan stays valid for the broadcast (seconds).
    uint256 public constant MAINNET_PLAN_MAX_AGE = 1 hours;
    /// @dev Mainnet: the simulation's plan (a hash of every input), required by the broadcast. Under deployments/,
    ///      the only directory the script may write (foundry.toml fs_permissions).
    string public constant MAINNET_PLAN = "deployments/4663.plan.json";
    /// @dev The verified mainnet tokens (packages/config/robinhood-mainnet.json, "_verification": on-chain
    ///      name/symbol/decimals and the issuers' published lists, 2026-11-14). The script refuses anything else on
    ///      4663 and checks that the config file still says the same. Stock order = the config's.
    address internal constant MAINNET_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    struct Tokens {
        address usdg;
        address[] stocks;
        string[] symbols;
    }

    /// @dev Settings read once from the environment (strictly, D-01): oracle bounds and open-interest cap, 1e18 units.
    struct Params {
        uint256 minPrice;
        uint256 maxPrice;
        uint256 oiCap;
    }

    /// @dev Mainnet only: what the gate checks and the summary prints. `refPrices` follow `t.stocks` (1e18 USDG per
    ///      token, 0 = not given). `phrase` is VELUM_MAINNET_GUARDED_CONFIRM as given ("" = not given).
    struct Mainnet {
        address deployer;
        uint256 deployerNonce;
        bool relayerSet;
        address relayer;
        address guardian;
        string phrase;
        uint256[] refPrices;
        bytes32 planHash;
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
        require(
            block.chainid == TESTNET || block.chainid == ANVIL || block.chainid == MAINNET,
            "Velum: deploy only to Robinhood Chain testnet (46630), a local anvil (31337) or, as the guarded beta, Robinhood Chain mainnet (4663)"
        );
        bool mainnet = block.chainid == MAINNET;
        // Mainnet: `forge script` without --broadcast is the simulation (step 1); anything else is held to the plan.
        bool dryRun = vm.isContext(VmSafe.ForgeContext.ScriptDryRun);

        vm.startBroadcast();
        Mainnet memory m = _roles();
        console2.log(guardianNotice(m.guardian));
        Tokens memory t = _tokens();
        if (mainnet) checkMainnetTokenContracts(t);
        Guard memory g = _guard(t);
        checkGuard(g, block.chainid, m.deployer, m.relayer);
        Params memory p = _params();
        if (mainnet) _mainnetGate(m, t, g, p, dryRun);
        console2.log(guardNotice(g));
        uint256 startBlock = block.number;
        Deployed memory d = _deploy(t);
        _wire(d, t, m.relayer, m.guardian, g, p);
        if (block.chainid == ANVIL && m.relayer == m.deployer) _seedPrices(d.oracle, t.stocks);
        vm.stopBroadcast();

        if (mainnet && dryRun) {
            _writePlan(m);
        } else {
            _write(t, d, m.relayer, m.guardian, g.admin, startBlock);
        }
        console2.log(guardNotice(g));
        if (mainnet) console2.log(_mainnetNextStep(m, dryRun));
        // Repeated after the addresses so it is the last thing the operator sees (internal audit F-07).
        console2.log(guardianNotice(m.guardian));
    }

    /// @dev The deployer (the broadcasting account), PRICE_RELAYER (default: the deployer, anvil only) and GUARDIAN,
    ///      checked: on mainnet `checkMainnetRoles` first (before any token is read), then `checkRelayer`.
    function _roles() internal view returns (Mainnet memory m) {
        (, m.deployer,) = vm.readCallers();
        (m.relayerSet, m.relayer) = envAddressStrict("PRICE_RELAYER");
        if (!m.relayerSet) m.relayer = m.deployer;
        (, m.guardian) = envAddressStrict("GUARDIAN");
        if (block.chainid == MAINNET) {
            (, address admin) = envAddressStrict("GUARD_ADMIN");
            checkMainnetRoles(m.relayerSet, m.relayer, m.deployer, admin, m.guardian);
        }
        checkRelayer(block.chainid, m.relayerSet, m.relayer, m.deployer);
    }

    // ---------------------------------------------------------------- mainnet: guarded beta only

    /// @dev The rest of the mainnet conditions (roles and token contracts are checked earlier in `run`): reference
    ///      prices and bounds, then the summary; the confirmation phrase (required for the broadcast) and, in the
    ///      broadcast run, the simulation's plan. Reverts with the reason on the first unmet condition.
    function _mainnetGate(Mainnet memory m, Tokens memory t, Guard memory g, Params memory p, bool dryRun) internal {
        m.deployerNonce = vm.getNonce(m.deployer);
        (, m.phrase) = _envStringStrict("VELUM_MAINNET_GUARDED_CONFIRM");
        // Repeated with the parsed guard (`_roles` checked the raw GUARD_ADMIN before any token was read).
        checkMainnetRoles(m.relayerSet, m.relayer, m.deployer, g.admin, m.guardian);
        m.refPrices = _refPrices(t);
        checkMainnetBounds(t.symbols, m.refPrices, p.minPrice, p.maxPrice);
        m.planHash = planHash(m, t, g, p);
        console2.log(mainnetSummary(m, t, g, p));
        string memory phrase = mainnetPhrase(block.chainid, g.admin, m.relayer);
        // Step 1 may be given the phrase already, but it must then be right; step 2 needs it.
        checkMainnetConfirm(m.phrase, phrase, !dryRun);
        if (dryRun) return;
        bool exists = vm.isFile(MAINNET_PLAN);
        uint256 planChain;
        bytes32 planned;
        uint256 simulatedAt;
        if (exists) {
            // forge-lint: disable-next-line(unsafe-cheatcode)
            string memory json = vm.readFile(MAINNET_PLAN);
            planChain = vm.parseJsonUint(json, ".chainId");
            planned = vm.parseJsonBytes32(json, ".configHash");
            simulatedAt = vm.parseJsonUint(json, ".simulatedAt");
        }
        checkPlan(exists, planChain, planned, simulatedAt, m.planHash, vm.unixTime() / 1000);
        // One plan, one broadcast: a second broadcast needs a new simulation (the nonce in the hash moves anyway).
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.removeFile(MAINNET_PLAN);
    }

    /// @notice The exact text VELUM_MAINNET_GUARDED_CONFIRM must hold for a mainnet broadcast. It names the chain id,
    ///         the guard admin and the price relayer (checksummed), so text copied from the docs never matches: only
    ///         an operator who has the real values in front of them (the simulation prints it) can give it.
    function mainnetPhrase(uint256 chainId, address guardAdmin, address relayer) public pure returns (string memory) {
        return string.concat(
            "deploy unaudited Velum guarded beta to chain ",
            vm.toString(chainId),
            " with guard admin ",
            vm.toString(guardAdmin),
            " and price relayer ",
            vm.toString(relayer)
        );
    }

    /// @notice The confirmation phrase: required for the broadcast, and when given (also in the simulation) it must be
    ///         exactly `expected`.
    function checkMainnetConfirm(string memory given, string memory expected, bool required) public pure {
        if (bytes(given).length == 0) {
            require(
                !required,
                string.concat(
                    "Velum: refusing Robinhood Chain mainnet (4663): set VELUM_MAINNET_GUARDED_CONFIRM to the exact phrase the simulation printed: ",
                    expected
                )
            );
            return;
        }
        require(
            keccak256(bytes(given)) == keccak256(bytes(expected)),
            string.concat(
                "Velum: refusing Robinhood Chain mainnet (4663): VELUM_MAINNET_GUARDED_CONFIRM does not match this deployment's chain id, guard admin and price relayer. Expected exactly: ",
                expected
            )
        );
    }

    /// @notice Mainnet roles: the launch guard on, a dedicated price-relay key that is neither the deployer nor the guard
    ///         admin, and a guardian (optional) that is neither the price relayer nor the deployer. Caps are checked by
    ///         `_guard` (every one required with GUARD_ADMIN) and `checkGuard`.
    function checkMainnetRoles(bool relayerSet, address relayer, address deployer, address guardAdmin, address guardian)
        public
        pure
    {
        require(
            guardAdmin != address(0),
            "Velum: refusing Robinhood Chain mainnet (4663) without the launch guard. Before the Phase 5 external audit mainnet is allowed only as the guarded beta: set GUARD_ADMIN (the owner multisig) and every GUARD_ACCOUNT_CAP_<SYMBOL> / GUARD_GLOBAL_CAP_<SYMBOL> (docs/07-mainnet-guarded-beta.md)"
        );
        _checkMainnetRelayer(relayerSet, relayer, deployer);
        require(relayer != guardAdmin, "Velum: refusing Robinhood Chain mainnet (4663): PRICE_RELAYER is GUARD_ADMIN");
        require(
            guardAdmin != deployer, "Velum: refusing Robinhood Chain mainnet (4663): GUARD_ADMIN is the deployer key"
        );
        if (guardian != address(0)) {
            require(
                guardian != relayer && guardian != deployer,
                "Velum: refusing Robinhood Chain mainnet (4663): GUARDIAN must be a cold owner key, not the price-relay or deployer key"
            );
        }
    }

    function _checkMainnetRelayer(bool relayerSet, address relayer, address deployer) internal pure {
        require(
            relayerSet && relayer != address(0),
            "Velum: refusing Robinhood Chain mainnet (4663): set PRICE_RELAYER to the signer's PRICE_RELAY key address (deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY, before this deployment)"
        );
        require(
            relayer != deployer, "Velum: refusing Robinhood Chain mainnet (4663): PRICE_RELAYER is the deployer key"
        );
    }

    /// @notice The verified mainnet token list (see MAINNET_USDG). Nothing else is ever deployed against on 4663.
    function mainnetTokens() public pure returns (Tokens memory t) {
        t.usdg = MAINNET_USDG;
        t.symbols = new string[](10);
        t.stocks = new address[](10);
        (t.symbols[0], t.stocks[0]) = ("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d);
        (t.symbols[1], t.stocks[1]) = ("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54);
        (t.symbols[2], t.stocks[2]) = ("PLTR", 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A);
        (t.symbols[3], t.stocks[3]) = ("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC);
        (t.symbols[4], t.stocks[4]) = ("NFLX", 0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8);
        (t.symbols[5], t.stocks[5]) = ("AMD", 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC);
        (t.symbols[6], t.stocks[6]) = ("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9);
        (t.symbols[7], t.stocks[7]) = ("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35);
        (t.symbols[8], t.stocks[8]) = ("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74);
        (t.symbols[9], t.stocks[9]) = ("COIN", 0x6330D8C3178a418788dF01a47479c0ce7CCF450b);
    }

    /// @notice `fromConfig` (packages/config/robinhood-mainnet.json, as the API, workers and web read it) must be the
    ///         verified list exactly: same USDG, same symbols in the same order, same addresses.
    function checkMainnetTokenList(Tokens memory fromConfig) public pure {
        Tokens memory v = mainnetTokens();
        string memory differs =
            "Velum: refusing Robinhood Chain mainnet (4663): packages/config/robinhood-mainnet.json does not list exactly the verified mainnet tokens of script/Deploy.s.sol (mainnetTokens)";
        require(fromConfig.usdg == v.usdg && fromConfig.stocks.length == v.stocks.length, differs);
        require(fromConfig.symbols.length == v.symbols.length, differs);
        for (uint256 i; i < v.stocks.length; ++i) {
            require(fromConfig.stocks[i] == v.stocks[i], differs);
            require(keccak256(bytes(fromConfig.symbols[i])) == keccak256(bytes(v.symbols[i])), differs);
        }
    }

    /// @notice Each listed token, on the chain being deployed to: has code, answers decimals() with 6 (USDG) or 18
    ///         (stocks) and symbol() with its ticker.
    function checkMainnetTokenContracts(Tokens memory t) public view {
        _checkToken(t.usdg, "USDG", 6);
        for (uint256 i; i < t.stocks.length; ++i) {
            _checkToken(t.stocks[i], t.symbols[i], 18);
        }
    }

    function _checkToken(address token, string memory symbol, uint8 decimals) internal view {
        string memory where = string.concat(
            "Velum: refusing Robinhood Chain mainnet (4663): the ", symbol, " token ", vm.toString(token), " "
        );
        require(token.code.length != 0, string.concat(where, "has no code on this chain"));
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(
            ok && ret.length == 32 && abi.decode(ret, (uint256)) == decimals,
            string.concat(where, "has other decimals than expected")
        );
        (ok, ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok && ret.length >= 64, string.concat(where, "has no readable symbol()"));
        require(
            keccak256(bytes(abi.decode(ret, (string)))) == keccak256(bytes(symbol)),
            string.concat(where, "reports another symbol()")
        );
    }

    /// @dev MAINNET_REF_PRICE_<SYMBOL> for every stock: the token's current price in USDG (a token amount with up to
    ///      18 decimals, e.g. 391.65), converted to 1e18 units. deploy/deploy-contracts.sh fills them from Robinhood's
    ///      quote API right before the simulation and passes the same values to the broadcast.
    function _refPrices(Tokens memory t) internal view returns (uint256[] memory ref) {
        ref = new uint256[](t.stocks.length);
        for (uint256 i; i < t.stocks.length; ++i) {
            string memory name = string.concat("MAINNET_REF_PRICE_", t.symbols[i]);
            if (_envGiven(name)) ref[i] = parseUnits(name, vm.envString(name), 18);
        }
    }

    /// @notice Mainnet bounds: every stock needs a reference price (non-zero) and the immutable oracle bounds must leave
    ///         at least MAINNET_BOUND_FACTOR on both sides of it: min x 5 <= ref and ref x 5 <= max (1e18 units).
    function checkMainnetBounds(string[] memory symbols, uint256[] memory refPrices, uint256 minPrice, uint256 maxPrice)
        public
        pure
    {
        require(symbols.length == refPrices.length, "Velum: reference prices differ in length");
        for (uint256 i; i < symbols.length; ++i) {
            string memory s = symbols[i];
            require(
                refPrices[i] != 0,
                string.concat(
                    "Velum: refusing Robinhood Chain mainnet (4663): set MAINNET_REF_PRICE_",
                    s,
                    " to the token's current price in USDG (deploy/deploy-contracts.sh reads it from Robinhood's quote API)"
                )
            );
            require(
                refPrices[i] < 1e27,
                string.concat(
                    "Velum: refusing Robinhood Chain mainnet (4663): MAINNET_REF_PRICE_", s, " is implausibly large"
                )
            );
            require(
                minPrice * MAINNET_BOUND_FACTOR <= refPrices[i] && refPrices[i] * MAINNET_BOUND_FACTOR <= maxPrice,
                string.concat(
                    "Velum: refusing Robinhood Chain mainnet (4663): the oracle bounds [",
                    formatUnits(minPrice, 18),
                    ", ",
                    formatUnits(maxPrice, 18),
                    "] leave less than 5x on a side of ",
                    s,
                    "'s reference price ",
                    formatUnits(refPrices[i], 18),
                    " (set PRICE_MIN_USD / PRICE_MAX_USD; the bounds are immutable)"
                )
            );
        }
    }

    /// @notice The simulation's plan, for the broadcast: it must exist (the simulation ran), be for this chain, carry
    ///         the same configuration hash (every input, the build and the deployer's nonce) and be at most
    ///         MAINNET_PLAN_MAX_AGE old (and not from the future). `nowSec`: wall-clock seconds.
    function checkPlan(
        bool exists,
        uint256 planChain,
        bytes32 planned,
        uint256 simulatedAt,
        bytes32 expected,
        uint256 nowSec
    ) public pure {
        require(
            exists,
            "Velum: refusing Robinhood Chain mainnet (4663): no simulation plan (deployments/4663.plan.json). Run the same command WITHOUT --broadcast first, check its summary, then broadcast within 1 hour"
        );
        require(planChain == MAINNET, "Velum: refusing Robinhood Chain mainnet (4663): the plan is for another chain");
        require(
            planned == expected,
            "Velum: refusing Robinhood Chain mainnet (4663): the settings, the build or the deployer's nonce differ from the simulation. Simulate again (without --broadcast) and check the new summary"
        );
        require(
            simulatedAt <= nowSec,
            "Velum: refusing Robinhood Chain mainnet (4663): the simulation plan is dated in the future"
        );
        require(
            nowSec - simulatedAt <= MAINNET_PLAN_MAX_AGE,
            "Velum: refusing Robinhood Chain mainnet (4663): the simulation is more than 1 hour old. Simulate again (without --broadcast)"
        );
    }

    /// @notice What the plan binds: chain, deployer and its nonce, every role, the guard, the tokens, bounds, open-interest
    ///         cap, reference prices and the creation code of all five contracts (the build).
    function planHash(Mainnet memory m, Tokens memory t, Guard memory g, Params memory p)
        public
        view
        returns (bytes32)
    {
        bytes32 build = keccak256(
            abi.encode(
                keccak256(type(VelumVault).creationCode),
                keccak256(type(OracleAdapter).creationCode),
                keccak256(type(SpotPools).creationCode),
                keccak256(type(MakerBook).creationCode),
                keccak256(type(PerpsMarkets).creationCode)
            )
        );
        bytes32 roles =
            keccak256(abi.encode(block.chainid, m.deployer, m.deployerNonce, m.relayer, m.guardian, g.admin));
        bytes32 tokens = keccak256(abi.encode(t.usdg, t.stocks, t.symbols, m.refPrices));
        return keccak256(abi.encode(build, roles, tokens, g.accountCaps, g.globalCaps, p.minPrice, p.maxPrice, p.oiCap));
    }

    /// @notice Everything the operator must check before broadcasting to mainnet, in one place.
    function mainnetSummary(Mainnet memory m, Tokens memory t, Guard memory g, Params memory p)
        public
        view
        returns (string memory out)
    {
        out = string.concat(
            "\n================ Velum GUARDED BETA on Robinhood Chain MAINNET (",
            vm.toString(block.chainid),
            ") ================\n",
            "UNAUDITED contracts (the Phase 5 external audit has not happened). Allowlisted wallets only, capped deposits,\n",
            "no pause, no upgrade: every contract locks itself in this script. Withdrawals are never blocked.\n",
            "Deployer:      ",
            vm.toString(m.deployer),
            " (nonce ",
            vm.toString(m.deployerNonce),
            ", balance ",
            formatUnits(m.deployer.balance, 18),
            " ETH)\n"
        );
        out = string.concat(
            out,
            "Price relayer: ",
            vm.toString(m.relayer),
            " (balance ",
            formatUnits(m.relayer.balance, 18),
            " ETH). FIXED FOREVER: must be the signer's PRICE_RELAY key (new-key.sh); a new key means a new deployment\n",
            "Guard admin:   ",
            vm.toString(g.admin),
            g.adminHasCode ? " (has code: a contract / multisig)\n" : " (NO CODE: a plain key, not a multisig)\n",
            "Guardian:      ",
            m.guardian == address(0)
                ? "none (no close-only switch: the corporate-actions procedure is unavailable)\n"
                : string.concat(vm.toString(m.guardian), " (close-only switch only)\n")
        );
        out = string.concat(
            out,
            "Oracle: relay-sourced (no Chainlink feed, no sequencer feed), bounds [",
            formatUnits(p.minPrice, 18),
            ", ",
            formatUnits(p.maxPrice, 18),
            "] USDG per token for every stock (immutable)\nOpen-interest cap per side and market: ",
            formatUnits(p.oiCap, 18),
            " tokens\nTokens (the verified mainnet list; on-chain code, decimals and symbol checked):\n  USDG ",
            vm.toString(t.usdg),
            " (6 decimals)\n"
        );
        for (uint256 i; i < t.stocks.length; ++i) {
            out = string.concat(
                out,
                "  ",
                t.symbols[i],
                " ",
                vm.toString(t.stocks[i]),
                " (18 decimals) reference price ",
                formatUnits(m.refPrices[i], 18),
                ": bounds = ref / ",
                vm.toString(p.minPrice == 0 ? 0 : m.refPrices[i] / p.minPrice),
                " .. ref x ",
                vm.toString(p.maxPrice / m.refPrices[i]),
                "\n"
            );
        }
        out = string.concat(
            out,
            "Plan (configuration) hash: ",
            vm.toString(m.planHash),
            "\nBroadcast confirmation phrase (VELUM_MAINNET_GUARDED_CONFIRM):\n  ",
            mainnetPhrase(block.chainid, g.admin, m.relayer),
            "\n========================================================================================="
        );
    }

    function _writePlan(Mainnet memory m) internal {
        string memory root = "plan";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "deployer", m.deployer);
        vm.serializeUint(root, "deployerNonce", m.deployerNonce);
        vm.serializeUint(root, "simulatedAt", vm.unixTime() / 1000);
        string memory out = vm.serializeBytes32(root, "configHash", m.planHash);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.writeJson(out, MAINNET_PLAN);
    }

    function _mainnetNextStep(Mainnet memory m, bool dryRun) internal pure returns (string memory) {
        if (dryRun) {
            return string.concat(
                "\nVelum: mainnet SIMULATION done, nothing was broadcast. Plan ",
                vm.toString(m.planHash),
                " written to ",
                MAINNET_PLAN,
                ". Check the summary above; then, within 1 hour, run the same command with --broadcast and",
                " VELUM_MAINNET_GUARDED_CONFIRM set to the phrase above (deploy/deploy-contracts.sh does both steps)."
            );
        }
        return "\nVelum: mainnet broadcast run accepted (plan matched). Check every transaction succeeded, then install deployments/4663.json (deploy/deploy-contracts.sh does).";
    }

    /// @dev An optional string variable: `(false, "")` when unset or empty.
    function _envStringStrict(string memory name) internal view returns (bool, string memory) {
        if (!_envGiven(name)) return (false, "");
        return (true, vm.envString(name));
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
    ///         Mainnet (4663) has the same rule plus more in `checkMainnetRoles`, which `run` applies there.
    function checkRelayer(uint256 chainId, bool relayerSet, address relayer, address deployer) public pure {
        if (chainId == MAINNET) return _checkMainnetRelayer(relayerSet, relayer, deployer);
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
    /// @dev PRICE_MIN_USD / PRICE_MAX_USD (relay bounds in whole USDG, default 1 / 100000) and OI_CAP_TOKENS (per side,
    ///      default 10000), read strictly, in 1e18 units.
    function _params() internal view returns (Params memory p) {
        uint256 minUsd = envUintStrict("PRICE_MIN_USD", 1);
        uint256 maxUsd = envUintStrict("PRICE_MAX_USD", 100_000);
        uint256 oiTokens = envUintStrict("OI_CAP_TOKENS", 10_000);
        require(maxUsd <= type(uint128).max / 1e18, "Velum: PRICE_MAX_USD too large");
        require(oiTokens <= type(uint128).max / 1e18, "Velum: OI_CAP_TOKENS too large");
        p.minPrice = minUsd * 1e18;
        p.maxPrice = maxUsd * 1e18;
        p.oiCap = oiTokens * 1e18;
    }

    function _wire(
        Deployed memory d,
        Tokens memory t,
        address relayer,
        address guardian,
        Guard memory g,
        Params memory p
    ) internal {
        _wireVault(d, t, g);
        uint256 n = t.stocks.length;
        // No verified Chainlink feeds on Robinhood Chain yet (packages/config), so every stock is relay-sourced.
        uint128[] memory mins = new uint128[](n);
        uint128[] memory maxs = new uint128[](n);
        uint256[] memory caps = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            mins[i] = uint128(p.minPrice);
            // forge-lint: disable-next-line(unsafe-typecast)
            maxs[i] = uint128(p.maxPrice);
            caps[i] = p.oiCap;
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
        if (block.chainid == MAINNET) return _mainnetTokensChecked();
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

    /// @dev Mainnet: the verified list, never an override; packages/config/robinhood-mainnet.json must agree with it.
    function _mainnetTokensChecked() internal view returns (Tokens memory t) {
        require(
            !_envGiven("USDG_ADDRESS") && !_envGiven("STOCK_ADDRESSES") && !_envGiven("STOCK_SYMBOLS"),
            "Velum: refusing Robinhood Chain mainnet (4663): USDG_ADDRESS, STOCK_ADDRESSES and STOCK_SYMBOLS are not accepted on mainnet; it deploys only against the verified token list"
        );
        t = mainnetTokens();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(MAINNET_CONFIG);
        Tokens memory c;
        c.usdg = vm.parseJsonAddress(json, ".tokens.USDG.address");
        c.stocks = new address[](t.stocks.length);
        c.symbols = new string[](t.stocks.length);
        for (uint256 i; i < t.stocks.length; ++i) {
            c.symbols[i] = t.symbols[i];
            c.stocks[i] = vm.parseJsonAddress(json, string.concat(".tokens.", t.symbols[i], ".address"));
        }
        // The config may not list more tokens than the verified ones either.
        require(
            vm.parseJsonKeys(json, ".tokens").length == t.stocks.length + 1,
            "Velum: refusing Robinhood Chain mainnet (4663): packages/config/robinhood-mainnet.json lists other tokens than the verified mainnet list"
        );
        checkMainnetTokenList(c);
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
