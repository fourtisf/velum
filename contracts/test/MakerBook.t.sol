// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VelumBase} from "./Base.t.sol";
import {MakerBook} from "../src/MakerBook.sol";
import {IVelumVault} from "../src/interfaces/IVelumVault.sol";

contract MakerBookTest is VelumBase {
    function setUp() public override {
        super.setUp();
        _fund(bob, usdg, 50_000 * USD);
    }

    function _post() internal returns (uint256) {
        vm.prank(bob);
        return book.postOffer(address(tsla), 5000 * USD, 1000 * USD, 8, 5, uint64(block.timestamp + 1 days));
    }

    function test_setup_guards() public {
        MakerBook b = new MakerBook(IVelumVault(address(vault)), address(usdg));
        address[] memory m = new address[](1);
        m[0] = address(tsla);
        vm.expectRevert(MakerBook.ZeroAddress.selector);
        b.setup(address(0), m);
        vm.prank(alice);
        vm.expectRevert(MakerBook.NotDeployer.selector);
        b.setup(address(perps), m);
        m[0] = address(0);
        vm.expectRevert(MakerBook.ZeroAddress.selector);
        b.setup(address(perps), m);
        m[0] = address(tsla);
        b.setup(address(perps), m);
        vm.expectRevert(MakerBook.AlreadySetUp.selector);
        b.setup(address(perps), m);
        vm.expectRevert(MakerBook.ZeroAddress.selector);
        new MakerBook(IVelumVault(address(vault)), address(0));
    }

    function test_post_locksBacking() public {
        vm.expectEmit(address(book));
        emit MakerBook.OfferPosted(
            1, bob, address(tsla), 5000 * USD, 1000 * USD, 8, 5, uint64(block.timestamp + 1 days)
        );
        uint256 id = _post();
        assertEq(id, 1);
        assertEq(_bal(bob, usdg), 45_000 * USD);
        assertEq(_bal(address(book), usdg), 5000 * USD);
        assertEq(book.totalBacking(), 5000 * USD);
        (address maker, address market, uint256 backing,,,,, bool active) = book.offers(id);
        assertEq(maker, bob);
        assertEq(market, address(tsla));
        assertEq(backing, 5000 * USD);
        assertTrue(active);
    }

    function test_post_validation() public {
        uint64 exp = uint64(block.timestamp + 1);
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.UnknownMarket.selector, address(usdg)));
        book.postOffer(address(usdg), 1, 1, 2, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 0, 1, 2, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 0, 2, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector); // largest fill above backing
        book.postOffer(address(tsla), 10, 11, 2, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 10, 501, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 10, 2, 501, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 10, 2, 0, uint64(block.timestamp));
        vm.stopPrank();
    }

    /// @notice Audit F-06: open spreads below the 2 bps floor are refused; close spreads may be zero.
    function test_post_minOpenSpread() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.startPrank(bob);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 10, 0, 0, exp);
        vm.expectRevert(MakerBook.BadOffer.selector);
        book.postOffer(address(tsla), 10, 10, 1, 5, exp);
        uint256 id = book.postOffer(address(tsla), 10, 10, 2, 0, exp);
        vm.stopPrank();
        (,,,, uint16 o, uint16 c,,) = book.offers(id);
        assertEq(o, 2);
        assertEq(c, 0);
    }

    function test_withdraw() public {
        uint256 id = _post();
        vm.prank(alice);
        vm.expectRevert(MakerBook.NotMaker.selector);
        book.withdrawOffer(id);
        vm.prank(bob);
        assertEq(book.withdrawOffer(id), 5000 * USD);
        assertEq(_bal(bob, usdg), 50_000 * USD);
        assertEq(book.totalBacking(), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.OfferInactive.selector, id));
        book.withdrawOffer(id);
    }

    function test_allocate_guards() public {
        uint256 id = _post();
        vm.expectRevert(MakerBook.NotPerps.selector);
        book.allocate(id, address(tsla), 1, 1);

        vm.startPrank(address(perps));
        vm.expectRevert(abi.encodeWithSelector(MakerBook.OfferInactive.selector, 99));
        book.allocate(99, address(tsla), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.WrongMarket.selector, id));
        book.allocate(id, address(amzn), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.FillTooLarge.selector, 1001 * USD, 1000 * USD));
        book.allocate(id, address(tsla), 1001 * USD, 1);
        vm.expectRevert(abi.encodeWithSelector(MakerBook.InsufficientBacking.selector, 5000 * USD, 5001 * USD));
        book.allocate(id, address(tsla), 1000 * USD, 5001 * USD);

        (address maker, uint16 o, uint16 c) = book.allocate(id, address(tsla), 1000 * USD, 200 * USD);
        assertEq(maker, bob);
        assertEq(o, 8);
        assertEq(c, 5);
        assertEq(_bal(address(perps), usdg), 200 * USD);
        assertEq(book.totalBacking(), 4800 * USD);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        vm.prank(address(perps));
        vm.expectRevert(abi.encodeWithSelector(MakerBook.OfferExpired.selector, id));
        book.allocate(id, address(tsla), 1, 1);
        // expired offers can still be withdrawn
        vm.prank(bob);
        assertEq(book.withdrawOffer(id), 4800 * USD);
    }
}
