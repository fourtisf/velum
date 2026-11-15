/**
 * The signer's own price snapshots (on-chain audit M-2). The price relayer used to read the snapshots the workers'
 * price-relay job writes to Redis, so whoever could write Redis or the workers' memory could choose what the relay key
 * signs. The signer now reads Robinhood's public quote API itself, with the same code and guards as price-relay:
 *  - robinhoodSource (sources/index.ts): the exact mainnet token address per symbol, the multiplier rules, the spread
 *    and freshness limits, and the jump guard (a move over 25% needs three agreeing quotes);
 *  - quoteTime / quoteConfirmed (lib/snapshot.ts): a quote keeps its time while it repeats unchanged (a frozen quote
 *    ages and the relayer refuses it after QUOTE_FROZEN_AFTER_MS), and a quote seen without a previous one stays
 *    unconfirmed until it changes;
 *  - the relayer then applies the session calendar, the 6 s freshness limit and the on-chain checks.
 * The last quote per market is kept in the signer's own state directory (0700), so a restart neither makes a frozen
 * quote look new nor loses the jump guard's reference; with no state the jump guard is seeded from the price last
 * relayed on chain. No Redis, no Postgres, nothing the app user can write.
 */
import { MAX_FUTURE_SKEW_MS, isPriceString, type MarketSnapshot } from '@velum/config';
import type { Logger } from '../lib/log';
import { quoteConfirmed, quoteTime } from '../lib/snapshot';
import type { PriceFeed } from '../onchain/relayer';
import { describeError, throttledWarn } from '../onchain/errors';
import type { PriceReader } from '../sources/robinhood';

interface SavedQuote {
  price: string;
  updatedAt: number;
  checkedAt: number;
  unconfirmed?: true;
}

export interface SignerPricesOptions {
  source: PriceReader;
  /** The markets to read (the deployment's). */
  symbols: readonly string[];
  /** Where the last quote per market is kept across restarts (the signer's own state file). */
  state?: { read(): unknown; write(v: unknown): void };
  log: Logger;
  /** The price clock (the relayer's `now`). */
  now?: () => number;
}

const isTime = (v: unknown, now: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= now + MAX_FUTURE_SKEW_MS;

export class SignerPrices implements PriceFeed {
  private readonly snaps = new Map<string, MarketSnapshot>();
  /** Jump-guard references for markets with no quote yet (the price last relayed on chain). */
  private readonly refs = new Map<string, string>();
  private readonly wanted: Set<string>;
  private readonly now: () => number;
  private readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  private polledAt: number | null = null;
  private okAt: number | null = null;

  constructor(private readonly o: SignerPricesOptions) {
    this.wanted = new Set(o.symbols);
    this.now = o.now ?? Date.now;
    this.warn = throttledWarn(o.log, 60_000, Date.now);
    this.restore();
  }

  private restore(): void {
    const raw = this.o.state?.read() as { v?: unknown; markets?: Record<string, Partial<SavedQuote>> } | null | undefined;
    if (!raw || raw.v !== 1 || typeof raw.markets !== 'object' || raw.markets === null) return;
    const now = this.now();
    for (const [symbol, q] of Object.entries(raw.markets)) {
      if (!this.wanted.has(symbol) || !q || !isPriceString(q.price) || !isTime(q.updatedAt, now) || !isTime(q.checkedAt, now) || q.checkedAt < q.updatedAt) continue;
      if (q.unconfirmed !== undefined && q.unconfirmed !== true) continue;
      this.snaps.set(symbol, { symbol, price: q.price, mark: q.price, open24h: q.price, spark: [q.price], source: 'robinhood', updatedAt: q.updatedAt, checkedAt: q.checkedAt, ...(q.unconfirmed ? { unconfirmed: true as const } : {}) });
    }
  }

  private save(): void {
    if (!this.o.state) return;
    const markets: Record<string, SavedQuote> = {};
    for (const [s, x] of this.snaps) markets[s] = { price: x.price, updatedAt: x.updatedAt, checkedAt: x.checkedAt ?? x.updatedAt, ...(x.unconfirmed ? { unconfirmed: true as const } : {}) };
    try {
      this.o.state.write({ v: 1, markets });
    } catch (err) {
      this.warn('signer could not save its last quotes', { err: describeError(err) });
    }
  }

  /** The jump guard's reference for a market that has no quote yet (e.g. the price last relayed on chain). */
  setReference(symbol: string, price: string): void {
    if (this.wanted.has(symbol) && isPriceString(price) && !this.snaps.has(symbol)) this.refs.set(symbol, price);
  }

  /** Markets that have neither a quote nor a reference yet. */
  unseeded(): string[] {
    return [...this.wanted].filter((s) => !this.snaps.has(s) && !this.refs.has(s));
  }

  /** One read of the source; updates the snapshots of the markets it could read. Never throws. */
  async poll(): Promise<void> {
    const now = this.now();
    this.polledAt = Date.now();
    const last = new Map<string, string>();
    for (const s of this.wanted) {
      const p = this.snaps.get(s)?.price ?? this.refs.get(s);
      if (p) last.set(s, p);
    }
    let prices: Map<string, string>;
    try {
      prices = await this.o.source.read(last, now);
    } catch (err) {
      this.warn('signer price read failed', { err: describeError(err) });
      return;
    }
    let changed = false;
    for (const [symbol, price] of prices) {
      if (!this.wanted.has(symbol)) continue;
      const prev = this.snaps.get(symbol);
      const quoteAt = quoteTime(prev, price, this.o.source.name, now);
      const confirmed = quoteConfirmed(prev, price, this.o.source.name);
      const next: MarketSnapshot = {
        symbol,
        price,
        mark: price,
        open24h: price,
        spark: [price],
        source: this.o.source.name,
        updatedAt: Math.min(quoteAt, now),
        checkedAt: now,
        ...(confirmed ? {} : { unconfirmed: true as const }),
      };
      if (!prev || prev.price !== next.price || prev.updatedAt !== next.updatedAt || !!prev.unconfirmed !== !!next.unconfirmed) changed = true;
      this.snaps.set(symbol, next);
      this.refs.delete(symbol);
    }
    if (prices.size) this.okAt = Date.now();
    if (changed) this.save();
  }

  async snapshots(symbols: readonly string[]): Promise<Map<string, MarketSnapshot>> {
    const out = new Map<string, MarketSnapshot>();
    for (const s of symbols) {
      const x = this.snaps.get(s);
      if (x) out.set(s, { ...x, spark: [...x.spark] });
    }
    return out;
  }

  /** Wall-clock ms of the last poll that returned at least one quote. */
  get lastOkAt(): number | null {
    return this.okAt;
  }

  /** For the status: when the source was last read, and each market's quote state (no prices). */
  status(): { lastPollAt: number | null; markets: Record<string, string> } {
    const now = this.now();
    const markets: Record<string, string> = {};
    for (const s of [...this.wanted].sort()) {
      const x = this.snaps.get(s);
      markets[s] = !x ? 'none' : x.unconfirmed ? 'unconfirmed' : now - (x.checkedAt ?? x.updatedAt) > 10_000 ? 'stale' : 'live';
    }
    return { lastPollAt: this.polledAt, markets };
  }
}
