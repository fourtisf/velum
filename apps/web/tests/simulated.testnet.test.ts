/**
 * Testnet build: every privacy feature is simulated in Phase 2, so it is labelled as simulated here
 * too (owner decision of 2026-11-15; audit web F12/F13): flows are titled "Simulated", steps for the
 * proof, relayer and private notes say what the full version will do, receipts end by saying nothing
 * was sent, and the simulated chain view stays (the prototype's layout) but says it is simulated.
 * The test-token notice is shown in full (CLAUDE.md §1.4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'testnet';
});

import { IS_MAINNET } from '@velum/config';
import { COPY, LANDING, SIM, UI, isDemoMetric, priceSourceText } from '@/lib/copy';
import { closePos, doSwap, lpGo, lpRemove, moveGo, openPerps, postOffer, receiptRows, spotTrade, withdrawOffer } from '@/lib/demo';
import { useMarkets } from '@/lib/markets';
import { BLOCK_BASE, chainSaw, emptyLedger, seedLedger, useApp } from '@/lib/store';
import { claimsIn, claimsInSource, strings } from './claims';
import { W, WALLET, connect, flowText, installStorage, takeFlow, text } from './helpers';

const initialMarkets = useMarkets.getState();
const initialApp = useApp.getState();
beforeEach(() => {
  installStorage();
  useMarkets.setState({ ...initialMarkets }, true);
  useApp.setState({ ...initialApp, ledger: emptyLedger(), account: null, modal: null, modalLocked: false }, true);
  connect(seedLedger());
});

it('runs as a testnet build', () => expect(IS_MAINNET).toBe(false));

describe('privacy claims are labelled as simulated on testnet too', () => {
  it('account card, portfolio, move forms and landing copy', () => {
    expect(SIM.accountBadge).toBe('Simulated');
    expect(SIM.portfolioSub).toBe('Your private balance here is a simulated practice account, kept in this browser only. Your public wallet is real.');
    expect(SIM.chainView).toBe(true);
    expect(SIM.chainLastLabel).toBe('Last simulated chain event');
    expect(SIM.chainSeesLabel).toBe('Simulated chain view');
    expect(SIM.visibleRow('The pool changed')).toEqual(['Demo', 'Simulated, nothing is sent onchain']);
    expect(SIM.flowTitle('Shield USDG')).toBe('Simulated: Shield USDG');
    expect(SIM.sendLast).toEqual({ t: 'Simulating the private transfer', d: 'Nothing is sent; the recipient gets nothing', ms: 600 });
    expect(COPY.heroPill).toBe('Simulated private perps on Robinhood Chain');
    expect(LANDING.lead).toMatch(/designed to keep your balance, positions and P&L encrypted end to end/);
    expect(LANDING.statProof).toBe('Target time to prove a trade in your browser');
    expect(LANDING.stepsMini.map(([t, s]) => `${t} ${s}`).join(' | ')).not.toMatch(/1\.8s/);
    expect(UI.perpsNote).toBe('In the full version, size, side and entry stay encrypted, and if no maker fills you within 15 minutes your margin comes back.');
    expect(UI.signIntro).toMatch(/demo private address/);
    expect(UI.signIntro).not.toMatch(/keys/);
    expect(UI.signDeriving).toBe('Opening your demo account…');
    expect(UI.accountNote).not.toMatch(/keys/);
  });

  it('no string the web shows states a simulated feature as fact', () => {
    const all = [
      ...strings(COPY),
      COPY.frameCap('demo', false),
      COPY.frameCap('robinhood', true),
      COPY.marketsSub('demo'),
      ...strings(LANDING),
      ...LANDING.stepsMini.flat(),
      ...Object.values(UI),
      SIM.accountBadge,
      SIM.portfolioSub,
      SIM.chainLastLabel,
      SIM.chainSeesLabel,
      ...(['shield', 'unshield', 'send'] as const).flatMap((k) => [SIM.moveText(k), SIM.moveNote(k)]),
      ...SIM.shieldSteps('USDG').flatMap((s) => [s.t, s.d]),
      SIM.unshieldLast(WALLET).t,
      SIM.unshieldLast(WALLET).d,
      SIM.sendLast.t,
      SIM.sendLast.d,
      SIM.shieldSub,
    ].join('\n');
    expect(claimsIn(all)).toEqual([]);
  });

  it('nothing in the web source makes such a claim (the signed message aside)', () => {
    expect(claimsInSource()).toEqual([]);
  });

  it('seed ledger keeps the prototype history and its simulated chain event', () => {
    const l = seedLedger();
    expect(l.history.map((h) => h.sub)).toEqual(['Private swap through the AMZN pool', 'Public deposit from your wallet', 'Public deposit from your wallet']);
    expect(l.lastChain!.what).toBe('The AMZN pool changed');
    expect(l.lastChain!.commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(l.lastChain!.block).toBeGreaterThan(BLOCK_BASE);
    expect(chainSaw(l, 'x').lastChain!.what).toBe('x');
  });
});

describe('the test-token notice and the price source', () => {
  it('the landing frame caption always carries "Testnet. Test tokens have no value."', () => {
    for (const origin of ['demo', 'robinhood', 'chainlink', 'loading', 'none'] as const)
      for (const connected of [false, true]) expect(COPY.frameCap(origin, connected)).toMatch(/Testnet\. Test tokens have no value\.$/);
    expect(COPY.frameCap('demo', false)).toBe('Live demo with test prices. Connect a test wallet to try a simulated private trade. Testnet. Test tokens have no value.');
  });

  it('names Robinhood only when the prices come from it', () => {
    expect(priceSourceText('robinhood')).toBe("Prices from Robinhood's public Stock Token API.");
    expect(priceSourceText('demo')).toBe('Prices are demo data on testnet.');
    expect(COPY.marketsSub('demo')).not.toMatch(/Robinhood/);
    expect(COPY.marketsSub('robinhood')).toBe("Prices from Robinhood's public Stock Token API. Trading here is simulated.");
    expect(COPY.marketsSub('demo')).toBe('Prices are demo data on testnet. Trading here is simulated.');
  });

  it('protocol metrics are always "Demo" on testnet', () => {
    expect(isDemoMetric()).toBe(true);
    expect(isDemoMetric(false)).toBe(true);
  });
});

describe('every demo action reads as simulated', () => {
  it('shield', () => {
    moveGo('shield', 'USDG', W('100'), WALLET);
    const f = takeFlow();
    const r = f.done();
    expect(f.steps.map((s) => [s.t, s.d])).toEqual([
      ['Checking your public USDG balance', 'Read only: no approval is asked of your wallet'],
      ['Simulating the deposit', 'Nothing is sent onchain'],
      ['Adding to your practice balance', 'Kept in this browser only'],
    ]);
    expect(text(receiptRows(r.rows).flat())).toMatch(/^Token USDG Amount 100\.00 Receipt #\d{6} Demo Simulated, nothing was sent onchain$/);
    // The simulated chain view still records what the chain would have seen (labelled in the UI).
    expect(useApp.getState().ledger.lastChain!.what).toBe('Public deposit of 100.00 USDG');
    expect(useApp.getState().ledger.history[0]!.sub).toBe('Practice deposit, your tokens stay in your wallet');
  });

  it('all flows: titled "Simulated", no privacy claim, receipts end with the demo row', () => {
    const seen: string[] = [];
    const run = (start: () => void) => {
      start();
      const f = takeFlow();
      const r = f.done();
      expect(r.toast).not.toMatch(/unavailable|already/i);
      seen.push(flowText(f, r));
      expect(text(receiptRows(r.rows).flat())).toMatch(/Simulated, nothing was sent onchain$/);
    };
    useApp.setState({ sel: 'TSLA', size: '500', lev: 2, side: 'long', spotSide: 'buy', spotAmt: '500', swapFrom: 'USDG', swapTo: 'TSLA', swapAmt: '100' });
    run(openPerps);
    run(spotTrade);
    run(doSwap);
    run(() => lpGo('TSLA', W('1000')));
    run(() => postOffer({ sym: 'TSLA', back: W('500'), max: W('100'), open: 8, close: 5 }));
    run(() => closePos(useApp.getState().ledger.positions[0]!.id));
    run(() => moveGo('unshield', 'USDG', W('50'), WALLET));
    run(() => moveGo('send', 'USDG', W('5'), 'velum1' + 'b'.repeat(36)));
    run(() => lpRemove('TSLA'));
    run(() => withdrawOffer(useApp.getState().ledger.offers[0]!.id));
    expect(seen.every((t) => t.startsWith('Simulated: '))).toBe(true);
    const all = seen.join('\n---\n');
    expect(claimsIn(all)).toEqual([]);
    expect(all).not.toMatch(/Visible onchain/);
    expect(all).toMatch(/Simulating the proof\nIn the full version, your browser makes a proof that the trade follows the rules without revealing it/);
    expect(all).toMatch(/Simulating the relayer\nIn the full version, a relayer submits the proof and pays gas/);
    // Positions keep a simulated commitment for the (labelled) testnet chain view.
    expect(useApp.getState().ledger.lastChain!.commit).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('receipts drop a "Visible onchain" row and end with the demo row', () => {
    const rows: Array<[string, string]> = [['Visible onchain', 'x'], ['Receipt', '#1']];
    expect(receiptRows(rows)).toEqual([['Receipt', '#1'], ['Demo', 'Simulated, nothing was sent onchain']]);
  });
});
