// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Drives random but valid-ish protocol usage for the invariant suite and keeps ghost totals.
contract Handler is Test {
    VelumVault public vault;
    OracleAdapter public oracle;
    SpotPools public pools;
    MakerBook public book;
    PerpsMarkets public perps;
    MockERC20 public usdg;
    MockERC20[2] public stocks;
    address public relayer;

    address[] public actors;
    address public liquidator = makeAddr("inv-liquidator");
    uint256[] public positionIds;
    uint256[] public offerIds;

    mapping(address token => uint256) public deposited;
    mapping(address token => uint256) public withdrawn;
    bool public liquidationOverpaid;
    uint256 public liquidations;
    uint256 public closes;
    uint256 public opens;
    uint256 public forcedExits;
    uint256 public openAttempts;
    uint256 public openFailures;
    bytes4 public lastOpenError;

    uint256[2] public price = [uint256(391.65e18), uint256(233.4e18)];

    constructor(
        VelumVault vault_,
        OracleAdapter oracle_,
        SpotPools pools_,
        MakerBook book_,
        PerpsMarkets perps_,
        MockERC20 usdg_,
        MockERC20 s0,
        MockERC20 s1,
        address relayer_
    ) {
        vault = vault_;
        oracle = oracle_;
        pools = pools_;
        book = book_;
        perps = perps_;
        usdg = usdg_;
        stocks[0] = s0;
        stocks[1] = s1;
        relayer = relayer_;
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 10 ether);
            vm.startPrank(a);
            usdg.approve(address(vault), type(uint256).max);
            s0.approve(address(vault), type(uint256).max);
            s1.approve(address(vault), type(uint256).max);
            vault.setApproval(address(pools), true);
            vault.setApproval(address(book), true);
            vault.setApproval(address(perps), true);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------ helpers

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function positionCount() external view returns (uint256) {
        return positionIds.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        uint256 k = seed % 3;
        return k == 0 ? usdg : stocks[k - 1];
    }

    /// @dev Keep both prices fresh; each push needs a new second.
    function refreshPrices() public {
        vm.warp(block.timestamp + 1);
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        t[0] = address(stocks[0]);
        t[1] = address(stocks[1]);
        v[0] = price[0];
        v[1] = price[1];
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    // ------------------------------------------------------------ vault

    function deposit(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 t = tokenSeed % 2 == 0 ? usdg : _token(tokenSeed);
        amount = bound(amount, t == usdg ? 100e6 : 1e15, t == usdg ? 200_000e6 : 500e18);
        t.mint(a, amount);
        vm.prank(a);
        uint256 got = vault.deposit(address(t), amount, a);
        deposited[address(t)] += got;
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 bal = vault.balanceOf(a, address(t));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        vault.withdraw(address(t), amount, a);
        withdrawn[address(t)] += amount;
    }

    // ------------------------------------------------------------ spot

    function addLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 s, uint256 u) external {
        address a = _actor(actorSeed);
        MockERC20 st = stocks[stockSeed % 2];
        uint256 sb = vault.balanceOf(a, address(st));
        uint256 ub = vault.balanceOf(a, address(usdg));
        if (sb < 1e15 || ub < 1e6) return;
        s = bound(s, 1e15, sb);
        u = bound(u, 1e6, ub);
        vm.prank(a);
        try pools.addLiquidity(address(st), s, u, 0, block.timestamp) {} catch {}
    }

    function removeLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 pct) external {
        address a = _actor(actorSeed);
        address st = address(stocks[stockSeed % 2]);
        uint256 sh = pools.sharesOf(st, a);
        if (sh == 0) return;
        uint256 amount = (sh * bound(pct, 1, 100)) / 100;
        if (amount == 0) return;
        vm.prank(a);
        try pools.removeLiquidity(st, amount, 0, 0, block.timestamp) {} catch {}
    }

    function swap(uint256 actorSeed, uint256 inSeed, uint256 outSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 tin = _token(inSeed);
        MockERC20 tout = _token(outSeed);
        if (tin == tout) return;
        uint256 bal = vault.balanceOf(a, address(tin));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        try pools.swap(address(tin), address(tout), amount, 0, block.timestamp) {} catch {}
    }

    // ------------------------------------------------------------ makers

    function postOffer(uint256 actorSeed, uint256 stockSeed, uint256 backing, uint256 fillPct, uint16 o, uint16 c)
        external
    {
        address a = _actor(actorSeed);
        uint256 bal = vault.balanceOf(a, address(usdg));
        if (bal < 20e6) return;
        backing = bound(backing, 10e6, bal / 2); // keep funds for trading too
        uint256 largest = (backing * bound(fillPct, 1, 100)) / 100;
        if (largest == 0) largest = backing;
        vm.prank(a);
        uint256 id = book.postOffer(
            address(stocks[stockSeed % 2]),
            backing,
            largest,
            uint16(bound(o, 0, 500)),
            uint16(bound(c, 0, 500)),
            uint64(block.timestamp + 30 days)
        );
        offerIds.push(id);
    }

    function withdrawOffer(uint256 idx) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[idx % offerIds.length];
        (address maker,,,,,,, bool active) = book.offers(id);
        if (!active) return;
        vm.prank(maker);
        book.withdrawOffer(id);
    }

    // ------------------------------------------------------------ perps

    function openPosition(uint256 actorSeed, uint256 offerIdx, bool isLong, uint256 size, uint8 lev) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[offerIdx % offerIds.length];
        (address maker, address market,,,,, uint64 expiry, bool active) = book.offers(id);
        if (!active || block.timestamp >= expiry) return;
        // first actor (from the seed) who is not the maker and holds some USDG
        address a;
        for (uint256 i; i < actors.length; ++i) {
            address c = _actor(actorSeed + i);
            if (c != maker && vault.balanceOf(c, address(usdg)) >= 10e6) {
                a = c;
                break;
            }
        }
        if (a == address(0)) return;
        lev = uint8(bound(lev, 2, 10));
        uint256 maxSize = _maxSize(id, a, lev, market);
        if (maxSize < 1e6) return;
        size = bound(size, 1e6, maxSize);
        openAttempts++;
        vm.prank(a);
        try perps.open(id, market, isLong, size, lev, 0) returns (uint256 pid) {
            positionIds.push(pid);
            opens++;
        } catch (bytes memory err) {
            openFailures++;
            lastOpenError = bytes4(err);
        }
    }

    /// @dev Largest size inside every limit: balance, largest fill, backing, ~99 tokens.
    function _maxSize(uint256 id, address a, uint8 lev, address market) internal view returns (uint256 maxSize) {
        (,, uint256 backing, uint256 largest,,,,) = book.offers(id);
        maxSize = (vault.balanceOf(a, address(usdg)) * lev * 99) / 200;
        if (largest < maxSize) maxSize = largest;
        if (backing * 5 < maxSize) maxSize = backing * 5;
        uint256 k = market == address(stocks[0]) ? 0 : 1;
        uint256 qtyCap = (price[k] * 99) / 1e12; // ~99 tokens of notional in USDG base units
        if (qtyCap < maxSize) maxSize = qtyCap;
    }

    function closePosition(uint256 idx) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open) return;
        vm.prank(p.taker);
        try perps.close(id, 0) {
            closes++;
        } catch {}
    }

    function addMargin(uint256 idx, uint256 amount, bool makerSide) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open) return;
        address who = makerSide ? p.maker : p.taker;
        uint256 bal = vault.balanceOf(who, address(usdg));
        if (bal == 0) return;
        vm.prank(who);
        perps.addMargin(id, bound(amount, 1, bal));
    }

    /// @dev Keeper-style: liquidate the first liquidatable position found from `idx`.
    function liquidate(uint256 idx) external {
        uint256 n = positionIds.length;
        for (uint256 j; j < n; ++j) {
            uint256 id = positionIds[(idx + j) % n];
            PerpsBase.Position memory p = perps.getPosition(id);
            if (!p.open) continue;
            try perps.isLiquidatable(id) returns (bool yes) {
                if (!yes) continue;
            } catch {
                continue;
            }
            _liquidate(id, p);
            return;
        }
    }

    function _liquidate(uint256 id, PerpsBase.Position memory p) internal {
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 insBefore = perps.insurance();
        uint256 tb = vault.balanceOf(p.taker, address(usdg));
        uint256 mb = vault.balanceOf(p.maker, address(usdg));
        uint256 lb = vault.balanceOf(liquidator, address(usdg));
        vm.prank(liquidator);
        perps.liquidate(id);
        liquidations++;
        uint256 paid = (vault.balanceOf(p.taker, address(usdg)) - tb) + (vault.balanceOf(p.maker, address(usdg)) - mb)
            + (vault.balanceOf(liquidator, address(usdg)) - lb);
        if (paid > pool + insBefore) liquidationOverpaid = true;
    }

    function requestForcedExit(uint256 idx, bool byMaker) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open || p.exitRequestedAt != 0) return;
        vm.prank(byMaker ? p.maker : p.taker);
        perps.requestForcedExit{value: 0.001 ether}(id);
    }

    /// @dev Jump a week, refresh prices and settle every due forced exit.
    function settleForcedExits() external {
        vm.warp(block.timestamp + 7 days);
        refreshPrices();
        for (uint256 i; i < positionIds.length; ++i) {
            PerpsBase.Position memory p = perps.getPosition(positionIds[i]);
            if (!p.open || p.exitRequestedAt == 0) continue;
            try perps.settleForcedExit(positionIds[i]) {
                forcedExits++;
            } catch {}
        }
    }

    function advanceFunding(uint256 stockSeed) external {
        try perps.advanceFunding(address(stocks[stockSeed % 2])) {} catch {}
    }

    // ------------------------------------------------------------ market

    /// @dev Move one price by up to ±10% (the relay limit) and refresh both.
    function movePrice(uint256 stockSeed, uint256 bps, bool up) external {
        uint256 k = stockSeed % 2;
        uint256 move = (price[k] * bound(bps, 0, 1000)) / 10_000;
        uint256 next = up ? price[k] + move : price[k] - move;
        if (next < 2e18 || next > 50_000e18) return;
        price[k] = next;
        refreshPrices();
    }

    /// @dev Let time pass (funding accrues), then refresh prices.
    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
        refreshPrices();
    }

    // ------------------------------------------------------------ wind down (afterInvariant)

    function windDown() external {
        refreshPrices();
        for (uint256 i; i < positionIds.length; ++i) {
            PerpsBase.Position memory p = perps.getPosition(positionIds[i]);
            if (!p.open) continue;
            vm.prank(p.taker);
            perps.close(positionIds[i], 0);
        }
        for (uint256 i; i < offerIds.length; ++i) {
            (address maker,,,,,,, bool active) = book.offers(offerIds[i]);
            if (!active) continue;
            vm.prank(maker);
            book.withdrawOffer(offerIds[i]);
        }
        for (uint256 a; a < actors.length; ++a) {
            for (uint256 s; s < 2; ++s) {
                uint256 sh = pools.sharesOf(address(stocks[s]), actors[a]);
                if (sh == 0) continue;
                vm.prank(actors[a]);
                try pools.removeLiquidity(address(stocks[s]), sh, 0, 0, block.timestamp) {} catch {}
            }
        }
    }
}
