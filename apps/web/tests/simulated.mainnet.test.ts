/**
 * Audit round 2, M2 (mainnet build): no fabricated on-chain evidence. Runs every demo action the
 * way the UI does and checks everything a user reads (flow titles, steps, receipts as the dialog
 * shows them, activity, account card and form copy) plus the stored ledger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

import { IS_MAINNET, PROTOCOL } from '@velum/config';
import { COPY, LANDING, SIM, UI, isDemoMetric, priceSourceText, simCopy } from '@/lib/copy';
import { NO_FUNDS, OVER_CAP, doSwap, lpGo, lpRemove, moveGo, openPerps, closePos, postOffer, receiptRows, spotTrade, withdrawOffer } from '@/lib/demo';
import { useMarkets } from '@/lib/markets';
import { NO_COMMIT, chainSaw, demoChainEvent, emptyLedger, loadLedger, saveLedger, seedLedger, useApp } from '@/lib/store';
import { claimsIn, claimsInSource, strings } from './claims';
import { W, WALLET, connect, flowText, installStorage, patchMarket, setLiveMarkets, takeFlow, text } from './helpers';

/** Strings that would claim something happened on a chain where nothing did. */
export const FABRICATED: RegExp[] = [
  /Visible onchain/i,
  /Velum contract/i,
  /Last thing the public chain saw/i,
  /What the public chain sees/i,
  /Commitment/i,
  /\bblock\s+[\d,]{3,}/i,
  /0x[0-9a-f]{4,}…[0-9a-f]{4}/i,
  /0x[0-9a-f]{64}/i,
  /\bEncrypted\b/,
  /decrypted on this device/i,
  /encrypted note for the recipient/i,
  /Sending public deposit/i,
  /Public deposit/i,
  /Approving /,
];
/** The user's own wallet (a real address, e.g. an unshield destination) is not evidence of anything. */
const fabricated = (s: string) => {
  const t = s.split(WALLET.slice(0, 6) + '…' + WALLET.slice(-4)).join('<own wallet>');
  return FABRICATED.filter((re) => re.test(t)).map(String);
};

const initialMarkets = useMarkets.getState();
const initialApp = useApp.getState();
beforeEach(() => {
  installStorage();
  useMarkets.setState({ ...initialMarkets }, true);
  useApp.setState({ ...initialApp, ledger: emptyLedger(), account: null, modal: null, modalLocked: false }, true);
  setLiveMarkets({ TSLA: '450' });
  connect(seedLedger());
});

it('runs as a mainnet build', () => expect(IS_MAINNET).toBe(true));

describe('copy around simulated actions', () => {
  it('account card, portfolio, forms and receipts use practice/simulated wording', () => {
    const all = [
      SIM.accountBadge,
      SIM.portfolioSub,
      SIM.nothingOnchain,
      ...SIM.visibleRow('The pool changed'),
      ...SIM.receiptDemoRow,
      ...(['shield', 'unshield', 'send'] as const).flatMap((k) => [SIM.moveText(k), SIM.moveNote(k)]),
      ...SIM.shieldSteps('USDG').flatMap((s) => [s.t, s.d]),
      SIM.unshieldLast(WALLET).t,
      SIM.unshieldLast(WALLET).d,
      SIM.sendLast.t,
      SIM.sendLast.d,
      SIM.shieldSub,
      SIM.unshieldSub(WALLET),
    ].join('\n');
    expect(fabricated(all)).toEqual([]);
    expect(SIM.accountBadge).toBe('Simulated');
    expect(SIM.nothingOnchain).toBe('Nothing is on-chain: demo trades are simulated');
    expect(SIM.chainView).toBe(false);
    expect(SIM.visibleRow('The pool changed')).toEqual(['Demo', 'Simulated, nothing is sent onchain']);
    expect(SIM.flowTitle('Open long TSLA')).toBe('Simulated: Open long TSLA');
  });

  it('simCopy(true) and SIM agree (the build picked mainnet)', () => {
    expect(simCopy(true).portfolioSub).toBe(SIM.portfolioSub);
  });
});

describe('privacy claims are labelled as simulated (owner decision of 2026-11-15)', () => {
  it('no string the web shows states a simulated feature, a key or a price source as fact', () => {
    const all = [
      ...strings(COPY),
      ...(['uniswap', 'robinhood', 'chainlink', 'demo', 'loading', 'none'] as const).flatMap((o) => [COPY.frameCap(o, false), COPY.frameCap(o, true), COPY.marketsSub(o)]),
      ...strings(LANDING),
      ...LANDING.stepsMini.flat(),
      ...Object.values(UI),
      SIM.accountBadge,
      SIM.portfolioSub,
      ...(['shield', 'unshield', 'send'] as const).flatMap((k) => [SIM.moveText(k), SIM.moveNote(k)]),
      SIM.sendLast.t,
      SIM.sendLast.d,
    ].join('\n');
    expect(claimsIn(all)).toEqual([]);
    // Mainnet without Velum contracts is real (Uniswap spot, Hyperliquid perps): no "demo" in the hero, and the private
    // account is named only as in development.
    expect(COPY.heroPill).toBe('Stock Tokens and perps on Robinhood Chain');
    expect(COPY.heroBadge).toBe('Live');
    expect(LANDING.metaDescription).toMatch(/^Velum is an exchange for Stock Tokens on Robinhood Chain/);
    expect(LANDING.metaDescription).toMatch(/private accounts in development\.$/);
    expect(UI.perpsNote).toMatch(/^In the full version, size, side and entry stay encrypted/);
    expect(UI.spotNote).toMatch(/^In the full version, pool reserves and your trade stay private/);
    expect(UI.swapNote).toMatch(/^In the full version, pool reserves are private/);
    expect(UI.signIntro).toBe(
      'Sign one message to open your demo private account: this browser turns the signature into a demo private address. It costs no gas and sends nothing to a server. The same wallet opens the same account on any device.',
    );
    expect(UI.accountNote).toMatch(/Disconnecting forgets it here \(your practice balance stays saved in this browser\); signing again opens the same one\.$/);
  });

  it('nothing in the web source makes such a claim (the signed message aside)', () => {
    expect(claimsInSource()).toEqual([]);
  });

  it('the price source is named only when it is real; a demo source reads as unavailable', () => {
    expect(priceSourceText('robinhood')).toBe("Prices from Robinhood's public Stock Token API.");
    expect(priceSourceText('chainlink')).toBe('Prices from Chainlink price feeds.');
    expect(priceSourceText('demo')).toBe('Live prices are unavailable right now.');
    expect(COPY.marketsSub('none')).toBe('Live prices are unavailable right now. Spot trades are real Uniswap swaps; perps trade for real on Hyperliquid from your own account.');
    expect(COPY.marketsSub('demo')).not.toMatch(/Robinhood/);
  });

  it('connected on the landing page, the caption says what is real (F3): no practice balance on mainnet', () => {
    expect(COPY.frameCap('robinhood', true)).toBe(
      "Prices from Robinhood's public Stock Token API. Spot trades are real Uniswap swaps from your wallet and perps are real trades from your own Hyperliquid account.",
    );
    for (const o of ['uniswap', 'robinhood', 'none'] as const) for (const c of [true, false]) expect(COPY.frameCap(o, c)).not.toMatch(/simulat|practice/i);
    expect(COPY.frameCap('robinhood', false)).toMatch(/Connect your wallet to buy Stock Tokens through Uniswap or trade stock perps on Hyperliquid\.$/);
  });

  it('metrics stay dashes on mainnet; a demo flag from the API is honoured where they are shown', () => {
    expect(isDemoMetric()).toBe(false);
    expect(isDemoMetric(true)).toBe(true);
  });
});

describe('perps fill re-checks the position cap at the fill price (audit web F13)', () => {
  it('a price drop during the flow that puts the position over the token cap cancels it', () => {
    const cap = PROTOCOL.maxTokensPerPosition;
    // 99 tokens at 100 USDG (plus the maker spread): under the cap when quoted.
    setLiveMarkets({ TSLA: '100' });
    useApp.setState({ sel: 'TSLA', size: '9900', lev: 5, side: 'long' });
    openPerps();
    const f = takeFlow();
    const before = useApp.getState().ledger;
    patchMarket('TSLA', { price: W('90'), priceNum: 90 }); // the same size now buys 110 tokens
    expect(f.done()).toBe(OVER_CAP);
    expect(useApp.getState().ledger).toBe(before);
    expect(OVER_CAP.rows[0]![1]).toBe(`Cancelled: above the ${cap}-token limit at the fill price`);
  });

  it('a balance that shrank before the fill cancels it too', () => {
    useApp.setState({ sel: 'TSLA', size: '500', lev: 1, side: 'long' });
    openPerps();
    const f = takeFlow();
    useApp.setState({ ledger: { ...useApp.getState().ledger, priv: { USDG: W('10') } } });
    expect(f.done()).toBe(NO_FUNDS);
    expect(useApp.getState().ledger.positions).toEqual([]);
  });
});

describe('no simulated chain event is recorded on mainnet', () => {
  it('chainSaw is a no-op and demoChainEvent returns null', () => {
    const l = seedLedger();
    expect(chainSaw(l, 'The TSLA pool changed')).toBe(l);
    expect(demoChainEvent('x')).toBeNull();
    expect(l.lastChain).toBeNull();
    expect(l.history.map((h) => h.sub).join(' ')).toMatch(/Nothing is on-chain/);
  });

  it('a ledger stored by an earlier build loses its simulated "last thing the chain saw"', () => {
    saveLedger(WALLET, { ...seedLedger(), lastChain: { what: 'A private note was locked', commit: '0x' + 'a'.repeat(64), block: 153_120_843 } });
    expect(loadLedger(WALLET)!.lastChain).toBeNull();
  });
});

describe('every demo action, end to end', () => {
  it('shield, open, spot, swap, LP, offer, close, unshield, send and withdrawals leave no fabricated evidence', () => {
    const seen: string[] = [];
    const run = (start: () => void) => {
      start();
      const f = takeFlow();
      const r = f.done();
      expect(r.toast).not.toMatch(/unavailable|already/i);
      seen.push(flowText(f, r));
      // Every mainnet receipt ends by saying nothing was sent.
      expect(text(receiptRows(r.rows).flat())).toMatch(/Simulated, nothing was sent onchain$/);
    };
    useApp.setState({ sel: 'TSLA', size: '500', lev: 2, side: 'long', spotSide: 'buy', spotAmt: '500', swapFrom: 'USDG', swapTo: 'TSLA', swapAmt: '100' });

    run(() => moveGo('shield', 'USDG', W('100'), WALLET));
    run(openPerps);
    run(spotTrade);
    run(doSwap);
    useApp.setState({ swapFrom: 'TSLA', swapTo: 'AMZN', swapAmt: '0.1' });
    run(doSwap);
    run(() => lpGo('TSLA', W('1000')));
    run(() => postOffer({ sym: 'TSLA', back: W('500'), max: W('100'), open: 8, close: 5 }));
    const l1 = useApp.getState().ledger;
    run(() => closePos(l1.positions[0]!.id));
    run(() => moveGo('unshield', 'USDG', W('50'), WALLET));
    run(() => moveGo('send', 'USDG', W('5'), 'velum1' + 'b'.repeat(36)));
    run(() => lpRemove('TSLA'));
    run(() => withdrawOffer(useApp.getState().ledger.offers[0]!.id));

    const l = useApp.getState().ledger;
    const activity = l.history.flatMap((h) => [h.title, h.sub]).join('\n');
    const problems = fabricated(seen.join('\n---\n') + '\n' + activity);
    expect(problems).toEqual([]);
    expect(l.lastChain).toBeNull();
    expect(l.history.slice(0, -1).every((h) => h.sub.endsWith(' · Simulated'))).toBe(true);
    expect(seen.every((t) => t.startsWith('Simulated: '))).toBe(true);
  });

  it('positions opened on mainnet carry no fabricated commitment or block', () => {
    useApp.setState({ sel: 'TSLA', size: '500', lev: 2, side: 'short' });
    openPerps();
    takeFlow().done();
    const [p] = useApp.getState().ledger.positions;
    expect(p!.commit).toBe(NO_COMMIT);
    expect(p!.block).toBe(0);
    expect(useApp.getState().ledger.lastChain).toBeNull();
  });

  it('withdrawing an offer that is already gone credits nothing (no stale fallback)', () => {
    postOffer({ sym: 'TSLA', back: W('500'), max: W('100'), open: 8, close: 5 });
    takeFlow().done();
    const id = useApp.getState().ledger.offers[0]!.id;
    withdrawOffer(id);
    const first = takeFlow();
    withdrawOffer(id);
    const second = takeFlow();
    first.done();
    const usdg = useApp.getState().ledger.priv.USDG;
    expect(second.done().rows).toEqual([['Status', 'Already withdrawn']]);
    expect(useApp.getState().ledger.priv.USDG).toBe(usdg);
  });
});
