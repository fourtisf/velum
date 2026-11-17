/**
 * Real perps through Hyperliquid (mainnet build, lib/hyperliquid): the pinned markets against the live market list,
 * the order math (sizes, limit prices, margin, refusals, liquidation estimate), the order action's parameters and how
 * its answer is read, the browser-held agent's storage, and how account answers are read. Account fixtures are trimmed
 * real answers of api.hyperliquid.xyz (tests/fixtures); the signing itself is checked against the live API by
 * e2e/hyperliquid-live.e2e.ts and in the browser by e2e/hyperliquid-browser.e2e.cjs.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});
// The wallet connectors are not needed (and not loadable) in Node: these tests never sign with the user's wallet.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));

import { HL_MARKETS, HL_MAX_LEVERAGE, hlAssetId, hlCheckMarket, type HlMarket } from '@velum/config/src/hyperliquid';
import { parseWad } from '@velum/math';
import { privateKeyToAccount } from 'viem/accounts';
import metaFixture from '../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json';
import account from './fixtures/hyperliquid-account-2026-11-16.json';
import { AGENT_DAYS, agentListed, clearAgent, loadAgent, newAgent, saveAgent } from '@/lib/hyperliquid/agent';
import { builderFromEnv, builderRate, modeOf, readBalances, readFills, readPositions } from '@/lib/hyperliquid/client';
import { HL_PERPS } from '@/lib/hyperliquid/enabled';
import { limitPrice, liqEstimate, orderOutcome, orderParams, planClose, planOpen } from '@/lib/hyperliquid/order';
import { HL, UNI, refTitle } from '@/lib/copy';

const universe = (metaFixture.body[0] as { universe: unknown[] }).universe;
const TSLA = hlCheckMarket('TSLA', universe)!;
const NFLX = hlCheckMarket('NFLX', universe)!;
const W = (v: string) => parseWad(v)!;

describe('mainnet build', () => {
  it('trades perps through Hyperliquid unless the build turns it off', () => {
    expect(HL_PERPS).toBe(true);
  });
});

describe('pinned xyz markets', () => {
  it('asset ids follow 100000 + dex index (1) x 10000 + market index', () => {
    expect(hlAssetId(1)).toBe(110001);
    expect(HL_MARKETS.TSLA!.asset).toBe(110001);
    expect(HL_MARKETS.NFLX!.asset).toBe(110019);
    expect(Object.keys(HL_MARKETS).sort()).toEqual(['AAPL', 'AMD', 'AMZN', 'COIN', 'META', 'MSFT', 'NFLX', 'NVDA', 'PLTR', 'TSLA']);
  });

  it('every pinned market is at its index in the real market list, with its live size decimals and max leverage', () => {
    for (const sym of Object.keys(HL_MARKETS)) {
      const m = hlCheckMarket(sym, universe);
      expect(m, sym).not.toBeNull();
      expect(m!.coin).toBe(`xyz:${sym}`);
    }
    expect(TSLA).toMatchObject({ szDecimals: 3, maxLeverage: 20 });
    expect(NFLX).toMatchObject({ szDecimals: 3, maxLeverage: 10 });
  });

  it('a moved, renamed or delisted market is refused (never an order on the wrong asset)', () => {
    const moved = universe.slice();
    moved[1] = { szDecimals: 3, name: 'xyz:OTHER', maxLeverage: 20 };
    expect(hlCheckMarket('TSLA', moved)).toBeNull();
    const delisted = universe.slice();
    delisted[1] = { ...(universe[1] as object), isDelisted: true };
    expect(hlCheckMarket('TSLA', delisted)).toBeNull();
    expect(hlCheckMarket('TSLA', universe.slice(0, 1))).toBeNull();
    expect(hlCheckMarket('TSLA', null)).toBeNull();
    expect(hlCheckMarket('HOOD', universe)).toBeNull();
  });

  it('an implausible max leverage falls back to the cautious pinned 10', () => {
    const odd = universe.slice();
    odd[1] = { ...(universe[1] as object), maxLeverage: 1000 };
    expect(hlCheckMarket('TSLA', odd)!.maxLeverage).toBe(10);
  });
});

describe('order math', () => {
  it('the IOC limit is the mark moved against the user, at most 5 significant figures, rounded down', () => {
    expect(limitPrice('383.93', true, 50n, 3)).toBe('385.84');
    expect(limitPrice('383.93', false, 50n, 3)).toBe('382.01');
    expect(limitPrice('1234.567', true, 0n, 3)).toBe('1234.5');
    expect(limitPrice('0', true, 50n, 3)).toBeNull();
    expect(limitPrice('abc', true, 50n, 3)).toBeNull();
  });

  it('opens about the size asked: size rounded down to the lot, margin at the leverage plus a 0.1% fee allowance', () => {
    const r = planOpen({ market: TSLA, long: true, notionalUsd: '1000', leverage: 3, markPx: '383.93', slipBps: 50n });
    expect(r).toEqual({
      ok: true,
      plan: { asset: 110001, coin: 'xyz:TSLA', isBuy: true, size: '2.604', limitPx: '385.84', leverage: 3, notional: '999.75', margin: '334.26' },
    });
    const s = planOpen({ market: TSLA, long: false, notionalUsd: '1000', leverage: 3, markPx: '383.93', slipBps: 50n });
    expect(s.ok && s.plan).toMatchObject({ isBuy: false, size: '2.604', limitPx: '382.01' });
  });

  it('refuses a leverage that is not a whole number from 1 to 5 (and within the market maximum)', () => {
    const base = { market: TSLA, long: true, notionalUsd: '100', markPx: '383.93', slipBps: 50n };
    for (const leverage of [0, 2.5, HL_MAX_LEVERAGE + 1, -1, Number.NaN]) expect(planOpen({ ...base, leverage })).toEqual({ ok: false, reason: 'leverage' });
    const low: HlMarket = { ...TSLA, maxLeverage: 3 };
    expect(planOpen({ ...base, market: low, leverage: 4 })).toEqual({ ok: false, reason: 'leverage' });
    expect(planOpen({ ...base, market: low, leverage: 3 }).ok).toBe(true);
  });

  it("refuses an order under Hyperliquid's 10 USD minimum, a size that rounds to zero, and a bad price", () => {
    const base = { market: TSLA, long: true, leverage: 2, markPx: '383.93', slipBps: 50n };
    expect(planOpen({ ...base, notionalUsd: '9.99' })).toEqual({ ok: false, reason: 'min' });
    // 10.30 USD buys 0.026 TSLA = 9.98 USD after rounding down to the lot: still under the minimum.
    expect(planOpen({ ...base, notionalUsd: '10.30' })).toEqual({ ok: false, reason: 'min' });
    expect(planOpen({ ...base, notionalUsd: '0.1' })).toEqual({ ok: false, reason: 'size' });
    expect(planOpen({ ...base, notionalUsd: '0' })).toEqual({ ok: false, reason: 'size' });
    expect(planOpen({ ...base, notionalUsd: '100', markPx: '0' })).toEqual({ ok: false, reason: 'price' });
  });

  it('refuses a position above 100 tokens, counting what is already held on either side', () => {
    const base = { market: TSLA, leverage: 2, markPx: '383.93', slipBps: 50n };
    expect(planOpen({ ...base, long: true, notionalUsd: '38500' })).toEqual({ ok: false, reason: 'max' });
    expect(planOpen({ ...base, long: true, notionalUsd: '3839', currentSzi: '90.5' })).toEqual({ ok: false, reason: 'max' });
    // Selling against a 90.5 long only reduces it.
    expect(planOpen({ ...base, long: false, notionalUsd: '3839', currentSzi: '90.5' }).ok).toBe(true);
    expect(planOpen({ ...base, long: true, notionalUsd: '3839', currentSzi: '-90.5' }).ok).toBe(true);
    expect(planOpen({ ...base, long: false, notionalUsd: '3839', currentSzi: '-90.5' })).toEqual({ ok: false, reason: 'max' });
  });

  it('closes the whole position with an order on the other side', () => {
    expect(planClose({ market: TSLA, szi: '6.22', markPx: '383.93', slipBps: 100n })).toEqual({ asset: 110001, coin: 'xyz:TSLA', isBuy: false, size: '6.220', limitPx: '380.09' });
    expect(planClose({ market: TSLA, szi: '-92.394', markPx: '160.1', slipBps: 50n })).toMatchObject({ isBuy: true, size: '92.394', limitPx: '160.9' });
    expect(planClose({ market: TSLA, szi: '0', markPx: '160', slipBps: 50n })).toBeNull();
    expect(planClose({ market: TSLA, szi: '1', markPx: '0', slipBps: 50n })).toBeNull();
  });

  it("estimates the isolated liquidation price with Hyperliquid's maintenance margin (half the initial margin at max leverage)", () => {
    // TSLA max 20x: maintenance 2.5%. Long 3x: 383.93 x (2/3) / 0.975 = 262.516…; short 3x: 383.93 x (4/3) / 1.025 = 499.42…
    const long = liqEstimate(W('383.93'), true, 3, 20)!;
    expect(long > W('262.51') && long < W('262.52')).toBe(true);
    const short = liqEstimate(W('383.93'), false, 3, 20)!;
    expect(short > W('499.42') && short < W('499.43')).toBe(true);
    expect(liqEstimate(W('383.93'), true, 1, 20)).toBeNull();
    expect(liqEstimate(0n, true, 3, 20)).toBeNull();
  });
});

describe('order action', () => {
  const plan = { asset: 110001, isBuy: true, size: '2.604', limitPx: '385.84' };

  it('one immediate-or-cancel limit order, no builder fee by default', () => {
    expect(orderParams({ ...plan, reduceOnly: false }, null)).toEqual({ orders: [{ a: 110001, b: true, p: '385.84', s: '2.604', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
  });

  it('carries the builder fee when the build sets one', () => {
    const b = { b: '0x00000000000000000000000000000000000000aa' as const, f: 10 };
    expect(orderParams({ ...plan, reduceOnly: true }, b)).toEqual({ orders: [{ a: 110001, b: true, p: '385.84', s: '2.604', r: true, t: { limit: { tif: 'Ioc' } } }], grouping: 'na', builder: b });
  });

  it("reads the order's status strictly", () => {
    const ok = (status: unknown) => ({ status: 'ok', response: { type: 'order', data: { statuses: [status] } } });
    expect(orderOutcome(ok({ filled: { totalSz: '2.604', avgPx: '384.1', oid: 77 } }))).toEqual({ kind: 'filled', totalSz: '2.604', avgPx: '384.1', oid: 77 });
    expect(orderOutcome(ok({ resting: { oid: 5 } }))).toEqual({ kind: 'resting', oid: 5 });
    expect(orderOutcome(ok({ error: 'Order could not immediately match against any resting orders. asset=110001' }))).toEqual({ kind: 'error', message: 'Order could not immediately match against any resting orders. asset=110001' });
    expect(orderOutcome(ok({ filled: { totalSz: 2.6, avgPx: '1', oid: 1 } })).kind).toBe('error');
    expect(orderOutcome(null).kind).toBe('error');
    expect(orderOutcome({ status: 'ok', response: { type: 'default' } }).kind).toBe('error');
  });
});

describe('builder fee from the build', () => {
  const addr = '0x' + 'aB'.repeat(20);
  it('is off unless both a valid address and a fee of 1 to 100 tenths of a basis point are set', () => {
    expect(builderFromEnv(undefined, undefined)).toBeNull();
    expect(builderFromEnv(addr, '')).toBeNull();
    expect(builderFromEnv(addr, '0')).toBeNull();
    expect(builderFromEnv(addr, '101')).toBeNull();
    expect(builderFromEnv(addr, '1.5')).toBeNull();
    expect(builderFromEnv('0x1234', '10')).toBeNull();
    expect(builderFromEnv(addr, '10')).toEqual({ b: addr.toLowerCase(), f: 10 });
  });
  it("is written as Hyperliquid's percent string", () => {
    expect(builderRate(10)).toBe('0.01%');
    expect(builderRate(1)).toBe('0.001%');
    expect(builderRate(100)).toBe('0.1%');
    expect(builderRate(25)).toBe('0.025%');
  });
});

/** An in-memory Storage. */
function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('browser-held agent', () => {
  const USER = '0x1111111111111111111111111111111111111111';
  const NOW = 1_794_800_000_000;

  it('is a fresh key named "velum valid_until <ms>", 30 days ahead, its address its own', () => {
    const a = newAgent(USER, NOW);
    expect(a.name).toBe(`velum valid_until ${NOW + AGENT_DAYS * 86_400_000}`);
    expect(a.validUntil).toBe(NOW + 30 * 86_400_000);
    expect(a.address).toBe(privateKeyToAccount(a.pk).address.toLowerCase());
    expect(newAgent(USER, NOW).pk).not.toBe(a.pk);
  });

  it('is stored per user in this browser only and read back while it has more than a day left', () => {
    const s = memory();
    const a = newAgent(USER, NOW);
    saveAgent(a, s);
    expect(s.getItem(`velum:hl-agent:${USER}`)).not.toBeNull();
    expect(loadAgent(USER, NOW, s)).toEqual({ user: a.user, address: a.address, pk: a.pk, validUntil: a.validUntil });
    expect(loadAgent(USER.toUpperCase().replace('0X', '0x'), NOW, s)).not.toBeNull();
    expect(loadAgent('0x2222222222222222222222222222222222222222', NOW, s)).toBeNull();
    expect(loadAgent(USER, a.validUntil - 86_400_000 + 1, s)).toBeNull();
    clearAgent(USER, s);
    expect(loadAgent(USER, NOW, s)).toBeNull();
  });

  it('ignores a tampered or malformed entry', () => {
    const s = memory();
    const a = newAgent(USER, NOW);
    s.setItem(`velum:hl-agent:${USER}`, JSON.stringify({ ...a, address: '0x' + '3'.repeat(40) }));
    expect(loadAgent(USER, NOW, s)).toBeNull();
    s.setItem(`velum:hl-agent:${USER}`, '{not json');
    expect(loadAgent(USER, NOW, s)).toBeNull();
    s.setItem(`velum:hl-agent:${USER}`, JSON.stringify({ ...a, pk: '0x12' }));
    expect(loadAgent(USER, NOW, s)).toBeNull();
    expect(loadAgent(USER, NOW, null)).toBeNull();
  });

  it("is used only while Hyperliquid still lists it among the user's agents", () => {
    const agents = [{ name: 'velum valid_until 1', address: '0xAbC0000000000000000000000000000000000001', validUntil: 1 }];
    expect(agentListed(agents, '0xabc0000000000000000000000000000000000001')).toBe(true);
    expect(agentListed(agents, '0xabc0000000000000000000000000000000000002')).toBe(false);
    expect(agentListed([], '0xabc0000000000000000000000000000000000001')).toBe(false);
    expect(agentListed(null, '0xabc0000000000000000000000000000000000001')).toBe(false);
  });
});

describe('account answers (trimmed real answers)', () => {
  it('account modes: unified and portfolio margin share one USDC balance, everything else is standard', () => {
    expect(modeOf('unifiedAccount')).toBe('unified');
    expect(modeOf('portfolioMargin')).toBe('portfolio');
    for (const m of ['disabled', 'default', 'dexAbstraction', null, 42]) expect(modeOf(m)).toBe('standard');
  });

  it('positions: only the Velum markets on the xyz dex, with side, leverage and margin type', () => {
    const p = readPositions(account.xyz);
    expect(p.map((x) => [x.symbol, x.szi, x.leverage, x.isolated, x.liquidationPx])).toEqual([
      ['TSLA', '6.22', 20, false, null],
      ['NVDA', '-92.394', 10, false, '626.0932775268'],
    ]);
    expect(readPositions({ assetPositions: [{ position: { coin: 'xyz:TSLA', szi: '0.0' } }] })).toEqual([]);
    expect(readPositions(null)).toEqual([]);
  });

  it('balances of a standard account: the xyz dex balance now, the main balance movable to it', () => {
    const b = readBalances('standard', account.xyz, account.main, account.spot);
    expect(b.xyzAvailable).toBe(7213.972701);
    expect(b.mainAvailable).toBe(9018.339306);
    expect(b.positions).toHaveLength(2);
    expect(b.funded).toBe(true);
  });

  it('balances of a unified account: the spot USDC balance, less what is on hold', () => {
    const b = readBalances('unified', account.xyz, account.main, { balances: [{ coin: 'USDC', total: '125.5', hold: '25.5' }] });
    expect(b.xyzAvailable).toBe(100);
    expect(b.mainAvailable).toBe(0);
  });

  it('an account with nothing anywhere is not funded (Hyperliquid refuses approvals before a first deposit)', () => {
    const empty = { marginSummary: { accountValue: '0.0' }, withdrawable: '0.0', assetPositions: [] };
    expect(readBalances('standard', empty, empty, { balances: [] }).funded).toBe(false);
    expect(readBalances('unified', empty, empty, { balances: [{ coin: 'USDC', total: '5.0', hold: '0.0' }] }).funded).toBe(true);
  });

  it('fills: only the Velum markets, newest first', () => {
    const f = readFills(account.fills);
    expect(f.map((x) => [x.symbol, x.dir])).toEqual([
      ['AMD', 'Close Short'],
      ['AMD', 'Open Short'],
    ]);
    expect(f[0]!.time).toBeGreaterThanOrEqual(f[1]!.time);
    expect(readFills('nope')).toEqual([]);
  });
});

describe('wording', () => {
  it('says plainly that perps are real, from the user’s own Hyperliquid account, public and liquidatable', () => {
    expect(UNI.banner).toBe('Spot trades are real Uniswap swaps from your wallet. Perps are real leveraged trades from your own account. Private accounts are in development.');
    expect(HL.perpsNote).toMatch(/real leveraged trade from your own perps account/);
    expect(HL.perpsNote).toMatch(/Public, not private/);
    // The app's wording names no venue (owner request); the confirmation dialog's "Venue" row discloses it.
    for (const t of [UNI.banner, HL.perpsNote, HL.unavailable, HL.noPositions, HL.noFills, HL.depositHint, HL.connectPositions]) expect(t).not.toMatch(/Hyperliquid/);
    expect(HL.perpsNote).toMatch(/can be liquidated/);
    // No venue name in the app's wording (owner request): the metrics are the traded market's own.
    expect(refTitle('Hyperliquid', 'TSLA')).toMatch(/^TSLA perp: live mark, funding and open interest of the market the Perps ticket trades\.$/);
    expect(refTitle('Lighter', 'TSLA')).toMatch(/until Velum's own perps are live/);
  });
});
