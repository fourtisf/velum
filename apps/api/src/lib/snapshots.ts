import type { MarketSnapshot } from '@velum/config';
import type { CacheReader } from './deps';
import { timeout } from './memo';

/** Longest wait for the price cache before answering from the last known values (audit L-4). */
export const CACHE_READ_TIMEOUT_MS = 400;

export interface SnapshotRead {
  snaps: Map<string, MarketSnapshot>;
  /** False when the cache could not be read: `snaps` then holds the last values this process saw. */
  ok: boolean;
}

/**
 * Reads market snapshots, remembering the last good value per market. When Redis is down or slow the
 * API still answers quickly with those values (or the seed price), all marked stale with reason
 * "unavailable", instead of failing with 500 after the client's timeouts (audit L-4).
 */
export function snapshotReader(cache: CacheReader, timeoutMs = CACHE_READ_TIMEOUT_MS) {
  const lastKnown = new Map<string, MarketSnapshot>();
  return async (symbols: readonly string[]): Promise<SnapshotRead> => {
    try {
      const snaps = await timeout(cache.snapshots(symbols), timeoutMs, 'price cache read');
      for (const [k, v] of snaps) lastKnown.set(k, v);
      return { snaps, ok: true };
    } catch {
      const snaps = new Map<string, MarketSnapshot>();
      for (const s of symbols) {
        const v = lastKnown.get(s);
        if (v) snaps.set(s, v);
      }
      return { snaps, ok: false };
    }
  };
}
export type SnapshotReader = ReturnType<typeof snapshotReader>;
