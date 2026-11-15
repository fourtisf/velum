// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVelumVault} from "./interfaces/IVelumVault.sol";
import {FixedMath} from "./libraries/FixedMath.sol";

/// @title SpotPools
/// @notice Constant-product pools, one per stock token against USDG. A 0.30% fee stays in the pool
///         on every swap (two fees when a stock-to-stock swap routes through USDG). Liquidity
///         providers hold shares tracked here. All balances live in the vault as this contract's
///         internal balance; users trade from their own internal balances.
/// @dev Pools are fixed at setup. The first deposit into a pool permanently locks MIN_LIQUIDITY
///      shares so the share price can't be inflated to steal later deposits.
contract SpotPools is ReentrancyGuard {
    using FixedMath for uint256;

    uint256 public constant FEE_BPS = 30;
    uint256 public constant MIN_LIQUIDITY = 1000;

    struct Pool {
        uint256 stockReserve;
        uint256 usdgReserve;
        uint256 totalShares;
        bool exists;
    }

    IVelumVault public immutable vault;
    address public immutable usdg;
    address public immutable deployer;
    bool public locked;

    mapping(address stock => Pool) public pools;
    mapping(address stock => mapping(address account => uint256)) public sharesOf;
    address[] public stocks;

    event Setup(address[] stocks);
    /// @notice Emitted after every reserve change so indexers can track pools from events alone.
    event PoolChanged(address indexed stock, uint256 stockReserve, uint256 usdgReserve, uint256 totalShares);
    event LiquidityAdded(
        address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares
    );
    event LiquidityRemoved(
        address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares
    );
    event Swapped(
        address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    error NotDeployer();
    error AlreadySetUp();
    error ZeroAddress();
    error UnknownPool(address stock);
    error Expired();
    error ZeroAmount();
    error SameToken();
    error NoLiquidity(address stock);
    error Slippage(uint256 got, uint256 min);
    /// @notice A zero `minOut`, `minShares`, `minStock` or `minUsdg` (no slippage protection) is refused (final
    ///         audit FA-05, as `priceLimit = 0` in perps since IA-10).
    error NoMinimum();
    error InsufficientShares(uint256 have, uint256 need);

    constructor(IVelumVault vault_, address usdg_) {
        if (address(vault_) == address(0) || usdg_ == address(0)) revert ZeroAddress();
        vault = vault_;
        usdg = usdg_;
        deployer = msg.sender;
    }

    function setup(address[] calldata stocks_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        locked = true;
        for (uint256 i; i < stocks_.length; ++i) {
            address s = stocks_[i];
            if (s == address(0) || s == usdg) revert ZeroAddress();
            pools[s].exists = true;
            stocks.push(s);
        }
        emit Setup(stocks_);
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    function stockCount() external view returns (uint256) {
        return stocks.length;
    }

    // ---------------------------------------------------------------- liquidity

    /// @notice Add liquidity up to `maxStock` / `maxUsdg`. Only the amounts matching the current
    ///         ratio are taken (rounded up, in the pool's favour). `minShares` must be non-zero (FA-05).
    function addLiquidity(address stock, uint256 maxStock, uint256 maxUsdg, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 shares, uint256 stockIn, uint256 usdgIn)
    {
        Pool storage p = _pool(stock);
        if (maxStock == 0 || maxUsdg == 0) revert ZeroAmount();
        if (minShares == 0) revert NoMinimum();
        if (p.totalShares == 0) {
            stockIn = maxStock;
            usdgIn = maxUsdg;
            uint256 root = FixedMath.sqrt(stockIn * usdgIn);
            if (root <= MIN_LIQUIDITY) revert ZeroAmount();
            shares = root - MIN_LIQUIDITY;
            p.totalShares = root;
            sharesOf[stock][address(0)] = MIN_LIQUIDITY;
        } else {
            uint256 total = p.totalShares;
            if (p.stockReserve == 0 || p.usdgReserve == 0) revert NoLiquidity(stock);
            shares = FixedMath.min(maxStock.mulDivDown(total, p.stockReserve), maxUsdg.mulDivDown(total, p.usdgReserve));
            if (shares == 0) revert ZeroAmount();
            stockIn = shares.mulDivUp(p.stockReserve, total);
            usdgIn = shares.mulDivUp(p.usdgReserve, total);
            p.totalShares = total + shares;
        }
        if (shares < minShares) revert Slippage(shares, minShares);
        vault.transferInternal(stock, msg.sender, address(this), stockIn);
        vault.transferInternal(usdg, msg.sender, address(this), usdgIn);
        p.stockReserve += stockIn;
        p.usdgReserve += usdgIn;
        sharesOf[stock][msg.sender] += shares;
        emit LiquidityAdded(msg.sender, stock, stockIn, usdgIn, shares);
        emit PoolChanged(stock, p.stockReserve, p.usdgReserve, p.totalShares);
    }

    /// @notice Burn shares for a pro-rata slice of both reserves (rounded down). `minStock` and `minUsdg` must
    ///         both be non-zero (FA-05).
    function removeLiquidity(address stock, uint256 shares, uint256 minStock, uint256 minUsdg, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 stockOut, uint256 usdgOut)
    {
        Pool storage p = _pool(stock);
        if (shares == 0) revert ZeroAmount();
        if (minStock == 0 || minUsdg == 0) revert NoMinimum();
        uint256 have = sharesOf[stock][msg.sender];
        if (have < shares) revert InsufficientShares(have, shares);
        uint256 total = p.totalShares;
        stockOut = shares.mulDivDown(p.stockReserve, total);
        usdgOut = shares.mulDivDown(p.usdgReserve, total);
        if (stockOut < minStock) revert Slippage(stockOut, minStock);
        if (usdgOut < minUsdg) revert Slippage(usdgOut, minUsdg);
        sharesOf[stock][msg.sender] = have - shares;
        p.totalShares = total - shares;
        p.stockReserve -= stockOut;
        p.usdgReserve -= usdgOut;
        // The locked MIN_LIQUIDITY shares normally keep both reserves above zero; refuse an exit
        // that would empty one side (only possible for a pool seeded at an extreme ratio).
        if (p.stockReserve == 0 || p.usdgReserve == 0) revert NoLiquidity(stock);
        vault.transferInternal(stock, address(this), msg.sender, stockOut);
        vault.transferInternal(usdg, address(this), msg.sender, usdgOut);
        emit LiquidityRemoved(msg.sender, stock, stockOut, usdgOut, shares);
        emit PoolChanged(stock, p.stockReserve, p.usdgReserve, p.totalShares);
    }

    // ---------------------------------------------------------------- swaps

    /// @notice Swap an exact input. USDG<->stock uses one pool; stock->stock routes through USDG in
    ///         the same call and pays both pools' fees. `minOut` must be non-zero (FA-05).
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amountOut)
    {
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert NoMinimum();
        vault.transferInternal(tokenIn, msg.sender, address(this), amountIn);
        if (tokenIn == usdg) {
            amountOut = _swapInPool(tokenOut, true, amountIn);
        } else if (tokenOut == usdg) {
            amountOut = _swapInPool(tokenIn, false, amountIn);
        } else {
            uint256 mid = _swapInPool(tokenIn, false, amountIn);
            amountOut = _swapInPool(tokenOut, true, mid);
        }
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        vault.transferInternal(tokenOut, address(this), msg.sender, amountOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Quote for `swap` at current reserves (no state change).
    function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        if (tokenIn == tokenOut) revert SameToken();
        if (tokenIn == usdg) return _quote(tokenOut, true, amountIn);
        if (tokenOut == usdg) return _quote(tokenIn, false, amountIn);
        return _quote(tokenOut, true, _quote(tokenIn, false, amountIn));
    }

    function _quote(address stock, bool usdgToStock, uint256 amountIn) internal view returns (uint256) {
        Pool storage p = _pool(stock);
        (uint256 rIn, uint256 rOut) = usdgToStock ? (p.usdgReserve, p.stockReserve) : (p.stockReserve, p.usdgReserve);
        if (rIn == 0 || rOut == 0) revert NoLiquidity(stock);
        uint256 inAfterFee = amountIn.mulDivDown(FixedMath.BPS - FEE_BPS, FixedMath.BPS);
        return inAfterFee.mulDivDown(rOut, rIn + inAfterFee);
    }

    function _swapInPool(address stock, bool usdgToStock, uint256 amountIn) internal returns (uint256 out) {
        out = _quote(stock, usdgToStock, amountIn);
        if (out == 0) revert ZeroAmount();
        Pool storage p = pools[stock];
        if (usdgToStock) {
            p.usdgReserve += amountIn;
            p.stockReserve -= out;
        } else {
            p.stockReserve += amountIn;
            p.usdgReserve -= out;
        }
        emit PoolChanged(stock, p.stockReserve, p.usdgReserve, p.totalShares);
    }

    function _pool(address stock) internal view returns (Pool storage p) {
        p = pools[stock];
        if (!p.exists) revert UnknownPool(stock);
    }
}
