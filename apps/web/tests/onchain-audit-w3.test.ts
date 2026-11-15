/**
 * The web audit of the real-transaction wiring (W3-01 to W3-13), one block per finding: the pure rules the
 * fixes rest on. The browser cases (Cancel then retry, API down on a real build, a replaced transaction, an
 * offer with a 500 bps close spread, dust offers, a liquidatable close, ...) run in apps/web/e2e/adv.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { Fragment, createElement, type ReactNode } from 'react';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Log, type TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';
import { pausedFor } from '@/components/onchain/useOc';
import { ApiError } from '@/lib/api';
import { onchainCopy, SIM } from '@/lib/copy';
import { PERPS_ABI, VAULT_ABI } from '@/lib/onchain/abi';
import { REAL_BUILD, checkResult, deploymentDiff, unverified, type Deployment } from '@/lib/onchain/deployment';
import { PANIC_CODES, panicSentence } from '@/lib/onchain/errors';
import { ReceiptMismatch, type Row } from '@/lib/onchain/flow';
import { closeFlow, expectEvent, openFlow, withdrawFlow } from '@/lib/onchain/flows';
import { HIGH_SPREAD_BPS, highSpread, liquidationQuote, lpAddPlan, openQuote, poolOut, roundTrip, sharesFor, takerProfitCap, valueScaleFor } from '@/lib/onchain/quote';
import { MAX_API_POSITIONS, apiOpenPositions, loadKnown, offerClass, offerFloor, positionsKey, rankOffers, rememberPosition, type ChainPosition, type Offer, type Protocol } from '@/lib/onchain/reads';
import { RETRY_COPY, refusedRetry, retryVerdict } from '@/lib/onchain/retry';
import { installStorage } from './helpers';

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
const PROTO: Protocol = { decimals: { USDG: 6, TSLA: 18, AMZN: 18 }, valueScale: VS, minPositionSize: 10n * E6, bond: 10n ** 15n, exitDelay: 7n * 86_400n, rewardCap: E6 };
const ME = getAddress('0x00000000000000000000000000000000000000aa');
const OC = { ...unverified(D, 'on'), verified: true };
const BASE = { oc: OC, proto: PROTO, account: ME };
const text = (rows: Row[]) => renderToStaticMarkup(createElement(Fragment, null, ...rows.map(([k, v], i) => createElement('p', { key: i }, k as ReactNode, ': ', v as ReactNode))));
const offer = (id: number, openBps: number, closeBps: number, x: Partial<Offer> = {}): Offer => ({ id: BigInt(id), maker: A(9), market: D.tokens.TSLA!, backing: 10_000n * E6, largestFill: 5_000n * E6, openBps, closeBps, expiry: 10n ** 12n, active: true, ...x });

describe('W3-01: a step that reached the wallet is never sent twice blindly', () => {
  const rec = (x: Partial<Parameters<typeof retryVerdict>[0]> = {}) => ({ nonce: 7, settled: true, cancelled: false, ...x });
  it('only after the request settled without a hash and the pending nonce did not move', () => {
    expect(retryVerdict(rec(), 7)).toBe('ok');
    expect(retryVerdict(rec({ settled: false, cancelled: true }), 7)).toBe('open');
    expect(retryVerdict(rec({ hash: `0x${'ab'.repeat(32)}` }), 7)).toBe('sent');
    expect(retryVerdict(rec(), 8)).toBe('pending');
    expect(retryVerdict(rec({ nonce: null }), 7)).toBe('unknown');
    expect(retryVerdict(rec(), null)).toBe('unknown');
  });
  it('says a transaction may already be pending', () => {
    expect(RETRY_COPY.cancelledOpen).toMatch(/may already be pending/);
    expect(refusedRetry('pending')).toMatch(/may already be pending/);
    expect(refusedRetry('unknown')).toMatch(/may already be pending/);
    expect(refusedRetry('open')).toMatch(/still has this request open/);
  });
  it('only approval steps (which re-read the chain) are marked safe to repeat', () => {
    const q = openQuote({ price: 400n * E18, size: 500n * E6, levHalf: 4, long: true, openBps: 5, slipBps: 50n, valueScale: VS });
    const f = openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 500n * E6, offer: offer(1, 5, 5), q, slip: 50n, oraclePrice: 400n * E18 });
    expect(f.steps.map((s) => !!s.idempotent)).toEqual([true, false]);
  });
});

describe('W3-02: a real build never falls back to the demo', () => {
  it('every API outcome but a match leaves trades paused with a reason, exits on the compiled addresses', () => {
    const body = { ...D, contracts: { ...D.contracts } };
    expect(checkResult(D, { body })).toMatchObject({ status: 'on', info: { verified: true, d: D } });
    expect(checkResult(D, { error: new ApiError('UNAVAILABLE', 'x', 503) })).toMatchObject({ status: 'unavailable', info: { verified: false, d: D } });
    expect(checkResult(D, { error: new TypeError('fetch failed') })).toMatchObject({ status: 'unavailable', info: { verified: false } });
    expect(checkResult(D, { error: new ApiError('NOT_FOUND', 'x', 404) })).toMatchObject({ status: 'missing', info: { verified: false } });
    const m = checkResult(D, { body: { ...body, contracts: { ...body.contracts, vault: A(99) } } });
    expect(m).toMatchObject({ status: 'mismatch', info: { verified: false, mismatch: 'a different vault address' } });
    for (const r of [checkResult(D, { error: new Error('x') }), m]) expect(r.info).not.toBeNull();
  });
  it('the mismatch reason is a fixed phrase', () => {
    expect(deploymentDiff(D, { ...D, chainId: 4663 })).toBe('chain ID 4663 instead of 46630');
    expect(deploymentDiff(D, { ...D, tokens: { ...D.tokens, NVDA: A(13) } })).toBe('a different token list');
    expect(deploymentDiff(D, { ...D, tokens: { ...D.tokens, TSLA: D.tokens.AMZN, AMZN: D.tokens.TSLA } })).toBe('a different AMZN token address');
    expect(deploymentDiff(D, '<b>hi</b>')).toBe('an answer that is not a valid deployment');
    expect(deploymentDiff(D, D)).toBeNull();
  });
  it('paused copy says why and never claims trades are real (the banner says so only once confirmed)', () => {
    for (const mainnet of [false, true]) {
      const c = onchainCopy(mainnet);
      for (const st of ['checking', 'unavailable', 'missing', 'mismatch'] as const) {
        expect(c.verifyBanner(st, 'a different vault address')).not.toMatch(/real/i);
        expect(c.pausedHint(st, null)).not.toMatch(/real/i);
      }
      expect(c.verifyBanner('mismatch', 'a different vault address')).toMatch(/a different vault address.*paused.*Withdrawals, closes and forced exits still work/);
      if (!mainnet) expect(c.verifyBanner('unavailable', null)).toMatch(/Testnet\. Test tokens have no value\.$/);
    }
    expect(pausedFor(unverified(D, 'unavailable'))?.label).toBe('New trades paused');
    expect(pausedFor(unverified(D, 'checking'))?.label).toBe('Checking the contracts…');
    expect(pausedFor(OC)).toBeNull();
  });
  it('the test build carries no deployment (so the demo engine may run here)', () => expect(REAL_BUILD).toBe(false));
});

describe('W3-03: offers are ranked by the whole round trip', () => {
  const ctx = { price: 391_65n * 10n ** 16n, levHalf: 4, long: true, valueScale: VS };
  it('a 2 bps open / 500 bps close offer never beats a 5 / 5 one', () => {
    const list = [offer(1, 5, 5), offer(2, 2, 500), offer(3, 8, 5)];
    expect(rankOffers(list, D.tokens.TSLA!, 1000n * E6, undefined, 0n, ctx).map((o) => o.id)).toEqual([1n, 3n, 2n]);
    expect(rankOffers(list, D.tokens.TSLA!, 1000n * E6, undefined, 0n).map((o) => o.id)).toEqual([1n, 3n, 2n]);
  });
  it('the round trip is both spreads plus both fees at an unchanged price', () => {
    const cheap = roundTrip({ price: ctx.price, size: 1000n * E6, levHalf: 4, long: true, openBps: 5, closeBps: 5, valueScale: VS });
    const steer = roundTrip({ price: ctx.price, size: 1000n * E6, levHalf: 4, long: true, openBps: 2, closeBps: 500, valueScale: VS });
    expect(Number(cheap.total) / 1e6).toBeCloseTo(2.2, 1); // 0.05% + 0.05% + 0.06% + 0.06% of 1,000
    expect(Number(steer.total) / 1e6).toBeCloseTo(51.2, 0); // the auditor measured -50.19 P&L and 0.57 close fee
    expect(steer.total).toBeGreaterThan(cheap.total * 20n);
  });
  it('an explicit acknowledgement above 50 bps, the close spread and the profit cap in the review', () => {
    expect(HIGH_SPREAD_BPS).toBe(50);
    expect(highSpread({ openBps: 5, closeBps: 50 })).toBe(false);
    expect(highSpread({ openBps: 5, closeBps: 51 })).toBe(true);
    expect(highSpread({ openBps: 60, closeBps: 5 })).toBe(true);
    const q = openQuote({ price: ctx.price, size: 1000n * E6, levHalf: 4, long: true, openBps: 2, slipBps: 50n, valueScale: VS });
    const f = openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 1000n * E6, offer: offer(2, 2, 500), q, slip: 50n, oraclePrice: ctx.price });
    expect(f.ack).toMatch(/500 bps close spread.*costs about 5\d\.\d\d USDG, 10\.\d\d% of my margin/);
    const r = text(f.review);
    expect(r).toMatch(/2 bps open, 500 bps close spread/);
    expect(r).toMatch(/Round trip \(est\.\): 5\d\.\d\d USDG \(10\.\d\d% of margin\)/);
    expect(r).toMatch(/Profit cap: 200 USDG \(maker margin, 20% of size\)/);
    expect(takerProfitCap(1000n * E6)).toBe(200n * E6);
    const q5 = openQuote({ price: ctx.price, size: 1000n * E6, levHalf: 4, long: true, openBps: 5, slipBps: 50n, valueScale: VS });
    expect(openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 1000n * E6, offer: offer(1, 5, 5), q: q5, slip: 50n, oraclePrice: ctx.price }).ack).toBeUndefined();
  });
});

describe('W3-04: receipts only from the expected events of the expected contract', () => {
  const log = (address: `0x${string}`, account: `0x${string}`, approved: boolean): Log =>
    ({
      address,
      topics: encodeEventTopics({ abi: VAULT_ABI, eventName: 'ModuleApproval', args: { account, module: D.contracts.perpsMarkets as `0x${string}` } }),
      data: encodeAbiParameters([{ type: 'bool' }], [approved]),
      blockHash: `0x${'1'.repeat(64)}`,
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: `0x${'2'.repeat(64)}`,
      transactionIndex: 0,
      removed: false,
    }) as Log;
  const receipt = (logs: Log[]) => ({ logs, transactionHash: `0x${'2'.repeat(64)}` }) as unknown as TransactionReceipt;
  const vault = D.contracts.vault;
  it('an event from another contract, another account or with other values does not count', () => {
    const match = (a: Record<string, unknown>) => String(a.account).toLowerCase() === ME.toLowerCase() && a.approved === true;
    expect(expectEvent(receipt([log(vault as `0x${string}`, ME, true)]), vault, VAULT_ABI, 'ModuleApproval', match).approved).toBe(true);
    expect(() => expectEvent(receipt([log(A(66), ME, true)]), vault, VAULT_ABI, 'ModuleApproval', match)).toThrow(ReceiptMismatch);
    expect(() => expectEvent(receipt([log(vault as `0x${string}`, A(67), true)]), vault, VAULT_ABI, 'ModuleApproval', match)).toThrow(ReceiptMismatch);
    expect(() => expectEvent(receipt([log(vault as `0x${string}`, ME, false)]), vault, VAULT_ABI, 'ModuleApproval', match)).toThrow(ReceiptMismatch);
    expect(() => expectEvent(receipt([]), vault, PERPS_ABI, 'PositionSettled')).toThrow(ReceiptMismatch);
  });
  it('every non-approval step reads its receipt', () => {
    const q = openQuote({ price: 400n * E18, size: 500n * E6, levHalf: 4, long: true, openBps: 5, slipBps: 50n, valueScale: VS });
    const f = openFlow(BASE, { sym: 'TSLA', long: true, lev: 2, levHalf: 4, size: 500n * E6, offer: offer(1, 5, 5), q, slip: 50n, oraclePrice: 400n * E18 });
    expect(f.steps.every((s) => typeof s.after === 'function')).toBe(true);
    expect(() => f.steps[1]!.after!(receipt([]), { d: D, proto: PROTO, account: ME, out: {}, txs: [] })).toThrow(ReceiptMismatch);
  });
});

describe('W3-05: positions survive an API outage', () => {
  it('at most 100 ids are taken from one API answer', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: String(100_000 + i), status: 'open', openTx: null }));
    expect(apiOpenPositions(many)).toHaveLength(MAX_API_POSITIONS);
  });
  it('ids are kept per chain, deployment and account, validated', () => {
    const st = installStorage({ [positionsKey(D, ME)]: JSON.stringify({ '12': `0x${'a'.repeat(64)}`, nope: 'x', '13': 'not a hash' }) });
    expect([...loadKnown(D, ME)]).toEqual([
      ['12', `0x${'a'.repeat(64)}`],
      ['13', null],
    ]);
    rememberPosition(OC, ME, 21n, null);
    expect(JSON.parse(st.getItem(positionsKey(D, ME))!)).toHaveProperty('21');
    expect(positionsKey(D, ME)).toContain(`:${D.chainId}:${D.contracts.perpsMarkets}:${ME.toLowerCase()}`);
    expect(loadKnown({ ...D, contracts: { ...D.contracts, perpsMarkets: A(55) } }, ME).size).toBe(0);
    installStorage({ [positionsKey(D, A(3))]: '{not json' });
    expect(loadKnown(D, A(3)).size).toBe(0);
  });
});

describe('W3-06: demo toasts say they were simulated', () => {
  it('labelled', () => expect(SIM.toast('TSLA long liquidated')).toBe('Simulated: TSLA long liquidated'));
});

describe('W3-07: the add-liquidity minimum comes from the reviewed pool after the user’s own swap', () => {
  const pool = { stockReserve: 100n * E18, usdgReserve: 39_165n * E6, totalShares: 1_979_015_000_000_000n };
  it('expected shares are what the add mints if nobody moves the pool in between', () => {
    const plan = lpAddPlan(pool, 400n * E6, 50n);
    const out = poolOut(plan.half, pool.usdgReserve, pool.stockReserve);
    expect(plan.stockOut).toBe(out);
    const after = { stockReserve: pool.stockReserve - out, usdgReserve: pool.usdgReserve + plan.half, totalShares: pool.totalShares };
    expect(plan.shares).toBe(sharesFor(after, out, 400n * E6 - plan.half));
    expect(plan.minShares).toBe((plan.shares * 9950n) / 10_000n);
    // A pool pushed between the two transactions (USDG side doubled) mints far fewer shares: below the minimum.
    const pushed = { ...after, usdgReserve: after.usdgReserve * 2n };
    expect(sharesFor(pushed, out, 400n * E6 - plan.half)).toBeLessThan(plan.minShares);
  });
});

describe('W3-08: the withdrawal destination is shown in full and flagged when it is not the wallet', () => {
  it('checksummed, flagged', () => {
    const other = '0x52908400098527886e0f7030069857d2e4169ee7';
    const f = withdrawFlow(BASE, 'USDG', 100n * E6, other as `0x${string}`);
    const r = text(f.review);
    expect(r).toContain(getAddress(other));
    expect(r).toMatch(/Not your connected wallet/);
    expect(f.note).toMatch(/not the wallet you are connected with/);
    expect(text(f.done({ d: D, proto: PROTO, account: ME, out: { amount: 100n * E6 }, txs: [] }).rows)).toContain(getAddress(other));
    const mine = withdrawFlow(BASE, 'USDG', 100n * E6, ME);
    expect(text(mine.review)).toContain(ME);
    expect(text(mine.review)).not.toMatch(/Not your connected wallet/);
  });
});

describe('W3-09: the offer scan pages past dead and dust offers', () => {
  const floor = offerFloor(10n * E6);
  it('dead, dust and live', () => {
    expect(floor).toEqual({ backing: 2n * E6, fill: 10n * E6 });
    expect(offerClass(offer(1, 5, 5, { active: false }), 100n, floor)).toBe('dead');
    expect(offerClass(offer(1, 5, 5, { expiry: 100n }), 100n, floor)).toBe('dead');
    expect(offerClass(offer(1, 2, 0, { backing: 1n, largestFill: 1n }), 100n, floor)).toBe('dust');
    expect(offerClass(offer(1, 5, 5, { largestFill: 9n * E6 }), 100n, floor)).toBe('dust');
    expect(offerClass(offer(1, 5, 5), 100n, floor)).toBe('live');
  });
});

describe('W3-10: closing a liquidatable position quotes the liquidation route', () => {
  it('taker side: claim minus the 1% penalty, half of it back as the liquidator reward', () => {
    // 5x long of 500 USDG at 391.65 after a 13% drop (the auditor's A15).
    const qty = (500n * E6 * VS) / (39_185n * 10n ** 16n);
    const price = (39_165n * 10n ** 16n * 87n) / 100n;
    const takerMargin = 100n * E6;
    const makerMargin = 100n * E6;
    const claim = takerMargin + (qty * (price - 39_185n * 10n ** 16n)) / VS;
    const l = liquidationQuote({ takerClaim: claim, takerMargin, makerMargin, qty, price, valueScale: VS, rewardCap: E6 })!;
    expect(l.takerSide).toBe(true);
    const notional = (qty * price + VS - 1n) / VS;
    expect(l.penalty).toBe((notional * 100n + 9999n) / 10_000n);
    expect(l.takerOut).toBe(claim - l.penalty);
    expect(l.reward).toBe(l.penalty / 2n);
  });
  it('maker side insolvent: the taker gets the pool and files the shortfall', () => {
    const l = liquidationQuote({ takerClaim: 260n * E6, takerMargin: 100n * E6, makerMargin: 100n * E6, qty: E18, price: 500n * E18, valueScale: VS, rewardCap: E6 })!;
    expect(l).toMatchObject({ takerSide: false, takerOut: 200n * E6, penalty: 0n, reward: 0n, shortfall: 60n * E6, topUp: E6 });
  });
  it('not liquidatable: null; the review names the route and the total', () => {
    expect(liquidationQuote({ takerClaim: 100n * E6, takerMargin: 100n * E6, makerMargin: 100n * E6, qty: E18, price: 400n * E18, valueScale: VS, rewardCap: E6 })).toBeNull();
    const pos: ChainPosition = { id: 7n, sym: 'TSLA', role: 'taker', long: true, levHalf: 10, closeBps: 5, qty: E18, entry: 400n * E18, takerMargin: 80n * E6, makerMargin: 80n * E6, openedAt: 1n, exitRequestedAt: 0n, exitRequester: A(0), openTx: null };
    const liq = { takerSide: true, takerOut: 30_000_000n, penalty: 3_600_000n, reward: 1_800_000n, topUp: 0n, shortfall: 0n };
    const r = text(closeFlow(BASE, { pos, price: 360n * E18, exit: 359n * E18, fee: 0n, estOut: 0n, slip: 50n, liq }).review);
    expect(r).toMatch(/Settles as: .*Liquidation \(your side is below maintenance\)/);
    expect(r).toMatch(/Liquidator reward to you \(est\.\): 1\.8 USDG/);
    expect(r).toMatch(/Total back to your vault \(est\.\): 31\.8 USDG/);
  });
});

describe('W3-11: "Guarded beta" only follows the vault', () => {
  it('no fixed "Guarded beta" in the banner or footer copy', () => {
    for (const mainnet of [false, true]) {
      expect(onchainCopy(mainnet).banner).not.toMatch(/guarded/i);
      expect(onchainCopy(mainnet).footer).not.toMatch(/guarded/i);
    }
  });
});

describe('W3-12: Solidity panics by their standard codes only', () => {
  it('names the check, never guesses about balances', () => {
    expect(panicSentence(0x11n)).toBe('The contract stopped with an arithmetic overflow or underflow (Solidity panic 0x11). Nothing was changed.');
    expect(panicSentence(0x12n)).toMatch(/division or modulo by zero/);
    expect(panicSentence(0x99n)).toBe('The contract stopped with a Solidity panic (code 0x99). Nothing was changed.');
    expect(panicSentence('x')).toBe('The contract stopped with a Solidity panic. Nothing was changed.');
    for (const v of Object.values(PANIC_CODES)) expect(v).not.toMatch(/balance|allowance/);
  });
});
