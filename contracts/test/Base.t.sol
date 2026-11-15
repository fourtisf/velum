// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumVault} from "../src/VelumVault.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {SpotPools} from "../src/SpotPools.sol";
import {MakerBook} from "../src/MakerBook.sol";
import {PerpsMarkets} from "../src/PerpsMarkets.sol";
import {IVelumVault} from "../src/interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../src/interfaces/IMakerBook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Deploys and wires the full system the way script/Deploy.s.sol does, with mock tokens
///         (USDG 6 decimals, stocks 18) and a relay-sourced oracle.
abstract contract VelumBase is Test {
    uint256 internal constant USD = 1e6; // one USDG in base units
    uint256 internal constant TOKEN = 1e18;
    uint256 internal constant TSLA_PRICE = 391.65e18;
    uint256 internal constant AMZN_PRICE = 233.4e18;
    uint256 internal constant OI_CAP = 10_000e18;

    MockERC20 internal usdg;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    VelumVault internal vault;
    OracleAdapter internal oracle;
    SpotPools internal pools;
    MakerBook internal book;
    PerpsMarkets internal perps;

    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice"); // taker
    address internal bob = makeAddr("bob"); // maker
    address internal carol = makeAddr("carol"); // LP / second taker
    address internal liquidator = makeAddr("liquidator");
    address internal guardian = makeAddr("guardian");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        amzn = new MockERC20("Amazon", "AMZN", 18);

        vault = new VelumVault();
        oracle = new OracleAdapter();
        pools = new SpotPools(IVelumVault(address(vault)), address(usdg));
        book = new MakerBook(IVelumVault(address(vault)), address(usdg));
        perps = new PerpsMarkets(
            IVelumVault(address(vault)), IOracleAdapter(address(oracle)), IMakerBook(address(book)), address(usdg), 6
        );

        address[] memory tokens = new address[](3);
        tokens[0] = address(usdg);
        tokens[1] = address(tsla);
        tokens[2] = address(amzn);
        address[] memory modules = new address[](3);
        modules[0] = address(pools);
        modules[1] = address(book);
        modules[2] = address(perps);
        address[] memory blocked = new address[](1);
        blocked[0] = address(oracle);
        (address guardAdmin, uint256[] memory accountCaps, uint256[] memory globalCaps) = _guardConfig();
        vault.setup(tokens, modules, blocked, guardAdmin, accountCaps, globalCaps);

        address[] memory stocks = _stocks();
        address[] memory feeds = new address[](2);
        uint128[] memory mins = new uint128[](2);
        uint128[] memory maxs = new uint128[](2);
        for (uint256 i; i < 2; ++i) {
            mins[i] = 1e18;
            maxs[i] = 100_000e18;
        }
        oracle.setup(stocks, feeds, mins, maxs, relayer, _sequencerFeed());
        pools.setup(stocks);
        book.setup(address(perps), stocks);
        uint256[] memory caps = new uint256[](2);
        caps[0] = _oiCap();
        caps[1] = _oiCap();
        perps.setup(stocks, caps, guardian);

        _pushPrice(address(tsla), TSLA_PRICE);
        _pushPrice(address(amzn), AMZN_PRICE);
    }

    /// @dev The vault's launch guard: none (unguarded, as the testnet deploy does by default). Caps follow the vault's
    ///      token order (USDG, TSLA, AMZN). The guard tests and the invariant suites override it.
    function _guardConfig()
        internal
        virtual
        returns (address admin, uint256[] memory accountCaps, uint256[] memory globalCaps)
    {}

    /// @dev A guard config with the same caps for both stocks (base units).
    function _guardCaps(
        address admin,
        uint256 usdgAccount,
        uint256 usdgGlobal,
        uint256 stockAccount,
        uint256 stockGlobal
    ) internal pure returns (address, uint256[] memory accountCaps, uint256[] memory globalCaps) {
        accountCaps = new uint256[](3);
        globalCaps = new uint256[](3);
        (accountCaps[0], globalCaps[0]) = (usdgAccount, usdgGlobal);
        (accountCaps[1], globalCaps[1]) = (stockAccount, stockGlobal);
        (accountCaps[2], globalCaps[2]) = (stockAccount, stockGlobal);
        return (admin, accountCaps, globalCaps);
    }

    function _oiCap() internal view virtual returns (uint256) {
        return OI_CAP;
    }

    /// @dev The L2 sequencer-uptime feed given to the oracle (none, as the testnet deploy does). The invariant suites
    ///      override it with a mock feed whose state the handler moves between down, grace and up.
    function _sequencerFeed() internal virtual returns (address) {
        return address(0);
    }

    function _stocks() internal view returns (address[] memory s) {
        s = new address[](2);
        s[0] = address(tsla);
        s[1] = address(amzn);
    }

    /// @dev Advances one second (the relay refuses two updates in the same second) and pushes.
    function _pushPrice(address token, uint256 p) internal {
        vm.warp(block.timestamp + 1);
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = token;
        v[0] = p;
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    /// @dev The relayer pushes `target`; if the price band clamps it, waits one band window and pushes
    ///      again until the reported price reaches `target` (at most 10% per 10 minutes).
    function _movePriceTo(address token, uint256 target) internal {
        _pushPrice(token, target);
        for (uint256 i; i < 200; ++i) {
            (uint256 cur,) = oracle.latest(token);
            if (cur == target) return;
            vm.warp(block.timestamp + oracle.MOVE_WINDOW() - 1);
            _pushPrice(token, target);
        }
        revert("price did not converge");
    }

    /// @dev One band window later (the reference rolls), push `p` again.
    function _nextWindowPush(address token, uint256 p) internal {
        vm.warp(block.timestamp + oracle.MOVE_WINDOW() - 1);
        _pushPrice(token, p);
    }

    function _effectivePrice(address token) internal view returns (uint256 p) {
        (p,) = oracle.latest(token);
    }

    /// @dev Mint, deposit into the vault and approve every module.
    function _fund(address who, MockERC20 token, uint256 amount) internal {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(vault), amount);
        vault.deposit(address(token), amount, who);
        vault.setApproval(address(pools), true);
        vault.setApproval(address(book), true);
        vault.setApproval(address(perps), true);
        vm.stopPrank();
    }

    function _bal(address who, MockERC20 token) internal view returns (uint256) {
        return vault.balanceOf(who, address(token));
    }

    /// @dev Bob posts a TSLA offer: backing, largest fill, open/close spread, 1 day expiry.
    function _postOffer(uint256 backing, uint256 largestFill, uint16 openBps, uint16 closeBps)
        internal
        returns (uint256 id)
    {
        if (_bal(bob, usdg) < backing) _fund(bob, usdg, backing);
        vm.prank(bob);
        id = book.postOffer(address(tsla), backing, largestFill, openBps, closeBps, uint64(block.timestamp + 1 days));
    }

    function _open(address who, uint256 offerId, bool isLong, uint256 size, uint8 levHalf)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = perps.open(offerId, address(tsla), isLong, size, levHalf, isLong ? type(uint256).max : 1);
    }

    /// @dev Total USDG held by the perps engine must equal open margins, insurance and reserved cover.
    function _assertPerpsSolvent() internal view {
        assertEq(
            _bal(address(perps), usdg),
            perps.totalMargin() + perps.insurance() + perps.coverReserved(),
            "perps accounting"
        );
    }
}
