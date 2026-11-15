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
