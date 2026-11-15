/** Display rounding (audit web F10): holdings round down, never up; protocol numbers come from PROTOCOL. */
import { PROTOCOL } from '@velum/config';
import { fromUnits, parseWad } from '@velum/math';
import { describe, expect, it } from 'vitest';
import { P } from '@/lib/copy';
import { bpsPct, dp, floorTo, fmt, fmtBal, usdBal } from '@/lib/format';

const W = (s: string) => parseWad(s)!;

describe('balances round down', () => {
  it('a 0.995 USDG public balance (6 decimals) shows 0.99, matching what Max fills', () => {
    const bal = fromUnits(995_000n, 6);
    expect(fmt(bal, dp('USDG'))).toBe('1.00'); // half-up: fine for prices, wrong for holdings
    expect(fmtBal(bal, dp('USDG'))).toBe('0.99');
    expect(fmtBal(bal, dp('USDG'))).toBe(floorTo(bal, dp('USDG')));
  });

  it('0.99995 TSLA shows 0.9999 TSLA', () => {
    expect(fmtBal(fromUnits(99_995n * 10n ** 13n, 18), dp('TSLA'))).toBe('0.9999');
  });

  it('totals of holdings round down too, negatives towards minus infinity', () => {
    expect(usdBal(W('9999.999'))).toBe('$9,999.99');
    expect(usdBal(W('-1.231'))).toBe('-$1.24');
    expect(usdBal(null)).toBe('—');
    expect(fmtBal(W('1234.5'), 0)).toBe('1,234');
  });
});

describe('protocol numbers in copy (RC-02)', () => {
  it('are derived from PROTOCOL, so they cannot drift', () => {
    expect(bpsPct(30)).toBe('0.30%');
    expect(bpsPct(100, 0)).toBe('1%');
    expect(P.poolFee).toBe(bpsPct(PROTOCOL.spotPoolFeeBps));
    expect(P.maxLev).toBe(`${PROTOCOL.maxLeverage}×`);
    expect(P.exitDays).toBe(PROTOCOL.forcedExitDelayDays);
    expect(P.penalty).toBe(bpsPct(PROTOCOL.liquidationPenaltyBps, 0));
    // Today's values (CLAUDE.md §5), so a config change is noticed here.
    expect([P.poolFee, P.maxLev, P.exitDays, P.penalty, P.fillMinutes]).toEqual(['0.30%', '5×', 7, '1%', 15]);
  });
});
