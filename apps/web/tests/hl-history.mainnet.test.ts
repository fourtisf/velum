/**
 * Perps history and chart lines: funding read from the exchange for the Velum markets only, the Portfolio sums
 * (realized P&L, fees, funding, net), the CSV export, and the price lines a position puts on the chart.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));

import { positionLines } from '@/lib/chartLines';
import type { HlFill } from '@/lib/hyperliquid/client';
import { historyCsv, historySummary, readFunding } from '@/lib/hyperliquid/history';

const FILLS: HlFill[] = [
  { coin: 'xyz:TSLA', symbol: 'TSLA', px: '392.46', sz: '6.574', dir: 'Close Long', closedPnl: '79.94', fee: '1.16', time: Date.UTC(2026, 10, 17, 12, 5), oid: 2 },
  { coin: 'xyz:TSLA', symbol: 'TSLA', px: '380.30', sz: '6.574', dir: 'Open Long', closedPnl: '0.0', fee: '1.12', time: Date.UTC(2026, 10, 17, 11, 0), oid: 1 },
];
const FUNDING = readFunding([
  { time: Date.UTC(2026, 10, 17, 12, 0), hash: '0x', delta: { type: 'funding', coin: 'xyz:TSLA', usdc: '-0.0158', szi: '6.574', fundingRate: '0.00000625', nSamples: null } },
  { time: Date.UTC(2026, 10, 17, 11, 0), hash: '0x', delta: { type: 'funding', coin: 'xyz:TSLA', usdc: '0.0042', szi: '6.574', fundingRate: '-0.0000017', nSamples: null } },
  { time: Date.UTC(2026, 10, 17, 11, 0), hash: '0x', delta: { type: 'funding', coin: 'BTC', usdc: '-5', szi: '1', fundingRate: '0.0001', nSamples: null } },
]);

describe('perps history', () => {
  it('reads funding for the Velum markets only, newest first', () => {
    expect(FUNDING.map((f) => [f.symbol, f.usdc])).toEqual([
      ['TSLA', -0.0158],
      ['TSLA', 0.0042],
    ]);
  });

  it('sums realized P&L, fees, funding and net', () => {
    expect(historySummary(FILLS, FUNDING)).toEqual({ realized: 79.94, fees: 2.28, funding: -0.01, net: 77.65, trades: 2, volume: 5080.12 });
  });

  it('exports every trade and funding payment as CSV, oldest first, in UTC', () => {
    const csv = historyCsv(FILLS, FUNDING).trim().split('\n');
    expect(csv[0]).toBe('time_utc,type,market,direction,size,price,notional_usdc,fee_usdc,realized_pnl_usdc,funding_usdc,order_id');
    expect(csv.slice(1)).toEqual([
      '2026-11-17T11:00:00.000Z,trade,TSLA,Open Long,6.574,380.30,2500.09,1.12,0.0,,1',
      '2026-11-17T11:00:00.000Z,funding,TSLA,Funding received,6.574,,,,,0.004200,',
      '2026-11-17T12:00:00.000Z,funding,TSLA,Funding paid,6.574,,,,,-0.015800,',
      '2026-11-17T12:05:00.000Z,trade,TSLA,Close Long,6.574,392.46,2580.03,1.16,79.94,,2',
    ]);
  });
});

describe('chart lines', () => {
  it('a position draws its entry, liquidation, TP, SL and resting limits', () => {
    const lines = positionLines({ pos: { long: true, entry: 384.12, liq: 262.9 }, tp: 420, sl: 360, limits: [{ isBuy: true, px: 350 }], fmt: (n) => n.toFixed(2) });
    expect(lines.map((l) => [l.label, l.tone, l.dashed])).toEqual([
      ['Long entry 384.12', 'up', false],
      ['Liq. 262.90', 'warn', true],
      ['TP 420.00', 'up', true],
      ['SL 360.00', 'down', true],
      ['Limit buy 350.00', 'acc', true],
    ]);
    expect(positionLines({ pos: { long: false, entry: 380, liq: null }, tp: null, sl: null, limits: [], fmt: String })).toEqual([{ price: 380, label: 'Short entry 380', tone: 'down', dashed: false }]);
  });
});
