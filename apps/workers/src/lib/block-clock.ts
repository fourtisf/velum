/**
 * Block times for the DEX candles (jobs/dex-candles.ts). Logs on Robinhood Chain carry no usable block timestamp
 * (blockTimestamp is 0x0), and a chart covers months of ~10 blocks per second, so fetching every swap's block is out
 * of the question. Instead the candles need, for each bucket boundary T (a multiple of 15 minutes, in seconds), the
 * first block whose timestamp is at or after T: a swap in block b then belongs to the bucket [T, T + tf) exactly when
 * boundary(T) <= b < boundary(T + tf). Block timestamps never decrease, so this is the same bucket as the swap's own
 * block time, to the second, with a few header reads per boundary (interpolation search, falling back to bisection,
 * since many blocks share one second).
 */

export interface BlockHeader {
  number: bigint;
  /** Unix seconds. */
  timestamp: number;
  hash: `0x${string}`;
}

/** Most headers kept in memory (a full backfill reads a few thousand). */
const MAX_CACHED = 20_000;

export class BlockClock {
  private cache = new Map<bigint, BlockHeader>();
  /** Header reads made (for logs and tests). */
  reads = 0;

  constructor(private readonly fetchHeader: (n: bigint) => Promise<BlockHeader>) {}

  async header(n: bigint): Promise<BlockHeader> {
    const hit = this.cache.get(n);
    if (hit) return hit;
    this.reads++;
    const h = await this.fetchHeader(n);
    if (h.number !== n || !Number.isSafeInteger(h.timestamp) || h.timestamp < 0) throw new Error(`malformed header for block ${n}`);
    if (this.cache.size >= MAX_CACHED) {
      // Drop the oldest quarter (Map keeps insertion order).
      let drop = MAX_CACHED / 4;
      for (const k of this.cache.keys()) {
        if (drop-- <= 0) break;
        this.cache.delete(k);
      }
    }
    this.cache.set(n, h);
    return h;
  }

  /** Forget a cached header (after a reorg check failed). */
  forget(n: bigint): void {
    this.cache.delete(n);
  }

  /**
   * The first block in (lo, hi] whose timestamp is >= `t` (Unix seconds). Requires lo.timestamp < t <= hi.timestamp
   * (throws otherwise). Interpolation search: each step guesses from the time span of the bracket; a step that did not
   * at least halve the bracket is followed by a bisection, so it always ends in O(log n) reads.
   */
  async firstAtOrAfter(t: number, lo: BlockHeader, hi: BlockHeader): Promise<bigint> {
    if (!(lo.timestamp < t && t <= hi.timestamp) || lo.number >= hi.number) throw new Error(`boundary ${t} is not inside blocks ${lo.number}..${hi.number}`);
    let a = lo;
    let b = hi;
    let bisect = false;
    while (b.number - a.number > 1n) {
      const width = b.number - a.number;
      let guess: bigint;
      if (bisect) guess = a.number + width / 2n;
      else {
        const span = BigInt(b.timestamp - a.timestamp);
        guess = span > 0n ? a.number + (width * BigInt(t - a.timestamp)) / span : a.number + width / 2n;
      }
      if (guess <= a.number) guess = a.number + 1n;
      if (guess >= b.number) guess = b.number - 1n;
      const h = await this.header(guess);
      if (h.timestamp >= t) b = h;
      else a = h;
      bisect = !bisect && (b.number - a.number) * 2n > width;
    }
    return b.number;
  }
}
