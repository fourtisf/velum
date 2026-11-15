// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {FixedMath} from "./libraries/FixedMath.sol";

/// @title OracleAdapter
/// @notice One price source per token, fixed at setup: either a Chainlink AggregatorV3 feed (production,
///         guarded by the L2 sequencer-uptime feed) or (testnet only) a price-relay updater that pushes
///         prices. Every price is clamped to fixed bounds and rate-limited. Prices are USDG per whole token,
///         scaled by 1e18. No owner after setup.
///
/// Price rate limit (internal audit F-04, F-02, round 2 R2-01). The price this adapter reports, the
/// "effective" price, moves from the LAST RECORDED effective price by at most
///         maxMove = last x MAX_MOVE_BPS x dt / (BPS x MOVE_WINDOW),   dt = min(now - lastAt, MOVE_WINDOW)
/// per recording (a source price outside [last - maxMove, last + maxMove] is clamped to it). So the price
/// moves at most 1/6000 per second (1% per minute, 5% per 5 minutes), compounding to at most
/// (1 + 1/6000)^t over t seconds (1.005% per minute), and no single recording, even the first after a long
/// silence, moves it more than 5%. Recording more often gives no reach beyond that compounding, so `poke`
/// cannot shape the limit. While the source is outside the limit (or outside the bounds, below) the price is
/// "lagging": perps refuses opens, closes, forced exits and margin removal on it, but liquidations and funding
/// go on at the effective price.
///
/// The clock (final audit FA-01). Before, every recording set `lastAt` to now, so anyone could throw away the
/// allowance the next source value would have had (a `poke` every second kept prices lagging half the time). Now:
///   - a recording that sees the same source value at an unchanged price (anyone's `poke` or `read`: trades,
///     keepers, indexers) writes nothing, exactly as if it had not happened;
///   - a recording that moves the price advances `lastAt` from the start of the allowance it used by the whole
///     seconds the move needed (rounded up), never past now: a move clamped at the limit uses everything up to
///     now, as before, and a catch-up that needed less leaves the rest to the next recording;
///   - a new source value (updatedAt > lastValidAt) also sets `lastAt` to at least its timestamp.
/// The limit per recording is unchanged and time is never credited twice: over any run of recordings the price
/// stays within (1 + 1/6000)^t of the price set when the clock started t seconds earlier, and no recording moves
/// it more than 5%. Because every source value sets the clock to at least its timestamp and a read needs a source
/// value at most maxAge old, at any successful read the clock started at most maxAge earlier (10 s for opens and
/// margin removal, 60 s otherwise); guarantees measured from an open shift by at most those 10 s.
///
/// Guarantees for a 5x pair (taker and maker margin 20%, maintenance 10%; test/audit/Round2PoC.t.sol):
///   - a side that is not liquidatable at a recorded price needs a 10% adverse move to reach zero: never
///     in one recording (at most 5%), and at least 9.5 minutes of recordings. Between its last
///     non-liquidatable recording and the first insolvent one there are always at least 60 s of fresh
///     prices at which it is liquidatable and solvent (9.5 minutes if the source reports every minute);
///   - no side of a pair opened at any non-lagging price can fall below zero within 12 minutes of the
///     open, for every leverage, side and open spread the book allows (at the worst spread 13.1 minutes from the
///     clock's start, 12.95 minutes when the open comes 10 s after it, FA-01);
///   - a compromised relay key moves a maker's claim by at most 5.5% of its margin per minute.
///
/// Bounds (independent audit IA-06). Each token has fixed sanity bounds [minPrice, maxPrice]. A source answer
/// outside them is not an error: it is clamped to the nearest bound and then rate-limited like any other
/// reading. So the effective price walks toward the bound at the rate limit and stops there, and it reads as
/// lagging for as long as the source stays outside: liquidations and funding go on at it, opens, closes and
/// margin removal are refused, and a matured forced exit settles at the bound once the effective price has
/// reached it (`atBound`). (Before, an out-of-bounds answer reverted every read before the rate limit, froze
/// liquidations and, after 14 days, made the token dead.)
///
/// Liveness (F-03). `lastValidAt` is the newest valid source timestamp recorded by `read`, `poke` or
/// `pushPrices`. A valid reading is any positive answer, inside the bounds or not (IA-06: a fresh out-of-bounds
/// answer keeps the token alive). A failed, zero or malformed read only makes the price stale. A token is dead
/// when no valid price was seen for DEAD_AFTER since max(lastValidAt, setup time).
///
/// Live clock (FA-02, FA-03). `liveClock` is block time minus every gap of more than DEAD_AFTER between two
/// consecutive recorded valid source times, and it stands still at the last valid time while such a gap is
/// running. Perps accrues funding over live time only, so a silence long enough to make the token dead is never
/// charged, whether the position leaves by a dead-oracle forced exit or stays open until prices return.
///
/// Sequencer (F-05, IA-07). With Chainlink sources the deployer must give the L2 sequencer-uptime feed;
/// `sequencerStatus()` reports whether the sequencer is up and whether it is past SEQUENCER_GRACE since it came
/// back ("ready"). Perps blocks opens and margin removal until ready; liquidations wait while it is down and,
/// during the grace hour, only go ahead for positions below half the maintenance margin. Zero sequencer feed
/// means relay sources only (testnet): always up and ready.
///
/// Feed reads (FA-07). Every feed is read with a plain staticcall and a length check, so a feed without code or
/// with malformed return data reads as failed (price stale, sequencer down) instead of reverting, and `poke`
/// never reverts. `setup` refuses a price feed or sequencer feed that does not answer `latestRoundData` with five
/// words, and a sequencer feed whose answer is neither 0 (up) nor 1 (down).
contract OracleAdapter is IOracleAdapter {
    using FixedMath for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_AGE = 60;
    uint256 public constant DEAD_AFTER = 14 days;
    /// @notice The effective price moves at most 5% per recording...
    uint256 public constant MAX_MOVE_BPS = 500;
    /// @notice ...and only 5% x dt / MOVE_WINDOW when dt < 5 minutes have passed since the last recording.
    uint256 public constant MOVE_WINDOW = 5 minutes;
    /// @notice Opens and margin removal wait this long after the L2 sequencer comes back up; liquidations only
    ///         for positions above half the maintenance margin (IA-07).
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    struct Source {
        address feed; // zero = relay-sourced
        uint8 feedDecimals;
        uint128 minPrice;
        uint128 maxPrice;
        bool configured;
    }

    struct Relayed {
        uint128 price;
        uint64 updatedAt;
    }

    /// @dev last: last recorded effective price (0 = no price yet). lastAt: block time of that recording.
    ///      lastValidAt: newest valid source timestamp recorded.
    struct Band {
        uint128 last;
        uint64 lastAt;
        uint64 lastValidAt;
    }

    address public immutable deployer;
    bool public locked;
    address public relayer;
    /// @notice Chainlink L2 sequencer-uptime feed (answer 0 = up). Zero: relay sources only.
    address public sequencerFeed;
    uint256 public setupAt;
    mapping(address token => Source) public sources;
    mapping(address token => Relayed) public relayed;
    mapping(address token => Band) public bands;
    /// @notice Total length of the gaps of more than DEAD_AFTER between consecutive recorded valid source times
    ///         (FA-02, FA-03): the time `liveClock` leaves out.
    mapping(address token => uint256) public deadTime;

    event Setup(address[] tokens, address[] feeds, address relayer, address sequencerFeed);
    /// @param price The price the relayer pushed. @param effectivePrice The rate-limited price now reported.
    event PriceRelayed(address indexed token, uint256 price, uint256 effectivePrice, uint256 timestamp);

    error NotDeployer();
    error AlreadySetUp();
    error LengthMismatch();
    error ZeroAddress();
    error BadBounds(address token);
    error BadFeedDecimals(address feed);
    /// @notice A feed without code or without a well-formed `latestRoundData`, or a sequencer feed whose answer is
    ///         neither 0 (up) nor 1 (down) (FA-07).
    error BadFeed(address feed);
    error SequencerFeedRequired();
    error NotRelayer();
    error NotRelaySourced(address token);
    error UnknownToken(address token);
    error NoPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    /// @notice A relayed price of zero or above type(uint128).max (reads clamp out-of-bounds prices, IA-06).
    error PriceOutOfBounds(address token, uint256 price);
    error TooSoon(address token);

    constructor() {
        deployer = msg.sender;
    }

    /// @param feeds Chainlink proxy per token, or address(0) for relay-sourced tokens.
    /// @param relayer_ The only address allowed to push relayed prices (may be zero if unused).
    /// @param sequencerFeed_ Chainlink L2 sequencer-uptime feed; required when any feed is set.
    function setup(
        address[] calldata tokens,
        address[] calldata feeds,
        uint128[] calldata minPrices,
        uint128[] calldata maxPrices,
        address relayer_,
        address sequencerFeed_
    ) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        if (tokens.length != feeds.length || tokens.length != minPrices.length || tokens.length != maxPrices.length) {
            revert LengthMismatch();
        }
        locked = true;
        relayer = relayer_;
        sequencerFeed = sequencerFeed_;
        setupAt = block.timestamp;
        if (sequencerFeed_ != address(0)) {
            // FA-07: an unreadable sequencer feed would read as "down" for good (nothing can be changed later).
            (bool ok, int256 answer,,) = _latestRound(sequencerFeed_);
            if (!ok || (answer != 0 && answer != 1)) revert BadFeed(sequencerFeed_);
        }
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            if (minPrices[i] == 0 || minPrices[i] >= maxPrices[i]) revert BadBounds(token);
            uint8 dec;
            if (feeds[i] != address(0)) {
                if (sequencerFeed_ == address(0)) revert SequencerFeedRequired();
                (bool ok,,,) = _latestRound(feeds[i]);
                if (!ok) revert BadFeed(feeds[i]);
                dec = IAggregatorV3(feeds[i]).decimals();
                if (dec > 18) revert BadFeedDecimals(feeds[i]);
            } else if (relayer_ == address(0)) {
                revert ZeroAddress();
            }
            sources[token] = Source(feeds[i], dec, minPrices[i], maxPrices[i], true);
        }
        emit Setup(tokens, feeds, relayer_, sequencerFeed_);
    }

    /// @notice Push prices for relay-sourced tokens (testnet price-relay worker). Any positive price that fits
    ///         uint128 is accepted. A price outside the token's bounds is stored as pushed and clamped when
    ///         recorded (IA-06); the reported price follows the (clamped) pushed price only at the rate limit.
    function pushPrices(address[] calldata tokens, uint256[] calldata prices) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (tokens.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            Source memory s = sources[token];
            if (!s.configured) revert UnknownToken(token);
            if (s.feed != address(0)) revert NotRelaySourced(token);
            uint256 p = prices[i];
            if (p == 0 || p > type(uint128).max) revert PriceOutOfBounds(token, p);
            // Arbitrum's block.number is an L1 estimate, so rate-limit by timestamp instead.
            if (relayed[token].updatedAt >= block.timestamp) revert TooSoon(token);
            // p <= type(uint128).max was checked above; timestamps fit uint64 for billions of years.
            // forge-lint: disable-next-line(unsafe-typecast)
            relayed[token] = Relayed(uint128(p), uint64(block.timestamp));
            uint256 effective = _record(token, s, p, block.timestamp);
            emit PriceRelayed(token, p, effective, block.timestamp);
        }
    }

    /// @inheritdoc IOracleAdapter
    function read(address token, uint256 maxAge) external returns (uint256 p, bool isLagging) {
        (uint256 raw, uint256 updatedAt) = _validSource(token);
        if (maxAge > MAX_AGE) maxAge = MAX_AGE;
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(token, updatedAt);
        p = _record(token, sources[token], raw, updatedAt);
        isLagging = p != raw;
    }

    /// @inheritdoc IOracleAdapter
    function poke(address token) external returns (bool valid) {
        (uint256 raw, uint256 updatedAt) = _source(token);
        if (raw == 0) return false;
        _record(token, sources[token], raw, updatedAt);
        return true;
    }

    /// @notice Latest valid effective price (what a recording now would report) and its source timestamp,
    ///         without the freshness check.
    function latest(address token) public view returns (uint256 p, uint256 updatedAt) {
        uint256 raw;
        (raw, updatedAt) = _validSource(token);
        p = _limit(bands[token], _clamp(sources[token], raw));
    }

    /// @inheritdoc IOracleAdapter
    function price(address token) external view returns (uint256 p) {
        uint256 updatedAt;
        (p, updatedAt) = latest(token);
        if (block.timestamp > updatedAt + MAX_AGE) revert StalePrice(token, updatedAt);
    }

    /// @notice True when a recording now would report a price other than the source price: the source is
    ///         outside the rate limit (the reported price is catching up) or outside the bounds (IA-06).
    function lagging(address token) external view returns (bool) {
        (uint256 raw,) = _validSource(token);
        return _limit(bands[token], _clamp(sources[token], raw)) != raw;
    }

    /// @inheritdoc IOracleAdapter
    function atBound(address token) external view returns (bool) {
        (uint256 raw,) = _source(token);
        if (raw == 0) return false;
        uint256 c = _clamp(sources[token], raw);
        return c != raw && _limit(bands[token], c) == c;
    }

    /// @notice Newest valid source timestamp recorded for `token` (0 = none yet).
    function lastValidAt(address token) external view returns (uint256) {
        return bands[token].lastValidAt;
    }

    /// @inheritdoc IOracleAdapter
    function lastRecorded(address token) external view returns (uint256 p, uint256 validAt) {
        Band memory b = bands[token];
        return (b.last, b.lastValidAt);
    }

    /// @inheritdoc IOracleAdapter
    function liveClock(address token) external view returns (uint256) {
        uint256 validAt = bands[token].lastValidAt;
        uint256 dead = deadTime[token];
        // A valid source reading nobody recorded yet counts as recording it would.
        (uint256 raw, uint256 at) = _source(token);
        if (raw != 0 && at > validAt) {
            dead += _deadGap(validAt, at);
            validAt = at;
        }
        uint256 t = block.timestamp;
        // A gap already longer than DEAD_AFTER: the clock stands at the last valid time.
        if (validAt != 0 && t - validAt > DEAD_AFTER) t = validAt;
        // `dead` sums gaps between valid times, all of them before validAt <= t.
        return t - dead;
    }

    /// @inheritdoc IOracleAdapter
    function isDead(address token) external view returns (bool) {
        if (!sources[token].configured) return true;
        uint256 alive = bands[token].lastValidAt;
        if (setupAt > alive) alive = setupAt;
        (uint256 raw, uint256 updatedAt) = _source(token);
        // Any positive answer is a live reading, inside the bounds or not (IA-06).
        if (raw != 0 && updatedAt > alive) alive = updatedAt;
        return block.timestamp > alive + DEAD_AFTER;
    }

    /// @inheritdoc IOracleAdapter
    function sequencerStatus() public view returns (bool up, bool ready) {
        address feed = sequencerFeed;
        if (feed == address(0)) return (true, true);
        (bool ok, int256 answer, uint256 startedAt,) = _latestRound(feed);
        // answer 0 = up; startedAt = when the current status began (0 = feed not initialised). An unreadable or
        // malformed feed reads as down and never reverts (FA-07).
        if (!ok || answer != 0 || startedAt == 0 || startedAt > block.timestamp) return (false, false);
        return (true, block.timestamp - startedAt > SEQUENCER_GRACE);
    }

    /// @inheritdoc IOracleAdapter
    function sequencerReady() external view returns (bool) {
        (, bool ready) = sequencerStatus();
        return ready;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Record a valid source reading: clamp it to the bounds and rate-limit it against the last recorded
    ///      effective price. The result and the clock are stored only when the reading brings a new source value or
    ///      changes the effective price (FA-01); otherwise nothing is written, exactly as if there had been no
    ///      recording. A new source value also advances lastValidAt and adds a gap of more than DEAD_AFTER since
    ///      the previous one to deadTime (FA-02, FA-03).
    function _record(address token, Source memory s, uint256 raw, uint256 updatedAt)
        internal
        returns (uint256 effective)
    {
        Band storage b = bands[token];
        Band memory old = b;
        effective = _limit(old, _clamp(s, raw));
        bool newSource = updatedAt > old.lastValidAt;
        if (newSource || effective != old.last) {
            // effective lies between the clamped source price and the last price, both within the uint128 bounds;
            // the clock is at most block.timestamp.
            // forge-lint: disable-next-line(unsafe-typecast)
            b.last = uint128(effective);
            // forge-lint: disable-next-line(unsafe-typecast)
            b.lastAt = uint64(_clockAfter(old, effective, newSource ? updatedAt : 0));
        }
        if (newSource) {
            uint256 gap = _deadGap(old.lastValidAt, updatedAt);
            if (gap != 0) deadTime[token] += gap;
            // Source timestamps are at most block.timestamp (relay: the push time; feeds: checked in _source).
            // forge-lint: disable-next-line(unsafe-typecast)
            b.lastValidAt = uint64(updatedAt);
        }
    }

    /// @dev The rate-limit clock after a recording moved the price from `b.last` to `effective` (FA-01): the start
    ///      of the allowance `_limit` used (lastAt, or now - MOVE_WINDOW if that is later) plus the whole seconds the
    ///      move needed at 1/6000 of `b.last` per second, rounded up; for a new source value at least its timestamp
    ///      `sourceAt` (0 otherwise). A move clamped at the limit uses all the time up to now, as before. A move that
    ///      reached its target sooner leaves the rest of the allowance to the next recording instead of discarding
    ///      it, so recording a caught-up price (a poke just before the next push) costs that push nothing. The time
    ///      is never credited twice: every move of m seconds' worth advances the clock by at least m, so over any
    ///      run of recordings the price stays within (1 + 1/6000)^t of the price set at the clock's start, and one
    ///      recording still moves it at most 5%. The first price ever starts the clock at now.
    function _clockAfter(Band memory b, uint256 effective, uint256 sourceAt) internal view returns (uint256 at) {
        uint256 last = b.last;
        if (last == 0) return block.timestamp;
        at = block.timestamp - b.lastAt > MOVE_WINDOW ? block.timestamp - MOVE_WINDOW : b.lastAt;
        uint256 moved = effective > last ? effective - last : last - effective;
        // moved <= last x dt / 6000 (the allowance _limit gave), so the seconds used are at most dt: at <= now.
        if (moved != 0) at += moved.mulDivUp(BPS * MOVE_WINDOW, last * MAX_MOVE_BPS);
        if (sourceAt > at) at = sourceAt;
    }

    /// @dev The dead time between two consecutive valid source times: all of it when it is longer than DEAD_AFTER
    ///      (the token counted as dead in between), else none; none before the first valid price (`from` = 0).
    function _deadGap(uint256 from, uint256 to) internal pure returns (uint256) {
        if (from == 0 || to - from <= DEAD_AFTER) return 0;
        return to - from;
    }

    /// @dev The effective price a recording of `target` (a price within the bounds) would produce now: `target`
    ///      clamped to last +- last x MAX_MOVE_BPS x min(dt, MOVE_WINDOW) / (BPS x MOVE_WINDOW), rounded toward
    ///      `last`. The first valid price ever is taken as is.
    function _limit(Band memory b, uint256 target) internal view returns (uint256) {
        uint256 last = b.last;
        if (last == 0) return target;
        uint256 dt = block.timestamp - b.lastAt;
        if (dt > MOVE_WINDOW) dt = MOVE_WINDOW;
        uint256 maxMove = last.mulDivDown(MAX_MOVE_BPS * dt, BPS * MOVE_WINDOW);
        if (target + maxMove < last) return last - maxMove;
        if (target > last + maxMove) return last + maxMove;
        return target;
    }

    /// @dev `raw` moved into the token's fixed bounds (IA-06).
    function _clamp(Source memory s, uint256 raw) internal pure returns (uint256) {
        if (raw < s.minPrice) return s.minPrice;
        if (raw > s.maxPrice) return s.maxPrice;
        return raw;
    }

    /// @dev Source price and timestamp, reverting if missing. An out-of-bounds price is returned as it is.
    function _validSource(address token) internal view returns (uint256 p, uint256 updatedAt) {
        (p, updatedAt) = _source(token);
        if (p == 0) revert NoPrice(token);
    }

    /// @dev Raw source price (0 = none: unconfigured, never pushed, failed or malformed feed read).
    function _source(address token) internal view returns (uint256 p, uint256 updatedAt) {
        Source memory s = sources[token];
        if (!s.configured) return (0, 0);
        if (s.feed == address(0)) {
            Relayed memory r = relayed[token];
            return (r.price, r.updatedAt);
        }
        (bool ok, int256 answer,, uint256 at) = _latestRound(s.feed);
        if (!ok || answer <= 0 || FixedMath.toUint(answer) > type(uint128).max || at == 0 || at > block.timestamp) {
            return (0, 0);
        }
        return (FixedMath.toUint(answer) * 10 ** (18 - s.feedDecimals), at);
    }

    /// @dev `latestRoundData()` of `feed` through a plain staticcall that copies back at most five words (FA-07).
    ///      `ok` is false when the call fails or returns fewer than five words (no code, wrong interface), so a
    ///      broken feed never reverts the caller. roundId and answeredInRound are not used.
    function _latestRound(address feed)
        internal
        view
        returns (bool ok, int256 answer, uint256 startedAt, uint256 updatedAt)
    {
        bytes4 selector = IAggregatorV3.latestRoundData.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            let success := staticcall(gas(), feed, ptr, 4, ptr, 0xa0)
            if and(success, iszero(lt(returndatasize(), 0xa0))) {
                ok := 1
                answer := mload(add(ptr, 0x20))
                startedAt := mload(add(ptr, 0x40))
                updatedAt := mload(add(ptr, 0x60))
            }
        }
    }
}
