/**
 * Official Robinhood Stock Token quotes (api.robinhood.com/rhj/prices and /rhj/assets) with every guard price-relay
 * applies. Its own module, free of database code, so both the workers (price-relay) and the signer process (the price
 * relayer's own quotes, on-chain audit M-2) use exactly this code.
 */
import { MAINNET_CHAIN_ID, MAINNET_TOKEN_ADDRESSES, MARKETS, PROTOCOL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL, type PriceSource } from '@velum/config';
import { parseWad, roundTo, toDecimalString, wmul } from '@velum/math';
import type { Logger } from '../lib/log';
import { redactUrls } from '../lib/redact';

/** Fresh prices (decimal strings) for the symbols a source could read this tick. */
export interface PriceReader {
  readonly name: PriceSource;
  read(last: ReadonlyMap<string, string>, now: number): Promise<Map<string, string>>;
  /**
   * Quote time (Unix ms) per symbol of the last read, for sources that report one (a Chainlink round's
   * updatedAt). Without it price-relay dates a quote by when its price last changed (audit M-1).
   */
  readonly quoteTimes?: ReadonlyMap<string, number>;
}

/** Prices at or above this (1e9 USDG, as a wad) are rejected outright, for every source. */
export const MAX_PRICE_WAD = 10n ** 27n;

export interface RhQuote {
  tokenSymbol?: string;
  deployments?: Array<{ contractAddress?: string; chainId?: number }>;
  /** Documented: the raw underlying-equity bid/ask, not multiplier-adjusted. */
  bid?: string;
  ask?: string;
  /** Undocumented: bid/ask x currentMultiplier (the token's price, corporate actions included). */
  tokenBid?: string;
  tokenAsk?: string;
  isTradingHalt?: boolean;
  /** Server time of the response (it advances while the quote itself stays frozen; audit M-1). */
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

/** Largest corporate-action multiplier accepted from /rhj/assets (splits reach a few x; 1000 is far above). */
export const RH_MAX_MULTIPLIER = 1000n * 10n ** 18n;

/**
 * The token's bid/ask as wads, or null. tokenBid/tokenAsk (undocumented, already multiplier-adjusted)
 * are used when present; otherwise the documented bid/ask times `multiplier` (currentMultiplier from
 * /rhj/assets; docs.robinhood.com/chain/stock-token-apis: /prices returns the raw underlying-equity
 * bid/ask, apply currentMultiplier from /assets for the token-equivalent value). Checked 2026-11-15:
 * AAPL bid 354.45 x currentMultiplier 1.0010906... = tokenBid 354.8365...
 * Without tokenBid and without a multiplier the quote is unusable (a multiplier of 1 is never assumed).
 */
export function rhTokenBidAsk(q: RhQuote, multiplier: string | null | undefined): [bigint, bigint] | null {
  const strict = (v: string | null | undefined): bigint | null => (v && STRICT_DECIMAL.test(v) ? parseWad(v) : null);
  if (q.tokenBid !== undefined || q.tokenAsk !== undefined) {
    const bid = strict(q.tokenBid);
    const ask = strict(q.tokenAsk);
    return bid === null || ask === null ? null : [bid, ask];
  }
  const m = strict(multiplier);
  const bid = strict(q.bid);
  const ask = strict(q.ask);
  if (m === null || m <= 0n || m > RH_MAX_MULTIPLIER || bid === null || ask === null) return null;
  return [wmul(bid, m, 'floor'), wmul(ask, m, 'ceil')];
}

/**
 * Midpoint of a Robinhood quote as a decimal string, or null when unusable. The token's bid/ask come
 * from rhTokenBidAsk (multiplier-adjusted). The quote must name the exact mainnet token address for the
 * symbol, because tickers are not unique on-chain. A midpoint that rounds to 0 at 4 decimals is
 * rejected (audit I-1).
 */
export function rhMid(symbol: string, q: RhQuote | undefined, now: number, multiplier?: string | null): string | null {
  if (!q || q.tokenSymbol !== symbol || q.isTradingHalt) return null;
  const want = MAINNET_TOKEN_ADDRESSES[symbol];
  const match = q.deployments?.some((d) => d.chainId === MAINNET_CHAIN_ID && d.contractAddress?.toLowerCase() === want);
  if (!want || !match) return null;
  const at = q.generatedAt ? Date.parse(q.generatedAt) : NaN;
  if (!Number.isFinite(at) || now - at > RH_MAX_QUOTE_AGE_MS || at - now > RH_MAX_FUTURE_MS) return null;
  const pair = rhTokenBidAsk(q, multiplier);
  if (!pair) return null;
  const [bid, ask] = pair;
  if (bid <= 0n || ask < bid || ask >= RH_MAX_PRICE) return null;
  const mid = (bid + ask) / 2n;
  if (((ask - bid) * 10_000n) / mid > RH_MAX_SPREAD_BPS) return null;
  const rounded = roundTo(mid, 4, 'floor');
  return rounded > 0n ? toDecimalString(rounded) : null;
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
    if (n === null || n <= 0n) return false;
    if (l === null || l <= 0n || ((n > l ? n - l : l - n) * 10_000n) / l <= RH_JUMP_BPS) {
      pending.delete(symbol);
      return true;
    }
    const p = pending.get(symbol);
    const same = p && p.price > 0n && ((n > p.price ? n - p.price : p.price - n) * 10_000n) / p.price <= 100n;
    const count = same ? p.count + 1 : 1;
    if (count >= RH_JUMP_CONFIRMATIONS) {
      pending.delete(symbol);
      return true;
    }
    pending.set(symbol, { price: n, count });
    return false;
  };
}

/** How often the corporate-action multipliers are re-read from /rhj/assets while a quote needs them. */
export const RH_ASSETS_REFRESH_MS = 10 * 60_000;
/** After a failed /rhj/assets read, wait this long before trying again. */
export const RH_ASSETS_RETRY_MS = 60_000;
/**
 * A multiplier table older than this is never used (audit F-5): while /rhj/assets keeps failing, a
 * corporate action (a split) would otherwise be priced with the old multiplier indefinitely. The quote
 * is then unusable and the market goes stale until the table is read again.
 */
export const RH_MULTIPLIER_MAX_AGE_MS = 24 * 3_600_000;

interface RhAsset {
  tokenSymbol?: string;
  deployments?: Array<{ contractAddress?: string; chainId?: number }>;
  currentMultiplier?: string;
  /**
   * Checked 2026-11-15 (one read of /rhj/assets): present on every asset, "" on all 203. A non-empty value
   * announces a multiplier change (a corporate action) whose effective time the API does not give.
   */
  pendingMultiplier?: string | null;
}

/** True when an asset announces a multiplier change: anything but "", absent, or the current multiplier. */
function multiplierPending(a: RhAsset): boolean {
  const p = a.pendingMultiplier;
  if (p === undefined || p === null || p === '') return false;
  if (typeof p !== 'string' || !STRICT_DECIMAL.test(p)) return true;
  return parseWad(p) !== parseWad(a.currentMultiplier!);
}

/**
 * currentMultiplier per symbol from /rhj/assets, matched by the exact mainnet token address (CC-05).
 * Read lazily (only when a quote lacks tokenBid/tokenAsk) and cached for RH_ASSETS_REFRESH_MS. Returns
 * null (the quote is unusable) when the table is older than RH_MULTIPLIER_MAX_AGE_MS because reads keep
 * failing, and for an asset with a pending multiplier change (audit F-5): around a corporate action the
 * raw bid/ask may already be on the new basis while currentMultiplier is still the old one, or the other
 * way round, and the API does not say when it switches. tokenBid/tokenAsk, which Robinhood adjusts
 * itself, are used whenever present and do not depend on this table.
 */
export function rhMultipliers(log: Logger, fetchImpl: typeof fetch = fetch, assetsUrl: string = ROBINHOOD_ASSETS_URL) {
  let table = new Map<string, string>();
  let pending = new Set<string>();
  let fetchedAt = -Infinity;
  let failedAt = -Infinity;
  let warnedExpiredAt = -Infinity;
  let inflight: Promise<void> | null = null;
  const load = async (now: number) => {
    try {
      const res = await fetchImpl(assetsUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { assets?: RhAsset[] };
      const next = new Map<string, string>();
      const nextPending = new Set<string>();
      for (const a of body.assets ?? []) {
        const want = a.tokenSymbol ? MAINNET_TOKEN_ADDRESSES[a.tokenSymbol] : undefined;
        if (!want || !a.currentMultiplier || !STRICT_DECIMAL.test(a.currentMultiplier)) continue;
        if (!a.deployments?.some((d) => d.chainId === MAINNET_CHAIN_ID && d.contractAddress?.toLowerCase() === want)) continue;
        next.set(a.tokenSymbol!, a.currentMultiplier);
        if (multiplierPending(a)) nextPending.add(a.tokenSymbol!);
      }
      table = next;
      pending = nextPending;
      fetchedAt = now;
      if (nextPending.size) log.warn('robinhood assets announce a multiplier change; quotes without tokenBid/tokenAsk are skipped for', { symbols: [...nextPending].join(',') });
    } catch (err) {
      failedAt = now;
      log.warn('robinhood assets read failed', { err: redactUrls(err instanceof Error ? err.message : String(err)) });
    }
  };
  return async (symbol: string, now: number): Promise<string | null> => {
    if (now - fetchedAt > RH_ASSETS_REFRESH_MS && now - failedAt > RH_ASSETS_RETRY_MS) {
      inflight ??= load(now).finally(() => (inflight = null));
      await inflight;
    }
    if (now - fetchedAt > RH_MULTIPLIER_MAX_AGE_MS) {
      if (fetchedAt > -Infinity && now - warnedExpiredAt > RH_ASSETS_REFRESH_MS) {
        warnedExpiredAt = now;
        log.warn('robinhood multipliers are over a day old; quotes without tokenBid/tokenAsk are skipped', { ageHours: Math.floor((now - fetchedAt) / 3_600_000) });
      }
      return null;
    }
    if (pending.has(symbol)) return null;
    return table.get(symbol) ?? null;
  };
}

export interface RobinhoodOptions {
  /** Read only these markets (default: every market in packages/config). The signer reads its deployment's markets. */
  symbols?: readonly string[];
  /** Base URLs (default ROBINHOOD_PRICES_URL and ROBINHOOD_ASSETS_URL). Only the anvil end-to-end test overrides them. */
  pricesUrl?: string;
  assetsUrl?: string;
}

/** Official Robinhood Stock Token quotes, one request per symbol (60 req/s limit; 10 per tick). */
export function robinhoodSource(log: Logger, fetchImpl: typeof fetch = fetch, opts: RobinhoodOptions = {}): PriceReader {
  const accept = jumpGuard();
  const multiplier = rhMultipliers(log, fetchImpl, opts.assetsUrl);
  const pricesUrl = opts.pricesUrl ?? ROBINHOOD_PRICES_URL;
  const wanted = opts.symbols ? new Set(opts.symbols) : null;
  const markets = MARKETS.filter((m) => !wanted || wanted.has(m.symbol));
  return {
    name: 'robinhood',
    async read(last, now) {
      const out = new Map<string, string>();
      await Promise.all(
        markets.map(async (m) => {
          try {
            const res = await fetchImpl(`${pricesUrl}/${encodeURIComponent(m.symbol)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            if (!res.ok) return log.warn('robinhood quote failed', { symbol: m.symbol, status: res.status });
            const body = (await res.json()) as { quotes?: RhQuote[] };
            const q = body.quotes?.[0];
            // tokenBid/tokenAsk are undocumented: without them, use bid/ask x currentMultiplier (CC-05).
            const needsMultiplier = !!q && q.tokenBid === undefined && q.tokenAsk === undefined;
            const mid = rhMid(m.symbol, q, now, needsMultiplier ? await multiplier(m.symbol, now) : null);
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
