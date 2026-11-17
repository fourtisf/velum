'use client';
import { installErrorReporting } from '@/lib/errorReport';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WagmiProvider, useConnection } from 'wagmi';
import { IS_MAINNET } from '@velum/config';
import { checkLiq, demoTick } from '@/lib/demo';
import { ENV } from '@/lib/env';
import { startMarketFeed, useMarkets } from '@/lib/markets';
import { REAL_BUILD, WALLET_ONLY, startOnchainCheck } from '@/lib/onchain/deployment';
import { dropLegacyStorage, emptyLedger, loadLedger, recallSession, saveLedger, seedLedger, useApp } from '@/lib/store';
import { wagmiConfig } from '@/lib/wagmi';
import { I } from './icons';
import { ModalHost } from './modals/ModalHost';

/** Keeps the private-account session in step with the connected wallet. */
function AccountSync() {
  const { address, status, chainId } = useConnection();
  const modal = useApp((s) => s.modal);
  const prompted = useRef<string | null>(null);

  useEffect(() => {
    if (status === 'connecting' || status === 'reconnecting') return;
    const s = useApp.getState();
    const cur = s.account?.addr.toLowerCase();
    if (status === 'disconnected' || !address) {
      if (s.account) s.set({ account: null, ledger: emptyLedger(), openChain: {} });
      return;
    }
    if (cur === address.toLowerCase()) return;
    // Mainnet without Velum contracts: the connected wallet is the account (no signature, no demo ledger).
    if (WALLET_ONLY) {
      s.set({ account: { addr: address, paddr: '' }, ledger: emptyLedger(), openChain: {} });
      return;
    }
    const paddr = recallSession(address);
    // A real build never shows the demo, so it never loads a demo ledger either: whatever a simulated
    // session left in this browser stays separate and untouched (web audit W3-06).
    if (paddr) s.set({ account: { addr: address, paddr }, ledger: REAL_BUILD ? emptyLedger() : (loadLedger(address) ?? seedLedger()), openChain: {} });
    else if (s.account) s.set({ account: null, ledger: emptyLedger(), openChain: {} });
  }, [address, status]);

  // Wrong network: ask once per wallet and chain. While another dialog is open the prompt waits and
  // shows when it closes (`modal` is a dependency, final audit W-13); a network dialog that is already
  // open counts as the prompt, so closing it does not bring it back.
  useEffect(() => {
    if (status !== 'connected' || !chainId || chainId === ENV.chainId) {
      prompted.current = null;
      return;
    }
    const k = `${address}:${chainId}`;
    if (prompted.current === k) return;
    if (modal?.kind === 'network') {
      prompted.current = k;
      return;
    }
    if (modal) return;
    prompted.current = k;
    useApp.getState().openModal({ kind: 'network' });
  }, [status, chainId, address, modal]);

  useEffect(dropLegacyStorage, []);

  // Persist the demo ledger per wallet (browser only). Not on a real build (no demo there, W3-06).
  useEffect(
    () =>
      REAL_BUILD
        ? undefined
        : useApp.subscribe((s, prev) => {
            if (s.account && s.ledger !== prev.ledger && s.account === prev.account) saveLedger(s.account.addr, s.ledger);
          }),
    [],
  );
  return null;
}

function VeilSync() {
  const veiled = useApp((s) => s.veiled);
  useEffect(() => {
    document.body.classList.toggle('veiled', veiled);
  }, [veiled]);
  return null;
}

function Feeds() {
  useEffect(() => startMarketFeed(), []);
  useEffect(() => installErrorReporting(), []);
  // Real transactions only when this build carries a deployment and the API serves the same one.
  useEffect(() => startOnchainCheck(), []);
  // Mainnet: the live ETH price (from the WETH/USDG pool), so ETH balances and amounts show in dollars.
  useEffect(() => {
    if (!IS_MAINNET) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import('@/lib/uniswap/ethPrice').then((m) => {
      if (!gone) stop = m.startEthPrice();
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  // The demo engine (simulated liquidations, maker fills, LP fees) runs only where the demo can be shown:
  // never on a real build, whatever the API says (web audit W3-06).
  useEffect(() => {
    if (REAL_BUILD) return;
    const unsub = useMarkets.subscribe((s, p) => {
      if (s.tick !== p.tick) checkLiq();
    });
    const t = setInterval(demoTick, 1600);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);
  return null;
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} msg={t.msg} warn={t.warn} />
      ))}
    </div>
  );
}

function ToastItem({ msg, warn }: { msg: string; warn?: boolean }) {
  const [fade, setFade] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFade(true), 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="toast" style={fade ? { transition: 'opacity .3s', opacity: 0 } : undefined}>
      {warn ? <I.info warn /> : <I.check />}
      <span>{msg}</span>
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2000 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <AccountSync />
        <VeilSync />
        <Feeds />
        {children}
        <ModalHost />
        <Toasts />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
