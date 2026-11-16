import { lastEndedSession, previousTradingDay, sessionOf, type SessionRef } from '@velum/config';
import type { DbReader } from './deps';

/** The close of a session: the 15-minute candle that ends at the session's end (20:00 ET is always a whole quarter hour). */
export const CLOSE_BUCKET_MS = 15 * 60_000;
/** A missing close is looked up again after this long (the workers may still be rebuilding history). */
export const CLOSES_RETRY_MS = 60_000;

export interface SessionCloses {
  /** The last session that ended (the one the closed market sits at) and the one before it. */
  last: SessionRef;
  prev: SessionRef;
  /** symbol -> close of `last` / of `prev` (decimal strings), from stored real candles; absent when not stored. */
  close: Map<string, string>;
  prevClose: Map<string, string>;
}

/**
 * The closes of the last two sessions for every market, from Postgres (15-minute candles of a real source: never
 * invented, never the demo series). A session's close is the close of its last quarter hour [end - 15 min, end):
 * the last quote before 20:00 ET, at most 15 minutes old (QUOTE_FROZEN_AFTER_MS). Cached in this process for the
 * pair of sessions; a result with a missing close is fetched again after CLOSES_RETRY_MS.
 */
export function sessionClosesReader(db: DbReader) {
  let cached: { key: string; at: number; value: SessionCloses; complete: boolean } | null = null;
  let inflight: { key: string; p: Promise<SessionCloses> } | null = null;
  return async (now: number, symbols: readonly string[]): Promise<SessionCloses | null> => {
    if (!db.closesAt) return null;
    const last = lastEndedSession(now);
    const prev = sessionOf(previousTradingDay(last.tradingDay));
    const key = `${last.end}:${prev.end}`;
    if (cached && cached.key === key && (cached.complete || now - cached.at < CLOSES_RETRY_MS)) return cached.value;
    if (inflight?.key === key) return inflight.p;
    const p = (async () => {
      const lastT = last.end - CLOSE_BUCKET_MS;
      const prevT = prev.end - CLOSE_BUCKET_MS;
      const rows = await db.closesAt!([lastT, prevT]);
      const close = new Map<string, string>();
      const prevClose = new Map<string, string>();
      for (const [sym, byT] of rows) {
        const c = byT.get(lastT);
        const pc = byT.get(prevT);
        if (c) close.set(sym, c);
        if (pc) prevClose.set(sym, pc);
      }
      const value: SessionCloses = { last, prev, close, prevClose };
      cached = { key, at: now, value, complete: symbols.every((s) => close.has(s) && prevClose.has(s)) };
      return value;
    })();
    inflight = { key, p };
    try {
      return await p;
    } finally {
      if (inflight?.p === p) inflight = null;
    }
  };
}
export type SessionClosesReader = ReturnType<typeof sessionClosesReader>;
