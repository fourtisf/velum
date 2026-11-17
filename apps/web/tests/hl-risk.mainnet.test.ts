/**
 * Perps risk tools (lib/hyperliquid/risk.ts, manage.ts and the open flow's limit and TP/SL paths): exact TP/SL checks and
 * P&L, the trigger orders sent, limit orders, partial closes, isolated margin math, open orders read from the exchange,
 * and what each flow signs (with the Hyperliquid client mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '@/lib/hyperliquid/client';
import type * as AgentModule from '@/lib/hyperliquid/agent';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({
  clearinghouseState: vi.fn(),
  extraAgents: vi.fn(),
  frontendOpenOrders: vi.fn(),
  moveToXyz: vi.fn(),
  freshAsset: vi.fn(),
  order: vi.fn(),
  cancel: vi.fn(),
  updateLeverage: vi.fn(),
  updateIsolatedMargin: vi.fn(),
  loadAgent: vi.fn(),
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/hyperliquid/client', async (orig) => {
  const real = await orig<typeof ClientModule>();
  return {
    builderRate: real.builderRate,
    BUILDER: null,
    info: { clearinghouseState: h.clearinghouseState, extraAgents: h.extraAgents, frontendOpenOrders: h.frontendOpenOrders },
    approveNewAgent: vi.fn(),
    moveToXyz: h.moveToXyz,
    freshAsset: h.freshAsset,
    agentClient: () => ({ order: h.order, cancel: h.cancel, updateLeverage: h.updateLeverage, updateIsolatedMargin: h.updateIsolatedMargin }),
    builderApproved: vi.fn(async () => true),
    approveBuilder: vi.fn(),
  };
});
vi.mock('@/lib/hyperliquid/agent', async (orig) => ({ ...(await orig<typeof AgentModule>()), loadAgent: h.loadAgent }));

import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { parseWad } from '@velum/math';
import { openFlow, type HlCtx, type HlFlowSpec } from '@/lib/hyperliquid/flows';
import { cancelFlow, marginFlow, partialCloseFlow, tpslFlow } from '@/lib/hyperliquid/manage';
import { orderParams, planOpen, type OpenPlan } from '@/lib/hyperliquid/order';
import { liqAfterMargin, ntliOf, planLimit, planPartialClose, planTpsl, readOpenOrders, tpslEntries, tpslOf, userPrice, type OpenOrder } from '@/lib/hyperliquid/risk';

const USER = '0x1111111111111111111111111111111111111111' as const;
const AGENT = { user: USER, address: '0x00000000000000000000000000000000000000a1' as const, pk: `0x${'1'.repeat(64)}` as const, validUntil: 2e12 };
const TSLA = { ...HL_MARKETS.TSLA!, maxLeverage: 10 };
const ctx = (): HlCtx => ({ user: USER, agent: AGENT, out: {} });
const ok = (statuses: unknown[]) => ({ status: 'ok', response: { type: 'order', data: { statuses } } });
const run = async (f: HlFlowSpec, c = ctx()) => {
  const out: Array<string | null> = [];
  for (const st of f.steps) out.push(await st.run(c));
  return { out, c };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.loadAgent.mockReturnValue(AGENT);
  h.extraAgents.mockResolvedValue([{ address: AGENT.address, name: 'velum', validUntil: 2e12 }]);
});

describe('take profit / stop loss', () => {
  it('a long takes profit above the entry and stops below it, with the exact P&L at each trigger', () => {
    const r = planTpsl({ market: TSLA, long: true, size: '2.604', entryPx: '384.12', tp: '400', sl: '370.5', liqPx: parseWad('262.9') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orders).toEqual([
      { kind: 'tp', triggerPx: '400', limitPx: '360', pnl: '41.35' },
      { kind: 'sl', triggerPx: '370.5', limitPx: '333.45', pnl: '-35.46' },
    ]);
    // The triggers close: a long's are sells, reduce-only trigger market orders for the whole size.
    expect(tpslEntries({ asset: TSLA.asset, long: true, size: '2.604', orders: r.orders })).toEqual([
      { a: TSLA.asset, b: false, p: '360', s: '2.604', r: true, t: { trigger: { isMarket: true, triggerPx: '400', tpsl: 'tp' } } },
      { a: TSLA.asset, b: false, p: '333.45', s: '2.604', r: true, t: { trigger: { isMarket: true, triggerPx: '370.5', tpsl: 'sl' } } },
    ]);
  });

  it('a short the other way; buys back with room above the trigger', () => {
    const r = planTpsl({ market: TSLA, long: false, size: '1', entryPx: '380', tp: '350', sl: '', liqPx: parseWad('450') });
    expect(r.ok && r.orders).toEqual([{ kind: 'tp', triggerPx: '350', limitPx: '385', pnl: '30.00' }]);
  });

  it('refuses a TP or SL on the wrong side, a stop past liquidation, junk, or nothing at all', () => {
    const base = { market: TSLA, long: true, size: '1', entryPx: '380', liqPx: parseWad('300') };
    expect(planTpsl({ ...base, tp: '370', sl: '' })).toEqual({ ok: false, reason: 'tpSide' });
    expect(planTpsl({ ...base, tp: '', sl: '390' })).toEqual({ ok: false, reason: 'slSide' });
    expect(planTpsl({ ...base, tp: '', sl: '290' })).toEqual({ ok: false, reason: 'slLiq' });
    expect(planTpsl({ ...base, tp: 'abc', sl: '' })).toEqual({ ok: false, reason: 'tpPrice' });
    expect(planTpsl({ ...base, tp: '', sl: '' })).toEqual({ ok: false, reason: 'none' });
    expect(planTpsl({ ...base, long: false, liqPx: parseWad('450'), tp: '', sl: '460' })).toEqual({ ok: false, reason: 'slLiq' });
  });

  it('prices follow the exchange tick rules (5 significant figures)', () => {
    expect(userPrice('384.123456', TSLA.szDecimals)).toBe('384.12');
    expect(userPrice('0', TSLA.szDecimals)).toBeNull();
    expect(userPrice('x', TSLA.szDecimals)).toBeNull();
  });
});

describe('limit orders', () => {
  it('are sized and margined at the limit price, and rest on the book (Gtc) with TP/SL waiting for the fill', () => {
    const r = planLimit({ market: TSLA, long: true, notionalUsd: '1000', leverage: 5, limitPx: '370' });
    expect(r.ok && r.plan).toMatchObject({ isBuy: true, size: '2.702', limitPx: '370', leverage: 5, notional: '999.74', margin: '200.95' });
    const plan = (r.ok ? r.plan : null)!;
    const tp = planTpsl({ market: TSLA, long: true, size: plan.size, entryPx: plan.limitPx, tp: '400', sl: '', liqPx: null });
    const p = orderParams({ ...plan, reduceOnly: false }, null, { tif: 'Gtc', tpsl: tpslEntries({ asset: TSLA.asset, long: true, size: plan.size, orders: tp.ok ? tp.orders : [] }) });
    expect(p.grouping).toBe('normalTpsl');
    expect(p.orders[0]).toEqual({ a: TSLA.asset, b: true, p: '370', s: '2.702', r: false, t: { limit: { tif: 'Gtc' } } });
    expect(p.orders[1]).toMatchObject({ b: false, r: true, s: '2.702', t: { trigger: { triggerPx: '400', tpsl: 'tp' } } });
    expect(planLimit({ market: TSLA, long: true, notionalUsd: '1000', leverage: 5, limitPx: '' })).toEqual({ ok: false, reason: 'price' });
  });

  it('the open flow places a resting limit order and says so', async () => {
    const plan = (planLimit({ market: TSLA, long: true, notionalUsd: '1000', leverage: 5, limitPx: '370' }) as { ok: true; plan: OpenPlan }).plan;
    h.freshAsset.mockResolvedValue({ leverage: { type: 'isolated', value: 5 } });
    h.order.mockResolvedValue(ok([{ resting: { oid: 77 } }, 'waitingForFill']));
    const tp = planTpsl({ market: TSLA, long: true, size: plan.size, entryPx: plan.limitPx, tp: '400', sl: '', liqPx: null });
    const f = openFlow({ user: USER, sym: 'TSLA', market: TSLA, plan, mode: 'unified', xyzAvailable: 500, mainAvailable: 0, slipPct: 0.5, liqEst: '300', otype: 'limit', tpsl: tp.ok ? tp.orders : [] });
    expect(f.confirmLabel).toBe('Place order');
    expect(f.steps.map((s) => s.t)).toEqual(['Enable trading', 'Set 5x isolated leverage', 'Limit long 2.702 TSLA at 370']);
    const { out, c } = await run(f);
    expect(out[2]).toBe('Order #77 placed at 370');
    expect(h.order.mock.calls[0]![0].grouping).toBe('normalTpsl');
    const d = f.done(c);
    expect(d.toast).toBe('Limit order placed');
    expect(String(d.rows[0]![1])).toBe('#77, resting');
  });
});

describe('market order with TP/SL', () => {
  it('fills first, then sets TP/SL on the whole position (positionTpsl), sized from the position after the fill', async () => {
    const r = planOpen({ market: TSLA, long: true, notionalUsd: '1000', leverage: 3, markPx: '383.93', slipBps: 50n });
    const plan = (r as { ok: true; plan: OpenPlan }).plan;
    const tp = planTpsl({ market: TSLA, long: true, size: plan.size, entryPx: '383.93', tp: '420', sl: '360', liqPx: parseWad('262') });
    h.freshAsset.mockResolvedValue({ leverage: { type: 'isolated', value: 3 } });
    h.order.mockResolvedValueOnce(ok([{ filled: { totalSz: '2.604', avgPx: '384.1', oid: 9 } }])).mockResolvedValueOnce(ok(['waitingForTrigger', 'waitingForTrigger']));
    h.clearinghouseState.mockResolvedValue({ withdrawable: '0', assetPositions: [{ position: { coin: TSLA.coin, szi: '3.604' } }] });
    const f = openFlow({ user: USER, sym: 'TSLA', market: TSLA, plan, mode: 'unified', xyzAvailable: 500, mainAvailable: 0, slipPct: 0.5, liqEst: '262', tpsl: tp.ok ? tp.orders : [] });
    expect(f.steps.at(-1)!.t).toBe('Set take profit and stop loss');
    const { out } = await run(f);
    expect(out.at(-1)).toBe('TP 420 · SL 360');
    const second = h.order.mock.calls[1]![0];
    expect(second.grouping).toBe('positionTpsl');
    expect(second.orders.map((o: { s: string; r: boolean; b: boolean }) => [o.s, o.r, o.b])).toEqual([
      ['3.604', true, false],
      ['3.604', true, false],
    ]);
    expect(Object.fromEntries(f.review.map(([k, v]) => [String(k), String(v)]))).toMatchObject({ 'Take profit': '420 (P&L about +$93.92)', 'Stop loss': '360 (P&L about -$62.31)' });
  });

  it('says plainly when the position opened but the TP/SL was refused', async () => {
    const plan = (planOpen({ market: TSLA, long: true, notionalUsd: '100', leverage: 2, markPx: '380', slipBps: 50n }) as { ok: true; plan: OpenPlan }).plan;
    const tp = planTpsl({ market: TSLA, long: true, size: plan.size, entryPx: '380', tp: '400', sl: '', liqPx: null });
    h.order.mockResolvedValue(ok([{ error: 'Invalid TP/SL price' }]));
    h.clearinghouseState.mockResolvedValue({ assetPositions: [] });
    const f = openFlow({ user: USER, sym: 'TSLA', market: TSLA, plan, mode: 'unified', xyzAvailable: 500, mainAvailable: 0, slipPct: 0.5, liqEst: '—', tpsl: tp.ok ? tp.orders : [] });
    await expect(f.steps.at(-1)!.run(ctx())).rejects.toThrow(/position is open, but the TP\/SL was refused: Invalid TP\/SL price/);
  });
});

describe('managing a position', () => {
  const OPEN: OpenOrder[] = readOpenOrders([
    { coin: TSLA.coin, side: 'A', limitPx: '360', sz: '0.0', oid: 501, timestamp: 3, orderType: 'Take Profit Market', isTrigger: true, triggerPx: '420', reduceOnly: true, isPositionTpsl: true, origSz: '0.0', triggerCondition: 'Price above 420', children: [] },
    { coin: TSLA.coin, side: 'A', limitPx: '330', sz: '0.0', oid: 502, timestamp: 2, orderType: 'Stop Market', isTrigger: true, triggerPx: '360', reduceOnly: true, isPositionTpsl: true, origSz: '0.0', triggerCondition: 'Price below 360', children: [] },
    { coin: TSLA.coin, side: 'B', limitPx: '370', sz: '1.5', oid: 503, timestamp: 1, orderType: 'Limit', isTrigger: false, triggerPx: '0.0', reduceOnly: false, isPositionTpsl: false, origSz: '1.5', triggerCondition: 'N/A', children: [] },
    { coin: 'BTC', side: 'B', limitPx: '1', sz: '1', oid: 9, timestamp: 9, orderType: 'Limit', isTrigger: false, triggerPx: '0', reduceOnly: false, isPositionTpsl: false, origSz: '1', triggerCondition: 'N/A', children: [] },
  ]);

  it('reads open orders for the Velum markets only, and finds the position TP and SL', () => {
    expect(OPEN.map((o) => [o.oid, o.kind, o.px, o.position, o.symbol])).toEqual([
      [501, 'tp', '420', true, 'TSLA'],
      [502, 'sl', '360', true, 'TSLA'],
      [503, 'limit', '370', false, 'TSLA'],
    ]);
    const t = tpslOf(OPEN, TSLA.coin);
    expect([t.tp?.oid, t.sl?.oid]).toEqual([501, 502]);
  });

  it('replacing a TP cancels the old one first, then sets the new one on the position', async () => {
    const tp = planTpsl({ market: TSLA, long: true, size: '2.604', entryPx: '384', tp: '430', sl: '', liqPx: null });
    h.cancel.mockResolvedValue({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } });
    h.order.mockResolvedValue(ok(['waitingForTrigger']));
    const f = tpslFlow({ user: USER, sym: 'TSLA', market: TSLA, long: true, size: '2.604', orders: tp.ok ? tp.orders : [], replace: [OPEN[0]!] });
    const { out, c } = await run(f);
    expect(h.cancel).toHaveBeenCalledWith({ cancels: [{ a: TSLA.asset, o: 501 }] });
    expect(h.order.mock.calls[0]![0]).toMatchObject({ grouping: 'positionTpsl', orders: [{ b: false, r: true, s: '2.604', t: { trigger: { triggerPx: '430', tpsl: 'tp' } } }] });
    expect(out[1]).toBe('TP 430');
    // A retry after the cancel went through does not cancel again.
    await f.steps[1]!.run(c);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('partial close: a share rounded down to the lot, at least 10 USD, reduce-only', async () => {
    const half = planPartialClose({ market: TSLA, szi: '6.575', markPx: '390', slipBps: 50n, pct: 50 });
    expect(half.ok && half.plan).toMatchObject({ isBuy: false, size: '3.287', pct: 50, notional: '1281.93', limitPx: '388.05' });
    expect(planPartialClose({ market: TSLA, szi: '-0.04', markPx: '390', slipBps: 50n, pct: 25 })).toEqual({ ok: false, reason: 'min' });
    const all = planPartialClose({ market: TSLA, szi: '-0.04', markPx: '390', slipBps: 50n, pct: 100 });
    expect(all.ok && all.plan).toMatchObject({ isBuy: true, size: '0.04' });
    h.order.mockResolvedValue(ok([{ filled: { totalSz: '3.287', avgPx: '389.9', oid: 12 } }]));
    const f = partialCloseFlow({ user: USER, sym: 'TSLA', plan: (half as { ok: true; plan: never }).plan, slipPct: 0.5, pnl: '40.00' });
    expect(f.title).toBe('Close 50% of TSLA');
    const { out } = await run(f);
    expect(h.order.mock.calls[0]![0].orders[0]).toMatchObject({ r: true, b: false, s: '3.287', t: { limit: { tif: 'Ioc' } } });
    expect(out[1]).toBe('Closed 3.287 TSLA at 389.9');
  });

  it('margin: exact ntli, the liquidation price moving the right way, and a top-up from the main balance when needed', async () => {
    expect(ntliOf('25.5', true)).toBe(25_500_000);
    expect(ntliOf('25.5', false)).toBe(-25_500_000);
    expect(ntliOf('0', true)).toBeNull();
    // Long 2 TSLA, liquidation 300, max leverage 10 (mm 5%): +19 USD moves it 19 / 2 / 0.95 = 10 lower.
    expect(liqAfterMargin('300', 19n * 10n ** 18n, '2', 10)).toBe(290n * 10n ** 18n);
    expect(liqAfterMargin('400', 21n * 10n ** 18n, '-2', 10)).toBe(410n * 10n ** 18n);
    expect(liqAfterMargin('300', -19n * 10n ** 18n, '2', 10)).toBe(310n * 10n ** 18n);
    h.clearinghouseState.mockResolvedValue({ withdrawable: '10' });
    h.updateIsolatedMargin.mockResolvedValue({ status: 'ok', response: { type: 'default' } });
    const f = marginFlow({ user: USER, sym: 'TSLA', market: TSLA, long: true, ntli: 25_500_000, mode: 'standard', liqNow: '300.00', liqAfter: '286.58' });
    const { out } = await run(f);
    expect(h.moveToXyz).toHaveBeenCalledWith(AGENT, '15.50');
    expect(h.updateIsolatedMargin).toHaveBeenCalledWith({ asset: TSLA.asset, isBuy: true, ntli: 25_500_000 });
    expect(out.slice(1)).toEqual(['Moved 15.50 USDC', 'Added 25.50 USDC']);
    const rm = marginFlow({ user: USER, sym: 'TSLA', market: TSLA, long: true, ntli: -5_000_000, mode: 'standard', liqNow: '300.00', liqAfter: '302.63' });
    expect(rm.steps.map((s) => s.t)).toEqual(['Enable trading', 'Remove 5.00 USDC of margin']);
  });

  it('cancel: one order or all of them, and a refusal reads plainly', async () => {
    h.cancel.mockResolvedValueOnce({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success', 'success', 'success'] } } });
    const f = cancelFlow({ user: USER, orders: OPEN });
    expect(f.confirmLabel).toBe('Cancel all');
    const { out } = await run(f);
    expect(h.cancel).toHaveBeenCalledWith({ cancels: OPEN.map((o) => ({ a: TSLA.asset, o: o.oid })) });
    expect(out[1]).toBe('3 cancelled');
    h.cancel.mockResolvedValueOnce({ status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } });
    await expect(cancelFlow({ user: USER, orders: [OPEN[2]!] }).steps[1]!.run(ctx())).rejects.toThrow(/already canceled, or filled/);
  });
});
