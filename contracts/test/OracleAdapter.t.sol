// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {OracleAdapter} from "../src/OracleAdapter.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

contract OracleAdapterTest is VelumBase {
    MockAggregator internal feed;
    OracleAdapter internal cl; // chainlink-sourced adapter for tsla, relay for amzn

    function setUp() public override {
        super.setUp();
        feed = new MockAggregator(8);
        feed.set(39_165_000_000, block.timestamp); // 391.65 at 8 decimals
        cl = new OracleAdapter();
        address[] memory tokens = _stocks();
        address[] memory feeds = new address[](2);
        feeds[0] = address(feed);
        uint128[] memory mins = new uint128[](2);
        uint128[] memory maxs = new uint128[](2);
        mins[0] = 1e18;
        mins[1] = 1e18;
        maxs[0] = 10_000e18;
        maxs[1] = 10_000e18;
        cl.setup(tokens, feeds, mins, maxs, relayer);
    }

    function _setupArgs(uint256 n)
        internal
        pure
        returns (address[] memory t, address[] memory f, uint128[] memory mn, uint128[] memory mx)
    {
        t = new address[](n);
        f = new address[](n);
        mn = new uint128[](n);
        mx = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            t[i] = address(uint160(0x1000 + i));
            mn[i] = 1;
            mx[i] = 2;
        }
    }

    function test_setup_guards() public {
        OracleAdapter o = new OracleAdapter();
        (address[] memory t, address[] memory f, uint128[] memory mn, uint128[] memory mx) = _setupArgs(1);
        vm.prank(alice);
        vm.expectRevert(OracleAdapter.NotDeployer.selector);
        o.setup(t, f, mn, mx, relayer);

        vm.expectRevert(OracleAdapter.LengthMismatch.selector);
        o.setup(t, new address[](2), mn, mx, relayer);

        mn[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadBounds.selector, t[0]));
        o.setup(t, f, mn, mx, relayer);
        mn[0] = 2;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadBounds.selector, t[0]));
        o.setup(t, f, mn, mx, relayer);
        mn[0] = 1;

        vm.expectRevert(OracleAdapter.ZeroAddress.selector); // relay-sourced without a relayer
        o.setup(t, f, mn, mx, address(0));

        f[0] = address(new MockAggregator(19));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadFeedDecimals.selector, f[0]));
        o.setup(t, f, mn, mx, relayer);

        t[0] = address(0);
        f[0] = address(0);
        vm.expectRevert(OracleAdapter.ZeroAddress.selector);
        o.setup(t, f, mn, mx, relayer);

        (t, f, mn, mx) = _setupArgs(1);
        o.setup(t, f, mn, mx, relayer);
        vm.expectRevert(OracleAdapter.AlreadySetUp.selector);
        o.setup(t, f, mn, mx, relayer);
    }

    function test_relay_pushAndRead() public view {
        assertEq(oracle.price(address(tsla)), TSLA_PRICE);
        (uint256 p, uint256 at) = oracle.latest(address(tsla));
        assertEq(p, TSLA_PRICE);
        assertEq(at, block.timestamp - 1); // setUp pushes TSLA one second before AMZN
    }

    function test_relay_guards() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = 400e18;

        vm.expectRevert(OracleAdapter.NotRelayer.selector);
        oracle.pushPrices(t, v);

        vm.startPrank(relayer);
        vm.expectRevert(OracleAdapter.LengthMismatch.selector);
        oracle.pushPrices(t, new uint256[](2));

        t[0] = address(amzn);
        v[0] = 234e18;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.TooSoon.selector, address(amzn)));
        oracle.pushPrices(t, v); // AMZN was pushed in this same second

        t[0] = address(tsla);
        v[0] = 431e18; // > 10% above 391.65
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.MoveTooLarge.selector, address(tsla), TSLA_PRICE, 431e18));
        oracle.pushPrices(t, v);

        v[0] = 0.5e18;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceOutOfBounds.selector, address(tsla), 0.5e18));
        oracle.pushPrices(t, v);

        t[0] = address(usdg);
        v[0] = 1e18;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.UnknownToken.selector, address(usdg)));
        oracle.pushPrices(t, v);
        vm.stopPrank();

        // after an hour without updates only the absolute bounds apply
        vm.warp(block.timestamp + 1 hours);
        t[0] = address(tsla);
        v[0] = 600e18;
        vm.prank(relayer);
        oracle.pushPrices(t, v);
        assertEq(oracle.price(address(tsla)), 600e18);
    }

    function test_relay_refusesFeedSourcedToken() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        t[0] = address(tsla);
        v[0] = 391e18;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NotRelaySourced.selector, address(tsla)));
        cl.pushPrices(t, v);
    }

    function test_staleness() public {
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 60);
        assertEq(oracle.price(address(tsla)), TSLA_PRICE);
        vm.warp(at + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), at));
        oracle.price(address(tsla));
    }

    function test_noPriceAndDead() public {
        // amzn on `cl` is relay-sourced and was never pushed
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(amzn)));
        cl.price(address(amzn));
        assertTrue(cl.isDead(address(amzn)));
        assertTrue(oracle.isDead(address(usdg))); // not configured at all
        assertFalse(oracle.isDead(address(tsla)));
        (, uint256 at) = oracle.latest(address(tsla));
        vm.warp(at + 14 days);
        assertFalse(oracle.isDead(address(tsla)));
        vm.warp(at + 14 days + 1);
        assertTrue(oracle.isDead(address(tsla)));
    }

    function test_chainlink_scalesAndChecks() public {
        assertEq(cl.price(address(tsla)), 391.65e18);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.StalePrice.selector, address(tsla), block.timestamp - 61));
        cl.price(address(tsla));

        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));
        assertTrue(cl.isDead(address(tsla)));

        feed.set(39_165_000_000, block.timestamp + 10); // updatedAt in the future
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));

        feed.set(5_000_000, block.timestamp); // 0.05 < min bound
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceOutOfBounds.selector, address(tsla), 0.05e18));
        cl.price(address(tsla));
        assertTrue(cl.isDead(address(tsla)));

        feed.set(39_165_000_000, block.timestamp);
        feed.setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.NoPrice.selector, address(tsla)));
        cl.price(address(tsla));
        assertTrue(cl.isDead(address(tsla)));
    }

    function testFuzz_chainlinkScaling(uint64 answer, uint8 dec) public {
        dec = uint8(bound(dec, 0, 18));
        MockAggregator f = new MockAggregator(dec);
        OracleAdapter o = new OracleAdapter();
        address[] memory t = new address[](1);
        address[] memory fs = new address[](1);
        uint128[] memory mn = new uint128[](1);
        uint128[] memory mx = new uint128[](1);
        t[0] = address(tsla);
        fs[0] = address(f);
        mn[0] = 1;
        mx[0] = type(uint128).max;
        o.setup(t, fs, mn, mx, address(0));
        vm.assume(answer > 0);
        f.set(int256(uint256(answer)), block.timestamp);
        assertEq(o.price(address(tsla)), uint256(answer) * 10 ** (18 - dec));
    }
}
