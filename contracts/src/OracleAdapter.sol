// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {FixedMath} from "./libraries/FixedMath.sol";

/// @title OracleAdapter
/// @notice One price source per token, fixed at setup: either a Chainlink AggregatorV3 feed or
///         (testnet only) a price-relay updater that pushes prices within bounds.
///         Prices are USDG per whole token, scaled by 1e18.
/// @dev Freshness: at most MAX_AGE seconds. A token is dead after DEAD_AFTER without a valid price;
///      perps then settle forced exits at entry price. No owner after setup.
contract OracleAdapter is IOracleAdapter {
    uint256 public constant MAX_AGE = 60;
    uint256 public constant DEAD_AFTER = 14 days;
    /// @notice A relayed price may move at most 10% from the previous one when that one is
    ///         younger than RELAY_MOVE_WINDOW. Older (e.g. after a market close) only bounds apply.
    uint256 public constant MAX_MOVE_BPS = 1_000;
    uint256 public constant RELAY_MOVE_WINDOW = 1 hours;

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

    address public immutable deployer;
    bool public locked;
    address public relayer;
    mapping(address token => Source) public sources;
    mapping(address token => Relayed) public relayed;

    event Setup(address[] tokens, address[] feeds, address relayer);
    event PriceRelayed(address indexed token, uint256 price, uint256 timestamp);

    error NotDeployer();
    error AlreadySetUp();
    error LengthMismatch();
    error ZeroAddress();
    error BadBounds(address token);
    error BadFeedDecimals(address feed);
    error NotRelayer();
    error NotRelaySourced(address token);
    error UnknownToken(address token);
    error NoPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    error PriceOutOfBounds(address token, uint256 price);
    error MoveTooLarge(address token, uint256 previous, uint256 next);
    error TooSoon(address token);

    constructor() {
        deployer = msg.sender;
    }

    /// @param feeds Chainlink proxy per token, or address(0) for relay-sourced tokens.
    /// @param relayer_ The only address allowed to push relayed prices (may be zero if unused).
    function setup(
        address[] calldata tokens,
        address[] calldata feeds,
        uint128[] calldata minPrices,
        uint128[] calldata maxPrices,
        address relayer_
    ) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        if (tokens.length != feeds.length || tokens.length != minPrices.length || tokens.length != maxPrices.length) {
            revert LengthMismatch();
        }
        locked = true;
        relayer = relayer_;
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            if (minPrices[i] == 0 || minPrices[i] >= maxPrices[i]) revert BadBounds(token);
            uint8 dec;
            if (feeds[i] != address(0)) {
                dec = IAggregatorV3(feeds[i]).decimals();
                if (dec > 18) revert BadFeedDecimals(feeds[i]);
            } else if (relayer_ == address(0)) {
                revert ZeroAddress();
            }
            sources[token] = Source(feeds[i], dec, minPrices[i], maxPrices[i], true);
        }
        emit Setup(tokens, feeds, relayer_);
    }

    /// @notice Push prices for relay-sourced tokens (testnet price-relay worker).
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
            Relayed memory prev = relayed[token];
            // Arbitrum's block.number is an L1 estimate, so rate-limit by timestamp instead.
            if (prev.updatedAt >= block.timestamp) revert TooSoon(token);
            if (prev.price != 0 && block.timestamp - prev.updatedAt < RELAY_MOVE_WINDOW) {
                uint256 diff = p > prev.price ? p - prev.price : prev.price - p;
                if (diff > FixedMath.mulDivDown(prev.price, MAX_MOVE_BPS, FixedMath.BPS)) {
                    revert MoveTooLarge(token, prev.price, p);
                }
            }
            // p <= maxPrice (uint128) was checked above; timestamps fit uint64 for billions of years.
            // forge-lint: disable-next-line(unsafe-typecast)
            relayed[token] = Relayed(uint128(p), uint64(block.timestamp));
            emit PriceRelayed(token, p, block.timestamp);
        }
    }

    /// @notice Latest valid price and its timestamp, without the freshness check.
    function latest(address token) public view returns (uint256 p, uint256 updatedAt) {
        bool ok;
        (ok, p, updatedAt) = _read(token);
        if (!ok) revert NoPrice(token);
        Source memory s = sources[token];
        if (p < s.minPrice || p > s.maxPrice) revert PriceOutOfBounds(token, p);
    }

    /// @inheritdoc IOracleAdapter
    function price(address token) external view returns (uint256 p) {
        uint256 updatedAt;
        (p, updatedAt) = latest(token);
        if (block.timestamp > updatedAt + MAX_AGE) revert StalePrice(token, updatedAt);
    }

    /// @inheritdoc IOracleAdapter
    function isDead(address token) external view returns (bool) {
        (bool ok, uint256 p, uint256 updatedAt) = _read(token);
        if (!ok) return true;
        Source memory s = sources[token];
        if (p < s.minPrice || p > s.maxPrice) return true;
        return block.timestamp > updatedAt + DEAD_AFTER;
    }

    function _read(address token) internal view returns (bool ok, uint256 p, uint256 updatedAt) {
        Source memory s = sources[token];
        if (!s.configured) return (false, 0, 0);
        if (s.feed == address(0)) {
            Relayed memory r = relayed[token];
            if (r.price == 0) return (false, 0, 0);
            return (true, r.price, r.updatedAt);
        }
        try IAggregatorV3(s.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 at, uint80) {
            if (answer <= 0 || FixedMath.toUint(answer) > type(uint128).max || at == 0 || at > block.timestamp) {
                return (false, 0, 0);
            }
            return (true, FixedMath.toUint(answer) * 10 ** (18 - s.feedDecimals), at);
        } catch {
            return (false, 0, 0);
        }
    }
}
