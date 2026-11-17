/**
 * Universal Router calldata for one exact-input swap through one curated pool (pure, unit-tested and checked against
 * the deployed router on a mainnet fork: apps/web/e2e/uniswap-fork.e2e.cjs).
 *
 * Universal Router 2.1.2 (Robinhood Chain mainnet):
 *  - v3: command V3_SWAP_EXACT_IN (0x00) with abi.encode(recipient, amountIn, amountOutMin, path, payerIsUser,
 *    minHopPriceX36[]); path = tokenIn | fee (3 bytes) | tokenOut; the router pulls tokenIn from the user through
 *    Permit2 and sends tokenOut to `recipient`, reverting below amountOutMin.
 *  - v4: command V4_SWAP (0x10) with abi.encode(actions, params[]): SWAP_EXACT_IN_SINGLE (0x06) with
 *    (poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData), SETTLE_ALL (0x0c) paying tokenIn
 *    from the user through Permit2 (at most amountIn), TAKE_ALL (0x0f) sending tokenOut to the user (at least the
 *    minimum).
 * minHopPriceX36 is left off (empty / 0): a single pool, already bounded by the minimum output.
 *
 * Buying with ETH (encodeEthBuy): WRAP_ETH (0x0b) with abi.encode(ADDRESS_THIS, amountMin) turns the ETH sent with the
 * call into WETH held by the router, then V3_SWAP_EXACT_IN over the path WETH | ethLeg fee | USDG | pool fee | stock with
 * payerIsUser false (the router pays from that WETH) and the stock sent to the user, reverting below amountOutMin.
 * One transaction, no approval: ETH is native.
 */
import type { UniPool } from '@velum/config/src/uniswap';
import { concatHex, encodeAbiParameters, numberToHex, type Address, type Hex } from 'viem';

export const UR_COMMAND = { V3_SWAP_EXACT_IN: 0x00, WRAP_ETH: 0x0b, V4_SWAP: 0x10 } as const;
/** Universal Router's stand-in for "the router itself" as a recipient (ActionConstants.ADDRESS_THIS). */
export const UR_ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;
export const V4_ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;
const MAX_UINT128 = (1n << 128n) - 1n;

/** One hop: which pool, and which way. */
export interface Hop {
  pool: UniPool;
  tokenIn: Address;
  tokenOut: Address;
}

/** v4 swaps are currency0 -> currency1 when zeroForOne. */
export const zeroForOne = (h: Hop): boolean => h.tokenIn.toLowerCase() === h.pool.currency0;

/** The hop for buying (USDG -> stock) or selling (stock -> USDG) a market through `pool`. */
export function hopFor(pool: UniPool, side: 'buy' | 'sell'): Hop {
  return side === 'buy' ? { pool, tokenIn: pool.usdg, tokenOut: pool.stock } : { pool, tokenIn: pool.stock, tokenOut: pool.usdg };
}

/** A v3 path for one pool: tokenIn (20 bytes) | fee (3 bytes) | tokenOut (20 bytes). */
export function v3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return concatHex([tokenIn, numberToHex(fee, { size: 3 }), tokenOut]);
}

/** A v3 path over several pools: token | fee (3 bytes) | token | fee | token. */
export function v3PathMulti(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length !== fees.length + 1 || fees.length === 0) throw new Error('a path needs one more token than fees');
  const parts: Hex[] = [tokens[0]!];
  fees.forEach((f, i) => parts.push(numberToHex(f, { size: 3 }), tokens[i + 1]!));
  return concatHex(parts);
}

/** The v3 path of buying a stock with ETH through the ETH leg and the stock's v3 pool. */
export function ethBuyPath(weth: Address, ethFee: number, pool: UniPool): Hex {
  if (pool.version !== 3) throw new Error('buying with ETH goes through a v3 stock pool');
  return v3PathMulti([weth, pool.usdg, pool.stock], [ethFee, pool.fee]);
}

/** Universal Router `execute` arguments (without the deadline) and the ETH to send, for buying a stock with ETH. */
export function encodeEthBuy(p: { weth: Address; ethFee: number; pool: UniPool; amountIn: bigint; minOut: bigint; recipient: Address }): { commands: Hex; inputs: Hex[]; value: bigint } {
  if (p.amountIn <= 0n || p.minOut <= 0n) throw new Error('amountIn and minOut must be positive');
  const wrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [UR_ADDRESS_THIS, p.amountIn]);
  const swap = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
    [p.recipient, p.amountIn, p.minOut, ethBuyPath(p.weth, p.ethFee, p.pool), false, []],
  );
  return { commands: concatHex([numberToHex(UR_COMMAND.WRAP_ETH, { size: 1 }), numberToHex(UR_COMMAND.V3_SWAP_EXACT_IN, { size: 1 })]), inputs: [wrap, swap], value: p.amountIn };
}

/** Universal Router `execute` arguments (without the deadline) for one exact-input swap. */
export function encodeSwap(h: Hop, amountIn: bigint, minOut: bigint, recipient: Address): { commands: Hex; inputs: Hex[] } {
  if (amountIn <= 0n || minOut <= 0n) throw new Error('amountIn and minOut must be positive');
  const p = h.pool;
  const valid = (h.tokenIn.toLowerCase() === p.usdg && h.tokenOut.toLowerCase() === p.stock) || (h.tokenIn.toLowerCase() === p.stock && h.tokenOut.toLowerCase() === p.usdg);
  if (!valid) throw new Error('the hop does not match its pool');
  if (p.version === 3) {
    const input = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      [recipient, amountIn, minOut, v3Path(h.tokenIn, p.fee, h.tokenOut), true, []],
    );
    return { commands: numberToHex(UR_COMMAND.V3_SWAP_EXACT_IN, { size: 1 }), inputs: [input] };
  }
  if (amountIn > MAX_UINT128 || minOut > MAX_UINT128) throw new Error('amount above uint128');
  const swap = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [
      {
        poolKey: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks },
        zeroForOne: zeroForOne(h),
        amountIn,
        amountOutMinimum: minOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
    ],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [h.tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [h.tokenOut, minOut]);
  const actions = concatHex([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL].map((a) => numberToHex(a, { size: 1 })));
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  return { commands: numberToHex(UR_COMMAND.V4_SWAP, { size: 1 }), inputs: [input] };
}

/** The minimum output for a quote and a slippage in basis points, rounded down (never looser than asked). */
export const minOutFor = (quote: bigint, slipBps: bigint): bigint => (quote * (10_000n - slipBps)) / 10_000n;
