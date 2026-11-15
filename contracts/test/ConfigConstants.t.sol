// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";

/// @notice RC-02: the contracts hard-code the CLAUDE.md §5 numbers as constants. This test ties every shared
///         constant to the `protocol` block of packages/config/robinhood-testnet.json (the file the API, workers and
///         web read), so a change on either side fails here instead of drifting. It changes no number.
///         Every key of the `protocol` block must be checked below or listed as not enforced on-chain.
contract ConfigConstantsTest is VelumBase {
    string internal constant CONFIG = "../packages/config/robinhood-testnet.json";
    uint256 internal constant BPS = 10_000;
    uint256 internal constant ONE = 1e18; // fixed point for the config's non-integer numbers

    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(CONFIG);
    }

    function _uint(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, string.concat(".protocol.", key));
    }

    /// @dev A non-integer config number as a fixed-point value with 18 decimals. `vm.parseJson*` cannot read
    ///      non-integer JSON numbers, so the number is taken from the file text after `"key":` in the protocol block.
    function _decimal(string memory key) internal view returns (uint256) {
        bytes memory all = bytes(json);
        uint256 from = vm.indexOf(json, "\"protocol\"");
        require(from != type(uint256).max, "no protocol block");
        bytes memory rest = new bytes(all.length - from);
        for (uint256 j; j < rest.length; ++j) {
            rest[j] = all[from + j];
        }
        uint256 at = vm.indexOf(string(rest), string.concat("\"", key, "\""));
        require(at != type(uint256).max, string.concat("missing protocol key ", key));
        uint256 i = at + bytes(key).length + 2;
        while (rest[i] == " " || rest[i] == ":" || rest[i] == "\"") {
            ++i;
        }
        bytes memory num;
        while (i < rest.length && ((rest[i] >= "0" && rest[i] <= "9") || rest[i] == ".")) {
            num = bytes.concat(num, rest[i]);
            ++i;
        }
        return _fixed(num);
    }

    /// @dev "0.001" -> 1e15, "5" -> 5e18.
    function _fixed(bytes memory num) internal pure returns (uint256 v) {
        require(num.length != 0, "not a number");
        uint256 decimals;
        bool dot;
        for (uint256 i; i < num.length; ++i) {
            if (num[i] == ".") {
                require(!dot, "two dots");
                dot = true;
                continue;
            }
            v = v * 10 + (uint8(num[i]) - 48);
            if (dot) ++decimals;
        }
        require(decimals <= 18, "too many decimals");
        v *= 10 ** (18 - decimals);
    }

    function _isKnown(string memory key) internal pure returns (bool) {
        string[15] memory known = [
            // checked against the contracts below
            "maxLeverage",
            "leverageStep",
            "maintenanceMarginFactor",
            "takerFeeBps",
            "liquidationPenaltyBps",
            "spotPoolFeeBps",
            "maxTokensPerPosition",
            "forcedExitDelayDays",
            "forcedExitBondEth",
            "oracleMaxAgeSeconds",
            "oracleDeadAfterDays",
            "maxFundingPerHourPct",
            // not enforced on-chain in Phase 3:
            // matching is atomic, there is no lock-then-fill step (contracts/README.md, simplifications)
            "makerFillWindowMinutes",
            // UI default for spot / swap minOut
            "defaultSlippagePct",
            // Phase 4 public-aggregate thresholds (indexer / API)
            "publicAggregate"
        ];
        for (uint256 i; i < known.length; ++i) {
            if (keccak256(bytes(key)) == keccak256(bytes(known[i]))) return true;
        }
        return false;
    }

    function test_RC02_everyProtocolKeyIsAccountedFor() public view {
        string[] memory keys = vm.parseJsonKeys(json, ".protocol");
        assertEq(keys.length, 15);
        for (uint256 i; i < keys.length; ++i) {
            assertTrue(_isKnown(keys[i]), string.concat("protocol key not checked against the contracts: ", keys[i]));
        }
    }

    function test_RC02_perpsConstantsMatchConfig() public view {
        uint256 maxL = _uint("maxLeverage");
        assertEq(perps.MAX_LEVERAGE(), maxL, "max leverage");
        // Leverage is passed as leverageHalf = leverage x 2, so the contract's unit is one 0.5 step.
        uint256 step = _decimal("leverageStep");
        assertEq(step * 2, ONE, "leverage step: leverageHalf counts steps of 1/2");
        // Initial margin 1 / maxL; maintenance margin factor / maxL (0.5 / 5 = 10%).
        assertEq(perps.IM_BPS(), BPS / maxL, "initial margin");
        assertEq(perps.MM_BPS() * ONE, (BPS * _decimal("maintenanceMarginFactor")) / maxL, "maintenance margin");
        assertEq(perps.TAKER_FEE_BPS(), _uint("takerFeeBps"), "taker fee");
        assertEq(perps.LIQUIDATION_PENALTY_BPS(), _uint("liquidationPenaltyBps"), "liquidation penalty");
        assertEq(perps.MAX_POSITION_QTY(), _uint("maxTokensPerPosition") * 1e18, "max tokens per position");
        assertEq(perps.FORCED_EXIT_DELAY(), _uint("forcedExitDelayDays") * 1 days, "forced exit delay");
        assertEq(perps.FORCED_EXIT_BOND(), _decimal("forcedExitBondEth"), "forced exit bond (wei)");
        // Funding rate unit: 1e18 = 100% per hour, so 0.01% / h = 1e14.
        assertEq(perps.MAX_FUNDING_RATE_PER_HOUR() * 100, int256(_decimal("maxFundingPerHourPct")), "funding cap");
    }

    function test_RC02_spotConstantsMatchConfig() public view {
        assertEq(pools.FEE_BPS(), _uint("spotPoolFeeBps"), "spot pool fee per hop");
    }

    /// @notice The config's oracleMaxAgeSeconds (60) is the oracle's freshness cap and the age the perps engine
    ///         accepts for closes, liquidations, forced exits and funding. Opens (F-06) and margin removal (IA-03)
    ///         deliberately need a fresher price, 10 s: that stricter limit is a contract-only safety parameter,
    ///         not a §5 number, and must stay below the config's 60 s.
    function test_RC02_oracleAgesMatchConfig() public view {
        uint256 maxAge = _uint("oracleMaxAgeSeconds");
        assertEq(oracle.MAX_AGE(), maxAge, "oracle freshness cap");
        assertEq(perps.MAX_PRICE_AGE(), maxAge, "closes, liquidations, forced exits, funding");
        assertEq(perps.OPEN_MAX_AGE(), 10, "opens and margin removal: 10 s");
        assertLt(perps.OPEN_MAX_AGE(), maxAge, "the open freshness is stricter than the config's");
        assertEq(oracle.DEAD_AFTER(), _uint("oracleDeadAfterDays") * 1 days, "dead after");
    }

    function test_RC02_decimalParser() public pure {
        assertEq(_fixed("0.5"), 0.5e18);
        assertEq(_fixed("0.001"), 1e15);
        assertEq(_fixed("0.01"), 1e16);
        assertEq(_fixed("5"), 5e18);
    }
}
