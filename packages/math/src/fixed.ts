/**
 * Fixed-point decimal math on bigint with 18 decimals ("wad").
 * Every money value in Velum is a Wad. Floats are only used for drawing charts.
 */
export type Wad = bigint;
export type Rounding = 'floor' | 'ceil';

export const DECIMALS = 18;
export const WAD: Wad = 10n ** 18n;
export const ZERO: Wad = 0n;

const POW10: bigint[] = Array.from({ length: 80 }, (_, i) => 10n ** BigInt(i));
const pow10 = (n: number): bigint => POW10[n] ?? 10n ** BigInt(n);

/** Signed division rounding toward -infinity (floor) or +infinity (ceil). */
export function divRound(a: bigint, b: bigint, rounding: Rounding = 'floor'): bigint {
  if (b === 0n) throw new RangeError('Division by zero');
  const q = a / b;
  const r = a % b;
  if (r === 0n) return q;
  const negative = (a < 0n) !== (b < 0n);
  if (rounding === 'floor') return negative ? q - 1n : q;
  return negative ? q : q + 1n;
}

/** a * b / d with a single rounding step. */
export function mulDiv(a: bigint, b: bigint, d: bigint, rounding: Rounding = 'floor'): bigint {
  return divRound(a * b, d, rounding);
}

export const wmul = (a: Wad, b: Wad, rounding: Rounding = 'floor'): Wad => mulDiv(a, b, WAD, rounding);
export const wdiv = (a: Wad, b: Wad, rounding: Rounding = 'floor'): Wad => mulDiv(a, WAD, b, rounding);

export const wmin = (a: Wad, b: Wad): Wad => (a < b ? a : b);
export const wmax = (a: Wad, b: Wad): Wad => (a > b ? a : b);
export const wabs = (a: Wad): Wad => (a < 0n ? -a : a);

/** Basis points to wad: 30 bps -> 0.003. */
export const bps = (n: number | bigint): Wad => (BigInt(n) * WAD) / 10_000n;

const NUM_RE = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?/;

/**
 * Parse a decimal string to a wad. Lenient like parseFloat: reads the leading number and
 * ignores the rest ("12abc" -> 12). Returns null when there is no number at all.
 * Digits beyond 18 decimals are truncated toward zero.
 */
export function parseWad(input: string): Wad | null {
  const m = NUM_RE.exec(input);
  if (!m) return null;
  const [, sign = '', intPart = '', fracPart = '', expPart] = m;
  if (!intPart && !fracPart) return null;
  const exp = expPart ? Number.parseInt(expPart, 10) : 0;
  if (!Number.isFinite(exp) || Math.abs(exp) > 60) return null;
  const digits = (intPart || '0') + fracPart;
  let scale = DECIMALS - fracPart.length + exp;
  let v = BigInt(digits);
  if (scale >= 0) v *= pow10(scale);
  else {
    scale = -scale;
    v /= pow10(scale);
  }
  return sign === '-' ? -v : v;
}

/** Parse or fall back to zero (for form inputs). */
export const parseOrZero = (input: string): Wad => parseWad(input) ?? 0n;

/** Convert a JS number to a wad via its shortest decimal representation. Use for seeds/constants only. */
export function fromNumber(n: number): Wad {
  if (!Number.isFinite(n)) throw new RangeError('Not a finite number');
  return parseWad(String(n)) ?? 0n;
}

/** Integer token units (e.g. 6-decimal USDG base units) to wad. */
export function fromUnits(units: bigint, decimals: number): Wad {
  return decimals <= DECIMALS ? units * pow10(DECIMALS - decimals) : units / pow10(decimals - DECIMALS);
}

/** Wad to integer token units, rounding down (never overstate a balance). */
export function toUnits(w: Wad, decimals: number, rounding: Rounding = 'floor'): bigint {
  return decimals <= DECIMALS ? divRound(w, pow10(DECIMALS - decimals), rounding) : w * pow10(decimals - DECIMALS);
}

/** Round to `dp` decimals. 'half' rounds half away from zero (display only). */
export function roundTo(w: Wad, dp: number, mode: Rounding | 'half' = 'half'): Wad {
  if (dp >= DECIMALS) return w;
  const unit = pow10(DECIMALS - dp);
  if (mode === 'half') {
    const half = unit / 2n;
    const r = w < 0n ? -divRound(-w + half, unit, 'floor') : divRound(w + half, unit, 'floor');
    return r * unit;
  }
  return divRound(w, unit, mode) * unit;
}

/** Exact decimal string. `dp` fixes the number of decimals (rounded half away from zero). */
export function toDecimalString(w: Wad, dp?: number): string {
  const v = dp === undefined ? w : roundTo(w, dp, 'half');
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / WAD;
  let frac = (abs % WAD).toString().padStart(DECIMALS, '0');
  if (dp === undefined) frac = frac.replace(/0+$/, '');
  else frac = frac.slice(0, dp);
  const s = frac ? `${int}.${frac}` : `${int}`;
  return neg && v !== 0n ? `-${s}` : s;
}

/** Lossy conversion for charts and layout math. Never feed the result back into money math. */
export function toNumber(w: Wad): number {
  return Number(toDecimalString(w));
}

/** Round to `n` significant figures (used for quotes and public pool sizes). */
export function roundSig(w: Wad, n: number, mode: Rounding = 'floor'): Wad {
  if (w === 0n) return 0n;
  const abs = wabs(w);
  const digits = abs.toString().length;
  const drop = digits - n;
  if (drop <= 0) return w;
  const unit = pow10(drop);
  return divRound(w, unit, mode) * unit;
}

/** Number of decimals needed to show `w` at `n` significant figures (capped at 18). */
export function sigDecimals(w: Wad, n: number): number {
  if (w === 0n) return 0;
  const digits = wabs(w).toString().length;
  return Math.max(0, Math.min(DECIMALS, DECIMALS - (digits - n)));
}

/** w * (1 + r) ^ k for small integer k, applied step by step with the given rounding. */
export function compound(w: Wad, factor: Wad, times: number, rounding: Rounding = 'floor'): Wad {
  let v = w;
  for (let i = 0; i < times; i++) v = wmul(v, factor, rounding);
  return v;
}
