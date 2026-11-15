// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {SpotPools} from "../src/SpotPools.sol";
import {IVelumVault} from "../src/interfaces/IVelumVault.sol";

contract SpotPoolsTest is VelumBase {
    uint256 internal constant DL = type(uint256).max;

    function setUp() public override {
        super.setUp();
        _fund(carol, tsla, 1000 * TOKEN);
        _fund(carol, amzn, 1000 * TOKEN);
        _fund(carol, usdg, 1_000_000 * USD);
        _fund(alice, usdg, 100_000 * USD);
        _fund(alice, tsla, 10 * TOKEN);
    }

    function _seed() internal {
        vm.startPrank(carol);
        pools.addLiquidity(address(tsla), 100 * TOKEN, 39_165 * USD, 1, DL); // 391.65 USDG per TSLA
        pools.addLiquidity(address(amzn), 100 * TOKEN, 23_340 * USD, 1, DL); // 233.40 USDG per AMZN
        vm.stopPrank();
    }

    function _reserves(address s) internal view returns (uint256 sr, uint256 ur, uint256 ts) {
        (sr, ur, ts,) = pools.pools(s);
    }

    function _ref(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        uint256 inFee = amountIn * 9970 / 10_000;
        return inFee * rOut / (rIn + inFee);
    }

    function test_setup_guards() public {
        SpotPools p = new SpotPools(IVelumVault(address(vault)), address(usdg));
        address[] memory s = new address[](1);
        s[0] = address(usdg);
        vm.expectRevert(SpotPools.ZeroAddress.selector);
        p.setup(s);
        s[0] = address(tsla);
        vm.prank(alice);
        vm.expectRevert(SpotPools.NotDeployer.selector);
        p.setup(s);
        p.setup(s);
        assertEq(p.stockCount(), 1);
        vm.expectRevert(SpotPools.AlreadySetUp.selector);
        p.setup(s);
        vm.expectRevert(SpotPools.ZeroAddress.selector);
        new SpotPools(IVelumVault(address(0)), address(usdg));
    }

    function test_firstLiquidity_locksMinimum() public {
        vm.prank(carol);
        (uint256 shares, uint256 sIn, uint256 uIn) = pools.addLiquidity(address(tsla), 100 * TOKEN, 39_165 * USD, 1, DL);
        uint256 root = _sqrt(100 * TOKEN * 39_165 * USD);
        assertEq(shares, root - 1000);
        assertEq(sIn, 100 * TOKEN);
        assertEq(uIn, 39_165 * USD);
        assertEq(pools.sharesOf(address(tsla), address(0)), 1000);
        (uint256 sr, uint256 ur, uint256 ts) = _reserves(address(tsla));
        assertEq(sr, 100 * TOKEN);
        assertEq(ur, 39_165 * USD);
        assertEq(ts, root);
        assertEq(_bal(address(pools), tsla), sr);
        assertEq(_bal(address(pools), usdg), ur);
    }

    function test_addLiquidity_proportionalRoundsUp() public {
        _seed();
        (uint256 sr, uint256 ur, uint256 ts) = _reserves(address(tsla));
        vm.prank(alice);
        (uint256 shares, uint256 sIn, uint256 uIn) = pools.addLiquidity(address(tsla), 1 * TOKEN, 1000 * USD, 1, DL);
        assertEq(shares, (1 * TOKEN * ts) / sr);
        assertLe(sIn, 1 * TOKEN);
        assertLe(uIn, 1000 * USD);
        assertGe(sIn * ts, shares * sr); // rounded up for the pool
        assertGe(uIn * ts, shares * ur);
    }

    function test_addLiquidity_guards() public {
        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(SpotPools.UnknownPool.selector, address(usdg)));
        pools.addLiquidity(address(usdg), 1, 1, 1, DL);
        vm.expectRevert(SpotPools.ZeroAmount.selector);
        pools.addLiquidity(address(tsla), 0, 1, 1, DL);
        vm.expectRevert(SpotPools.ZeroAmount.selector); // sqrt(1000*1) <= MIN_LIQUIDITY
        pools.addLiquidity(address(tsla), 1000, 1, 1, DL);
        vm.expectRevert(SpotPools.Expired.selector);
        pools.addLiquidity(address(tsla), 1, 1, 0, block.timestamp - 1);
        pools.addLiquidity(address(tsla), 100 * TOKEN, 39_165 * USD, 1, DL);
        (,, uint256 ts) = _reserves(address(tsla));
        (uint256 sr,,) = _reserves(address(tsla));
        uint256 wouldGet = (1 * TOKEN * ts) / sr;
        vm.expectRevert(abi.encodeWithSelector(SpotPools.Slippage.selector, wouldGet, wouldGet + 1));
        pools.addLiquidity(address(tsla), 1 * TOKEN, 1000 * USD, wouldGet + 1, DL);
        vm.expectRevert(SpotPools.ZeroAmount.selector); // rounds to zero shares
        pools.addLiquidity(address(tsla), 1, 1, 1, DL);
        vm.stopPrank();
    }

    function test_removeLiquidity() public {
        _seed();
        uint256 mine = pools.sharesOf(address(tsla), carol);
        (uint256 sr, uint256 ur, uint256 ts) = _reserves(address(tsla));
        uint256 beforeS = _bal(carol, tsla);
        vm.prank(carol);
        (uint256 sOut, uint256 uOut) = pools.removeLiquidity(address(tsla), mine / 2, 1, 1, DL);
        assertEq(sOut, (mine / 2) * sr / ts);
        assertEq(uOut, (mine / 2) * ur / ts);
        assertEq(_bal(carol, tsla), beforeS + sOut);

        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(SpotPools.InsufficientShares.selector, mine - mine / 2, mine));
        pools.removeLiquidity(address(tsla), mine, 1, 1, DL);
        vm.expectRevert(SpotPools.ZeroAmount.selector);
        pools.removeLiquidity(address(tsla), 0, 1, 1, DL);
        (sr, ur, ts) = _reserves(address(tsla));
        uint256 next = (mine / 2) * sr / ts;
        vm.expectRevert(abi.encodeWithSelector(SpotPools.Slippage.selector, next, type(uint256).max));
        pools.removeLiquidity(address(tsla), mine / 2, type(uint256).max, 1, DL);
        // everything except the locked minimum comes back
        pools.removeLiquidity(address(tsla), mine - mine / 2, 1, 1, DL);
        vm.stopPrank();
        (sr, ur, ts) = _reserves(address(tsla));
        assertEq(ts, 1000);
        assertGt(sr, 0);
        assertGt(ur, 0);
    }

    function test_swap_usdgToStock() public {
        _seed();
        (uint256 sr, uint256 ur,) = _reserves(address(tsla));
        uint256 expected = _ref(1000 * USD, ur, sr);
        assertEq(pools.getAmountOut(address(usdg), address(tsla), 1000 * USD), expected);
        vm.prank(alice);
        uint256 out = pools.swap(address(usdg), address(tsla), 1000 * USD, expected, DL);
        assertEq(out, expected);
        (uint256 sr2, uint256 ur2,) = _reserves(address(tsla));
        assertEq(ur2, ur + 1000 * USD); // fee stays in the pool
        assertEq(sr2, sr - out);
        assertGe(sr2 * ur2, sr * ur); // k never decreases
        assertEq(_bal(alice, tsla), 10 * TOKEN + out);
    }

    function test_swap_stockToUsdg() public {
        _seed();
        (uint256 sr, uint256 ur,) = _reserves(address(tsla));
        vm.prank(alice);
        uint256 out = pools.swap(address(tsla), address(usdg), 2 * TOKEN, 1, DL);
        assertEq(out, _ref(2 * TOKEN, sr, ur));
    }

    function test_swap_twoHopsPaysTwoFees() public {
        _seed();
        (uint256 tsr, uint256 tur,) = _reserves(address(tsla));
        (uint256 asr, uint256 aur,) = _reserves(address(amzn));
        uint256 mid = _ref(1 * TOKEN, tsr, tur);
        uint256 expected = _ref(mid, aur, asr);
        assertEq(pools.getAmountOut(address(tsla), address(amzn), 1 * TOKEN), expected);
        vm.prank(alice);
        uint256 out = pools.swap(address(tsla), address(amzn), 1 * TOKEN, expected, DL);
        assertEq(out, expected);
        (, uint256 tur2,) = _reserves(address(tsla));
        (, uint256 aur2,) = _reserves(address(amzn));
        assertEq(tur2, tur - mid);
        assertEq(aur2, aur + mid);
    }

    function test_swap_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(SpotPools.NoLiquidity.selector, address(tsla)));
        pools.swap(address(usdg), address(tsla), 1 * USD, 1, DL);
        vm.expectRevert(SpotPools.SameToken.selector);
        pools.swap(address(usdg), address(usdg), 1, 1, DL);
        vm.expectRevert(SpotPools.ZeroAmount.selector);
        pools.swap(address(usdg), address(tsla), 0, 1, DL);
        vm.expectRevert(SpotPools.Expired.selector);
        pools.swap(address(usdg), address(tsla), 1, 0, block.timestamp - 1);
        vm.expectRevert(SpotPools.SameToken.selector);
        pools.getAmountOut(address(tsla), address(tsla), 1);
        vm.stopPrank();
        _seed();
        vm.prank(alice);
        vm.expectRevert(); // Slippage
        pools.swap(address(usdg), address(tsla), 1000 * USD, 100 * TOKEN, DL);
        vm.prank(alice);
        vm.expectRevert(SpotPools.ZeroAmount.selector); // output rounds to zero
        pools.swap(address(tsla), address(usdg), 1, 1, DL);
    }

    function testFuzz_swapNeverDecreasesK(uint256 amountIn, bool buy) public {
        _seed();
        _fund(alice, usdg, 1_000_000 * USD);
        _fund(alice, tsla, 1000 * TOKEN);
        (uint256 sr, uint256 ur,) = _reserves(address(tsla));
        amountIn = buy ? bound(amountIn, 10, 1_000_000 * USD) : bound(amountIn, 1e9, 1000 * TOKEN);
        vm.prank(alice);
        try pools.swap(
            buy ? address(usdg) : address(tsla), buy ? address(tsla) : address(usdg), amountIn, 1, DL
        ) returns (
            uint256 out
        ) {
            (uint256 sr2, uint256 ur2,) = _reserves(address(tsla));
            assertGe(sr2 * ur2, sr * ur);
            assertLt(out, buy ? sr : ur);
            assertEq(_bal(address(pools), tsla), sr2);
            assertEq(_bal(address(pools), usdg), ur2 + 23_340 * USD); // plus the AMZN pool's USDG
        } catch (bytes memory err) {
            assertEq(bytes4(err), SpotPools.ZeroAmount.selector);
        }
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
