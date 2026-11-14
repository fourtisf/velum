/** Audit round 2, M4 on the default (testnet) build: the prototype's demo behaviour is unchanged. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'testnet';
});

import { IS_MAINNET, MARKETS } from '@velum/config';
import { privTotal } from '@/lib/calc';
import { livePrice, mk, startMarketFeed, tokPx, useMarkets } from '@/lib/markets';
import { seedLedger } from '@/lib/store';
import { W, installStorage, patchMarket } from './helpers';

const initialMarkets = useMarkets.getState();
beforeEach(() => {
  installStorage();
  useMarkets.setState({ ...initialMarkets }, true);
});

it('runs as a testnet build', () => expect(IS_MAINNET).toBe(false));

describe('testnet demo prices', () => {
  it('the seed is the demo price until the API answers (prototype)', () => {
    expect(livePrice('TSLA')).toBe(W('391.65'));
    expect(tokPx('ETH')).toBe(W('3420'));
    expect(privTotal(seedLedger())).toBe(W('12500') + W('4') * 391_65n / 100n + W('10') * 233_40n / 100n);
  });

  it('a market the API reports without data (source null) is still not tradable', () => {
    patchMarket('TSLA', { noData: true });
    expect(livePrice('TSLA')).toBeNull();
    expect(privTotal(seedLedger())).toBeNull();
  });

  it('staleness never blocks the testnet demo', () => {
    patchMarket('TSLA', { stale: true });
    useMarkets.setState({ failures: 7, lastOkAt: 1 });
    expect(livePrice('TSLA')).toBe(W('391.65'));
  });
});

describe('the live feed (startMarketFeed) on testnet', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('API down: switches to the simulated walk, which stays tradable (never on mainnet)', async () => {
    const stop = startMarketFeed();
    await vi.advanceTimersByTimeAsync(2100);
    const s = useMarkets.getState();
    expect(s.source).toBe('local');
    expect(s.feedStale).toBe(false);
    for (const m of MARKETS) expect(livePrice(m.symbol)).not.toBeNull();
    expect(mk('TSLA').noData).toBe(false);
    stop();
  });
});
