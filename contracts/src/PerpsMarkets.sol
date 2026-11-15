// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IVelumVault} from "./interfaces/IVelumVault.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IMakerBook} from "./interfaces/IMakerBook.sol";
import {FixedMath} from "./libraries/FixedMath.sol";
import {PerpsBase} from "./perps/PerpsBase.sol";
import {PerpsForcedExit} from "./perps/PerpsForcedExit.sol";

/// @title PerpsMarkets
/// @notice Isolated-margin long/short positions on stock tokens, filled against makers' standing
///         offers (MakerBook). Phase 3: public, no privacy layer yet.
///
/// Opening (taker, size S USDG, leverage L in 0.5 steps from 1x to 5x):
///   entry       = oracle price ± the offer's open spread (worse for the taker)
///   takerMargin = S / L (>= initial margin 1/maxL)      fee = 0.06% of S, to insurance
///   makerMargin = S / maxL, taken from the offer's backing
///   qty         = S / entry, at most 100 tokens; per-market open-interest cap per side; S >= 10 USDG
///   needs: price at most 10 s old and not lagging, sequencer up past grace, market not close-only,
///   and a non-zero `priceLimit` (independent audit IA-10).
/// Closing (taker, any time, no maker signature), at a price up to 60 s old that is not lagging:
///   exit = oracle ∓ the maker's committed close spread; fee = 0.06% of exit notional;
///   taker gets max(0, margin + pnl - funding - fee) capped by the pool; the maker gets the rest.
///   A liquidatable position is settled as a liquidation instead (internal audit F-12) when the sequencer
///   rule allows a liquidation (see PerpsLiquidation, IA-07), at the oracle price with no close spread or
///   fee: an insolvent counterparty's shortfall becomes a cover claim rather than being forfeited, and a
///   losing taker pays the 1% penalty but gets the liquidator half back. `priceLimit` (non-zero, IA-10) is
///   checked against the spread-adjusted exit before either route; it does not account for the penalty.
///   A forced exit the taker requested costs exactly the same as this plain close (IA-01).
contract PerpsMarkets is PerpsForcedExit {
    using FixedMath for uint256;

    event Setup(address[] markets, uint256[] oiCaps, address guardian);

    constructor(IVelumVault vault_, IOracleAdapter oracle_, IMakerBook book_, address usdg_, uint8 usdgDecimals)
        PerpsBase(vault_, oracle_, book_, usdg_, usdgDecimals)
    {}

    /// @notice One-time market list with per-side open-interest caps (qty, 1e18 = one token).
    /// @param guardian_ Optional emergency guardian (zero = none). It can only switch a market into or
    ///        out of close-only; it can never move, freeze or redirect funds, or change prices or
    ///        parameters (internal audit F-07).
    function setup(address[] calldata markets_, uint256[] calldata oiCaps, address guardian_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        if (markets_.length != oiCaps.length) revert LengthMismatch();
        locked = true;
        guardian = guardian_;
        for (uint256 i; i < markets_.length; ++i) {
            if (markets_[i] == address(0)) revert ZeroAddress();
            Market storage m = markets[markets_[i]];
            m.enabled = true;
            m.oiCap = oiCaps[i];
            // forge-lint: disable-next-line(unsafe-typecast)
            m.lastFundingUpdate = uint64(block.timestamp);
            marketList.push(markets_[i]);
        }
        emit Setup(markets_, oiCaps, guardian_);
    }

    /// @notice Guardian only: stop (true) or resume (false) new opens in `market`, e.g. around a stock
    ///         split, dividend or earnings. Closing, margin changes, liquidation and forced exit keep
    ///         working; no balance moves.
    function setCloseOnly(address market, bool on) external {
        if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
        if (!markets[market].enabled) revert UnknownMarket(market);
        closeOnly[market] = on;
        emit CloseOnlySet(market, on);
    }

    /// @notice Open a position against maker offer `offerId`.
    /// @param size Position size in USDG base units (notional at entry).
    /// @param leverageHalf Leverage times two: 2 = 1x ... 10 = 5x.
    /// @param priceLimit Worst acceptable entry (max for longs, min for shorts). Must be non-zero (IA-10).
    function open(uint256 offerId, address market, bool isLong, uint256 size, uint8 leverageHalf, uint256 priceLimit)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (!markets[market].enabled) revert UnknownMarket(market);
        if (closeOnly[market]) revert CloseOnly(market);
        if (size < minPositionSize) revert PositionTooSmall(size, minPositionSize);
        if (leverageHalf < 2 || leverageHalf > 2 * MAX_LEVERAGE) revert BadLeverage(leverageHalf);
        if (priceLimit == 0) revert NoPriceLimit();
        _requireSequencer();
        (uint256 price, bool lagging) = _accrue(market, OPEN_MAX_AGE);
        if (lagging) revert PriceLagging(market);

        id = nextPositionId++;
        Position storage p = _positions[id];
        p.taker = msg.sender;
        p.market = market;
        p.isLong = isLong;
        p.open = true;
        p.leverageHalf = leverageHalf;
        // forge-lint: disable-next-line(unsafe-typecast)
        p.openedAt = uint64(block.timestamp);
        p.fundingIndexAtOpen = markets[market].fundingIndex;
        _match(p, offerId, size, price, priceLimit);
        _collectMargin(p, size);
        _setRate(market);
        _emitChange(id, p, Action.Open, price);
    }

    /// @dev Fill against the offer: maker margin, entry with the open spread, qty and OI checks.
    function _match(Position storage p, uint256 offerId, uint256 size, uint256 price, uint256 priceLimit) internal {
        uint256 makerMargin = size.mulDivUp(IM_BPS, BPS);
        (address maker, uint16 openBps, uint16 closeBps) = book.allocate(offerId, p.market, size, makerMargin);
        if (maker == msg.sender) revert SelfTrade();
        uint256 entry = p.isLong ? price.mulDivUp(BPS + openBps, BPS) : price.mulDivDown(BPS - openBps, BPS);
        if (p.isLong ? entry > priceLimit : entry < priceLimit) revert PriceLimit(entry, priceLimit);
        uint256 qty = size.mulDivDown(valueScale, entry);
        if (qty == 0 || qty > MAX_POSITION_QTY) revert BadQuantity(qty);
        Market storage m = markets[p.market];
        if (p.isLong) {
            m.longOI += qty;
            if (m.longOI > m.oiCap) revert OpenInterestCap(p.market);
        } else {
            m.shortOI += qty;
            if (m.shortOI > m.oiCap) revert OpenInterestCap(p.market);
        }
        p.maker = maker;
        p.closeSpreadBps = closeBps;
        p.entry = entry;
        p.qty = qty;
        p.makerMargin = makerMargin;
    }

    /// @dev Taker pays margin (size / leverage) plus the 0.06% fee, which goes to insurance.
    function _collectMargin(Position storage p, uint256 size) internal {
        uint256 takerMargin = size.mulDivUp(2, p.leverageHalf);
        uint256 fee = size.mulDivUp(TAKER_FEE_BPS, BPS);
        vault.transferInternal(usdg, msg.sender, address(this), takerMargin + fee);
        insurance += fee;
        totalMargin += takerMargin + p.makerMargin;
        p.takerMargin = takerMargin;
    }

    /// @notice Close at the oracle price minus the maker's committed close spread. Refused while the price is
    ///         lagging its source. If the position is liquidatable it is liquidated instead, with the taker
    ///         as liquidator (reward paid on top).
    /// @param priceLimit Worst acceptable spread-adjusted exit (min for longs, max for shorts). Must be non-zero
    ///        (IA-10). A close that settles as a liquidation uses the oracle price (no spread) but, for a
    ///        losing taker, also the 1% penalty (half refunded as the reward); the limit does not cover that.
    /// @return takerOut The taker's share of the pool (excluding any liquidator reward or cover claim).
    function close(uint256 id, uint256 priceLimit) external nonReentrant returns (uint256 takerOut) {
        Position storage p = _position(id);
        if (msg.sender != p.taker) revert NotTaker();
        if (priceLimit == 0) revert NoPriceLimit();
        (uint256 price, bool lagging) = _accrue(p.market, MAX_PRICE_AGE);
        // R2-04: no exit at a known-lagging price on either route: as a liquidation it would let a losing
        // taker leave at the stale, more favourable effective price. Keepers still use liquidate().
        if (lagging) revert PriceLagging(p.market);
        uint256 exit = _exitPrice(p, price);
        if (p.isLong ? exit < priceLimit : exit > priceLimit) revert PriceLimit(exit, priceLimit);
        // F-12: never forfeit cover by closing against an insolvent side. While the sequencer rule forbids a
        // liquidation (F-05, IA-07) a plain close stays available.
        (bool liquidatable, bool allowed) = _liquidationState(p, price);
        if (liquidatable && allowed) {
            (takerOut,) = _liquidateAt(id, p, price, msg.sender);
            return takerOut;
        }
        return _settleAt(id, p, Action.Close, price, exit, _closeFee(p, exit));
    }

    /// @notice Add USDG margin to your side (taker or maker) of a position.
    function addMargin(uint256 id, uint256 amount) external nonReentrant {
        Position storage p = _position(id);
        if (amount == 0) revert ZeroAmount();
        if (msg.sender == p.taker) p.takerMargin += amount;
        else if (msg.sender == p.maker) p.makerMargin += amount;
        else revert NotParty();
        totalMargin += amount;
        vault.transferInternal(usdg, msg.sender, address(this), amount);
        _emitChange(id, p, Action.AddMargin, 0);
    }

    /// @notice Take USDG margin back as the taker, keeping the claim at or above initial margin.
    ///         Needs a non-lagging price at most 10 s old, as for an open (independent audit IA-03), and the
    ///         sequencer up past its grace period.
    function removeMargin(uint256 id, uint256 amount) external nonReentrant {
        Position storage p = _position(id);
        if (msg.sender != p.taker) revert NotTaker();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.takerMargin) revert ExceedsMargin(amount, p.takerMargin);
        _requireSequencer();
        (uint256 price, bool lagging) = _accrue(p.market, OPEN_MAX_AGE);
        if (lagging) revert PriceLagging(p.market);
        int256 claimAfter = _takerClaim(p, markets[p.market], price) - FixedMath.toInt(amount);
        uint256 required = _notionalUp(p.qty, price).mulDivUp(IM_BPS, BPS);
        if (claimAfter < FixedMath.toInt(required)) revert BelowInitialMargin(claimAfter, required);
        p.takerMargin -= amount;
        totalMargin -= amount;
        _pay(p.taker, amount);
        _setRate(p.market);
        _emitChange(id, p, Action.RemoveMargin, price);
    }

    /// @notice Add USDG to the insurance fund (anyone, e.g. to bootstrap testnet).
    function fundInsurance(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        insurance += amount;
        vault.transferInternal(usdg, msg.sender, address(this), amount);
        emit InsuranceFunded(msg.sender, amount);
    }
}
