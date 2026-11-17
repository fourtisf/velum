'use client';
/**
 * Portfolio cards: Telegram alerts for this wallet's perps account (the wallet signs one message, no gas; the bot link
 * opens in Telegram; apps/workers/src/alerts.ts sends the alerts), and the wallet's invite link with how many wallets
 * arrived through it (lib/referral.ts). Neither exists for the server unless the user opts in.
 */
import { alertsMessage, refCode } from '@velum/config/src/alerts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { signMessage } from 'wagmi/actions';
import { ENV } from '@/lib/env';
import { useApp } from '@/lib/store';
import { wagmiConfig } from '@/lib/wagmi';

export function AlertsCard() {
  const s = useApp();
  const user = s.account?.addr;
  const cfg = useQuery({
    queryKey: ['alerts-config'],
    staleTime: 600_000,
    retry: 1,
    queryFn: async () => (await (await fetch(`${ENV.apiUrl}/v1/alerts`)).json()) as { enabled?: boolean; bot?: string | null },
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!user || !cfg.data?.enabled) return null;
  const link = async () => {
    setBusy(true);
    setMsg('');
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessage(wagmiConfig, { message: alertsMessage(user, issuedAt) });
      const r = await fetch(`${ENV.apiUrl}/v1/alerts/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: user, issuedAt, signature }) });
      const j = (await r.json()) as { url?: string; error?: { message?: string } };
      if (!r.ok || !j.url) throw new Error(j.error?.message ?? 'The link could not be created. Try again.');
      window.open(j.url, '_blank', 'noopener,noreferrer');
      setMsg('Telegram is opening: press Start in the bot to turn alerts on. The link works once, for 15 minutes.');
    } catch (e) {
      const m = String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? '');
      setMsg(/reject|denied/i.test(m) ? 'You declined the signature. Nothing was linked.' : m.slice(0, 160));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2 className="ph">Telegram alerts</h2>
      <p className="ph-sub">Liquidation warnings, fills (take profit, stop loss, closes) and deposits for this wallet&apos;s perps account, in Telegram.</p>
      <button className="btn btn-white btn-sm" style={{ marginTop: 12 }} disabled={busy} onClick={() => void link()}>
        {busy ? 'Waiting for your wallet…' : 'Get alerts on Telegram'}
      </button>
      {msg ? <p className="hint">{msg}</p> : null}
      <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
        Your wallet signs one message (no gas) to prove it is yours. Velum keeps only the link between this wallet and your Telegram chat; /stop in the bot deletes it.
      </p>
    </section>
  );
}

export function InviteCard() {
  const user = useApp((s) => s.account?.addr);
  const [copied, setCopied] = useState(false);
  const code = user ? refCode(user) : null;
  const stats = useQuery({
    queryKey: ['ref-stats', code],
    enabled: !!code,
    staleTime: 120_000,
    retry: 1,
    queryFn: async () => (await (await fetch(`${ENV.apiUrl}/v1/referrals/${code}`)).json()) as { friends?: number },
  });
  if (!user || !code) return null;
  const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/?ref=${code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the link is selectable */
    }
  };
  return (
    <section className="card">
      <h2 className="ph">Invite friends</h2>
      <p className="ph-sub">Share your link. Wallets that connect for the first time through it are counted here.</p>
      <div className="invite-row">
        <code className="invite-url">{url}</code>
        <button className="btn btn-dark btn-sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>
        Friends joined: <b className="num">{stats.data?.friends ?? '—'}</b>
      </p>
    </section>
  );
}
