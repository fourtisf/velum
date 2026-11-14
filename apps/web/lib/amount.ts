/**
 * Strict parsing for every amount the user types (audit web L11). Web-only on purpose:
 * @velum/math's parseWad stays lenient for the API, while form fields here accept plain
 * decimals only: digits with at most one dot, up to 15 integer digits and 18 decimals.
 * Commas, exponents, signs, hex and anything else are rejected with a hint, never guessed.
 */
import type { Wad } from '@velum/math';

export const MAX_INT_DIGITS = 15;
export const MAX_DECIMALS = 18;
/** Longest valid amount: 15 integer digits, a dot and 18 decimals. Used as the input's maxLength. */
export const AMOUNT_MAX_LENGTH = MAX_INT_DIGITS + 1 + MAX_DECIMALS;

const PLAIN = /^(\d*)(?:\.(\d*))?$/;
const POW = 10n ** BigInt(MAX_DECIMALS);

export type AmountResult =
  /** Empty (or a lone dot while typing): no value yet, no hint. */
  | { kind: 'empty' }
  | { kind: 'ok'; value: Wad }
  | { kind: 'invalid'; hint: string };

export function checkAmount(raw: string): AmountResult {
  const s = raw.trim();
  if (s === '' || s === '.') return { kind: 'empty' };
  if (s.length > AMOUNT_MAX_LENGTH) return { kind: 'invalid', hint: 'That amount is too long.' };
  const m = PLAIN.exec(s);
  if (!m) {
    if (/,/.test(s)) return { kind: 'invalid', hint: 'Use a dot for decimals and no commas, like 1250.50.' };
    return { kind: 'invalid', hint: 'Use digits and one dot only, like 1250.50.' };
  }
  const int = m[1] ?? '';
  const frac = m[2] ?? '';
  if (int.length > MAX_INT_DIGITS) return { kind: 'invalid', hint: 'That amount is too large.' };
  if (frac.length > MAX_DECIMALS) return { kind: 'invalid', hint: `Use at most ${MAX_DECIMALS} decimal places.` };
  const value = BigInt(int || '0') * POW + BigInt((frac || '0').padEnd(MAX_DECIMALS, '0'));
  return { kind: 'ok', value };
}

/** The amount as a Wad, or 0 when empty or invalid (forms then show the hint and disable the action). */
export function amountOrZero(raw: string): Wad {
  const r = checkAmount(raw);
  return r.kind === 'ok' ? r.value : 0n;
}

/** The hint to show under the form, or '' when the input is empty or valid. */
export function amountHint(raw: string): string {
  const r = checkAmount(raw);
  return r.kind === 'invalid' ? r.hint : '';
}

const MAX_BPS = 1000n * POW;

/** Spreads in bps: a plain decimal from 0 to 1,000 (compared exactly, before any float rounding), else null. */
export function bpsOrNull(raw: string): number | null {
  const r = checkAmount(raw);
  if (r.kind !== 'ok' || r.value > MAX_BPS) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** Shared attributes for amount inputs: decimal keyboard, length cap, invalid state for assistive tech. */
export function amountInputProps(raw: string, hintId: string) {
  const invalid = checkAmount(raw).kind === 'invalid';
  return {
    inputMode: 'decimal' as const,
    autoComplete: 'off',
    spellCheck: false,
    maxLength: AMOUNT_MAX_LENGTH,
    'aria-invalid': invalid || undefined,
    'aria-describedby': hintId,
  };
}
