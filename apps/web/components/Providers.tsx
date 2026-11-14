'use client';
import { CHAIN } from '@velum/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WagmiProvider, useAccount } from 'wagmi';
import { checkLiq, demoTick } from '@/lib/demo';
import { startMarketFeed, useMarkets } from '@/lib/markets';
import { emptyLedger, loadLedger, recallSession, saveLedger, seedLedger, useApp } from '@/lib/store';
import { wagmiConfig } from '@/lib/wagmi';
import { I } from './icons';
import { ModalHost } from './modals/ModalHost';

/** Keeps the private-account session in step with the connected wallet. */
function AccountSync() {
  const { address, status, chainId } = useAccount();
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
    const paddr = recallSession(address);
    if (paddr) s.set({ account: { addr: address, paddr }, ledger: loadLedger(address) ?? seedLedger(), openChain: {} });
    else if (s.account) s.set({ account: null, ledger: emptyLedger(), openChain: {} });
  }, [address, status]);

  useEffect(() => {
    const s = useApp.getState();
    if (status !== 'connected' || !chainId || chainId === CHAIN.id) {
      prompted.current = null;
      return;
    }
    const k = `${address}:${chainId}`;
    if (prompted.current === k || s.modal) return;
    prompted.current = k;
    s.openModal({ kind: 'network' });
  }, [status, chainId, address]);

  // Persist the demo ledger per wallet (browser only).
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
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
  useEffect(() => {
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
