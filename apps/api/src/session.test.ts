/**
 * Session-boundary math (packages/config/src/session.ts) for the closed-market display: sessions end at 20:00
 * New York time on trading days, NYSE holidays skipped, across DST changes. Early closes (13:00 ET) are not in the
 * calendar (its header says so), so there is nothing half-day to test beyond that.
 */
import {
  closedPeriods,
  closedThrough,
  decCmp,
  dropClosedRepeats,
  eveningEt,
  isTradingDay,
  lastEndedSession,
  nextOpen,
  nextTradingDay,
  previousTradingDay,
  repeatsLastStr,
  sessionOf,
  tradingDayCandles,
  tradingDayOf,
  usEquitySession,
} from '@velum/config';
import { describe, expect, it } from 'vitest';

const Z = (s: string) => Date.parse(s);
const H = 3_600_000;

describe('session ends at 20:00 New York time, across DST', () => {
  it('20:00 EDT is 00:00 UTC next day, 20:00 EST is 01:00 UTC', () => {
    expect(eveningEt('2026-10-30')).toBe(Z('2026-10-31T00:00:00Z')); // Friday, EDT
    expect(eveningEt('2026-11-13')).toBe(Z('2026-11-14T01:00:00Z')); // Friday, EST
    // The DST change days themselves (02:00 local), evenings unambiguous.
    expect(eveningEt('2026-11-01')).toBe(Z('2026-11-02T01:00:00Z')); // back to EST that morning
    expect(eveningEt('2026-03-08')).toBe(Z('2026-03-09T00:00:00Z')); // EDT from that morning
    expect(eveningEt('2027-03-14')).toBe(Z('2027-03-15T00:00:00Z'));
    expect(eveningEt('2027-11-07')).toBe(Z('2027-11-08T01:00:00Z'));
  });

  it('a session runs from the previous evening to the day evening (Monday from Sunday 20:00)', () => {
    expect(sessionOf('2026-11-02')).toEqual({ tradingDay: '2026-11-02', start: Z('2026-11-02T01:00:00Z'), end: Z('2026-11-03T01:00:00Z') });
    // The week DST ends: the previous Friday closed at 00:00 UTC, Monday opens at 01:00 UTC (the weekend is 49 h).
    expect(lastEndedSession(Z('2026-11-01T12:00:00Z'))).toEqual({ tradingDay: '2026-10-30', start: Z('2026-10-30T00:00:00Z'), end: Z('2026-10-31T00:00:00Z') });
    expect(nextOpen(Z('2026-11-01T12:00:00Z'))).toBe(Z('2026-11-02T01:00:00Z'));
    // The week DST starts: Friday closed at 01:00 UTC, Monday opens at 00:00 UTC (47 h).
    expect(lastEndedSession(Z('2026-03-08T12:00:00Z')).end).toBe(Z('2026-03-07T01:00:00Z'));
    expect(nextOpen(Z('2026-03-08T12:00:00Z'))).toBe(Z('2026-03-09T00:00:00Z'));
  });

  it('the boundary instant belongs to the next session', () => {
    const fri = eveningEt('2026-11-13');
    expect(usEquitySession(fri - 1).open).toBe(true);
    expect(usEquitySession(fri).open).toBe(false);
    expect(tradingDayOf(fri - 1)).toBe('2026-11-13');
    expect(tradingDayOf(fri)).toBe('2026-11-14');
    expect(lastEndedSession(fri).tradingDay).toBe('2026-11-13');
    expect(lastEndedSession(fri - 1).tradingDay).toBe('2026-11-12');
  });
});

describe('holidays and weekends are skipped (NYSE 2026/2027)', () => {
  it('trading days', () => {
    expect(isTradingDay('2026-11-13')).toBe(true);
    expect(isTradingDay('2026-11-14')).toBe(false); // Saturday
    expect(isTradingDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(isTradingDay('2026-11-27')).toBe(true); // the day after: an early close on NYSE, a full day in this calendar
    expect(isTradingDay('2026-04-03')).toBe(false); // Good Friday 2026
    expect(isTradingDay('2027-03-26')).toBe(false); // Good Friday 2027
    expect(isTradingDay('2027-06-18')).toBe(false); // Juneteenth 2027, observed Friday
    expect(isTradingDay('2027-07-05')).toBe(false); // Independence Day 2027, observed Monday
    expect(isTradingDay('2027-12-24')).toBe(false); // Christmas 2027, observed Friday
  });

  it('previous and next trading days', () => {
    expect(previousTradingDay('2026-11-16')).toBe('2026-11-13');
    expect(previousTradingDay('2026-11-27')).toBe('2026-11-25'); // across Thanksgiving
    expect(nextTradingDay('2026-11-25')).toBe('2026-11-27');
    expect(previousTradingDay('2027-01-04')).toBe('2026-12-31'); // across New Year 2027 (Friday) and a year
    expect(nextTradingDay('2026-12-24')).toBe('2026-12-28'); // Christmas Friday plus the weekend
    expect(previousTradingDay('2027-07-06')).toBe('2027-07-02');
  });

  it('the last ended session while closed, and its previous session', () => {
    // Thanksgiving 2026, noon New York: closed since Wednesday 20:00; Wednesday vs Tuesday.
    const tg = lastEndedSession(Z('2026-11-26T17:00:00Z'));
    expect(tg).toMatchObject({ tradingDay: '2026-11-25', end: Z('2026-11-26T01:00:00Z') });
    expect(previousTradingDay(tg.tradingDay)).toBe('2026-11-24');
    // Good Friday 2026 (Saturday after): Thursday's session (EDT).
    expect(lastEndedSession(Z('2026-04-04T16:00:00Z'))).toMatchObject({ tradingDay: '2026-04-02', end: Z('2026-04-03T00:00:00Z') });
    expect(nextOpen(Z('2026-04-04T16:00:00Z'))).toBe(Z('2026-04-06T00:00:00Z'));
    // Christmas 2026 (Friday): Thursday Dec 24 closed the week.
    expect(lastEndedSession(Z('2026-12-26T12:00:00Z')).tradingDay).toBe('2026-12-24');
    // New Year 2027 weekend: Thursday Dec 31, 2026.
    expect(lastEndedSession(Z('2027-01-03T15:00:00Z')).tradingDay).toBe('2026-12-31');
    // Independence Day 2027 observed Monday: the Friday before; reopens Monday 20:00 EDT.
    expect(lastEndedSession(Z('2027-07-05T16:00:00Z')).tradingDay).toBe('2027-07-02');
    expect(nextOpen(Z('2027-07-05T16:00:00Z'))).toBe(Z('2027-07-06T00:00:00Z'));
  });
});

describe('closed intervals and candle session views', () => {
  it('closedThrough: a bucket wholly in closed time', () => {
    expect(closedThrough(Z('2026-11-14T12:00:00Z'), Z('2026-11-14T13:00:00Z'))).toBe(true); // Saturday hour
    expect(closedThrough(Z('2026-11-14T00:00:00Z'), Z('2026-11-14T01:00:00Z'))).toBe(false); // Friday 19:00-20:00 EST
    expect(closedThrough(Z('2026-11-15T20:00:00Z'), Z('2026-11-16T00:00:00Z'))).toBe(true); // Sunday 15:00-19:00 EST
    expect(closedThrough(Z('2026-11-16T00:00:00Z'), Z('2026-11-16T04:00:00Z'))).toBe(false); // holds Sunday 20:00 EST
    expect(closedThrough(Z('2026-11-26T04:00:00Z'), Z('2026-11-26T08:00:00Z'))).toBe(true); // Thanksgiving
    expect(closedThrough(Z('2026-11-14T12:00:00Z'), Z('2026-11-14T12:00:00Z'))).toBe(false); // empty
  });

  const c = (t: number, o: string, h = o, l = o, cl = o) => ({ t, o, h, l, c: cl });

  it('dropClosedRepeats: weekend hours that only repeat the close go, moving ones and open hours stay', () => {
    const fri19 = Z('2026-11-14T00:00:00Z'); // Friday 19:00 EST, last open hour
    const list = [
      c(fri19, '391.2', '391.9', '390.8', '391.65'),
      c(fri19 + H, '391.65'), // Friday 20:00, closed, repeats
      c(fri19 + 2 * H, '391.65'),
      c(fri19 + 3 * H, '391.65', '392', '391.65', '392'), // closed but moved (simulated prices): stays
      c(Z('2026-11-16T01:00:00Z'), '392', '393', '391', '392.5'), // Sunday 20:00 EST: open
      c(Z('2026-11-16T02:00:00Z'), '392.5'), // open and flat: a quiet hour, stays
    ];
    const kept = dropClosedRepeats(list, H, repeatsLastStr);
    expect(kept.map((k) => k.t)).toEqual([fri19, fri19 + 3 * H, Z('2026-11-16T01:00:00Z'), Z('2026-11-16T02:00:00Z')]);
    // A flat closed bucket at a different price than the last close is not a repeat (a quote change while closed).
    expect(dropClosedRepeats([c(fri19, '391.65'), c(fri19 + H, '391.7')], H, repeatsLastStr).length).toBe(2);
    // The first bucket has no previous one: flat in closed time, nothing traded: left out.
    expect(dropClosedRepeats([c(fri19 + H, '391.65')], H, repeatsLastStr)).toEqual([]);
  });

  it('tradingDayCandles: one candle per trading day from hourly candles, no weekend candle, t = the date at 00:00 UTC', () => {
    // Thursday Oct 29 to Monday Nov 2, 2026: Friday's session is EDT, Monday's opens after DST ended (EST).
    const hours: Array<ReturnType<typeof c>> = [];
    const add = (from: number, to: number, base: number) => {
      for (let t = from, i = 0; t < to; t += H, i++) hours.push(c(t, (base + i).toFixed(2), (base + i + 0.5).toFixed(2), (base + i - 0.5).toFixed(2), (base + i + 1).toFixed(2)));
    };
    add(Z('2026-10-29T00:00:00Z'), Z('2026-10-30T00:00:00Z'), 100); // Thursday's session (Wed 20:00 to Thu 20:00 EDT)
    add(Z('2026-10-30T00:00:00Z'), Z('2026-10-31T00:00:00Z'), 200); // Friday's
    for (let t = Z('2026-10-31T00:00:00Z'); t < Z('2026-11-02T01:00:00Z'); t += H) hours.push(c(t, '224')); // weekend: repeats the close
    add(Z('2026-11-02T01:00:00Z'), Z('2026-11-03T01:00:00Z'), 300); // Monday's (Sun 20:00 to Mon 20:00 EST)
    const days = tradingDayCandles(hours);
    expect(days.map((d) => d.t)).toEqual([Z('2026-10-29T00:00:00Z'), Z('2026-10-30T00:00:00Z'), Z('2026-11-02T00:00:00Z')]);
    expect(days[1]).toEqual({ t: Z('2026-10-30T00:00:00Z'), o: '200.00', h: '223.50', l: '199.50', c: '224.00' });
    expect(days[2]).toMatchObject({ o: '300.00', c: '324.00', h: '323.50', l: '299.50' });
  });

  it('closedPeriods: the gaps between sessions', () => {
    expect(closedPeriods(Z('2026-11-12T12:00:00Z'), Z('2026-11-17T12:00:00Z'))).toEqual([{ start: Z('2026-11-14T01:00:00Z'), end: Z('2026-11-16T01:00:00Z') }]);
    // Thanksgiving week: Wednesday evening to Thursday evening, then the weekend.
    expect(closedPeriods(Z('2026-11-24T12:00:00Z'), Z('2026-11-30T12:00:00Z'))).toEqual([
      { start: Z('2026-11-26T01:00:00Z'), end: Z('2026-11-27T01:00:00Z') },
      { start: Z('2026-11-28T01:00:00Z'), end: Z('2026-11-30T01:00:00Z') },
    ]);
  });

  it('decCmp compares decimal strings exactly', () => {
    expect(decCmp('391.65', '391.650')).toBe(0);
    expect(decCmp('391.65', '391.6501')).toBe(-1);
    expect(decCmp('1000', '999.99')).toBe(1);
    expect(decCmp('0.1', '00.10')).toBe(0);
  });
});
