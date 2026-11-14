// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVelumVault} from "./interfaces/IVelumVault.sol";
import {IMakerBook} from "./interfaces/IMakerBook.sol";

/// @title MakerBook
/// @notice Makers post standing offers backed by USDG from their internal balance. The perps engine
///         fills a taker against a chosen offer, taking the maker's margin for that position out of
///         the offer's remaining backing. Makers can withdraw unused backing at any time; open
///         positions are unaffected and keep their allocated margin.
/// @dev Offer backing is held as this contract's internal vault balance, so the vault balance of
///      this contract always equals the sum of active offers' remaining backing.
contract MakerBook is IMakerBook, ReentrancyGuard {
    /// @notice Spreads above 5% are refused to protect takers from fat-finger or griefing offers.
    uint16 public constant MAX_SPREAD_BPS = 500;
    /// @notice Open spreads below 2 bps are refused (internal audit F-06). Perps opens need a price at
    ///         most 10 s old; the floor (plus the 6 bps taker fee) prices the option that is left.
    uint16 public constant MIN_OPEN_SPREAD_BPS = 2;

    struct Offer {
        address maker;
        address market;
        uint256 backing; // remaining, unallocated USDG
        uint256 largestFill; // largest taker size (USDG notional) one fill may take
        uint16 openSpreadBps;
        uint16 closeSpreadBps;
        uint64 expiry;
        bool active;
    }

    IVelumVault public immutable vault;
    address public immutable usdg;
    address public immutable deployer;
    bool public locked;
    address public perps;
    mapping(address market => bool) public isMarket;
    mapping(uint256 id => Offer) public offers;
    uint256 public nextOfferId = 1;
    /// @notice Sum of `backing` over active offers (equals this contract's vault USDG balance).
    uint256 public totalBacking;

    event Setup(address perps, address[] markets);
    event OfferPosted(
        uint256 indexed id,
        address indexed maker,
        address indexed market,
        uint256 backing,
        uint256 largestFill,
        uint16 openSpreadBps,
        uint16 closeSpreadBps,
        uint64 expiry
    );
    event OfferFilled(uint256 indexed id, uint256 fillSize, uint256 makerMargin, uint256 backingLeft);
    event OfferWithdrawn(uint256 indexed id, address indexed maker, uint256 returned);

    error NotDeployer();
    error AlreadySetUp();
    error ZeroAddress();
    error NotPerps();
    error UnknownMarket(address market);
    error BadOffer();
    error NotMaker();
    error OfferInactive(uint256 id);
    error OfferExpired(uint256 id);
    error WrongMarket(uint256 id);
    error FillTooLarge(uint256 fillSize, uint256 largestFill);
    error InsufficientBacking(uint256 backing, uint256 needed);

    constructor(IVelumVault vault_, address usdg_) {
        if (address(vault_) == address(0) || usdg_ == address(0)) revert ZeroAddress();
        vault = vault_;
        usdg = usdg_;
        deployer = msg.sender;
    }

    function setup(address perps_, address[] calldata markets) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        if (perps_ == address(0)) revert ZeroAddress();
        locked = true;
        perps = perps_;
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i] == address(0)) revert ZeroAddress();
            isMarket[markets[i]] = true;
        }
        emit Setup(perps_, markets);
    }

    /// @notice Lock `backing` USDG behind a standing offer for `market`.
    /// @param largestFill Largest taker size (USDG notional) a single fill may take; at most `backing`.
    function postOffer(
        address market,
        uint256 backing,
        uint256 largestFill,
        uint16 openSpreadBps,
        uint16 closeSpreadBps,
        uint64 expiry
    ) external nonReentrant returns (uint256 id) {
        if (!isMarket[market]) revert UnknownMarket(market);
        if (backing == 0 || largestFill == 0 || largestFill > backing) revert BadOffer();
        if (openSpreadBps < MIN_OPEN_SPREAD_BPS) revert BadOffer();
        if (openSpreadBps > MAX_SPREAD_BPS || closeSpreadBps > MAX_SPREAD_BPS) revert BadOffer();
        if (expiry <= block.timestamp) revert BadOffer();
        id = nextOfferId++;
        offers[id] = Offer(msg.sender, market, backing, largestFill, openSpreadBps, closeSpreadBps, expiry, true);
        totalBacking += backing;
        vault.transferInternal(usdg, msg.sender, address(this), backing);
        emit OfferPosted(id, msg.sender, market, backing, largestFill, openSpreadBps, closeSpreadBps, expiry);
    }

    /// @notice Close an offer and return all unused backing to the maker's internal balance.
    function withdrawOffer(uint256 id) external nonReentrant returns (uint256 returned) {
        Offer storage o = offers[id];
        if (o.maker != msg.sender) revert NotMaker();
        if (!o.active) revert OfferInactive(id);
        returned = o.backing;
        o.backing = 0;
        o.active = false;
        totalBacking -= returned;
        vault.transferInternal(usdg, address(this), msg.sender, returned);
        emit OfferWithdrawn(id, msg.sender, returned);
    }

    /// @inheritdoc IMakerBook
    function allocate(uint256 id, address market, uint256 fillSize, uint256 makerMargin)
        external
        nonReentrant
        returns (address maker, uint16 openSpreadBps, uint16 closeSpreadBps)
    {
        if (msg.sender != perps) revert NotPerps();
        Offer storage o = offers[id];
        if (!o.active) revert OfferInactive(id);
        if (block.timestamp >= o.expiry) revert OfferExpired(id);
        if (o.market != market) revert WrongMarket(id);
        if (fillSize > o.largestFill) revert FillTooLarge(fillSize, o.largestFill);
        if (makerMargin > o.backing) revert InsufficientBacking(o.backing, makerMargin);
        o.backing -= makerMargin;
        totalBacking -= makerMargin;
        vault.transferInternal(usdg, address(this), msg.sender, makerMargin);
        emit OfferFilled(id, fillSize, makerMargin, o.backing);
        return (o.maker, o.openSpreadBps, o.closeSpreadBps);
    }
}
