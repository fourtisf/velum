// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {FixedMath} from "./libraries/FixedMath.sol";

/// @title OracleAdapter
/// @notice One price source per token, fixed at setup: either a Chainlink AggregatorV3 feed (production,
///         guarded by the L2 sequencer-uptime feed) or (testnet only) a price-relay updater that pushes
///         prices within bounds. Prices are USDG per whole token, scaled by 1e18. No owner after setup.
///
/// Price band (internal audit F-04, F-02). The price this adapter reports, the "effective" price, stays
/// within ±MAX_MOVE_BPS (10%) of a reference price. The reference moves to the last recorded effective
/// price at most once per MOVE_WINDOW (10 minutes). So a source can move the reported price by at most
/// 10% per 10 minutes, and after a gap or a silence the first price is capped at 10% from the last valid
/// one; further moves walk in steps. While the source is outside the band the price is "lagging": perps
/// refuses opens, closes and margin removal on it, but liquidations go on at the banded price. A 5x
/// position that is above maintenance at the reference price stays solvent within the band, so a gap
/// alone can no longer create a shortfall: one needs keepers to miss a whole window.
///
/// Liveness (F-03). `lastValidAt` is the newest valid source timestamp recorded by `read`, `poke` or
/// `pushPrices`. A failed or out-of-bounds read only makes the price stale. A token is dead when no valid
/// price was seen for DEAD_AFTER since max(lastValidAt, setup time).
///
/// Sequencer (F-05). With Chainlink sources the deployer must give the L2 sequencer-uptime feed; while the
/// sequencer is down and for SEQUENCER_GRACE after it comes back, `sequencerReady()` is false and perps
/// blocks opens and liquidations. Zero sequencer feed means relay sources only (testnet).
contract OracleAdapter is IOracleAdapter {
    using FixedMath for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_AGE = 60;
    uint256 public constant DEAD_AFTER = 14 days;
    /// @notice The effective price moves at most 10% from the band reference...
    uint256 public constant MAX_MOVE_BPS = 1000;
    /// @notice ...and the reference moves at most once per 10 minutes.
    uint256 public constant MOVE_WINDOW = 10 minutes;
    /// @notice Opens and liquidations wait this long after the L2 sequencer comes back up.
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

    /// @dev ref: band centre for the window that started at refAt (0 = no price yet).
    ///      last: last recorded effective price. lastValidAt: newest valid source timestamp recorded.
    struct Band {
        uint128 ref;
        uint64 refAt;
        uint64 lastValidAt;
        uint128 last;
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

    event Setup(address[] tokens, address[] feeds, address relayer, address sequencerFeed);
    /// @param price The price the relayer pushed. @param effectivePrice The banded price now reported.
    event PriceRelayed(address indexed token, uint256 price, uint256 effectivePrice, uint256 timestamp);

    error NotDeployer();
    error AlreadySetUp();
    error LengthMismatch();
    error ZeroAddress();
    error BadBounds(address token);
    error BadFeedDecimals(address feed);
    error SequencerFeedRequired();
    error NotRelayer();
    error NotRelaySourced(address token);
    error UnknownToken(address token);
    error NoPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
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
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            if (minPrices[i] == 0 || minPrices[i] >= maxPrices[i]) revert BadBounds(token);
            uint8 dec;
            if (feeds[i] != address(0)) {
                if (sequencerFeed_ == address(0)) revert SequencerFeedRequired();
                dec = IAggregatorV3(feeds[i]).decimals();
                if (dec > 18) revert BadFeedDecimals(feeds[i]);
            } else if (relayer_ == address(0)) {
                revert ZeroAddress();
            }
            sources[token] = Source(feeds[i], dec, minPrices[i], maxPrices[i], true);
        }
        emit Setup(tokens, feeds, relayer_, sequencerFeed_);
    }

    /// @notice Push prices for relay-sourced tokens (testnet price-relay worker). Any price within the
    ///         absolute bounds is accepted, but the reported price follows it only through the band.
    function pushPrices(address[] calldata tokens, uint256[] calldata prices) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (tokens.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            Source memory s = sources[token];
            if (!s.configured) revert UnknownToken(token);
            if (s.feed != address(0)) revert NotRelaySourced(token);
            uint256 p = prices[i];
            if (p < s.minPrice || p > s.maxPrice) revert PriceOutOfBounds(token, p);
            // Arbitrum's block.number is an L1 estimate, so rate-limit by timestamp instead.
            if (relayed[token].updatedAt >= block.timestamp) revert TooSoon(token);
            // p <= maxPrice (uint128) was checked above; timestamps fit uint64 for billions of years.
            // forge-lint: disable-next-line(unsafe-typecast)
            relayed[token] = Relayed(uint128(p), uint64(block.timestamp));
            uint256 effective = _record(token, p, block.timestamp);
            emit PriceRelayed(token, p, effective, block.timestamp);
        }
    }

    /// @inheritdoc IOracleAdapter
    function read(address token, uint256 maxAge) external returns (uint256 p, bool isLagging) {
        (uint256 raw, uint256 updatedAt) = _validSource(token);
        if (maxAge > MAX_AGE) maxAge = MAX_AGE;
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(token, updatedAt);
        p = _record(token, raw, updatedAt);
        isLagging = p != raw;
    }

    /// @inheritdoc IOracleAdapter
    function poke(address token) external returns (bool valid) {
        (uint256 raw, uint256 updatedAt) = _source(token);
        if (!_inBounds(token, raw)) return false;
        _record(token, raw, updatedAt);
        return true;
    }

    /// @notice Latest valid banded price and its source timestamp, without the freshness check.
    function latest(address token) public view returns (uint256 p, uint256 updatedAt) {
        uint256 raw;
        (raw, updatedAt) = _validSource(token);
        p = _clamp(raw, _bandRef(bands[token]));
    }

    /// @inheritdoc IOracleAdapter
    function price(address token) external view returns (uint256 p) {
        uint256 updatedAt;
        (p, updatedAt) = latest(token);
        if (block.timestamp > updatedAt + MAX_AGE) revert StalePrice(token, updatedAt);
    }

    /// @notice True when the source price is outside the band, i.e. the reported price is catching up.
    function lagging(address token) external view returns (bool) {
        (uint256 raw,) = _validSource(token);
        return _clamp(raw, _bandRef(bands[token])) != raw;
    }

    /// @notice Newest valid source timestamp recorded for `token` (0 = none yet).
    function lastValidAt(address token) external view returns (uint256) {
        return bands[token].lastValidAt;
    }

    /// @inheritdoc IOracleAdapter
    function isDead(address token) external view returns (bool) {
        if (!sources[token].configured) return true;
        uint256 alive = bands[token].lastValidAt;
        if (setupAt > alive) alive = setupAt;
        (uint256 raw, uint256 updatedAt) = _source(token);
        if (_inBounds(token, raw) && updatedAt > alive) alive = updatedAt;
        return block.timestamp > alive + DEAD_AFTER;
    }

    /// @inheritdoc IOracleAdapter
    function sequencerReady() external view returns (bool) {
        address feed = sequencerFeed;
        if (feed == address(0)) return true;
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            // answer 0 = up; startedAt = when the current status began (0 = feed not initialised).
            if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) return false;
            return block.timestamp - startedAt > SEQUENCER_GRACE;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- internals

    /// @dev Record a valid source reading: roll the band reference if its window is over, clamp the
    ///      price into the band and remember it, and advance lastValidAt.
    function _record(address token, uint256 raw, uint256 updatedAt) internal returns (uint256 effective) {
        Band storage b = bands[token];
        if (b.ref == 0) {
            // First valid price ever: it becomes the reference. raw <= maxPrice fits uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            b.ref = uint128(raw);
            // forge-lint: disable-next-line(unsafe-typecast)
            b.refAt = uint64(block.timestamp);
            effective = raw;
        } else {
            if (block.timestamp >= uint256(b.refAt) + MOVE_WINDOW) {
                b.ref = b.last;
                // forge-lint: disable-next-line(unsafe-typecast)
                b.refAt = uint64(block.timestamp);
            }
            effective = _clamp(raw, b.ref);
        }
        // effective lies between raw and the reference, both within the uint128 price bounds.
        // forge-lint: disable-next-line(unsafe-typecast)
        b.last = uint128(effective);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (updatedAt > b.lastValidAt) b.lastValidAt = uint64(updatedAt);
    }

    /// @dev The reference `_record` would use now (a view of the roll).
    function _bandRef(Band memory b) internal view returns (uint256) {
        if (b.ref == 0) return 0;
        return block.timestamp >= uint256(b.refAt) + MOVE_WINDOW ? b.last : b.ref;
    }

    function _clamp(uint256 p, uint256 ref) internal pure returns (uint256) {
        if (ref == 0) return p;
        uint256 lo = ref.mulDivUp(BPS - MAX_MOVE_BPS, BPS);
        uint256 hi = ref.mulDivDown(BPS + MAX_MOVE_BPS, BPS);
        return p < lo ? lo : (p > hi ? hi : p);
    }

    function _inBounds(address token, uint256 p) internal view returns (bool) {
        Source memory s = sources[token];
        return p != 0 && p >= s.minPrice && p <= s.maxPrice;
    }

    /// @dev Source price and timestamp, reverting if missing or out of bounds.
    function _validSource(address token) internal view returns (uint256 p, uint256 updatedAt) {
        (p, updatedAt) = _source(token);
        if (p == 0) revert NoPrice(token);
        Source memory s = sources[token];
        if (p < s.minPrice || p > s.maxPrice) revert PriceOutOfBounds(token, p);
    }

    /// @dev Raw source price (0 = none: unconfigured, never pushed, failed or malformed feed read).
    function _source(address token) internal view returns (uint256 p, uint256 updatedAt) {
        Source memory s = sources[token];
        if (!s.configured) return (0, 0);
        if (s.feed == address(0)) {
            Relayed memory r = relayed[token];
            return (r.price, r.updatedAt);
        }
        try IAggregatorV3(s.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 at, uint80) {
            if (answer <= 0 || FixedMath.toUint(answer) > type(uint128).max || at == 0 || at > block.timestamp) {
                return (0, 0);
            }
            return (FixedMath.toUint(answer) * 10 ** (18 - s.feedDecimals), at);
        } catch {
            return (0, 0);
        }
    }
}
