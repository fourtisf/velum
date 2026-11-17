/**
 * Mainnet without Velum contracts is real only (WALLET_ONLY): the live ETH price (read from the WETH/USDG pool) and its
 * freshness, dollar values of a wallet (USDG, Stock Tokens, ETH), and the wallet's activity read from the chain (token
 * transfers grouped into buys, sells, swaps, sends and receives; a buy paid with ETH recognised from the transaction).
 * The chain is mocked here; the real RPC limits these reads respect are noted in lib/walletActivity.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
  delete process.env.NEXT_PUBLIC_VELUM_DEPLOYMENT;
});

const h = vi.hoisted(() => ({
  head: 116_000_000n,
  sqrt: 0n,
  logs: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ address: string; topics: Array<string | null>; fromBlock: string; toBlock: string }>,
  txs: {} as Record<string, { value: bigint; to: string; from: string }>,
}));

vi.mock('@/lib/chain', () => ({
  publicClient: {
    getBlockNumber: async () => h.head,
    readContract: async () => [h.sqrt, 0, 0, 0, 0, 0, true],
    request: async ({ params }: { params: [{ address: string; topics: Array<string | null>; fromBlock: string; toBlock: string }] }) => {
      const q = params[0];
      h.queries.push(q);
      return h.logs.filter((l) => {
        const t = l.topics as string[];
        return String(l.address).toLowerCase() === q.address && (q.topics[1] === null || q.topics[1] === undefined || t[1] === q.topics[1]) && (q.topics[2] === undefined || q.topics[2] === null || t[2] === q.topics[2]);
      });
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber }),
    getTransaction: async ({ hash }: { hash: string }) => h.txs[hash] ?? { value: 0n, to: '0x0000000000000000000000000000000000000001', from: '0x0' },
  },
}));

import { TOKENS } from '@velum/config';
import { UNISWAP } from '@velum/config/src/uniswap';
import { pad, type Address, type Hex } from 'viem';
import { tokPx, useMarkets } from '@/lib/markets';
import { WALLET_ONLY } from '@/lib/onchain/deployment';
import { readEthPrice } from '@/lib/uniswap/ethPrice';
import { ACTIVITY_BLOCKS, ACTIVITY_TOKENS, groupMoves, readWalletActivity } from '@/lib/walletActivity';
import { WETH_TOKEN } from '@/lib/balances';
import { LOGOS } from '@/lib/logos';
import { walletValue } from '@/lib/walletValue';
import { W, setLiveMarkets } from './helpers';

const ME = '0x1111111111111111111111111111111111111111' as Address;
const POOL = '0x2222222222222222222222222222222222222222' as Address;
const FRIEND = '0x3333333333333333333333333333333333333333' as Address;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const tok = (sym: string) => TOKENS[sym]!.address.toLowerCase();
let n = 0;
const log = (sym: string, from: Address, to: Address, units: bigint, tx: string, block: bigint) => ({
  address: tok(sym),
  topics: [TRANSFER, pad(from), pad(to)] as Hex[],
  data: `0x${units.toString(16).padStart(64, '0')}` as Hex,
  blockNumber: `0x${block.toString(16)}` as Hex,
  transactionHash: tx as Hex,
  logIndex: `0x${(n++).toString(16)}` as Hex,
});
const hash = (c: string) => `0x${c.repeat(64)}`;

/** Integer square root (Newton), for building a pool price. */
function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = v;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + v / x) / 2n;
  }
  return x;
}

beforeEach(() => {
  useMarkets.setState({ ethPx: null });
  h.logs = [];
  h.queries = [];
  h.txs = {};
});

describe('mainnet without Velum contracts', () => {
  it('is wallet-only: no private-account signature, no demo ledger', () => {
    expect(WALLET_ONLY).toBe(true);
  });
});

describe('ETH price', () => {
  it('reads USDG per ETH from the WETH/USDG pool (WETH 18 decimals, USDG 6)', async () => {
    const cfg = UNISWAP!;
    const wethIs0 = cfg.contracts.weth.toLowerCase() < cfg.usdg.address.toLowerCase();
    // 3,000 USDG per ETH: raw price token1/token0 in base units, as sqrt(price) * 2^96.
    const raw = wethIs0 ? { num: 3000n * 10n ** 6n, den: 10n ** 18n } : { num: 10n ** 18n, den: 3000n * 10n ** 6n };
    h.sqrt = isqrt((raw.num << 192n) / raw.den);
    const px = await readEthPrice();
    expect(px).not.toBeNull();
    const err = px! > W('3000') ? px! - W('3000') : W('3000') - px!;
    expect(err < W('0.000001')).toBe(true);
  });

  it('values ETH only while the price is fresh (three minutes), never from a demo price', () => {
    const now = 1_800_000_000_000;
    expect(tokPx('ETH', now)).toBeNull();
    useMarkets.setState({ ethPx: { px: W('3000'), at: now - 60_000 } });
    expect(tokPx('ETH', now)).toBe(W('3000'));
    useMarkets.setState({ ethPx: { px: W('3000'), at: now - 181_000 } });
    expect(tokPx('ETH', now)).toBeNull();
  });
});

describe('wallet value', () => {
  it('adds USDG, Stock Tokens and ETH at live prices', () => {
    setLiveMarkets({ TSLA: '400', NVDA: '200' });
    useMarkets.setState({ ethPx: { px: W('3000'), at: Date.now() } });
    const v = walletValue({ USDG: W('100'), TSLA: W('0.5'), NVDA: W('2'), ETH: W('0.01') });
    expect(v.held).toEqual(['TSLA', 'NVDA']);
    expect(v.stocks).toBe(W('600'));
    expect(v.eth).toBe(W('30'));
    expect(v.total).toBe(W('730'));
  });

  it('counts WETH on Robinhood Chain at the ETH price, with the ETH', () => {
    expect(WETH_TOKEN).toEqual({ symbol: 'WETH', address: UNISWAP!.contracts.weth, decimals: 18 });
    setLiveMarkets({ TSLA: '400' });
    useMarkets.setState({ ethPx: { px: W('2000'), at: Date.now() } });
    expect(tokPx('WETH')).toBe(W('2000'));
    const v = walletValue({ USDG: 0n, ETH: W('0.1'), WETH: W('0.05') });
    expect(v.eth).toBe(W('300'));
    expect(v.total).toBe(W('300'));
  });

  it('shows no total (a dash) while ETH has no price, or a balance could not be read', () => {
    setLiveMarkets({ TSLA: '400' });
    const b = { USDG: W('100'), TSLA: W('1'), ETH: W('0.01') };
    expect(walletValue(b).total).toBeNull();
    // An empty ETH balance needs no price.
    expect(walletValue({ ...b, ETH: 0n }).total).toBe(W('500'));
    useMarkets.setState({ ethPx: { px: W('3000'), at: Date.now() } });
    expect(walletValue(b, ['NVDA']).total).toBeNull();
    expect(walletValue(undefined).total).toBeNull();
  });
});

describe('wallet activity', () => {
  it('groups transfers per transaction: bought, sold, swapped, sent; arrivals left to the transaction', () => {
    const logs = [
      log('USDG', ME, POOL, 25_000000n, hash('a'), 10n),
      log('NVDA', POOL, ME, W('0.125'), hash('a'), 10n),
      log('TSLA', ME, POOL, W('1'), hash('b'), 20n),
      log('USDG', POOL, ME, 400_000000n, hash('b'), 20n),
      log('TSLA', ME, POOL, W('1'), hash('c'), 30n),
      log('NVDA', POOL, ME, W('2'), hash('c'), 30n),
      log('AMD', ME, FRIEND, W('3'), hash('d'), 40n),
      log('META', POOL, ME, W('0.5'), hash('e'), 50n),
      // A self-transfer moves nothing.
      log('USDG', ME, ME, 1_000000n, hash('f'), 60n),
    ];
    const g = groupMoves(ME, [...logs, logs[0]!], TOKENS);
    expect(g.map((x) => [x.hash[2], x.kind])).toEqual([
      ['e', null],
      ['d', 'send'],
      ['c', 'swap'],
      ['b', 'sell'],
      ['a', 'buy'],
    ]);
    const buy = g.find((x) => x.hash === hash('a'))!;
    // The duplicated log is counted once.
    expect(buy.out).toEqual([{ sym: 'USDG', units: 25_000000n, decimals: 6 }]);
    expect(buy.in).toEqual([{ sym: 'NVDA', units: W('0.125'), decimals: 18 }]);
    expect(g.find((x) => x.hash === hash('d'))!.counterparty).toBe(FRIEND.toLowerCase());
  });

  it('reads every token both ways over the last 9.9M blocks, and recognises a buy paid with ETH', async () => {
    const router = UNISWAP!.contracts.universalRouter;
    h.logs = [log('NVDA', POOL, ME, W('0.05'), hash('1'), h.head - 5n), log('TSLA', FRIEND, ME, W('1'), hash('2'), h.head - 9n)];
    h.txs[hash('1')] = { value: 10n ** 16n, to: router, from: ME };
    h.txs[hash('2')] = { value: 0n, to: tok('TSLA'), from: FRIEND };
    const acts = await readWalletActivity(ME);
    // USDG, every Stock Token and WETH, each both ways.
    expect(Object.keys(ACTIVITY_TOKENS)).toEqual([...Object.keys(TOKENS), 'WETH']);
    expect(h.queries).toHaveLength(Object.keys(ACTIVITY_TOKENS).length * 2);
    for (const q of h.queries) {
      expect(BigInt(q.toBlock) - BigInt(q.fromBlock)).toBe(ACTIVITY_BLOCKS);
      expect(BigInt(q.toBlock) - BigInt(q.fromBlock) <= 10_000_000n).toBe(true);
    }
    for (const sym of Object.keys(TOKENS)) {
      expect(h.queries.filter((q) => q.address === tok(sym))).toHaveLength(2);
    }
    expect(h.queries.filter((q) => q.address === UNISWAP!.contracts.weth.toLowerCase())).toHaveLength(2);
    expect(acts.map((a) => [a.hash[2], a.kind, a.ethPaid])).toEqual([
      ['1', 'buy', 10n ** 16n],
      ['2', 'receive', 0n],
    ]);
    expect(acts[0]!.time).toBe(Number(h.head - 5n) * 1000);
    expect(acts[1]!.counterparty).toBe(FRIEND.toLowerCase());
  });
});

describe('logos', () => {
  it('ETH, WETH and USDG have their own logo, like the Stock Tokens', () => {
    expect(LOGOS.ETH?.path).toMatch(/^M11\.944 17\.97/);
    expect(LOGOS.WETH?.path).toBe(LOGOS.ETH?.path);
    expect(LOGOS.USDG?.text).toBe('$');
    for (const sym of Object.keys(TOKENS)) expect(LOGOS[sym], sym).toBeDefined();
  });
});
