import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ORACLE_LIMITS, PERPS_LIMITS, RELAY_INTERVAL_MS, RELAY_MAX_PUSH_GAP_S } from '@velum/config/src/onchain';
import { describe, expect, it } from 'vitest';
import { allowance, decide, fitTime, fits, limitedPrice, type Band } from './relay-math';

const E18 = 10n ** 18n;
const P = 400n * E18;
const band = (last: bigint, lastAt: bigint): Band => ({ last, lastAt, lastValidAt: lastAt });

describe('the TypeScript rate limit equals OracleAdapter._limit', () => {
  it('allows 1/6000 of the price per second, capped at 5% after 5 minutes', () => {
    const b = band(P, 1000n);
    expect(allowance(b, 1000n)).toBe(0n);
    expect(allowance(b, 1001n)).toBe(P / 6000n);
    expect(allowance(b, 1060n)).toBe(P / 100n); // 1% per minute
    expect(allowance(b, 1300n)).toBe((P * 5n) / 100n);
    expect(allowance(b, 10_000n)).toBe((P * 5n) / 100n);
    expect(allowance(band(0n, 0n), 5n)).toBeNull(); // the first price is taken as is
    expect(allowance(b, 999n)).toBe(0n); // a clock ahead of t never yields a negative allowance
  });

  it('clamps toward the last price and rounds the allowance down', () => {
    const b = band(6000n * E18, 0n);
    expect(limitedPrice(b, 7000n * E18, 1n)).toBe(6001n * E18);
    expect(limitedPrice(b, 5000n * E18, 1n)).toBe(5999n * E18);
    expect(limitedPrice(b, 6000n * E18 + 5n, 1n)).toBe(6000n * E18 + 5n);
    // floor(last x 500 x dt / 3e6): 6001 wei x 1 s / 6000 rounds down to 1 wei.
    expect(allowance(band(6001n, 0n), 1n)).toBe(1n);
  });

  it('fitTime is the first block time at which a move fits, null beyond 5%', () => {
    const b = band(P, 100n);
    const target = P + (P * 3n) / 1000n; // +0.3% = 18 s of allowance
    const at = fitTime(b, target)!;
    expect(at).toBe(118n);
    expect(fits(b, target, at)).toBe(true);
    expect(fits(b, target, at - 1n)).toBe(false);
    expect(fitTime(b, P + (P * 6n) / 100n)).toBeNull();
    expect(fitTime(b, P)).toBe(100n);
    for (const bp of [1n, 7n, 13n, 149n, 499n]) {
      const t = fitTime(b, P - (P * bp) / 10_000n)!;
      expect(fits(b, P - (P * bp) / 10_000n, t)).toBe(true);
      expect(fits(b, P - (P * bp) / 10_000n, t - 1n)).toBe(false);
    }
  });
});

describe('the push decision (FA-01 clock: a push restarts the clock at its own block time)', () => {
  const base = { intervalS: 9n, maxGapS: BigInt(RELAY_MAX_PUSH_GAP_S) };

  it('pushes the first price at once', () => {
    expect(decide({ ...base, target: P, band: band(0n, 0n), relayed: { price: 0n, updatedAt: 0n }, t: 50n })).toEqual({ action: 'push', fits: true });
  });

  it('waits for the cadence, then pushes a move that fits', () => {
    const b = band(P, 1000n);
    const r = { price: P, updatedAt: 1000n };
    expect(decide({ ...base, target: P, band: b, relayed: r, t: 1005n })).toEqual({ action: 'wait', reason: 'interval', until: 1009n });
    expect(decide({ ...base, target: P + P / 1000n, band: b, relayed: r, t: 1009n })).toEqual({ action: 'push', fits: true });
    // An unchanged price is pushed too: opens need a price at most 10 s old.
    expect(decide({ ...base, target: P, band: b, relayed: r, t: 1009n })).toEqual({ action: 'push', fits: true });
  });

  it('defers a move the limit would clamp until it fits, within the gap limit', () => {
    const b = band(P, 1000n);
    const r = { price: P, updatedAt: 1000n };
    const target = P + (P * 2n) / 1000n; // +0.2% needs 12 s
    expect(decide({ ...base, target, band: b, relayed: r, t: 1009n })).toEqual({ action: 'wait', reason: 'deferred', until: 1012n });
    expect(decide({ ...base, target, band: b, relayed: r, t: 1012n })).toEqual({ action: 'push', fits: true });
  });

  it('pushes to converge when the move cannot fit before the gap limit (a jump), or the limit passed', () => {
    const b = band(P, 1000n);
    const r = { price: P, updatedAt: 1000n };
    expect(decide({ ...base, target: P + (P * 3n) / 1000n, band: b, relayed: r, t: 1009n })).toEqual({ action: 'push', fits: false }); // needs 18 s > 15
    expect(decide({ ...base, target: P - (P * 8n) / 100n, band: b, relayed: r, t: 1009n })).toEqual({ action: 'push', fits: false }); // > 5%
    // After a lagging push the band trails the source; the next push converges further.
    const lagging = band(P + (P * 15n) / 10_000n, 1009n);
    expect(decide({ ...base, target: P + (P * 3n) / 1000n, band: lagging, relayed: { price: P + (P * 3n) / 1000n, updatedAt: 1009n }, t: 1018n })).toEqual({ action: 'push', fits: true });
  });

  it('the clock in the band, not the last push, sets the allowance (a recording that moved the price advanced it)', () => {
    const b = band(P, 1005n); // a poke at 1005 caught the price up and advanced the clock
    const r = { price: P, updatedAt: 1000n };
    const target = P + (P * 15n) / 10_000n; // 9 s of allowance
    expect(decide({ ...base, target, band: b, relayed: r, t: 1009n })).toEqual({ action: 'wait', reason: 'deferred', until: 1014n });
  });
});

describe('constants mirror contracts/src', () => {
  const src = (f: string) => readFileSync(path.resolve(__dirname, '../../../../contracts/src', f), 'utf8');
  it('OracleAdapter and PerpsBase', () => {
    const oracle = src('OracleAdapter.sol');
    expect(oracle).toMatch(new RegExp(`MAX_MOVE_BPS = ${ORACLE_LIMITS.maxMoveBps};`));
    expect(oracle).toMatch(/MOVE_WINDOW = 5 minutes;/);
    expect(ORACLE_LIMITS.moveWindowSeconds).toBe(300n);
    expect(oracle).toMatch(new RegExp(`MAX_AGE = ${ORACLE_LIMITS.maxAgeSeconds};`));
    const perps = src('perps/PerpsBase.sol');
    expect(perps).toMatch(new RegExp(`OPEN_MAX_AGE = ${ORACLE_LIMITS.openMaxAgeSeconds};`));
    expect(perps).toMatch(new RegExp(`MAX_PRICE_AGE = ${ORACLE_LIMITS.maxAgeSeconds};`));
    expect(perps).toMatch(/LIQUIDATION_PENALTY_BPS = 100;/);
    expect(PERPS_LIMITS.penaltyBps).toBe(100n);
    expect(perps).toMatch(/MM_BPS = BPS \/ 2 \/ MAX_LEVERAGE;/);
    expect(perps).toMatch(/MAX_LEVERAGE = 5;/);
    expect(PERPS_LIMITS.maintenanceBps).toBe(1000n);
    expect(perps).toMatch(/FORCED_EXIT_DELAY = 7 days;/);
    expect(perps).toMatch(/COVER_EPOCH = 1 hours;/);
  });
  it('the relay cadence keeps opens possible (pushes at most 10 s apart) and the gap limit under a minute', () => {
    expect(RELAY_INTERVAL_MS.max / 1000).toBeLessThanOrEqual(ORACLE_LIMITS.openMaxAgeSeconds);
    expect(RELAY_INTERVAL_MS.min).toBe(8000);
    expect(RELAY_MAX_PUSH_GAP_S).toBeLessThan(ORACLE_LIMITS.maxAgeSeconds);
  });
});
