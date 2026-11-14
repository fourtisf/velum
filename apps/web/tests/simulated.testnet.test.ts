/**
 * Audit round 2, M2 on the default (testnet) build: the prototype's words and simulated chain view
 * stay exactly as they were (the testnet demo is pixel- and copy-faithful to prototype/index.html).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'testnet';
});

import { IS_MAINNET } from '@velum/config';
import { SIM } from '@/lib/copy';
import { moveGo, openPerps, receiptRows, spotTrade } from '@/lib/demo';
import { useMarkets } from '@/lib/markets';
import { BLOCK_BASE, chainSaw, emptyLedger, seedLedger, useApp } from '@/lib/store';
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

describe('prototype copy (verbatim)', () => {
  it('account card, portfolio and move forms', () => {
    expect(SIM.accountBadge).toBe('Encrypted');
    expect(SIM.portfolioSub).toBe('Everything below is decrypted on this device only.');
    expect(SIM.chainView).toBe(true);
    expect(SIM.visibleRow('The pool changed')).toEqual(['Visible onchain', 'The pool changed']);
    expect(SIM.moveText('shield')).toBe('Move tokens from your public wallet into your private balance.');
    expect(SIM.moveText('unshield')).toBe('Move tokens from your private balance back to a public address.');
    expect(SIM.moveText('send')).toBe('Send to another private address. The amount and both parties stay hidden.');
    expect(SIM.moveNote('send')).toBe('Nothing about this transfer is published in readable form.');
    expect(SIM.moveNote('shield')).toBe('This step is public: anyone can see the wallet, token, amount and time. Vary amounts and wait between moves to make them harder to link.');
    expect(SIM.flowTitle('Shield USDG')).toBe('Shield USDG');
  });

  it('seed ledger has the prototype history and a simulated chain event', () => {
    const l = seedLedger();
    expect(l.history.map((h) => h.sub)).toEqual(['Private swap through the AMZN pool', 'Public deposit from your wallet', 'Public deposit from your wallet']);
    expect(l.lastChain!.what).toBe('The AMZN pool changed');
    expect(l.lastChain!.commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(l.lastChain!.block).toBeGreaterThan(BLOCK_BASE);
    expect(chainSaw(l, 'x').lastChain!.what).toBe('x');
  });
});

describe('flows read like the prototype', () => {
  it('shield', () => {
    moveGo('shield', 'USDG', W('100'), WALLET);
    const f = takeFlow();
    const r = f.done();
    expect(f.steps.map((s) => [s.t, s.d])).toEqual([
      ['Approving USDG', 'Lets the Velum contract receive this token'],
      ['Sending public deposit', 'Visible onchain: wallet, token, amount, time'],
      ['Adding a note to your private balance', 'Usually within a block or two'],
    ]);
    expect(text(receiptRows(r.rows).flat())).toMatch(/^Token USDG Amount 100\.00 Visible onchain Wallet, token, amount, time Receipt #\d{6}$/);
    expect(useApp.getState().ledger.lastChain!.what).toBe('Public deposit of 100.00 USDG');
    expect(useApp.getState().ledger.history[0]!.sub).toBe('Public deposit from your wallet');
  });

  it('open long and spot buy keep "Visible onchain" and the chain event', () => {
    useApp.setState({ sel: 'TSLA', size: '500', lev: 2, side: 'long', spotSide: 'buy', spotAmt: '500' });
    openPerps();
    let f = takeFlow();
    let r = f.done();
    expect(flowText(f, r)).toMatch(/Visible onchain A position changed/);
    const [p] = useApp.getState().ledger.positions;
    expect(p!.commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(useApp.getState().ledger.lastChain).toEqual({ what: 'A TSLA position changed', commit: p!.commit, block: p!.block });
    spotTrade();
    f = takeFlow();
    r = f.done();
    expect(flowText(f, r)).toMatch(/Visible onchain The pool changed/);
    expect(useApp.getState().ledger.lastChain!.what).toBe('The TSLA pool changed');
  });

  it('receipts are not rewritten on testnet', () => {
    const rows: Array<[string, string]> = [['Visible onchain', 'x']];
    expect(receiptRows(rows)).toBe(rows);
  });
});
