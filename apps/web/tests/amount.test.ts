import { parseWad } from '@velum/math';
import { describe, expect, it } from 'vitest';
import { AMOUNT_MAX_LENGTH, amountHint, amountInputProps, amountOrZero, bpsOrNull, checkAmount } from '@/lib/amount';

const W = (s: string) => parseWad(s)!;

describe('strict amount parsing (audit web L11)', () => {
  const ok: Array<[string, string]> = [
    ['0', '0'],
    ['5', '5'],
    ['5.', '5'],
    ['.5', '0.5'],
    ['001.10', '1.1'],
    [' 12.5 ', '12.5'],
    ['999999999999999.999999999999999999', '999999999999999.999999999999999999'],
  ];
  for (const [i, v] of ok)
    it(`accepts ${JSON.stringify(i)}`, () => {
      const r = checkAmount(i);
      expect(r).toEqual({ kind: 'ok', value: W(v) });
      expect(amountOrZero(i)).toBe(W(v));
      expect(amountHint(i)).toBe('');
    });

  const bad = ['1,000', '1e3', '1E3', '-5', '+5', '0x10', 'Infinity', 'NaN', '1.2.3', '12abc', '1 000', '5,5', '١٢', '1_000', '1000000000000000', '1.0000000000000000001', '０１２', '​1', '1​', '٫5', '..'];
  for (const i of bad)
    it(`rejects ${JSON.stringify(i)}`, () => {
      expect(checkAmount(i).kind).toBe('invalid');
      expect(amountHint(i)).not.toBe('');
      expect(amountOrZero(i)).toBe(0n);
    });

  it('empty and a lone dot are empty, not errors', () => {
    for (const i of ['', '.', '   ', ' . ']) {
      expect(checkAmount(i).kind).toBe('empty');
      expect(amountHint(i)).toBe('');
      expect(amountOrZero(i)).toBe(0n);
    }
  });

  it('hints say what is wrong', () => {
    expect(amountHint('1,000')).toMatch(/comma/);
    expect(amountHint('1000000000000000')).toMatch(/too large/);
    expect(amountHint('1.0000000000000000001')).toMatch(/18 decimal/);
    expect(amountHint('1'.repeat(40))).toMatch(/too long/);
  });

  it('caps input length at 34 characters', () => {
    expect(AMOUNT_MAX_LENGTH).toBe(34);
    expect(amountInputProps('1', 'h').maxLength).toBe(34);
  });

  it('marks invalid input for assistive tech', () => {
    expect(amountInputProps('1e3', 'h')['aria-invalid']).toBe(true);
    expect(amountInputProps('12', 'h')['aria-invalid']).toBeUndefined();
    expect(amountInputProps('12', 'h')['aria-describedby']).toBe('h');
  });

  it('spreads are plain decimals from 0 to 1,000 bps', () => {
    expect(bpsOrNull('8')).toBe(8);
    expect(bpsOrNull('7.5')).toBe(7.5);
    expect(bpsOrNull('0')).toBe(0);
    expect(bpsOrNull('1000')).toBe(1000);
    expect(bpsOrNull('1001')).toBeNull();
    expect(bpsOrNull('1000.000000000000001')).toBeNull();
    expect(bpsOrNull('1e2')).toBeNull();
    expect(bpsOrNull('0x10')).toBeNull();
    expect(bpsOrNull('')).toBeNull();
  });
});
