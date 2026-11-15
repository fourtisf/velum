import { MARKETS, PRICE_FEEDS, PROTOCOL, type Address } from '@velum/config';
import { fromUnits, roundTo, toDecimalString } from '@velum/math';
import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { floatToDec, stepPrice, type Rng } from '../lib/demo';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';
import { MAX_PRICE_WAD, robinhoodSource, type PriceReader } from './robinhood';
import { uniswapClient, uniswapSource } from './uniswap';
import { UNISWAP } from '@velum/config/src/uniswap';
import type { PriceSource } from '@velum/config';

export { redactUrls };
// The Robinhood source lives in its own module (no database code in its imports), so the signer process can use it
// (on-chain audit M-2); re-exported here for the workers and the tests.
export * from './robinhood';
export * from './uniswap';

/** Random walk from the last price (or seed) for every market, 2-decimal prices. */
export function demoSource(rng: Rng = Math.random): PriceReader {
  const walk = new Map<string, number>();
  return {
    name: 'demo',
    async read(last) {
      const out = new Map<string, string>();
      for (const m of MARKETS) {
        const seed = Number(m.seedPrice);
        const from = walk.get(m.symbol) ?? Number(last.get(m.symbol) ?? m.seedPrice);
        const next = stepPrice(from, m.vol, seed, rng);
        walk.set(m.symbol, next);
        out.set(m.symbol, floatToDec(next, 2));
      }
      return out;
    },
  };
}

const AGGREGATOR_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** A feed round dated further ahead than this many seconds is rejected (clock skew allowance). */
export const FEED_MAX_FUTURE_S = 30;
/** Feeds reporting more decimals than this are rejected (real feeds use 8 or 18). */
export const FEED_MAX_DECIMALS = 36;

export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export type FeedVerdict =
  | { ok: true; price: string }
  | { ok: false; reason: 'decimals' | 'no-timestamp' | 'future' | 'stale' | 'answer' | 'incomplete-round' | 'bounds'; age?: number };

/**
 * Validates one latestRoundData() answer (audit L14): sane decimals, a timestamp that is set,
 * not in the future and not older than PROTOCOL.oracleMaxAgeSeconds, a positive answer from a
 * complete round, and a price inside (0, 1e9) USDG after rounding to 4 decimals.
 */
export function checkFeedRound(round: FeedRound, decimals: number, now: number): FeedVerdict {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > FEED_MAX_DECIMALS) return { ok: false, reason: 'decimals' };
  if (round.updatedAt <= 0n) return { ok: false, reason: 'no-timestamp' };
  const nowS = BigInt(Math.floor(now / 1000));
  if (round.updatedAt > nowS + BigInt(FEED_MAX_FUTURE_S)) return { ok: false, reason: 'future', age: Number(nowS - round.updatedAt) };
  const age = Number(nowS - round.updatedAt);
  if (age > PROTOCOL.oracleMaxAgeSeconds) return { ok: false, reason: 'stale', age };
  if (round.answer <= 0n) return { ok: false, reason: 'answer' };
  if (round.answeredInRound < round.roundId) return { ok: false, reason: 'incomplete-round' };
  const price = roundTo(fromUnits(round.answer, decimals), 4, 'floor');
  if (price <= 0n || price >= MAX_PRICE_WAD) return { ok: false, reason: 'bounds' };
  return { ok: true, price: toDecimalString(price) };
}

/** The one viem call the Chainlink source needs (injectable for tests). */
export type FeedClient = Pick<PublicClient, 'readContract'>;

/**
 * Chainlink AggregatorV3 feeds from PRICE_FEEDS. A market is skipped (keeps its last price and
 * goes stale in the API) when it has no feed, the read fails, or checkFeedRound rejects the round.
 * Stock feeds stop updating when the stock market is closed, so stale outside trading hours is expected.
 * TODO(phase 3): check the L2 sequencer uptime feed once its address is verified.
 */
export function chainlinkSource(rpcUrl: string, feeds: Record<string, Address>, log: Logger, client?: FeedClient, chainOk: () => boolean = () => true): PriceReader {
  const rpc: FeedClient = client ?? (createPublicClient({ transport: http(rpcUrl, { timeout: 5000, retryCount: 1 }) }) as PublicClient);
  const decimals = new Map<string, number>();
  const quoteTimes = new Map<string, number>();
  return {
    name: 'chainlink',
    quoteTimes,
    async read(_last, now) {
      const out = new Map<string, string>();
      // RPC_URL serving another chain (audit I-5): read nothing, every market goes stale.
      if (!chainOk()) return out;
      await Promise.all(
        Object.entries(feeds).map(async ([symbol, address]) => {
          try {
            let d = decimals.get(symbol);
            if (d === undefined) {
              d = Number(await rpc.readContract({ address, abi: AGGREGATOR_ABI, functionName: 'decimals' }));
              decimals.set(symbol, d);
            }
            const [roundId, answer, , updatedAt, answeredInRound] = (await rpc.readContract({ address, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' })) as readonly [bigint, bigint, bigint, bigint, bigint];
            const v = checkFeedRound({ roundId, answer, updatedAt, answeredInRound }, d, now);
            if (v.ok) {
              out.set(symbol, v.price);
              quoteTimes.set(symbol, Number(updatedAt) * 1000);
            } else if (v.reason === 'stale') log.debug('feed stale', { symbol, age: v.age });
            else log.warn('feed round rejected', { symbol, reason: v.reason, ...(v.age !== undefined ? { age: v.age } : {}) });
          } catch (err) {
            log.warn('feed read failed', { symbol, err: redactUrls(err instanceof Error ? err.message : String(err)) });
          }
        }),
      );
      return out;
    },
  };
}

export function pickSource(kind: PriceSource, rpcUrl: string, log: Logger, chainOk?: () => boolean): PriceReader {
  if (kind === 'robinhood') return robinhoodSource(log);
  if (kind === 'uniswap') {
    if (!UNISWAP) throw new Error('PRICE_SOURCE=uniswap but this network has no curated Uniswap pools (mainnet only).');
    return uniswapSource(uniswapClient(rpcUrl), UNISWAP, log, chainOk);
  }
  if (kind === 'chainlink') {
    if (Object.keys(PRICE_FEEDS).length === 0) {
      // Fail loudly rather than run simulated prices under a "real" label.
      throw new Error('PRICE_SOURCE=chainlink but packages/config has no verified price feeds. Use PRICE_SOURCE=robinhood or demo.');
    }
    return chainlinkSource(rpcUrl, PRICE_FEEDS, log, undefined, chainOk);
  }
  return demoSource();
}
