/**
 * The OracleAdapter's rate limit in TypeScript (contracts/src/OracleAdapter.sol `_limit`, `_clockAfter`), and
 * the relay's push decision built on it.
 *
 * The rule (contracts/README.md "The rate-limit clock", FA-01): a recording may move the reported price from
 * the last recorded price `last` by at most
 *     maxMove = last x 5% x dt / 300 s,   dt = min(t - lastAt, 300 s)
 * where `lastAt` is the rate-limit clock and `t` the block time. A push is a new source value, so it sets the
 * clock to at least its observation time (`observedAt`, the source timestamp since audit M-1, a few seconds
 * before its block time); anyone else's recording that changes nothing leaves the clock alone, and one that
 * moves the price advances it only by the whole seconds the move used. So:
 *  - the allowance a push gets is the block time since the clock (normally the previous push's observation),
 *    1/6000 of the price per second, never more than 5%;
 *  - a push the limit clamps is recorded as the source price but reported at the clamped price: the market
 *    reads as lagging (opens, closes, margin removal and forced exits revert) until a later recording catches
 *    up, and the push still restarts the clock at its observation time;
 *  - waiting costs nothing: the allowance keeps growing until the next push.
 *
 * The relay therefore pushes the true price on its cadence when it fits the allowance at the push's block
 * time; when it does not, it defers the push second by second until the allowance covers the move (the push
 * then lands exactly, not lagging), but only while its last push is younger than RELAY_MAX_PUSH_GAP_S. A move
 * that cannot fit by then (a jump) is pushed anyway: that is what makes the on-chain price converge, and the
 * lagging state is the protection the contracts want during a jump. The relay never pushes a pre-clamped,
 * made-up price: that would hide the lag and let takers trade against a price the market has left.
 */
import { ORACLE_LIMITS } from '@velum/config/src/onchain';

export interface Band {
  /** Last recorded effective price (1e18), 0 before the first price. */
  last: bigint;
  /** The rate-limit clock (block time, s). */
  lastAt: bigint;
  lastValidAt: bigint;
}

export interface Relayed {
  price: bigint;
  /** Observation time of the last push (s, chain time; the source timestamp, audit M-1), 0 before the first. */
  updatedAt: bigint;
}

const { maxMoveBps, moveWindowSeconds, bps } = ORACLE_LIMITS;
const abs = (x: bigint) => (x < 0n ? -x : x);

/** `_limit`'s maxMove at block time `t` (the first price ever is unlimited: returns null). */
export function allowance(band: Band, t: bigint): bigint | null {
  if (band.last === 0n) return null;
  let dt = t - band.lastAt;
  if (dt < 0n) dt = 0n;
  if (dt > moveWindowSeconds) dt = moveWindowSeconds;
  return (band.last * maxMoveBps * dt) / (bps * moveWindowSeconds);
}

/** The price a recording of `target` (already inside the bounds) reports at block time `t` (`_limit`). */
export function limitedPrice(band: Band, target: bigint, t: bigint): bigint {
  const max = allowance(band, t);
  if (max === null) return target;
  if (target + max < band.last) return band.last - max;
  if (target > band.last + max) return band.last + max;
  return target;
}

/** Whether pushing `target` at block time `t` lands exactly (not clamped, so not lagging). */
export const fits = (band: Band, target: bigint, t: bigint): boolean => limitedPrice(band, target, t) === target;

/**
 * The earliest block time at which `target` fits, or null when it never fits in one recording (a move of more
 * than 5%, the cap at a full window).
 */
export function fitTime(band: Band, target: bigint): bigint | null {
  if (band.last === 0n) return band.lastAt;
  const diff = abs(target - band.last);
  if (diff === 0n) return band.lastAt;
  const unit = band.last * maxMoveBps;
  const dt = (diff * bps * moveWindowSeconds + unit - 1n) / unit;
  return dt > moveWindowSeconds ? null : band.lastAt + dt;
}

export type RelayDecision =
  | { action: 'push'; fits: boolean }
  | { action: 'wait'; reason: 'interval' | 'deferred'; until: bigint };

export interface DecideInput {
  /** The price to push (1e18), inside the bounds (an out-of-bounds quote: the bound it is clamped to). */
  target: bigint;
  /**
   * The quote is outside the adapter's bounds (audit L-7): it is pushed as it is on the cadence, never deferred
   * (the adapter clamps it, so it reads as lagging however long the push waits).
   */
  clamped?: boolean;
  band: Band;
  relayed: Relayed;
  /** Lower estimate of the push's block time (s). */
  t: bigint;
  /** Push cadence (s), 8-10. */
  intervalS: bigint;
  /** RELAY_MAX_PUSH_GAP_S. */
  maxGapS: bigint;
}

/**
 * Push now, or wait (for the cadence, or because the move does not fit yet and can fit before the gap limit).
 * See the module comment for the strategy.
 */
export function decide(i: DecideInput): RelayDecision {
  const lastPush = i.relayed.updatedAt;
  if (lastPush === 0n || i.band.last === 0n) return { action: 'push', fits: true };
  if (i.t < lastPush + i.intervalS) return { action: 'wait', reason: 'interval', until: lastPush + i.intervalS };
  if (i.clamped) return { action: 'push', fits: false };
  if (fits(i.band, i.target, i.t)) return { action: 'push', fits: true };
  const deadline = lastPush + i.maxGapS;
  const at = fitTime(i.band, i.target);
  if (at !== null && at > i.t && at <= deadline) return { action: 'wait', reason: 'deferred', until: at };
  return { action: 'push', fits: false };
}
