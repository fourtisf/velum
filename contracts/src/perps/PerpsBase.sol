// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVelumVault} from "../interfaces/IVelumVault.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {IMakerBook} from "../interfaces/IMakerBook.sol";
import {FixedMath} from "../libraries/FixedMath.sol";

/// @title PerpsBase
/// @notice Shared state, parameters and accounting for the perps engine.
///
/// Model: every position is a pair between one taker and one maker in one market.
///   - Both sides post USDG margin, held as this contract's internal vault balance (the "pool").
///   - The taker's claim on the pool at price P is
///         takerMargin + pnl(P) - fundingOwed,
///     and the maker's claim is the rest of the pool. Claims always sum to the pool, so value is
///     conserved; payouts are capped by what both sides posted (plus insurance on liquidation).
///   - Prices are USDG per whole token scaled by 1e18; `qty` is token units scaled by 1e18;
///     margins, fees and payouts are USDG base units. `valueScale` converts qty * price to USDG.
abstract contract PerpsBase is ReentrancyGuard {
    using FixedMath for uint256;

    // ---------------------------------------------------------------- parameters (CLAUDE.md §5)
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 5;
    /// @notice Initial margin = 1 / maxLeverage = 20%.
    uint256 public constant IM_BPS = BPS / MAX_LEVERAGE;
    /// @notice Maintenance margin = 0.5 / maxLeverage = 10%.
    uint256 public constant MM_BPS = BPS / 2 / MAX_LEVERAGE;
    uint256 public constant TAKER_FEE_BPS = 6;
    uint256 public constant LIQUIDATION_PENALTY_BPS = 100;
    uint256 public constant MAX_POSITION_QTY = 100e18;
    /// @notice Funding rate cap: 0.01% per hour (1e18 = 100%).
    int256 public constant MAX_FUNDING_RATE_PER_HOUR = 1e14;
    uint256 public constant FORCED_EXIT_DELAY = 7 days;
    uint256 public constant FORCED_EXIT_BOND = 0.001 ether;

    // ---------------------------------------------------------------- audit hardening (2026-11)
    /// @notice Opens need a price at most 10 s old (F-06); closes, liquidations and funding 60 s.
    uint256 public constant OPEN_MAX_AGE = 10;
    uint256 public constant MAX_PRICE_AGE = 60;
    /// @notice Shortfall cover is paid per hourly epoch (F-02)...
    uint256 public constant COVER_EPOCH = 1 hours;
    /// @notice ...pro rata across that epoch's claims. Cover plus keeper top-ups of one epoch draw at most
    ///         10% of the insurance fund as it stood at the epoch's first draw (R2-02, R2-03).
    uint256 public constant COVER_CAP_BPS = 1000;

    struct Market {
        bool enabled;
        uint256 oiCap; // per side, in qty (1e18 = one token)
        uint256 longOI; // taker longs, qty
        uint256 shortOI; // taker shorts, qty
        int256 fundingIndex; // cumulative funding per token, price units (1e18)
        int256 fundingRate; // per hour, 1e18 = 100%; positive = longs pay shorts
        uint64 lastFundingUpdate;
    }

    struct Position {
        address taker;
        address maker;
        address market;
        bool isLong; // taker's side
        bool open;
        uint8 leverageHalf; // leverage * 2 (2..10 = 1x..5x in 0.5 steps)
        uint16 closeSpreadBps; // maker's binding close spread
        uint64 openedAt;
        uint64 exitRequestedAt;
        address exitRequester;
        uint256 qty;
        uint256 entry;
        uint256 takerMargin;
        uint256 makerMargin;
        int256 fundingIndexAtOpen;
    }

    enum Action {
        Open,
        Close,
        AddMargin,
        RemoveMargin,
        Liquidate,
        ForcedExit
    }

    IVelumVault public immutable vault;
    IOracleAdapter public immutable oracle;
    IMakerBook public immutable book;
    address public immutable usdg;
    /// @notice qty(1e18) * price(1e18) / valueScale = USDG base units.
    uint256 public immutable valueScale;
    address public immutable deployer;
    /// @notice Smallest position size: 10 USDG (F-10, dust positions).
    uint256 public immutable minPositionSize;
    /// @notice Largest keeper reward top-up from insurance per liquidation: 1 USDG (F-11).
    uint256 public immutable keeperRewardCap;
    bool public locked;
    /// @notice May only switch markets into or out of close-only (F-07). Fixed at setup; zero = none.
    address public guardian;

    mapping(address market => Market) public markets;
    /// @notice Close-only markets refuse new opens; everything else works as usual.
    mapping(address market => bool) public closeOnly;
    address[] public marketList;
    mapping(uint256 id => Position) internal _positions;
    uint256 public nextPositionId = 1;
    /// @notice USDG insurance fund (fees and half of liquidation penalties), held in this
    ///         contract's vault balance next to the position pools.
    uint256 public insurance;
    /// @notice Sum of takerMargin + makerMargin over open positions.
    uint256 public totalMargin;
    /// @notice Forced-exit bonds whose ETH refund failed; claim with `claimBond`.
    mapping(address account => uint256) public bondRefunds;
    /// @notice Cover reserved for filed claims and not yet paid (moved out of `insurance` when filed).
    ///         This contract's vault balance == totalMargin + insurance + coverReserved.
    uint256 public coverReserved;

    /// @notice Emitted on every position state change. `price` is the oracle price used (0 if none).
    event PositionChanged(
        uint256 indexed id,
        address indexed market,
        Action indexed action,
        address taker,
        address maker,
        bool isLong,
        uint256 qty,
        uint256 entry,
        uint256 takerMargin,
        uint256 makerMargin,
        uint256 price
    );
    /// @notice Final split of a position's pool when it closes for any reason.
    event PositionSettled(
        uint256 indexed id,
        uint256 exitPrice,
        int256 takerPnl,
        int256 takerFunding,
        uint256 fee,
        uint256 takerOut,
        uint256 makerOut
    );
    /// @param reward Paid to the liquidator: half the penalty, topped up from insurance when the loser
    ///        could not pay it in full. @param shortfall Filed as a cover claim for the winner.
    event Liquidated(
        uint256 indexed id,
        address indexed liquidator,
        bool takerSide,
        uint256 price,
        uint256 penalty,
        uint256 reward,
        uint256 shortfall
    );
    event FundingAdvanced(address indexed market, int256 rate, int256 index, uint256 timestamp);
    event InsuranceFunded(address indexed from, uint256 amount);
    event ForcedExitRequested(uint256 indexed id, address indexed requester, uint256 settleAfter);
    event ForcedExitSettled(uint256 indexed id, uint256 price, bool atEntryPrice);
    event BondRefundDeferred(address indexed account, uint256 amount);
    event BondClaimed(address indexed account, uint256 amount);
    event CloseOnlySet(address indexed market, bool closeOnly);
    event CoverClaimFiled(uint256 indexed epoch, address indexed account, uint256 amount);
    event CoverEpochSettled(uint256 indexed epoch, uint256 claimed, uint256 budget);
    event CoverPaid(uint256 indexed epoch, address indexed account, uint256 claim, uint256 paid);

    error NotDeployer();
    error AlreadySetUp();
    error ZeroAddress();
    error ZeroAmount();
    error LengthMismatch();
    error UnknownMarket(address market);
    error BadLeverage(uint8 leverageHalf);
    error BadQuantity(uint256 qty);
    error OpenInterestCap(address market);
    error SelfTrade();
    error PriceLimit(uint256 price, uint256 limit);
    error NotOpen(uint256 id);
    error NotTaker();
    error NotParty();
    error BelowInitialMargin(int256 claim, uint256 required);
    error NotLiquidatable(uint256 id);
    error BadBond();
    error AlreadyRequested(uint256 id);
    error NotRequested(uint256 id);
    error TooEarly(uint256 settleAfter);
    error NothingToClaim();
    error RefundFailed();
    error PositionTooSmall(uint256 size, uint256 minSize);
    error ExceedsMargin(uint256 amount, uint256 margin);
    error CloseOnly(address market);
    error NotGuardian();
    error PriceLagging(address market);
    error SequencerDown();
    error EpochNotOver(uint256 epoch);
    error EpochSettled(uint256 epoch);

    constructor(IVelumVault vault_, IOracleAdapter oracle_, IMakerBook book_, address usdg_, uint8 usdgDecimals) {
        if (address(vault_) == address(0) || address(oracle_) == address(0) || address(book_) == address(0)) {
            revert ZeroAddress();
        }
        if (usdg_ == address(0)) revert ZeroAddress();
        vault = vault_;
        oracle = oracle_;
        book = book_;
        usdg = usdg_;
        valueScale = 10 ** (36 - uint256(usdgDecimals));
        deployer = msg.sender;
        uint256 oneUsdg = 10 ** uint256(usdgDecimals);
        minPositionSize = 10 * oneUsdg;
        keeperRewardCap = oneUsdg;
    }

    // ---------------------------------------------------------------- views

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function marketCount() external view returns (uint256) {
        return marketList.length;
    }

    /// @notice Taker's claim on the pool at `price` (can be negative), using funding accrued so far.
    ///         Zero for closed positions.
    function takerClaimAt(uint256 id, uint256 price) external view returns (int256) {
        Position storage p = _positions[id];
        if (!p.open) return 0;
        return _takerClaim(p, markets[p.market], price);
    }

    // ---------------------------------------------------------------- accounting helpers

    function _position(uint256 id) internal view returns (Position storage p) {
        p = _positions[id];
        if (!p.open) revert NotOpen(id);
    }

    /// @dev Signed P&L of the taker at `price`, rounded down (against the taker).
    function _takerPnl(Position storage p, uint256 price) internal view returns (int256) {
        int256 diff = FixedMath.toInt(price) - FixedMath.toInt(p.entry);
        if (!p.isLong) diff = -diff;
        return FixedMath.mulDivFloorSigned(diff, p.qty, valueScale);
    }

    /// @dev Funding the taker owes since open (negative = receives), rounded up (against the taker).
    function _takerFunding(Position storage p, Market storage m) internal view returns (int256) {
        return _takerFundingAt(p, m.fundingIndex);
    }

    function _takerFundingAt(Position storage p, int256 index) internal view returns (int256) {
        int256 d = index - p.fundingIndexAtOpen;
        if (!p.isLong) d = -d;
        return FixedMath.mulDivCeilSigned(d, p.qty, valueScale);
    }

    function _takerClaim(Position storage p, Market storage m, uint256 price) internal view returns (int256) {
        return FixedMath.toInt(p.takerMargin) + _takerPnl(p, price) - _takerFunding(p, m);
    }

    /// @dev Whether either side is below maintenance (10% of notional) at `price` with funding index
    ///      `index`, and which: the side with the smaller claim is the one liquidated.
    function _liquidationSide(Position storage p, uint256 price, int256 index)
        internal
        view
        returns (bool liquidatable, bool takerSide, int256 takerClaim, uint256 notional)
    {
        takerClaim = FixedMath.toInt(p.takerMargin) + _takerPnl(p, price) - _takerFundingAt(p, index);
        int256 makerClaim = FixedMath.toInt(p.takerMargin + p.makerMargin) - takerClaim;
        notional = _notionalUp(p.qty, price);
        int256 req = FixedMath.toInt(notional.mulDivUp(MM_BPS, BPS));
        if (takerClaim < req && takerClaim <= makerClaim) return (true, true, takerClaim, notional);
        if (makerClaim < req) return (true, false, takerClaim, notional);
    }

    function _requireSequencer() internal view {
        if (!oracle.sequencerReady()) revert SequencerDown();
    }

    /// @dev Notional value in USDG at `price`, rounded up (used for requirements and fees).
    function _notionalUp(uint256 qty, uint256 price) internal view returns (uint256) {
        return qty.mulDivUp(price, valueScale);
    }

    /// @dev Remove a position from the book and pay both sides from its pool. The caller emits
    ///      events first (they report the pre-settlement margins).
    function _settle(Position storage p, uint256 takerOut, uint256 makerOut) internal {
        Market storage m = markets[p.market];
        if (p.isLong) m.longOI -= p.qty;
        else m.shortOI -= p.qty;
        totalMargin -= p.takerMargin + p.makerMargin;
        p.open = false;
        _pay(p.taker, takerOut);
        _pay(p.maker, makerOut);
        address requester = p.exitRequester;
        if (requester != address(0)) _refundBond(requester);
        _setRate(p.market);
        // keep the struct for history; zero the pools so views can't double count
        p.takerMargin = 0;
        p.makerMargin = 0;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount != 0) vault.transferInternal(usdg, address(this), to, amount);
    }

    /// @dev Pull-only (internal audit F-01): never send ETH inside settlement. A push to a
    ///      user-controlled address let a contract block every close, liquidation and forced
    ///      exit by returning a huge revert payload. The owner withdraws with claimBond().
    function _refundBond(address to) internal {
        bondRefunds[to] += FORCED_EXIT_BOND;
        emit BondRefundDeferred(to, FORCED_EXIT_BOND);
    }

    function _emitChange(uint256 id, Position storage p, Action action, uint256 price) internal {
        emit PositionChanged(
            id, p.market, action, p.taker, p.maker, p.isLong, p.qty, p.entry, p.takerMargin, p.makerMargin, price
        );
    }

    // ---------------------------------------------------------------- funding hooks

    /// @dev Bring funding up to date with a price no older than `maxAge`; returns the effective price and
    ///      whether it is lagging its source.
    function _accrue(address market, uint256 maxAge) internal virtual returns (uint256 price, bool lagging);

    function _setRate(address market) internal virtual;
}
