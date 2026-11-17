/**
 * Referral links (lib/referral.ts): ?ref=<code> is kept on the first visit for 30 days (a later link does not replace a
 * fresh one), junk is ignored, and a wallet's own code is its first 10 hex digits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { refCode } from '@velum/config/src/alerts';
import { captureRef, storedRef } from '@/lib/referral';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as unknown as { window: unknown }).window = { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }, location: { search: '' } };
});

describe('referral links', () => {
  it('keeps the first fresh code, ignores junk, and expires after 30 days', () => {
    const t0 = Date.UTC(2026, 10, 17);
    captureRef('?ref=ZZZ', t0);
    expect(storedRef(t0)).toBeNull();
    captureRef('?ref=ABCDEF0123', t0);
    expect(storedRef(t0)).toBe('abcdef0123');
    captureRef('?ref=1111111111', t0 + 86_400_000);
    expect(storedRef(t0 + 86_400_000)).toBe('abcdef0123');
    expect(storedRef(t0 + 31 * 86_400_000)).toBeNull();
    captureRef('?ref=1111111111', t0 + 31 * 86_400_000);
    expect(storedRef(t0 + 31 * 86_400_000)).toBe('1111111111');
  });

  it('a wallet’s code is its first 10 hex digits', () => {
    expect(refCode('0x92EF4C8D8DF09A9AE7ED9A12409BC9A84FB70E7B')).toBe('92ef4c8d8d');
  });
});
