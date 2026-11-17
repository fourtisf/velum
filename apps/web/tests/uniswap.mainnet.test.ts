/**
 * Real spot trades through Uniswap (mainnet build): the Universal Router calldata, the flow the dialog runs (steps,
 * exact approvals, review), how its errors read, and the live price source's wording. The calldata is also executed
 * against the deployed contracts on a mainnet fork by e2e/uniswap-fork.e2e.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { IS_MAINNET } from '@velum/config';
import { UNISWAP, UNISWAP_MAINNET, buildUniswap, type UniPool } from '@velum/config/src/uniswap';
import { decodeAbiParameters, encodeErrorResult, slice, type Hex } from 'viem';
import { UNI, priceSourceText } from '@/lib/copy';
import { decodeTxError } from '@/lib/onchain/errors';
import { REAL_SOURCES, priceOrigin } from '@/lib/markets';
import { UNI_ERRORS_ABI } from '@/lib/uniswap/abi';
import { UR_ADDRESS_THIS, UR_COMMAND, encodeEthBuy, encodeSwap, ethBuyPath, hopFor, minOutFor, v3Path, v3PathMulti, zeroForOne } from '@/lib/uniswap/encode';
import { uniEthBuyFlow, uniTarget, uniTradeFlow } from '@/lib/uniswap/flows';
import uniJson from '@velum/config/uniswap-mainnet.json';
import mainnetJson from '@velum/config/robinhood-mainnet.json';

const cfg = UNISWAP!;
const ME = '0x1111111111111111111111111111111111111111' as const;
const tslaV3 = cfg.pools.TSLA!.find((p) => p.version === 3 && p.fee === 3000)! as Extract<UniPool, { version: 3 }>;
const tslaV4 = cfg.pools.TSLA!.find((p) => p.version === 4)! as Extract<UniPool, { version: 4 }>;
const metaV4 = cfg.pools.META!.find((p) => p.version === 4)! as Extract<UniPool, { version: 4 }>;

describe('mainnet build', () => {
  it('has the curated Uniswap venue', () => {
    expect(IS_MAINNET).toBe(true);
    expect(cfg.chainId).toBe(4663);
  });
});

describe('Universal Router calldata', () => {
  it('v3: one V3_SWAP_EXACT_IN with recipient, amounts, path, payerIsUser and an empty minHopPriceX36', () => {
    const h = hopFor(tslaV3, 'buy');
    const { commands, inputs } = encodeSwap(h, 1_000_000_000n, 2_500_000_000_000_000_000n, ME);
    expect(commands).toBe('0x00');
    const [recipient, amountIn, minOut, path, payerIsUser, hops] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      inputs[0]!,
    );
    expect(recipient.toLowerCase()).toBe(ME);
    expect(amountIn).toBe(1_000_000_000n);
    expect(minOut).toBe(2_500_000_000_000_000_000n);
    expect(path).toBe(v3Path(cfg.usdg.address, 3000, tslaV3.stock));
    expect(slice(path, 20, 23)).toBe('0x000bb8');
    expect(payerIsUser).toBe(true);
    expect(hops).toEqual([]);
  });
  it('v4: V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL and the hookless pool key', () => {
    const h = hopFor(tslaV4, 'sell');
    const { commands, inputs } = encodeSwap(h, 10n ** 18n, 380_000_000n, ME);
    expect(commands).toBe('0x10');
    expect(UR_COMMAND.V4_SWAP).toBe(0x10);
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
    expect(actions).toBe('0x060c0f');
    const [swap] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'minHopPriceX36', type: 'uint256' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      params[0]!,
    );
    expect(swap.poolKey.currency0.toLowerCase()).toBe(tslaV4.currency0);
    expect(swap.poolKey.hooks).toBe('0x0000000000000000000000000000000000000000');
    // TSLA is currency0: selling TSLA is zeroForOne.
    expect(swap.zeroForOne).toBe(true);
    expect(swap.amountIn).toBe(10n ** 18n);
    expect(swap.amountOutMinimum).toBe(380_000_000n);
    const [settleToken, settleMax] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!);
    const [takeToken, takeMin] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);
    expect([settleToken.toLowerCase(), settleMax]).toEqual([tslaV4.stock, 10n ** 18n]);
    expect([takeToken.toLowerCase(), takeMin]).toEqual([cfg.usdg.address, 380_000_000n]);
  });
  it('picks the swap direction from the token order', () => {
    expect(metaV4.stockIsToken0).toBe(false);
    expect(zeroForOne(hopFor(metaV4, 'buy'))).toBe(true);
    expect(zeroForOne(hopFor(metaV4, 'sell'))).toBe(false);
    expect(zeroForOne(hopFor(tslaV4, 'buy'))).toBe(false);
  });
  it('refuses zero amounts and a hop that does not match its pool', () => {
    expect(() => encodeSwap(hopFor(tslaV3, 'buy'), 0n, 1n, ME)).toThrow();
    expect(() => encodeSwap(hopFor(tslaV3, 'buy'), 1n, 0n, ME)).toThrow();
    expect(() => encodeSwap({ pool: tslaV3, tokenIn: cfg.usdg.address, tokenOut: metaV4.stock }, 1n, 1n, ME)).toThrow(/does not match/);
  });
  it('minimum output rounds down and never exceeds the quote', () => {
    expect(minOutFor(1_000_000n, 50n)).toBe(995_000n);
    expect(minOutFor(999n, 10n)).toBe(998n);
    expect(minOutFor(1n, 50n)).toBe(0n);
  });
});

describe('buying with ETH', () => {
  const weth = cfg.contracts.weth;
  it('uses the vetted WETH/USDG 0.01% pool as the ETH leg', () => {
    expect(cfg.ethLeg).toEqual({ address: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', fee: 100 });
    expect(weth).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    // Every market has a v3 pool, so every market can be bought with ETH in one transaction.
    for (const [sym, pools] of Object.entries(cfg.pools)) expect(pools.some((p) => p.version === 3), sym).toBe(true);
  });

  it('rejects a malformed ETH leg in the curated data', () => {
    const tokens = mainnetJson.tokens as Record<string, { address: string; decimals: number }>;
    const bad = (ethLeg: unknown) => () => buildUniswap({ ...(uniJson as unknown as Record<string, unknown>), ethLeg } as never, tokens);
    expect(bad({ version: 4, address: cfg.ethLeg.address, fee: 100 })).toThrow(/ethLeg/);
    expect(bad({ version: 3, address: '0x52E65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', fee: 100 })).toThrow(/ethLeg/);
    expect(bad({ version: 3, address: cfg.ethLeg.address, fee: 20000 })).toThrow(/ethLeg/);
    expect(UNISWAP_MAINNET.ethLeg.fee).toBe(100);
  });

  it('a two-hop v3 path: WETH | 100 | USDG | pool fee | stock', () => {
    expect(v3PathMulti([weth, cfg.usdg.address, tslaV3.stock], [100, 3000])).toBe(`${weth}000064${cfg.usdg.address.slice(2)}000bb8${tslaV3.stock.slice(2)}`);
    expect(ethBuyPath(weth, 100, tslaV3)).toBe(v3PathMulti([weth, cfg.usdg.address, tslaV3.stock], [100, 3000]));
    expect(() => ethBuyPath(weth, 100, tslaV4)).toThrow(/v3/);
    expect(() => v3PathMulti([weth], [])).toThrow();
  });

  it('WRAP_ETH to the router, then a v3 exact-input swap paid by the router, with the ETH as value', () => {
    const r = encodeEthBuy({ weth, ethFee: 100, pool: tslaV3, amountIn: 5n * 10n ** 16n, minOut: 123n, recipient: ME });
    expect(r.commands).toBe('0x0b00');
    expect(UR_COMMAND.WRAP_ETH).toBe(0x0b);
    expect(r.value).toBe(5n * 10n ** 16n);
    const [to, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], r.inputs[0]!);
    expect([to.toLowerCase(), min]).toEqual([UR_ADDRESS_THIS, 5n * 10n ** 16n]);
    const [recipient, amountIn, minOut, path, payerIsUser, hops] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      r.inputs[1]!,
    );
    expect(recipient).toBe(ME);
    expect(amountIn).toBe(5n * 10n ** 16n);
    expect(minOut).toBe(123n);
    expect(path).toBe(ethBuyPath(weth, 100, tslaV3));
    expect(payerIsUser).toBe(false);
    expect(hops).toEqual([]);
    expect(() => encodeEthBuy({ weth, ethFee: 100, pool: tslaV3, amountIn: 0n, minOut: 1n, recipient: ME })).toThrow();
  });

  it('the flow: one swap step sending the ETH, reviewed with the route and no approval', async () => {
    const f = uniEthBuyFlow({ account: ME, sym: 'TSLA', amountIn: 5n * 10n ** 16n, quoteOut: 24n * 10n ** 16n, minOut: 239n * 10n ** 15n, pool: tslaV3 });
    expect(f.steps).toHaveLength(1);
    const rows = Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]));
    expect(rows['You pay']).toMatch(/0\.05 ETH/);
    expect(rows.Route).toMatch(/^ETH to USDG \(Uniswap v3, 0\.01%\), then /);
    expect(rows.Approvals).toMatch(/None/);
    expect(f.ack).toMatch(/real trade/);
  });
});

describe('the trade flow', () => {
  const base = { account: ME, amountIn: 500_000_000n, quoteOut: 1_290_000_000_000_000_000n, minOut: 1_283_550_000_000_000_000n, title: 'Buy TSLA', toast: 'Bought TSLA' };
  it('one leg: two exact approvals (skippable) then the swap; review shows every amount, the route and what is public', () => {
    const f = uniTradeFlow({ ...base, from: 'USDG', to: 'TSLA', first: hopFor(tslaV3, 'buy'), firstMin: base.minOut });
    expect(f.steps.map((s) => s.label)).toEqual(['USDG approval', 'Router allowance', 'Swap']);
    expect(f.steps[0]!.idempotent && f.steps[1]!.idempotent).toBe(true);
    expect(f.steps[2]!.idempotent).toBeFalsy();
    const review = Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]));
    expect(review['You pay']).toBe('500 USDG');
    expect(review['Minimum you get']).toBe('1.28355 TSLA');
    expect(review.Route).toBe('Uniswap v3, 0.30% pool');
    expect(review['Visible onchain']).toMatch(/public Uniswap trade/);
    expect(f.ack).toMatch(/real trade with real tokens/);
    expect(f.d.chainId).toBe(4663);
    expect(f.d.tokens.TSLA).toBe(tslaV3.stock);
    expect(uniTarget().proto.decimals).toMatchObject({ USDG: 6, TSLA: 18 });
  });
  it('two legs (stock to stock): sell for USDG, approve exactly that USDG, then buy with the overall minimum', () => {
    const f = uniTradeFlow({ ...base, from: 'META', to: 'TSLA', amountIn: 10n ** 18n, first: hopFor(metaV4, 'sell'), firstMin: 600_000_000n, second: hopFor(tslaV3, 'buy'), title: 'Swap META for TSLA', toast: 'Swapped' });
    expect(f.steps.map((s) => s.label)).toEqual(['META approval', 'Router allowance', 'Swap 1', 'USDG approval', 'Router allowance', 'Swap 2']);
    expect(String(f.note)).toMatch(/keep the USDG/);
  });
  it('a swap receipt must show exactly the input paid and at least the minimum received', async () => {
    const f = uniTradeFlow({ ...base, from: 'USDG', to: 'TSLA', first: hopFor(tslaV3, 'buy'), firstMin: base.minOut });
    const swap = f.steps[2]!;
    const ctx = { d: f.d, proto: f.proto, account: ME, out: {} as Record<string, unknown>, txs: [] };
    // Build the plan (the call reads the chain time: stub it).
    const chain = await import('@/lib/chain');
    const spy = vi.spyOn(chain.publicClient, 'getBlock').mockResolvedValue({ timestamp: 1_800_000_000n } as never);
    const call = await swap.call(ctx);
    spy.mockRestore();
    expect(call?.functionName).toBe('execute');
    expect((call?.args[2] as bigint) - 1_800_000_000n).toBe(1200n);
    const pad = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex;
    const transfer = (token: string, from: string, to: string, value: bigint) => ({
      address: token,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(to)] as [Hex, Hex, Hex],
      data: ('0x' + value.toString(16).padStart(64, '0')) as Hex,
    });
    const r = (logs: unknown[]) => ({ logs }) as never;
    expect(() => swap.after!(r([transfer(cfg.usdg.address, ME, tslaV3.address, base.amountIn), transfer(tslaV3.stock, tslaV3.address, ME, base.minOut)]), ctx)).not.toThrow();
    expect(ctx.out.received).toBe(base.minOut);
    expect(() => swap.after!(r([transfer(cfg.usdg.address, ME, tslaV3.address, base.amountIn), transfer(tslaV3.stock, tslaV3.address, ME, base.minOut - 1n)]), ctx)).toThrow();
    expect(() => swap.after!(r([transfer(cfg.usdg.address, ME, tslaV3.address, base.amountIn - 1n), transfer(tslaV3.stock, tslaV3.address, ME, base.minOut)]), ctx)).toThrow();
    // A Transfer event from another contract never counts.
    expect(() => swap.after!(r([transfer(cfg.usdg.address, ME, tslaV3.address, base.amountIn), transfer('0x2222222222222222222222222222222222222222', tslaV3.address, ME, base.minOut)]), ctx)).toThrow();
  });
});

describe('Uniswap errors read as one sentence', () => {
  const ctx = { sym: () => null, dec: () => null };
  const revert = (data: Hex) => Object.assign(new Error('reverted'), { data });
  it('slippage, deadline and Permit2 errors', async () => {
    const { BaseError } = await import('viem');
    const wrap = (data: Hex) => new BaseError('execution reverted', { cause: revert(data) as Error });
    const tooLittle = encodeErrorResult({ abi: UNI_ERRORS_ABI, errorName: 'V3TooLittleReceived' });
    expect(decodeTxError(wrap(tooLittle), ctx, cfg.usdg.address).message).toMatch(/slippage limit/);
    const v4 = encodeErrorResult({ abi: UNI_ERRORS_ABI, errorName: 'V4TooLittleReceived', args: [10n, 9n] });
    expect(decodeTxError(wrap(v4), ctx, cfg.usdg.address).message).toMatch(/slippage limit/);
    const wrapped = encodeErrorResult({ abi: UNI_ERRORS_ABI, errorName: 'ExecutionFailed', args: [0n, tooLittle] });
    expect(decodeTxError(wrap(wrapped), ctx, cfg.usdg.address).message).toMatch(/slippage limit/);
    const deadline = encodeErrorResult({ abi: UNI_ERRORS_ABI, errorName: 'TransactionDeadlinePassed' });
    expect(decodeTxError(wrap(deadline), ctx, cfg.usdg.address).message).toMatch(/deadline passed/);
    const expired = encodeErrorResult({ abi: UNI_ERRORS_ABI, errorName: 'AllowanceExpired', args: [1n] });
    expect(decodeTxError(wrap(expired), ctx, cfg.usdg.address).message).toMatch(/Permit2 allowance/);
  });
});

describe('price source wording', () => {
  it('names Uniswap as a real, 24/7 source', () => {
    expect(REAL_SOURCES).toContain('uniswap');
    expect(priceSourceText('uniswap', true)).toMatch(/Uniswap on Robinhood Chain, 24\/7/);
    const m = { noData: false, priceSource: 'uniswap', closed: false } as never;
    expect(priceOrigin({ bySym: { TSLA: m }, source: 'api' }, true)).toBe('uniswap');
    expect(UNI.banner).toMatch(/Perps are real leveraged trades from your own account\. Private accounts are in development\./);
  });
});

describe('perps reference (Lighter) in the web', () => {
  it('reads only known venues from the API and words the reference', async () => {
    const { apiPerpVenue, PERP_VENUES } = await import('@/lib/markets');
    const { refTitle } = await import('@/lib/copy');
    expect(apiPerpVenue({ venue: 'lighter', market: 112 })).toBe('lighter');
    expect(apiPerpVenue({ venue: 'binance' })).toBeNull();
    expect(apiPerpVenue({ venue: '__proto__' })).toBeNull();
    expect(apiPerpVenue(null)).toBeNull();
    expect(PERP_VENUES.lighter).toBe('Lighter');
    expect(refTitle('Lighter', 'TSLA')).toMatch(/TSLA perp on Lighter.*until Velum's own perps are live/);
  });
});
