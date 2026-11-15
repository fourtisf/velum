/** Regression tests for audit R2-L5: the workers process reports liveness independently of prices. */
import { cacheKeys } from '@velum/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMac } from '../__fixtures__/mac';
import { WORKERS_HEARTBEAT, startLiveness } from './liveness';
import type { Logger } from './log';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const KEY = cacheKeys.heartbeat(WORKERS_HEARTBEAT);

afterEach(() => {
  vi.useRealTimers();
});

describe('R2-L5: workers liveness heartbeat', () => {
  it('writes velum:heartbeat:workers at once and on every interval until stopped, authenticated (F-2)', async () => {
    vi.useFakeTimers();
    let t = 1_000;
    const writes: Array<[string, string]> = [];
    const redis = { set: async (k: string, v: string) => (writes.push([k, v]), 'OK' as const) };
    const stop = await startLiveness(redis, testMac, silent, 5000, () => t);
    expect(writes).toEqual([[KEY, testMac.seal(KEY, '1000')]]);
    t = 6_000;
    await vi.advanceTimersByTimeAsync(5000);
    t = 11_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes.map(([k, v]) => testMac.open(k, v))).toEqual(['1000', '6000', '11000']);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(writes).toHaveLength(3);
  });
  it('a failed write is logged, not thrown', async () => {
    const warns: string[] = [];
    const redis = { set: async () => Promise.reject(new Error('READONLY')) };
    const stop = await startLiveness(redis, testMac, { ...silent, warn: (m, d) => warns.push(`${m}:${String(d?.err)}`) }, 60_000);
    stop();
    expect(warns).toEqual(['liveness heartbeat failed:READONLY']);
  });
  it('uses the key the API reads', () => {
    expect(KEY).toBe('velum:heartbeat:workers');
  });
});
