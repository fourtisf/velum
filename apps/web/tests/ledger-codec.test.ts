import { describe, expect, it } from 'vitest';
import { decodeLedger, encodeLedger } from '@/lib/ledger-codec';
import type { Ledger } from '@/lib/store';

const realistic = (): Ledger => ({
  priv: { USDG: 10n ** 22n, TSLA: 4n * 10n ** 18n },
  positions: [
    { id: 'abc1234', sym: 'TSLA', side: 'long', lev: 2.5, margin: 1n, qty: 2n, entry: 3n, liq: null, cs: 10n ** 14n, commit: '0x' + 'a'.repeat(64), block: 1, openedAt: 1_800_000_000_000 },
  ],
  history: [{ t: 1_800_000_000_000, title: 't', sub: 's', icon: 'trade' }],
  offers: [{ id: 'o1', sym: 'TSLA', back: 1n, max: 1n, open: 8, close: 5, exp: '24 hours', fills: 0, earned: 0n }],
  lp: { TSLA: 5n },
  lastChain: { what: 'w', commit: '0x' + 'b'.repeat(64), block: 2 },
  shielded: { USDG: 1n },
});

describe('stored demo ledger decoding (audit web L6)', () => {
  it('round-trips a realistic ledger exactly', () => {
    const l = realistic();
    expect(decodeLedger(encodeLedger(l))).toEqual(l);
  });

  it('writes money as "<digits>n" strings', () => {
    expect(encodeLedger(realistic())).toContain('"USDG":"10000000000000000000000n"');
  });

  it('returns null for data that is not a ledger', () => {
    for (const raw of ['', 'nope', '[]', 'null', '42', '"x"']) expect(decodeLedger(raw)).toBeNull();
  });

  it('ignores prototype-pollution keys', () => {
    const raw =
      '{"priv":{"__proto__":"5n","USDG":"1n","constructor":"3n"},"positions":[{"__proto__":{"id":"x"}}],"lp":{"__proto__":{"polluted":true}},"history":[],"offers":[],"lastChain":{"__proto__":{"what":"a"}},"shielded":{}}';
    const l = decodeLedger(raw)!;
    expect(Object.keys(l.priv)).toEqual(['USDG']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(l.priv)).toBe(Object.prototype);
    expect(l.positions).toEqual([]);
    expect(l.lastChain).toBeNull();
  });

  it('turns "123n" into bigint only for money fields', () => {
    const l = decodeLedger('{"priv":{"USDG":"12n"},"history":[{"t":1700000000000,"title":"5n","sub":"6n","icon":"info"}]}')!;
    expect(l.priv.USDG).toBe(12n);
    expect(l.history[0]!.title).toBe('5n');
  });

  it('drops bad entries one by one, keeping the rest', () => {
    const raw = JSON.stringify({
      priv: { USDG: '1n', ETH: '1n', BTC: '2n', TSLA: '-1n', AMZN: 5, NVDA: '1.5n' },
      positions: [
        { ...JSON.parse(encodeLedger(realistic())).positions[0] },
        { ...JSON.parse(encodeLedger(realistic())).positions[0], id: 'dup' },
        { ...JSON.parse(encodeLedger(realistic())).positions[0], id: 'abc1234' },
        { ...JSON.parse(encodeLedger(realistic())).positions[0], id: 'bad1', sym: 'DOGE' },
        { ...JSON.parse(encodeLedger(realistic())).positions[0], id: 'bad2', lev: 9 },
        { ...JSON.parse(encodeLedger(realistic())).positions[0], id: 'bad3', entry: '0n' },
      ],
      history: [{ t: 1, title: 'x', sub: 'y', icon: 'info' }, { t: 1_800_000_000_000, title: 'ok', sub: 'y', icon: 'info' }, { t: 1_800_000_000_000, title: 'x', sub: 'y', icon: 'bomb' }],
      offers: [{ id: '', sym: 'TSLA', back: '1n', max: '1n', open: 1, close: 1, exp: '24 hours', fills: 0, earned: '0n' }],
    });
    const l = decodeLedger(raw)!;
    expect(l.priv).toEqual({ USDG: 1n });
    expect(l.positions.map((p) => p.id)).toEqual(['abc1234', 'dup']);
    expect(l.history.map((h) => h.title)).toEqual(['ok']);
    expect(l.offers).toEqual([]);
  });

  it('bounds huge inputs', () => {
    const big = JSON.stringify({ priv: { USDG: '9'.repeat(46) + 'n' }, history: Array.from({ length: 5000 }, () => ({ t: 1_700_000_000_000, title: 'x', sub: 'y', icon: 'info' })) });
    const l = decodeLedger(big)!;
    expect(l.priv.USDG).toBeUndefined();
    expect(l.history.length).toBe(100);
  });

  it('accepts the all-zero placeholder commitment (mainnet positions have no chain event)', () => {
    const l = realistic();
    l.positions[0]!.commit = '0x' + '0'.repeat(64);
    l.positions[0]!.block = 0;
    l.lastChain = null;
    expect(decodeLedger(encodeLedger(l))).toEqual(l);
  });
});
