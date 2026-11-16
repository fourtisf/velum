/**
 * US-equity session calendar for Stock Tokens (audit M-1). Pure and dependency-free, so the API, the
 * workers and the web share one rule.
 *
 * Official hours (checked 2026-11-15):
 *  - docs.robinhood.com/chain/stock-tokens, "Trading Hours": minting/burning (the tokenization window)
 *    runs Monday 02:00 CET/CEST to Saturday 02:00 CET/CEST, i.e. Sunday 20:00 to Friday 20:00 US
 *    Eastern; which sessions an asset trades in (market, extended, overnight) is per asset
 *    (`tradingCapabilities` in api.robinhood.com/rhj/assets).
 *  - docs.robinhood.com/chain/oracles-and-price-feeds: "Stock feeds update 24/5, following market hours."
 *  - US market holidays follow the NYSE holiday rules (nyse.com/markets/hours-calendars, Rule 7.2).
 *
 * Model: a trading day D (a weekday that is not an NYSE holiday) covers [D-1 20:00 ET, D 20:00 ET),
 * so the 24/5 week opens Sunday 20:00 ET and closes Friday 20:00 ET, and a holiday closes the 24 hours
 * ending 20:00 ET on that day. The CET/CEST tokenization window equals this except in the two or three
 * weeks a year when only one of the US and EU has switched daylight saving time. Early closes (13:00 ET)
 * and unscheduled closures are not in the calendar: the frozen-quote rule (QUOTE_FROZEN_AFTER_MS) covers
 * them.
 */

export type SessionClosedReason = 'weekend' | 'holiday';

export interface SessionState {
  open: boolean;
  /** Why the session is closed (null when open). */
  reason: SessionClosedReason | null;
  /** The trading day this instant belongs to, YYYY-MM-DD (US Eastern). */
  tradingDay: string;
}

/**
 * A quote whose bid/ask has not changed for this long is treated as frozen (not live) even inside the
 * calendar's open hours. Robinhood's /rhj/prices cache window is 15 s and the Velum markets are large
 * caps whose quotes move every few seconds through the 24/5 week (overnight included), so 15 minutes
 * without any change means the upstream stopped quoting (an early close, an unscheduled closure, an
 * upstream fault), not a quiet market. It never flaps during normal trading.
 */
export const QUOTE_FROZEN_AFTER_MS = 15 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Day of month of the n-th `weekday` (0 = Sunday) of `month` (0-based), n = 1..5; n = -1 for the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/** Easter Sunday (Gregorian, anonymous algorithm): [month 0-based, day]. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month - 1, day];
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const utcDay = (y: number, m: number, d: number): number => Date.UTC(y, m, d);

/** A fixed-date holiday moved to Friday when on a Saturday and to Monday when on a Sunday. */
function observed(y: number, m: number, d: number): number {
  const t = utcDay(y, m, d);
  const wd = new Date(t).getUTCDay();
  return wd === 6 ? t - DAY : wd === 0 ? t + DAY : t;
}

const holidayCache = new Map<number, ReadonlySet<string>>();

/** NYSE full-day holidays of `year` as YYYY-MM-DD (NYSE Rule 7.2, Juneteenth from 2022). */
export function nyseHolidays(year: number): ReadonlySet<string> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const days: number[] = [];
  // New Year's Day: a Sunday moves to Monday; a Saturday is not observed (no holiday on Dec 31).
  const ny = utcDay(year, 0, 1);
  const nyWd = new Date(ny).getUTCDay();
  if (nyWd === 0) days.push(ny + DAY);
  else if (nyWd !== 6) days.push(ny);
  days.push(utcDay(year, 0, nthWeekday(year, 0, 1, 3))); // Martin Luther King Jr. Day: 3rd Monday of January
  days.push(utcDay(year, 1, nthWeekday(year, 1, 1, 3))); // Washington's Birthday: 3rd Monday of February
  const [em, ed] = easter(year);
  days.push(utcDay(year, em, ed) - 2 * DAY); // Good Friday
  days.push(utcDay(year, 4, nthWeekday(year, 4, 1, -1))); // Memorial Day: last Monday of May
  if (year >= 2022) days.push(observed(year, 5, 19)); // Juneteenth
  days.push(observed(year, 6, 4)); // Independence Day
  days.push(utcDay(year, 8, nthWeekday(year, 8, 1, 1))); // Labor Day: 1st Monday of September
  days.push(utcDay(year, 10, nthWeekday(year, 10, 4, 4))); // Thanksgiving: 4th Thursday of November
  days.push(observed(year, 11, 25)); // Christmas
  const set = new Set(days.map(iso));
  holidayCache.set(year, set);
  return set;
}

/** US Eastern offset from UTC at `t` (US daylight saving rules since 2007): -4 h or -5 h. */
export function easternOffsetMs(t: number): number {
  const y = new Date(t).getUTCFullYear();
  // DST starts on the 2nd Sunday of March at 02:00 EST (07:00 UTC) and ends on the 1st Sunday of
  // November at 02:00 EDT (06:00 UTC).
  const start = Date.UTC(y, 2, nthWeekday(y, 2, 0, 2), 7);
  const end = Date.UTC(y, 10, nthWeekday(y, 10, 0, 1), 6);
  return t >= start && t < end ? -4 * HOUR : -5 * HOUR;
}

/** Whether the 24/5 US-equity session for Stock Tokens is open at `t` (Unix ms). */
export function usEquitySession(t: number): SessionState {
  // 20:00 ET is midnight of the next trading day: shift Eastern time by 4 hours and take the date.
  const shifted = t + easternOffsetMs(t) + 4 * HOUR;
  const d = new Date(shifted);
  const tradingDay = iso(shifted);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return { open: false, reason: 'weekend', tradingDay };
  if (nyseHolidays(d.getUTCFullYear()).has(tradingDay)) return { open: false, reason: 'holiday', tradingDay };
  return { open: true, reason: null, tradingDay };
}

/* ---------- Sessions (closed-market display: last-session change, chart session breaks) ---------- */

/** A trading day's session: [start, end) in Unix ms, start = 20:00 ET on the previous calendar day, end = 20:00 ET on the day. */
export interface SessionRef {
  /** YYYY-MM-DD (US Eastern) */
  tradingDay: string;
  start: number;
  end: number;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayParts = (day: string): [number, number, number] => {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a YYYY-MM-DD day: ${day}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
};

/** `day` moved by `n` calendar days (YYYY-MM-DD). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = dayParts(day);
  return iso(utcDay(y, m, d) + n * DAY);
}

/** Midnight UTC of calendar day `day` (the `t` of that day's 1D candle). */
export function dayStartUtc(day: string): number {
  const [y, m, d] = dayParts(day);
  return utcDay(y, m, d);
}

/** Whether `day` (YYYY-MM-DD) is a trading day: a weekday that is not an NYSE holiday. */
export function isTradingDay(day: string): boolean {
  const [y, m, d] = dayParts(day);
  const wd = new Date(utcDay(y, m, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !nyseHolidays(y).has(day);
}

/** 20:00 US Eastern on calendar day `day`, as Unix ms (EDT or EST, whichever is in force that evening). */
export function eveningEt(day: string): number {
  const [y, m, d] = dayParts(day);
  const wall = Date.UTC(y, m, d, 20);
  // 20:00 is never inside a DST change (those happen at 02:00 on Sundays): exactly one offset fits.
  for (const off of [-4 * HOUR, -5 * HOUR]) if (easternOffsetMs(wall - off) === off) return wall - off;
  return wall + 5 * HOUR;
}

/** The session of trading day `day` (the day need not be a trading day: callers check isTradingDay). */
export function sessionOf(day: string): SessionRef {
  return { tradingDay: day, start: eveningEt(shiftDay(day, -1)), end: eveningEt(day) };
}

/** The trading day strictly before `day` (weekends and NYSE holidays skipped). */
export function previousTradingDay(day: string): string {
  let d = shiftDay(day, -1);
  for (let i = 0; i < 30 && !isTradingDay(d); i++) d = shiftDay(d, -1);
  return d;
}

/** The trading day strictly after `day`. */
export function nextTradingDay(day: string): string {
  let d = shiftDay(day, 1);
  for (let i = 0; i < 30 && !isTradingDay(d); i++) d = shiftDay(d, 1);
  return d;
}

/** The trading day (US Eastern, sessions ending 20:00 ET) instant `t` belongs to, open or not. */
export const tradingDayOf = (t: number): string => usEquitySession(t).tradingDay;

/**
 * The most recent session that ended at or before `t`. While the market is closed this is the session
 * whose close the market sits at (Friday's on a weekend, Wednesday's on Thanksgiving).
 */
export function lastEndedSession(t: number): SessionRef {
  return sessionOf(previousTradingDay(tradingDayOf(t)));
}

/** When the market next opens at or after `t` (`t` itself while it is open). */
export function nextOpen(t: number): number {
  const s = usEquitySession(t);
  return s.open ? t : sessionOf(nextTradingDay(s.tradingDay)).start;
}

/** Whether the whole interval [from, to) lies in closed time (weekend or NYSE holiday). */
export function closedThrough(from: number, to: number): boolean {
  return to > from && nextOpen(from) >= to;
}

/**
 * Candles shown in session view (session breaks): a bucket [t, t + bucketMs) that lies wholly in closed
 * time and only repeats the last price (`repeats(c, previous)`) is left out. Nothing is deleted: the stored
 * history keeps those buckets. A closed-time bucket that moved (simulated prices on testnet keep moving)
 * stays. `repeats` compares prices exactly in the caller's representation.
 */
export function dropClosedRepeats<T extends { t: number }>(list: readonly T[], bucketMs: number, repeats: (c: T, prev: T | undefined) => boolean): T[] {
  const out: T[] = [];
  let prev: T | undefined;
  for (const c of list) {
    if (!(closedThrough(c.t, c.t + bucketMs) && repeats(c, prev))) out.push(c);
    prev = c;
  }
  return out;
}

/** Plain non-negative decimal strings compared exactly (no sign, no exponent): -1, 0 or 1. */
export function decCmp(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const ia = ai.replace(/^0+(?=\d)/, '');
  const ib = bi.replace(/^0+(?=\d)/, '');
  if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
  if (ia !== ib) return ia < ib ? -1 : 1;
  const n = Math.max(af.length, bf.length);
  const fa = af.padEnd(n, '0');
  const fb = bf.padEnd(n, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

interface StrCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

/** A candle (decimal strings) flat at the previous candle's close: nothing traded it away from the last price. */
export const repeatsLastStr = (c: Omit<StrCandle, 't'>, prev: { c: string } | undefined): boolean =>
  decCmp(c.o, c.h) === 0 && decCmp(c.o, c.l) === 0 && decCmp(c.o, c.c) === 0 && (prev === undefined || decCmp(c.c, prev.c) === 0);

/**
 * One candle per trading day from hourly candles (decimal strings, oldest first): the hours of the session
 * [D-1 20:00 ET, D 20:00 ET) make day D's candle (20:00 ET is always a whole UTC hour, so no hour straddles
 * two sessions). `t` is D at 00:00 UTC, the date the candle stands for, as before. Hours in closed time that
 * only repeat the last price are left out, so a weekend or holiday gets no candle; a closed day that moved
 * (simulated prices on testnet) keeps its own.
 */
export function tradingDayCandles(hourly: readonly StrCandle[]): StrCandle[] {
  const out: StrCandle[] = [];
  let day = '';
  for (const k of dropClosedRepeats(hourly, HOUR, repeatsLastStr)) {
    const d = tradingDayOf(k.t);
    const last = out[out.length - 1];
    if (last && d === day) {
      if (decCmp(k.h, last.h) > 0) last.h = k.h;
      if (decCmp(k.l, last.l) < 0) last.l = k.l;
      last.c = k.c;
      continue;
    }
    day = d;
    out.push({ t: dayStartUtc(d), o: k.o, h: k.h, l: k.l, c: k.c });
  }
  return out;
}

/**
 * The closed periods between sessions that overlap [from, to): each runs from a session's end to the next
 * session's start (a weekend, a holiday). Used to place on-chain DEX candles on the daily chart.
 */
export function closedPeriods(from: number, to: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let day = isTradingDay(tradingDayOf(from)) ? tradingDayOf(from) : previousTradingDay(tradingDayOf(from));
  for (let i = 0; i < 400; i++) {
    const end = sessionOf(day).end;
    const next = nextTradingDay(day);
    const start = sessionOf(next).start;
    if (end >= to) break;
    if (start > end && start > from) out.push({ start: end, end: start });
    day = next;
  }
  return out;
}
