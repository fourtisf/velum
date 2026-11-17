/**
 * The real perps flows on Hyperliquid (lib/hyperliquid/flows.ts) with the Hyperliquid client mocked: which steps an
 * account gets, what each step sends and when it is skipped, what the review and the receipt say, and how errors read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '@/lib/hyperliquid/client';
import type * as AgentModule from '@/lib/hyperliquid/agent';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({
  builder: null as null | { b: `0x${string}`; f: number },
  clearinghouseState: vi.fn(),
  extraAgents: vi.fn(),
  approveNewAgent: vi.fn(),
  moveToXyz: vi.fn(),
  freshAsset: vi.fn(),
  order: vi.fn(),
  updateLeverage: vi.fn(),
  builderApproved: vi.fn(),
  approveBuilder: vi.fn(),
  loadAgent: vi.fn(),
  clearAgent: vi.fn(),
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/hyperliquid/client', async (orig) => {
  const real = await orig<typeof ClientModule>();
  return {
    builderRate: real.builderRate,
    get BUILDER() {
      return h.builder;
    },
    info: { clearinghouseState: h.clearinghouseState, extraAgents: h.extraAgents },
    approveNewAgent: h.approveNewAgent,
    moveToXyz: h.moveToXyz,
    freshAsset: h.freshAsset,
    agentClient: () => ({ order: h.order, updateLeverage: h.updateLeverage }),
    builderApproved: h.builderApproved,
    approveBuilder: h.approveBuilder,
  };
});
vi.mock('@/lib/hyperliquid/agent', async (orig) => ({ ...(await orig<typeof AgentModule>()), loadAgent: h.loadAgent, clearAgent: h.clearAgent }));

import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { closeFlow, hlErrorText, openFlow, type HlCtx, type HlFlowSpec } from '@/lib/hyperliquid/flows';
import { planClose, planOpen, type OpenPlan } from '@/lib/hyperliquid/order';

const USER = '0x1111111111111111111111111111111111111111' as const;
const AGENT = { user: USER, address: '0x00000000000000000000000000000000000000a1' as const, pk: `0x${'1'.repeat(64)}` as const, validUntil: 2e12 };
const TSLA = { ...HL_MARKETS.TSLA!, maxLeverage: 20 };
const r = planOpen({ market: TSLA, long: true, notionalUsd: '1000', leverage: 3, markPx: '383.93', slipBps: 50n });
const PLAN = (r.ok ? r.plan : null) as OpenPlan;
const ctx = (): HlCtx => ({ user: USER, agent: AGENT, out: {} });
const filled = (totalSz: string, avgPx: string, oid = 9) => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz, avgPx, oid } }] } } });
const open = (mode: 'standard' | 'unified', xyzAvailable = 0) =>
  openFlow({ user: USER, sym: 'TSLA', market: TSLA, plan: PLAN, mode, xyzAvailable, mainAvailable: 1000, slipPct: 0.5, liqEst: '262.52' });
const step = (f: HlFlowSpec, title: string) => f.steps.find((s) => s.t === title)!;
const text = (rows: Array<[unknown, unknown]>) => Object.fromEntries(rows.map(([k, v]) => [String(k), String(v)]));

beforeEach(() => {
  vi.clearAllMocks();
  h.builder = null;
});

describe('open flow', () => {
  it('standard accounts move margin to the stock perps balance first; unified accounts do not', () => {
    expect(open('standard').steps.map((s) => s.t)).toEqual(['Enable trading', 'Move margin to your stock perps balance', 'Set 3x isolated leverage', 'Long 2.604 TSLA']);
    expect(open('unified').steps.map((s) => s.t)).toEqual(['Enable trading', 'Set 3x isolated leverage', 'Long 2.604 TSLA']);
  });

  it('reviews every number before anything is signed, and asks the user to acknowledge real money', () => {
    const f = open('standard', 100);
    expect(text(f.review)).toEqual({
      Side: 'Long',
      Size: '2.604 TSLA (about 999.75 USD)',
      Leverage: '3x isolated',
      Margin: '334.26 USDC',
      'Price limit': 'At most 385.84 (0.5% slippage)',
      'Liquidation (est.)': '262.52',
      Market: 'TSLA stock perp',
      Venue: 'Hyperliquid, from your own account at this address',
      Fees: "The exchange's trading fee; Velum adds none",
    });
    expect(f.note).toMatch(/234\.26 USDC moves from your main balance/);
    expect(f.ack).toMatch(/real leveraged trade with real money/);
    expect(open('unified', 0).note).not.toMatch(/moves from your main/);
  });

  it('enabling reuses the agent Hyperliquid still lists, else the wallet approves a fresh one', async () => {
    const f = open('unified');
    h.loadAgent.mockReturnValue(AGENT);
    h.extraAgents.mockResolvedValue([{ address: AGENT.address.toUpperCase().replace('0X', '0x'), name: 'velum', validUntil: 2e12 }]);
    const c: HlCtx = { user: USER, agent: null, out: {} };
    expect(await f.steps[0]!.run(c)).toBeNull();
    expect(c.agent).toEqual(AGENT);
    expect(h.approveNewAgent).not.toHaveBeenCalled();

    h.extraAgents.mockResolvedValue([]);
    h.approveNewAgent.mockResolvedValue({ ...AGENT, address: '0x00000000000000000000000000000000000000b2' });
    const c2: HlCtx = { user: USER, agent: null, out: {} };
    expect(await f.steps[0]!.run(c2)).toBe('Approved in your wallet');
    expect(h.clearAgent).toHaveBeenCalledWith(USER);
    expect(h.approveNewAgent).toHaveBeenCalledWith(USER);
    expect(c2.agent!.address).toBe('0x00000000000000000000000000000000000000b2');
  });

  it('moves only the shortfall, rounded up to cents, and nothing when the xyz balance covers the margin', async () => {
    const s = step(open('standard'), 'Move margin to your stock perps balance');
    h.clearinghouseState.mockResolvedValue({ withdrawable: '300.001' });
    expect(await s.run(ctx())).toBe('Moved 34.26 USDC');
    expect(h.clearinghouseState).toHaveBeenCalledWith({ user: USER, dex: 'xyz' });
    expect(h.moveToXyz).toHaveBeenCalledWith(AGENT, '34.26');
    h.moveToXyz.mockClear();
    h.clearinghouseState.mockResolvedValue({ withdrawable: '334.26' });
    expect(await s.run(ctx())).toBeNull();
    expect(h.moveToXyz).not.toHaveBeenCalled();
  });

  it('sets isolated leverage unless it is already set', async () => {
    const s = step(open('unified'), 'Set 3x isolated leverage');
    h.freshAsset.mockResolvedValue({ leverage: { type: 'isolated', value: 3 } });
    expect(await s.run(ctx())).toBeNull();
    expect(h.updateLeverage).not.toHaveBeenCalled();
    h.freshAsset.mockResolvedValue({ leverage: { type: 'cross', value: 20 } });
    expect(await s.run(ctx())).toBe('3x isolated');
    expect(h.updateLeverage).toHaveBeenCalledWith({ asset: 110001, isCross: false, leverage: 3 });
  });

  it('places one IOC order at the reviewed limit and reads its fill', async () => {
    const f = open('unified');
    const s = step(f, 'Long 2.604 TSLA');
    h.order.mockResolvedValue(filled('2.604', '384.12', 4242));
    const c = ctx();
    expect(await s.run(c)).toBe('Filled 2.604 TSLA at 384.12');
    expect(h.order).toHaveBeenCalledWith({ orders: [{ a: 110001, b: true, p: '385.84', s: '2.604', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
    expect(text(f.done(c).rows)).toMatchObject({ Filled: '2.604 TSLA', 'Average price': '384.12 USDC', Order: '#4242' });
  });

  it('an order that did not fill fails the step with the reason (nothing was traded)', async () => {
    const s = step(open('unified'), 'Long 2.604 TSLA');
    h.order.mockResolvedValue({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=110001' }] } } });
    await expect(s.run(ctx())).rejects.toThrow(/could not immediately match/);
    h.order.mockResolvedValue({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } });
    await expect(s.run(ctx())).rejects.toThrow(/did not fill immediately/);
  });

  it("with a builder fee in the build, the wallet allows Velum's fee once and orders carry it", async () => {
    h.builder = { b: '0x00000000000000000000000000000000000000fe', f: 10 };
    const f = open('unified');
    expect(f.steps.map((s) => s.t)).toEqual(['Enable trading', "Allow Velum's fee", 'Set 3x isolated leverage', 'Long 2.604 TSLA']);
    expect(text(f.review).Fees).toBe("The exchange's trading fee, plus Velum's 0.01%");
    h.builderApproved.mockResolvedValue(false);
    expect(await f.steps[1]!.run(ctx())).toBe('Approved in your wallet');
    expect(h.approveBuilder).toHaveBeenCalledWith(USER, h.builder);
    h.builderApproved.mockResolvedValue(true);
    h.approveBuilder.mockClear();
    expect(await f.steps[1]!.run(ctx())).toBeNull();
    expect(h.approveBuilder).not.toHaveBeenCalled();
    h.order.mockResolvedValue(filled('2.604', '384.12'));
    await step(f, 'Long 2.604 TSLA').run(ctx());
    expect(h.order.mock.calls[0]![0].builder).toEqual({ b: '0x00000000000000000000000000000000000000fe', f: 10 });
  });

  it('a step without an approved agent refuses to sign', async () => {
    const s = step(open('unified'), 'Long 2.604 TSLA');
    await expect(s.run({ user: USER, agent: null, out: {} })).rejects.toThrow(/not approved/);
    expect(h.order).not.toHaveBeenCalled();
  });
});

describe('close flow', () => {
  it('closes the whole position with one reduce-only IOC order on the other side', async () => {
    const plan = planClose({ market: TSLA, szi: '6.22', markPx: '383.93', slipBps: 50n })!;
    const f = closeFlow({ user: USER, sym: 'TSLA', plan, slipPct: 0.5, pnl: '-11.06' });
    expect(f.steps.map((s) => s.t)).toEqual(['Enable trading', 'Close 6.220 TSLA']);
    expect(text(f.review)).toEqual({ Position: 'Long 6.220 TSLA', 'Price limit': 'At least 382.01 (0.5% slippage)', 'Unrealized P&L': '-11.06 USDC' });
    h.order.mockResolvedValue(filled('6.22', '383.5'));
    const c = ctx();
    expect(await f.steps[1]!.run(c)).toBe('Closed 6.22 TSLA at 383.5');
    expect(h.order).toHaveBeenCalledWith({ orders: [{ a: 110001, b: false, p: '382.01', s: '6.220', r: true, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
    expect(text(f.done(c).rows)).toEqual({ Closed: '6.22 TSLA', 'Average price': '383.5 USDC' });
  });
});

describe('error wording', () => {
  it('one plain sentence for what Hyperliquid and the wallet can answer', () => {
    expect(hlErrorText({ code: 4001, message: 'User rejected the request.' })).toBe('You declined the request in your wallet. Nothing was sent.');
    expect(hlErrorText(new Error('Must deposit before performing actions. User: 0x11'))).toMatch(/no deposit yet/);
    expect(hlErrorText(new Error('order 0: Order could not immediately match against any resting orders. asset=110001'))).toMatch(/price moved past your slippage limit/);
    expect(hlErrorText(new Error('Insufficient margin to place order. asset=110001'))).toMatch(/Not enough margin/);
    expect(hlErrorText(new Error('Order must have minimum value of $10. asset=110001'))).toBe('Orders must be at least 10 USD.');
    expect(hlErrorText(new Error('User or API Wallet 0x00000000000000000000000000000000000000a1 does not exist.'))).toMatch(/no longer approved/);
    expect(hlErrorText(new Error('Your wallet switched to another account. Reconnect the account you trade with.'))).toMatch(/^Your wallet switched/);
    expect(hlErrorText(new Error('order 0: Something odd\nstack'))).toBe('The exchange refused the request: Something odd');
    expect(hlErrorText(new Error(''))).toBe('The exchange did not answer. Nothing was traded; try again.');
  });
});
