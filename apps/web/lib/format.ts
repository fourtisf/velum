/**
 * Display formatting, matching the prototype's helpers (fmt, usd, pct, …).
 * Money arrives as Wad (bigint, 1e18) and is formatted exactly via Intl with a decimal string.
 * Plain numbers are accepted for chart/axis labels and percentages.
 */
import { roundSig, sigDecimals, toDecimalString, wabs, type Wad } from '@velum/math';

type Num = Wad | number;

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max = min): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

/** Intl accepts exact decimal strings; typed as number in older lib.d.ts. */
const formatDecimal = (f: Intl.NumberFormat, s: string): string => f.format(s as unknown as number);

export function fmt(n: Num, d = 2): string {
  if (typeof n === 'bigint') return formatDecimal(nf(d), toDecimalString(n, d));
  return nf(d).format(Number.isFinite(n) ? n : 0);
}

const isNeg = (n: Num) => (typeof n === 'bigint' ? n < 0n : n < 0);
const abs = (n: Num): Num => (typeof n === 'bigint' ? wabs(n) : Math.abs(n));

export const usd = (n: Num, d = 2): string => (isNeg(n) && fmt(abs(n), d) !== fmt(0, d) ? '-$' : '$') + fmt(abs(n), d);
export const pct = (n: number, d = 2): string => (n >= 0 ? '+' : '') + fmt(n, d) + '%';
export const sgnUsd = (n: Num): string => (isNeg(n) && fmt(abs(n)) !== '0.00' ? '-$' : '+$') + fmt(abs(n));

export function compact(n: number): string {
  return n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n / 1e3) + 'K';
}

/** Four significant figures below 1,000, otherwise 2 decimals (prototype's sig4). */
export function sig4(n: Wad): string {
  if (wabs(n) >= 1000n * 10n ** 18n) return fmt(n, 2);
  const r = roundSig(n, 4, 'floor');
  const d = Math.min(6, sigDecimals(r, 4));
  return formatDecimal(nf(0, d), toDecimalString(r, d));
}

export const fmtLev = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '×';

/** Floor to d decimals and return a plain input string (prototype's floorTo). */
export function floorTo(w: Wad, d: number): string {
  if (w <= 0n) return '0';
  const unit = 10n ** BigInt(18 - d);
  const floored = (w / unit) * unit;
  return toDecimalString(floored);
}

export const shortH = (h: string): string => h.slice(0, 6) + '…' + h.slice(-4);

export function ago(t: number, now = Date.now()): string {
  const s = (now - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

/** Display decimals per token: USDG 2, everything else 4. */
export const dp = (t: string): number => (t === 'USDG' ? 2 : 4);

export function randomHex(bytes: number): `0x${string}` {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

export const uid = (): string => Math.random().toString(36).slice(2, 9);
export const receiptId = (): string => String(Math.floor(100000 + Math.random() * 900000));
