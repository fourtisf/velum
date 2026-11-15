/**
 * Phase 3 flows and what feeds them: the web ABIs agree with packages/config and parse every error the
 * contracts raise; reverts are decoded into sentences; flow builders ask for exact approvals, module
 * approvals only when missing and always send non-zero limits; the offer book picks the best fitting offer;
 * API activity and positions are validated; totals value every holding or none.
 */
import { BOOK_ABI as CFG_BOOK, PERPS_ABI as CFG_PERPS, SPOT_ABI as CFG_SPOT, VAULT_ABI as CFG_VAULT } from '@velum/config/src/onchain-abi';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fragment, createElement, type ReactNode } from 'react';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type AbiEvent,
  type AbiFunction,
} from 'viem';
import { describe, expect, it } from 'vitest';
import type { ActivityDTO } from '@/lib/api';
import { ALL_ERRORS_ABI, BOOK_ABI, ERC20_ABI, PERPS_ABI, SPOT_ABI, VAULT_ABI } from '@/lib/onchain/abi';
import { activityRow, dec } from '@/lib/onchain/activity';
import type { Deployment, OnchainInfo } from '@/lib/onchain/deployment';
import { decodeTxError, describeRevert, isUserRejection, type ErrorContext } from '@/lib/onchain/errors';
import type { Row, TxRunCtx } from '@/lib/onchain/flow';
import { closeFlow, depositFlow, exact, marginFlow, openFlow, postOfferFlow, swapFlow, withdrawFlow, withdrawOfferFlow, forcedExitFlow } from '@/lib/onchain/flows';
import { openQuote, valueScaleFor } from '@/lib/onchain/quote';
import { apiActivity, apiOpenPositions, bestOffer, priceUsable, type ChainPosition, type Offer, type Protocol } from '@/lib/onchain/reads';
import { positionValue, tokenValue, vaultTotals } from '@/lib/onchain/totals';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const E6 = 1_000_000n;
const E18 = 10n ** 18n;
const VS = valueScaleFor(6);
const D: Deployment = {
  chainId: 46630,
  startBlock: 1,
  contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) },
  tokens: { USDG: A(10), TSLA: A(11), AMZN: A(12) },
  priceRelayer: null,
  guardian: null,
};
const OC: OnchainInfo = { d: D, markets: ['AMZN', 'TSLA'], closeOnly: null };
const PROTO: Protocol = { decimals: { USDG: 6, TSLA: 18, AMZN: 18 }, valueScale: VS, minPositionSize: 10n * E6, bond: 10n ** 15n, exitDelay: 7n * 86_400n };
const ME = A(77);
const BASE = { oc: OC, proto: PROTO, account: ME };
const CTX: ErrorContext = {
  sym: (a) => Object.entries(D.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0] ?? null,
  dec: (a) => {
    const s = Object.entries(D.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0];
    return s ? PROTO.decimals[s]! : null;
  },
};
const text = (rows: Row[]) => renderToStaticMarkup(createElement(Fragment, null, ...rows.map(([k, v], i) => createElement('p', { key: i }, k as ReactNode, ': ', v as ReactNode))));
const ctx = (): TxRunCtx => ({ d: D, proto: PROTO, account: ME, out: {}, txs: [] });

describe('ABIs', () => {
  const fnSig = (abi: readonly unknown[]) => (abi as Array<{ type: string }>).filter((x): x is AbiFunction => x.type === 'function').map((f) => toFunctionSelector(f));
  const evSig = (abi: readonly unknown[]) => (abi as Array<{ type: string }>).filter((x): x is AbiEvent => x.type === 'event').map((e) => toEventSelector(e));

  it('functions and events the web shares with packages/config have the same signatures', () => {
    for (const [mine, cfg] of [
      [VAULT_ABI, CFG_VAULT],
      [SPOT_ABI, CFG_SPOT],
      [BOOK_ABI, CFG_BOOK],
      [PERPS_ABI, CFG_PERPS],
    ] as const) {
      const theirs = parseAbi(cfg as readonly string[]);
      const cf = new Set(fnSig(theirs));
      const ce = new Set(evSig(theirs));
      const names = new Map((theirs as unknown as Array<{ type: string; name?: string }>).map((x) => [x.name, x.type]));
      for (const f of (mine as readonly { type: string; name?: string }[]).filter((x) => x.type === 'function')) if (names.get(f.name) === 'function') expect(cf.has(toFunctionSelector(f as AbiFunction)), f.name).toBe(true);
      for (const e of (mine as readonly { type: string; name?: string }[]).filter((x) => x.type === 'event')) if (names.get(e.name) === 'event') expect(ce.has(toEventSelector(e as AbiEvent)), e.name).toBe(true);
    }
  });

  it('every custom error in the contract sources is decodable', () => {
    const dir = path.join(__dirname, '../../../contracts/src');
    const files = ['VelumVault.sol', 'SpotPools.sol', 'MakerBook.sol', 'OracleAdapter.sol', 'perps/PerpsBase.sol'];
    const names = new Set(ALL_ERRORS_ABI.map((e) => (e as { name: string }).name));
    const setupOnly = new Set(['NotDeployer', 'AlreadySetUp', 'LengthMismatch', 'BadBounds', 'BadFeedDecimals', 'SequencerFeedRequired', 'BadGuardConfig', 'BadCaps', 'CapDecrease', 'NotGuardAdmin', 'NotPendingGuardAdmin', 'AllowlistInactive', 'CapsInactive', 'NotRelayer', 'TooSoon', 'ObservedInFuture', 'PushExpired', 'StaleObservation', 'NotGuardian', 'NotModule', 'NotSetUp', 'DuplicateToken']);
    for (const f of files) {
      for (const m of readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*error (\w+)\(/gm)) {
        if (!setupOnly.has(m[1]!)) expect(names.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });

  it('the ERC-20 ABI has approve and allowance (exact approvals)', () => {
    expect(fnSig(ERC20_ABI)).toContain(toFunctionSelector('function approve(address,uint256)'));
    expect(fnSig(ERC20_ABI)).toContain(toFunctionSelector('function allowance(address,address)'));
  });
});

describe('revert decoding', () => {
  const revert = (abi: typeof PERPS_ABI | typeof SPOT_ABI | typeof VAULT_ABI, errorName: string, args: readonly unknown[]) => {
    const data = encodeErrorResult({ abi, errorName, args } as never);
    return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName: 'x' }), { abi, functionName: 'x', args: [], contractAddress: A(5) });
  };

  it('a price limit (slippage exceeded) says what happened and that nothing traded', () => {
    const d = decodeTxError(revert(PERPS_ABI, 'PriceLimit', [393_1965n * 10n ** 14n, 392_2376n * 10n ** 14n]), CTX, D.tokens.USDG!);
    expect(d.name).toBe('PriceLimit');
    expect(d.message).toMatch(/slippage limit.*393\.1965.*392\.2376.*Nothing was traded/);
    expect(d.rejected).toBe(false);
  });

  it('amounts use the token decimals', () => {
    expect(decodeTxError(revert(VAULT_ABI, 'InsufficientBalance', [ME, D.tokens.USDG, 5n * E6, 7_500_000n]), CTX, D.tokens.USDG!).message).toBe('Not enough in your vault balance: you have 5 USDG, this needs 7.5 USDG.');
    expect(decodeTxError(revert(VAULT_ABI, 'AccountCapExceeded', [ME, D.tokens.TSLA, 3n * E18, 2n * E18]), CTX, D.tokens.USDG!).message).toMatch(/3 TSLA, over the cap of 2 TSLA/);
    expect(decodeTxError(revert(SPOT_ABI, 'Slippage', [900n, 950n]), CTX, D.tokens.USDG!, { outToken: D.tokens.USDG }).message).toMatch(/0\.0009 USDG, below your minimum of 0\.00095 USDG/);
  });

  it('guard, staleness, lagging and close-only have their own sentences', () => {
    expect(describeRevert('NotAllowlisted', [ME], CTX, D.tokens.USDG!)).toMatch(/allowlist/);
    expect(describeRevert('StalePrice', [A(11), 1n], CTX, D.tokens.USDG!)).toMatch(/too old/);
    expect(describeRevert('PriceLagging', [A(11)], CTX, D.tokens.USDG!)).toMatch(/catching up/);
    expect(describeRevert('CloseOnly', [A(11)], CTX, D.tokens.USDG!)).toMatch(/closes/);
    expect(describeRevert('SomethingNew', [], CTX, D.tokens.USDG!)).toBe('The contract refused this transaction (SomethingNew).');
  });

  it('raw revert data is decoded with every contract error', () => {
    const data = encodeErrorResult({ abi: PERPS_ABI, errorName: 'NoPriceLimit', args: [] });
    const e = new BaseError('call reverted', { cause: Object.assign(new Error('x'), { data }) });
    expect(decodeTxError(e, CTX, D.tokens.USDG!).name).toBe('NoPriceLimit');
  });

  it('a declined wallet request is not an error of the contract', () => {
    const e = new UserRejectedRequestError(new Error('User rejected the request.'));
    expect(isUserRejection(e)).toBe(true);
    expect(decodeTxError(e, CTX, D.tokens.USDG!)).toMatchObject({ rejected: true, message: expect.stringMatching(/declined.*Nothing was sent/) });
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error('boom'))).toBe(false);
  });
});

describe('flow builders', () => {
  it('deposit: exact approval (skipped when the allowance covers it is decided on chain), then deposit to self', async () => {
    const f = depositFlow(BASE, 'USDG', 2500n * E6);
    expect(text(f.review)).toMatch(/Deposit: 2,500 USDG/);
    expect(text(f.review)).toMatch(/Exactly 2,500 USDG/);
    expect(f.steps.map((s) => s.label)).toEqual(['Token approval', 'Deposit']);
    const dep = await f.steps[1]!.call(ctx());
    expect(dep).toMatchObject({ address: D.contracts.vault, functionName: 'deposit', args: [D.tokens.USDG, 2500n * E6, ME] });
  });

  it('withdraw: to the given address, no approval needed', async () => {
    const f = withdrawFlow(BASE, 'TSLA', 15n * 10n ** 17n, A(88));
    expect(f.steps).toHaveLength(1);
    expect(await f.steps[0]!.call(ctx())).toMatchObject({ functionName: 'withdraw', args: [D.tokens.TSLA, 15n * 10n ** 17n, A(88)] });
    expect(text(f.review)).toMatch(/1\.5 TSLA/);
  });

  it('open: module approval, then open with a non-zero price limit, waiting out a stale or lagging price', async () => {
    const offer: Offer = { id: 3n, maker: A(9), market: D.tokens.TSLA!, backing: 10_000n * E6, largestFill: 5_000n * E6, openBps: 5, closeBps: 5, expiry: 10n ** 12n, active: true };
    const q = openQuote({ price: 400n * E18, size: 500n * E6, levHalf: 4, long: true, openBps: 5, slipBps: 50n, valueScale: VS });
    const f = openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 500n * E6, offer, q, slip: 50n, oraclePrice: 400n * E18 });
    expect(f.steps[0]!.label).toBe('Approval');
    const open = f.steps[1]!;
    expect(open.waitFor).toEqual(['StalePrice', 'PriceLagging']);
    const call = await open.call(ctx());
    expect(call).toMatchObject({ address: D.contracts.perpsMarkets, functionName: 'open', args: [3n, D.tokens.TSLA, true, 500n * E6, 4, q.priceLimit] });
    expect(q.priceLimit).toBeGreaterThan(0n);
    const r = text(f.review);
    expect(r).toMatch(/Fee \(0\.06%\): 0\.3 USDG/);
    expect(r).toMatch(/Liquidation \(est\.\): [\d,]+\.\d\d/);
    expect(r).toMatch(/Total from your vault: 250\.3 USDG/);
    expect(r).toMatch(/Price limit: At most [\d,.]+ \(0\.5% slippage\)/);
  });

  it('close: a non-zero limit from the slippage (at least for longs)', async () => {
    const pos: ChainPosition = { id: 7n, sym: 'TSLA', role: 'taker', long: true, levHalf: 4, closeBps: 5, qty: E18, entry: 400n * E18, takerMargin: 200n * E6, makerMargin: 80n * E6, openedAt: 1n, exitRequestedAt: 0n, exitRequester: A(0), openTx: null };
    const f = closeFlow(BASE, { pos, exit: 399n * E18, fee: 239_400n, estOut: 199n * E6, slip: 100n });
    const call = await f.steps[0]!.call(ctx());
    expect(call).toMatchObject({ functionName: 'close', args: [7n, (399n * E18 * 9900n) / 10_000n] });
    expect(text(f.review)).toMatch(/At least [\d,.]+ \(1% slippage\)/);
  });

  it('margin: adding asks for the module approval, removing waits for a fresh price', async () => {
    const pos: ChainPosition = { id: 7n, sym: 'TSLA', role: 'taker', long: false, levHalf: 4, closeBps: 5, qty: E18, entry: 400n * E18, takerMargin: 200n * E6, makerMargin: 80n * E6, openedAt: 1n, exitRequestedAt: 0n, exitRequester: A(0), openTx: null };
    const add = marginFlow(BASE, pos, true, 50n * E6);
    expect(add.steps.map((s) => s.label)).toEqual(['Approval', 'Add margin']);
    expect(text(add.review)).toMatch(/Margin after: 250 USDG/);
    const rm = marginFlow(BASE, pos, false, 50n * E6);
    expect(rm.steps).toHaveLength(1);
    expect(rm.steps[0]!.waitFor).toContain('StalePrice');
    expect(await rm.steps[0]!.call(ctx())).toMatchObject({ functionName: 'removeMargin', args: [7n, 50n * E6] });
  });

  it('forced exit: pays exactly the bond', async () => {
    const pos: ChainPosition = { id: 9n, sym: 'TSLA', role: 'maker', long: true, levHalf: 4, closeBps: 5, qty: E18, entry: 400n * E18, takerMargin: 200n * E6, makerMargin: 80n * E6, openedAt: 1n, exitRequestedAt: 0n, exitRequester: A(0), openTx: null };
    const f = forcedExitFlow(BASE, pos);
    expect(await f.steps[0]!.call(ctx())).toMatchObject({ functionName: 'requestForcedExit', args: [9n], value: 10n ** 15n });
    expect(text(f.review)).toMatch(/0\.001 ETH/);
    expect(text(f.review)).toMatch(/After 7 days/);
  });

  it('swap: a non-zero minimum and a deadline', async () => {
    const f = swapFlow(BASE, { from: 'USDG', to: 'TSLA', amountIn: 100n * E6, quote: 25n * 10n ** 16n, min: 24875n * 10n ** 13n, hops: 1, slip: 50n, fee: '0.30 USDG' });
    expect(f.steps.map((s) => s.label)).toEqual(['Approval', 'Swap']);
    expect(f.steps[1]!.outToken).toBe(D.tokens.TSLA);
    expect(text(f.review)).toMatch(/Minimum you get: 0\.24875 TSLA \(0\.5% slippage\)/);
  });

  it('maker offer: approval, then post with whole-bps spreads; withdraw returns the unused backing', async () => {
    const f = postOfferFlow(BASE, { sym: 'TSLA', backing: 1000n * E6, largestFill: 500n * E6, openBps: 8, closeBps: 5, duration: 86_400n, durationLabel: '24 hours' });
    expect(f.steps.map((s) => s.label)).toEqual(['Approval', 'Post offer']);
    expect(text(f.review)).toMatch(/Up to 5 × backing \(5,000 USDG/);
    const o: Offer = { id: 4n, maker: ME, market: D.tokens.TSLA!, backing: 600n * E6, largestFill: 500n * E6, openBps: 8, closeBps: 5, expiry: 1n, active: true };
    const w = withdrawOfferFlow(BASE, o, 'TSLA');
    expect(await w.steps[0]!.call(ctx())).toMatchObject({ functionName: 'withdrawOffer', args: [4n] });
    expect(text(w.review)).toMatch(/600 USDG/);
  });

  it('exact amounts: no rounding, thousands separators', () => {
    expect(exact(1_234_567_891n, 6, 'USDG')).toBe('1,234.567891 USDG');
    expect(exact(10n ** 18n, 18)).toBe('1');
    expect(exact(-1_500_000n, 6)).toBe('-1.5');
    expect(exact(0n, 6)).toBe('0');
  });

  it('no flow claims privacy or simulation', () => {
    const offer: Offer = { id: 3n, maker: A(9), market: D.tokens.TSLA!, backing: 10_000n * E6, largestFill: 5_000n * E6, openBps: 5, closeBps: 5, expiry: 10n ** 12n, active: true };
    const q = openQuote({ price: 400n * E18, size: 500n * E6, levHalf: 4, long: true, openBps: 5, slipBps: 50n, valueScale: VS });
    for (const f of [depositFlow(BASE, 'USDG', E6), openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 500n * E6, offer, q, slip: 50n, oraclePrice: 400n * E18 })]) {
      const all = `${f.title} ${text(f.review)} ${f.note ?? ''} ${f.steps.map((s) => `${s.t} ${s.d ?? ''}`).join(' ')}`;
      expect(all).not.toMatch(/simulat|privately|private balance|tokenized/i);
    }
  });
});

describe('offer book', () => {
  const o = (id: number, x: Partial<Offer> = {}): Offer => ({ id: BigInt(id), maker: A(9), market: D.tokens.TSLA!, backing: 1000n * E6, largestFill: 1000n * E6, openBps: 10, closeBps: 5, expiry: 2000n, active: true, ...x });

  it('the lowest open spread that fits the size, never the taker’s own, inactive or expiring offers', () => {
    const list = [o(1, { openBps: 20 }), o(2, { openBps: 5, maker: ME }), o(3, { openBps: 6, active: false }), o(4, { openBps: 7, expiry: 1010n }), o(5, { openBps: 8, largestFill: 100n * E6 }), o(6, { openBps: 9 }), o(7, { openBps: 9 })];
    expect(bestOffer(list, D.tokens.TSLA!, 500n * E6, ME, 1000n)?.id).toBe(6n);
    expect(bestOffer(list, D.tokens.TSLA!, 50n * E6, ME, 1000n)?.id).toBe(5n);
    expect(bestOffer(list, D.tokens.AMZN!, 50n * E6, ME, 1000n)).toBeNull();
  });

  it('backing must cover the 20% maker margin', () => {
    expect(bestOffer([o(1, { backing: 99n * E6 })], D.tokens.TSLA!, 500n * E6, ME, 0n)).toBeNull();
    expect(bestOffer([o(1, { backing: 100n * E6 })], D.tokens.TSLA!, 500n * E6, ME, 0n)?.id).toBe(1n);
  });
});

describe('oracle freshness', () => {
  const p = (age: bigint, lagging = false) => ({ price: E18, updatedAt: 100n, now: 100n + age, lagging, closeOnly: false, fundingRate: 0n });
  it('opens need 10 s, closes 60 s, and never a lagging price', () => {
    expect(priceUsable(p(10n), 'open')).toBe(true);
    expect(priceUsable(p(11n), 'open')).toBe(false);
    expect(priceUsable(p(60n), 'close')).toBe(true);
    expect(priceUsable(p(61n), 'close')).toBe(false);
    expect(priceUsable(p(1n, true), 'close')).toBe(false);
    expect(priceUsable(null, 'close')).toBe(false);
  });
});

describe('API answers are validated', () => {
  it('open positions: only well-formed open ones', () => {
    expect(apiOpenPositions([{ id: '12', status: 'open', openTx: '0x' + 'a'.repeat(64) }, { id: '13', status: 'closed' }, { id: 'x', status: 'open' }, null, { id: '14', status: 'open', openTx: 'bad' }])).toEqual([
      { id: 12n, openTx: '0x' + 'a'.repeat(64) },
      { id: 14n, openTx: null },
    ]);
    expect(apiOpenPositions({ error: 1 })).toEqual([]);
  });

  it('activity: items need a kind, a transaction hash and data', () => {
    const good = { kind: 'swap', tx: '0x' + 'b'.repeat(64), block: 1, logIndex: 0, at: 1, contract: A(3), market: null, token: null, positionId: null, data: {} };
    expect(apiActivity({ items: [good, { ...good, tx: 'nope' }, { ...good, data: null }, 'x'] })).toHaveLength(1);
    expect(apiActivity(null)).toEqual([]);
  });
});

describe('activity rows', () => {
  const item = (kind: string, data: Record<string, unknown>, market: string | null = 'TSLA'): ActivityDTO => ({ kind, tx: '0x' + 'c'.repeat(64), block: 1, logIndex: 0, at: 1000, contract: A(5), market, token: null, positionId: null, data });

  it('deposits, opens, swaps and settlements read like the prototype rows', () => {
    expect(activityRow(item('deposit', { token: 'USDG', amount: '2000', from: ME, to: ME }), ME)).toMatchObject({ title: 'Shielded 2,000.00 USDG', icon: 'shieldIn' });
    expect(activityRow(item('position_open', { role: 'taker', side: 'short', qty: '1.5', entry: '391.85', takerMargin: '250' }), ME).title).toBe('Opened short TSLA');
    expect(activityRow(item('swap', { tokenIn: 'USDG', tokenOut: 'TSLA', amountIn: '100', amountOut: '0.2539' }), ME).title).toBe('Swapped 100.00 USDG for 0.2539 TSLA');
    expect(activityRow(item('position_settled', { role: 'taker', positionId: '2', pnl: '-0.2', payout: '96.32' }), ME).sub).toBe('P&L -$0.20, 96.32 USDG back to your vault');
    expect(activityRow(item('weird_new_kind', {}), ME).title).toBe('weird new kind');
  });

  it('malformed amounts show a dash, never a guess', () => {
    expect(dec('1e30')).toBe('—');
    expect(dec(5)).toBe('—');
    expect(dec('12.5.7')).toBe('—');
    expect(dec('-3.456', 2)).toBe('-3.46');
  });
});

describe('vault totals', () => {
  const pos = (x: Partial<ChainPosition> = {}): ChainPosition => ({ id: 1n, sym: 'TSLA', role: 'taker', long: true, levHalf: 4, closeBps: 5, qty: E18, entry: 400n * E18, takerMargin: 200n * E6, makerMargin: 80n * E6, openedAt: 1n, exitRequestedAt: 0n, exitRequester: A(0), openTx: null, ...x });

  it('values free balances, positions, offers and pool shares at the oracle price', () => {
    const t = vaultTotals({
      vault: { USDG: 1000n * E6, TSLA: 2n * E18, AMZN: 0n },
      decimals: PROTO.decimals,
      prices: { TSLA: 410n * E18, AMZN: 200n * E18 },
      positions: [pos(), pos({ id: 2n, role: 'maker', long: false, entry: 400n * E18 })],
      offers: [{ id: 1n, maker: ME, market: D.tokens.TSLA!, backing: 300n * E6, largestFill: 1n, openBps: 5, closeBps: 5, expiry: 1n, active: true }],
      pools: { TSLA: { sym: 'TSLA', stockReserve: 100n * E18, usdgReserve: 40_000n * E6, totalShares: 1000n, mine: 10n } },
      valueScale: VS,
    });
    // positions: taker long +10 on 200 margin = 210; maker of a short taker: 80 + (410-400) = 90
    expect(t.inPositions).toBe(300n * E6);
    // 1000 + 2 x 410 + 300 offers + pool (400 USDG + 1 TSLA x 410) + 300 positions
    expect(t.total).toBe((1000n + 820n + 300n + 400n + 410n + 300n) * E6);
  });

  it('a holding without a price makes the total unknown, not smaller', () => {
    const t = vaultTotals({ vault: { USDG: 1n, TSLA: E18 }, decimals: PROTO.decimals, prices: {}, positions: [], offers: [], pools: {}, valueScale: VS });
    expect(t.total).toBeNull();
    expect(t.inPositions).toBe(0n);
    expect(vaultTotals({ vault: {}, decimals: { TSLA: 18 }, prices: {}, positions: [], offers: [], pools: {}, valueScale: VS }).total).toBeNull();
  });

  it('token and position values', () => {
    expect(tokenValue(15n * 10n ** 17n, 18, 400n * E18, 6)).toBe(600n * E6);
    expect(positionValue(pos({ long: false }), 390n * E18, VS)).toBe(210n * E6);
  });
});
