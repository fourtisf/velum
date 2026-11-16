import {
  CANDLE_CACHE_SIZE,
  DEX_PARAMS,
  MAX_FUTURE_SKEW_MS,
  REAL_PRICE_SOURCES,
  TIMEFRAMES,
  TIMEFRAME_MS,
  closedPeriods,
  closedThrough,
  decCmp,
  dexPoolsOf,
  dropClosedRepeats,
  getMarket,
  previousTradingDay,
  repeatsLastStr,
  sessionOf,
  tradingDayCandles,
  tradingDayOf,
  type Candle,
  type DexTimeframe,
  type Timeframe,
} from '@velum/config';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../lib/deps';
import { notFound } from '../lib/errors';
import { createMemo } from '../lib/memo';

interface CandlesRoute {
  Params: { symbol: string };
  Querystring: { tf: Timeframe; limit: number; sessions: boolean; dex: boolean };
}

/** A candle of the session view: on-chain DEX candles of closed periods carry `src: "dex"` (and, on 1D, the period's end). */
export interface SessionCandle extends Candle {
  src?: 'dex';
  end?: number;
}

/** How long a session-view answer is reused per instance (the web refetches every 6 s; the view reads Postgres). */
export const SESSION_CANDLES_TTL_MS = 5_000;
export const SESSION_DAILY_TTL_MS = 30_000;

/**
 * GET /v1/markets/:symbol/candles. The workers' Redis cache first (authenticated and validated: shape,
 * bounds, no future buckets, written for this network); otherwise Postgres, where concurrent requests
 * for the same series share one query (audit I-4). Postgres never returns buckets dated ahead of now
 * (audit L-1). On mainnet only real history is served, from either: a cache built from a simulated
 * source is skipped (audit F-3: an earlier testnet run may have left one in Redis), and Postgres returns
 * only candles tagged with a real source (audit I-7, F-4).
 *
 * `sessions=true` (session view, docs/03): buckets that lie wholly in closed time and only repeat the last price are
 * left out (nothing is deleted), 1D has one candle per trading day (mainnet: built from the hourly candles of each
 * session, so no weekend or holiday candle), and, unless `dex=false`, closed periods carry the display-only on-chain
 * DEX candles of the market's pool (`src: "dex"`) while that pool passes the liquidity threshold.
 */
export function candlesRoutes(deps: AppDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  const memo = createMemo(now);
  const mainnet = deps.env.network === 'mainnet';

  /** Whether the market's DEX pool may be shown now (configured, fresh, above the liquidity threshold). */
  const dexAllowed = async (symbol: string, t: number): Promise<boolean> => {
    if (!dexPoolsOf(deps.env.network)[symbol] || !deps.cache.dexSnapshots || !deps.db.dexCandles) return false;
    const snap = (await deps.cache.dexSnapshots([symbol]).catch(() => new Map())).get(symbol);
    return !!snap && !snap.belowThreshold && t - snap.checkedAt <= DEX_PARAMS.staleAfterMs && t - snap.liquidityAt <= DEX_PARAMS.liquidityStaleAfterMs;
  };

  const intraday = async (symbol: string, tf: Exclude<Timeframe, '1D'>, limit: number, withDex: boolean): Promise<SessionCandle[]> => {
    const t = now();
    const ms = TIMEFRAME_MS[tf];
    // Read more than `limit`: closed time that only repeats the last price is left out below.
    const rows = await deps.db.candles(symbol, tf, Math.min(1000, limit * 3), { until: t + MAX_FUTURE_SKEW_MS, realOnly: mainnet });
    const kept: SessionCandle[] = dropClosedRepeats(rows, ms, repeatsLastStr);
    if (!withDex || !(await dexAllowed(symbol, t))) return kept.slice(-limit);
    const since = kept.length ? kept[Math.max(0, kept.length - limit)]!.t : t - limit * ms;
    const dex = (await deps.db.dexCandles!(symbol, tf as DexTimeframe, since, t + MAX_FUTURE_SKEW_MS)).filter((c) => closedThrough(c.t, c.t + ms));
    const quoteTimes = new Set(kept.map((c) => c.t));
    const merged = [...kept, ...dex.filter((c) => !quoteTimes.has(c.t)).map((c): SessionCandle => ({ ...c, src: 'dex' }))].sort((a, b) => a.t - b.t);
    return merged.slice(-limit);
  };

  const daily = async (symbol: string, limit: number, withDex: boolean): Promise<SessionCandle[]> => {
    const t = now();
    const until = t + MAX_FUTURE_SKEW_MS;
    if (!mainnet || !deps.db.candlesBetween) {
      // Simulated prices (testnet) trade every day: keep the daily series, minus closed days that only repeat.
      const rows = await deps.db.candles(symbol, '1D', limit, { until, realOnly: mainnet });
      return dropClosedRepeats(rows, TIMEFRAME_MS['1D'], repeatsLastStr);
    }
    let day = tradingDayOf(t);
    for (let i = 0; i < limit; i++) day = previousTradingDay(day);
    const since = sessionOf(day).start;
    const hourly = await deps.db.candlesBetween(symbol, '1h', since, until, { realOnly: true });
    const days: SessionCandle[] = tradingDayCandles(hourly).slice(-limit);
    if (!withDex || !(await dexAllowed(symbol, t))) return days;
    const first = days[0]?.t ?? since;
    const dexHours = await deps.db.dexCandles!(symbol, '1h', first, until);
    const periods: SessionCandle[] = [];
    for (const p of closedPeriods(first, t)) {
      const inside = dexHours.filter((c) => c.t >= p.start && c.t + TIMEFRAME_MS['1h'] <= p.end);
      if (!inside.length) continue;
      const k: SessionCandle = { t: p.start, o: inside[0]!.o, h: inside[0]!.h, l: inside[0]!.l, c: inside[inside.length - 1]!.c, src: 'dex', end: p.end };
      for (const c of inside) {
        if (decCmp(c.h, k.h) > 0) k.h = c.h;
        if (decCmp(c.l, k.l) < 0) k.l = c.l;
      }
      periods.push(k);
    }
    return [...days, ...periods].sort((a, b) => a.t - b.t).slice(-limit);
  };

  return async (app) => {
    app.get<CandlesRoute>(
      '/v1/markets/:symbol/candles',
      {
        schema: {
          params: { type: 'object', properties: { symbol: { type: 'string', maxLength: 12 } }, required: ['symbol'] },
          querystring: {
            type: 'object',
            properties: {
              tf: { type: 'string', enum: [...TIMEFRAMES], default: '1h' },
              limit: { type: 'integer', minimum: 1, maximum: CANDLE_CACHE_SIZE, default: 120 },
              sessions: { type: 'boolean', default: false },
              dex: { type: 'boolean', default: true },
            },
          },
        },
      },
      async (req) => {
        const seed = getMarket(req.params.symbol);
        if (!seed) throw notFound(`No market called ${req.params.symbol.toUpperCase()}.`);
        const { tf, limit, sessions, dex } = req.query;
        if (sessions) {
          return memo(`s:${seed.symbol}:${tf}:${limit}:${dex}`, tf === '1D' ? SESSION_DAILY_TTL_MS : SESSION_CANDLES_TTL_MS, () =>
            tf === '1D' ? daily(seed.symbol, limit, dex) : intraday(seed.symbol, tf, limit, dex),
          );
        }
        const cached = await deps.cache.candles(seed.symbol, tf).catch(() => null);
        const usable = cached && cached.network === deps.env.network && (!mainnet || REAL_PRICE_SOURCES.includes(cached.source));
        if (usable && cached.candles.length) return cached.candles.slice(-limit);
        return memo(`${seed.symbol}:${tf}:${limit}`, 0, () => deps.db.candles(seed.symbol, tf, limit, { until: now() + MAX_FUTURE_SKEW_MS, realOnly: mainnet }));
      },
    );
  };
}
