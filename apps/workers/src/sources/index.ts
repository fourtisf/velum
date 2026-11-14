import { MAINNET_CHAIN_ID, MAINNET_TOKEN_ADDRESSES, MARKETS, PRICE_FEEDS, PROTOCOL, ROBINHOOD_PRICES_URL, type Address, type PriceSource } from '@velum/config';
import { fromUnits, parseWad, roundTo, toDecimalString } from '@velum/math';
import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { floatToDec, stepPrice, type Rng } from '../lib/demo';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';

export { redactUrls };

/** Fresh prices (decimal strings) for the symbols a source could read this tick. */
export interface PriceReader {
  readonly name: PriceSource;
  read(last: ReadonlyMap<string, string>, now: number): Promise<Map<string, string>>;
}

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

/** Prices at or above this (1e9 USDG, as a wad) are rejected outright, for every source. */
export const MAX_PRICE_WAD = 10n ** 27n;
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
export function chainlinkSource(rpcUrl: string, feeds: Record<string, Address>, log: Logger, client?: FeedClient): PriceReader {
  const rpc: FeedClient = client ?? (createPublicClient({ transport: http(rpcUrl, { timeout: 5000, retryCount: 1 }) }) as PublicClient);
  const decimals = new Map<string, number>();
  return {
    name: 'chainlink',
    async read(_last, now) {
      const out = new Map<string, string>();
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
            if (v.ok) out.set(symbol, v.price);
            else if (v.reason === 'stale') log.debug('feed stale', { symbol, age: v.age });
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

interface RhQuote {
  tokenSymbol?: string;
  deployments?: Array<{ contractAddress?: string; chainId?: number }>;
  tokenBid?: string;
  tokenAsk?: string;
  isTradingHalt?: boolean;
  generatedAt?: string;
}

/** Quotes older than the API's freshness window are ignored (the market keeps its last price and goes stale). */
export const RH_MAX_QUOTE_AGE_MS = PROTOCOL.oracleMaxAgeSeconds * 1000;
/** A quote dated further ahead than this is rejected. */
export const RH_MAX_FUTURE_MS = 30_000;
/** Widest bid/ask spread accepted, as a share of the midpoint (overnight spreads reach ~8%). */
export const RH_MAX_SPREAD_BPS = 2000n;
/** Prices outside (0, 1e9) USDG are rejected outright. */
export const RH_MAX_PRICE = MAX_PRICE_WAD;
/** A move larger than this against the last accepted price needs confirming ticks. */
export const RH_JUMP_BPS = 2500n;
export const RH_JUMP_CONFIRMATIONS = 3;
const STRICT_DECIMAL = /^\d{1,12}(\.\d{1,18})?$/;

/**
 * Midpoint of a Robinhood quote as a decimal string, or null when unusable. tokenBid/tokenAsk are
 * multiplier-adjusted token prices (corporate actions included). The quote must name the exact
 * mainnet token address for the symbol, because tickers are not unique on-chain.
 */
export function rhMid(symbol: string, q: RhQuote | undefined, now: number): string | null {
  if (!q || q.tokenSymbol !== symbol || q.isTradingHalt) return null;
  const want = MAINNET_TOKEN_ADDRESSES[symbol];
  const match = q.deployments?.some((d) => d.chainId === MAINNET_CHAIN_ID && d.contractAddress?.toLowerCase() === want);
  if (!want || !match) return null;
  const at = q.generatedAt ? Date.parse(q.generatedAt) : NaN;
  if (!Number.isFinite(at) || now - at > RH_MAX_QUOTE_AGE_MS || at - now > RH_MAX_FUTURE_MS) return null;
  if (!q.tokenBid || !q.tokenAsk || !STRICT_DECIMAL.test(q.tokenBid) || !STRICT_DECIMAL.test(q.tokenAsk)) return null;
  const bid = parseWad(q.tokenBid);
  const ask = parseWad(q.tokenAsk);
  if (bid === null || ask === null || bid <= 0n || ask < bid || ask >= RH_MAX_PRICE) return null;
  const mid = (bid + ask) / 2n;
  if (((ask - bid) * 10_000n) / mid > RH_MAX_SPREAD_BPS) return null;
  return toDecimalString(roundTo(mid, 4, 'floor'));
}

/**
 * Guards against a single glitched quote: a move of more than RH_JUMP_BPS from the last accepted
 * price is held back until RH_JUMP_CONFIRMATIONS consecutive quotes agree (within 1%).
 */
export function jumpGuard() {
  const pending = new Map<string, { price: bigint; count: number }>();
  return (symbol: string, next: string, last: string | undefined): boolean => {
    const n = parseWad(next);
    const l = last ? parseWad(last) : null;
    if (n === null) return false;
    if (l === null || l <= 0n || ((n > l ? n - l : l - n) * 10_000n) / l <= RH_JUMP_BPS) {
      pending.delete(symbol);
      return true;
    }
    const p = pending.get(symbol);
    const same = p && ((n > p.price ? n - p.price : p.price - n) * 10_000n) / p.price <= 100n;
    const count = same ? p.count + 1 : 1;
    if (count >= RH_JUMP_CONFIRMATIONS) {
      pending.delete(symbol);
      return true;
    }
    pending.set(symbol, { price: n, count });
    return false;
  };
}

/** Official Robinhood Stock Token quotes, one request per symbol (60 req/s limit; 10 per tick). */
export function robinhoodSource(log: Logger, fetchImpl: typeof fetch = fetch): PriceReader {
  const accept = jumpGuard();
  return {
    name: 'robinhood',
    async read(last, now) {
      const out = new Map<string, string>();
      await Promise.all(
        MARKETS.map(async (m) => {
          try {
            const res = await fetchImpl(`${ROBINHOOD_PRICES_URL}/${encodeURIComponent(m.symbol)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            if (!res.ok) return log.warn('robinhood quote failed', { symbol: m.symbol, status: res.status });
            const body = (await res.json()) as { quotes?: RhQuote[] };
            const mid = rhMid(m.symbol, body.quotes?.[0], now);
            if (!mid) return log.debug('robinhood quote unusable', { symbol: m.symbol });
            if (accept(m.symbol, mid, last.get(m.symbol))) out.set(m.symbol, mid);
            else log.warn('robinhood quote held: large jump awaiting confirmation', { symbol: m.symbol, price: mid, last: last.get(m.symbol) });
          } catch (err) {
            log.warn('robinhood quote error', { symbol: m.symbol, err: redactUrls(err instanceof Error ? err.message : String(err)) });
          }
        }),
      );
      return out;
    },
  };
}

export function pickSource(kind: PriceSource, rpcUrl: string, log: Logger): PriceReader {
  if (kind === 'robinhood') return robinhoodSource(log);
  if (kind === 'chainlink') {
    if (Object.keys(PRICE_FEEDS).length === 0) {
      // Fail loudly rather than run simulated prices under a "real" label.
      throw new Error('PRICE_SOURCE=chainlink but packages/config has no verified price feeds. Use PRICE_SOURCE=robinhood or demo.');
    }
    return chainlinkSource(rpcUrl, PRICE_FEEDS, log);
  }
  return demoSource();
}
