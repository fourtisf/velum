'use client';
/**
 * Deposit into the user's own Hyperliquid account without leaving Velum, from:
 *  - Robinhood Chain (default): ETH or USDG from the wallet, bridged by Relay into USDC on Hyperliquid
 *    (lib/hyperliquid/relay.ts), with a live, validated quote;
 *  - Ethereum: ETH from the wallet on Ethereum mainnet, bridged by Relay the same way (the wallet switches to Ethereum
 *    for the one transaction and back);
 *  - Arbitrum: native USDC sent to Hyperliquid's bridge (lib/hyperliquid/deposit.ts), at least 5 USDC.
 * Either way the deposit flow dialog shows every amount before the wallet signs.
 */
import { HL_MIN_DEPOSIT_USDC } from '@velum/config/src/hyperliquid';
import { useEffect, useState } from 'react';
import { amountInputProps } from '@/lib/amount';
import { usePublicBalances } from '@/lib/balances';
import { valueOf } from '@/lib/calc';
import { DEPOSIT } from '@/lib/copy';
import { usd } from '@/lib/format';
import { useEthereumEth } from '@/lib/ethereumEth';
import { depositFlow, planDeposit, usdcText, useArbBalances, type DepositRefusal } from '@/lib/hyperliquid/deposit';
import { ORIGINS, RELAY_MIN_OUT, ethReserve, hlUsdcText, relayDepositFlow, sourceText, sourceUnits, useRelayQuote, type RelayOrigin, type RelaySource } from '@/lib/hyperliquid/relay';
import { useMarkets, usePriceTick } from '@/lib/markets';
import { useApp } from '@/lib/store';
import { I } from '../icons';

const HINT = 'dep-hint';
const LABEL: Record<DepositRefusal, string> = {
  amount: 'Enter an amount',
  min: `Minimum ${HL_MIN_DEPOSIT_USDC} USDC`,
  balance: 'Not enough USDC on Arbitrum',
  gas: 'No ETH on Arbitrum for gas',
  loading: 'Reading your Arbitrum wallet…',
};

type From = RelayOrigin | 'arb';
const FROM: Array<[From, string]> = [
  ['robinhood', 'Robinhood Chain'],
  ['ethereum', 'Ethereum'],
  ['arb', 'Arbitrum'],
];

export function HlDepositModal() {
  const s = useApp();
  const [from, setFrom] = useState<From>('robinhood');
  return (
    <>
      <div className="m-head">
        <h3 id="m-title">{DEPOSIT.title}</h3>
        <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
          <I.x />
        </button>
      </div>
      <p className="m-text">{DEPOSIT.intro}</p>
      <div className="fl" style={{ marginTop: 14 }}>
        <span>Deposit from</span>
      </div>
      <div className="seg full seg-src" role="group" aria-label="Deposit from">
        {FROM.map(([k, l]) => (
          <button key={k} className={from === k ? 'on' : ''} aria-pressed={from === k} onClick={() => setFrom(k)}>
            {k === 'robinhood' ? (
              <>
                <span className="hide-sm">{l}</span>
                <span className="show-sm">Robinhood</span>
              </>
            ) : (
              l
            )}
          </button>
        ))}
      </div>
      {from === 'arb' ? <ArbDeposit /> : <RelayDeposit key={from} origin={from} />}
    </>
  );
}

/** A value that settles `ms` after it stops changing (quotes are requested for the settled amount only). */
function useSettled<T>(v: T, ms: number): T {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
}

/** ETH or USDG on Robinhood Chain, or ETH on Ethereum, bridged by Relay into USDC on Hyperliquid. */
function RelayDeposit({ origin }: { origin: RelayOrigin }) {
  usePriceTick();
  useMarkets((m) => m.ethPx);
  const s = useApp();
  const user = s.account?.addr;
  const pub = usePublicBalances(origin === 'robinhood' ? user : undefined);
  const l1 = useEthereumEth(origin === 'ethereum' ? user : undefined);
  const where = ORIGINS[origin];
  const [src, setSrc] = useState<RelaySource>('ETH');
  const [amt, setAmt] = useState('');
  const parsed = sourceUnits(src, amt);
  const units = parsed ?? 0n;
  const settled = useSettled(units, 450);
  const q = useRelayQuote(user, origin, src, settled);
  const quote = settled === units ? (q.data ?? null) : null;
  // The wallet's balance on the origin chain, as a wad: Robinhood Chain's reads, or ETH on Ethereum.
  const wad = origin === 'ethereum' ? (l1.data ?? null) : (pub.data?.bal[src] ?? null);
  const readErr = origin === 'ethereum' ? l1.isError : pub.isError;
  // Base units of the source: ETH is already 18 decimals; USDG has 6 (the balance wad rounded down).
  const have = wad === null ? null : src === 'ETH' ? wad : wad / 10n ** 12n;
  const eth = origin === 'ethereum' ? (l1.data ?? null) : (pub.data?.bal.ETH ?? null);
  const reserve = ethReserve(origin);
  const spendable = have === null ? null : src === 'ETH' ? (have > reserve ? have - reserve : 0n) : have;
  const inUsd = units > 0n ? valueOf(src, src === 'ETH' ? units : units * 10n ** 12n) : null;
  let hint = '';
  let label: string;
  let go: (() => void) | undefined;
  if (!user) label = 'Connect wallet';
  else if (amt.trim() !== '' && parsed === null) label = 'Enter a valid amount';
  else if (units === 0n) label = 'Enter an amount';
  else if (spendable === null) label = readErr ? 'Balance unavailable' : 'Reading your wallet…';
  else if (units > spendable) {
    label = `Not enough ${src} on ${where.label}`;
    hint = src === 'ETH' ? DEPOSIT.ethHint(sourceText('ETH', spendable), where.label) : DEPOSIT.rhHolds(`${sourceText('USDG', have ?? 0n)} USDG`);
  } else if (src === 'USDG' && eth === 0n) {
    label = 'No ETH for gas';
    hint = DEPOSIT.rhGas;
  } else if (!quote && (q.isFetching || settled !== units)) label = 'Getting a quote…';
  else if (q.isError || !quote) {
    label = 'No route right now';
    hint = q.error instanceof Error ? q.error.message : DEPOSIT.rhNoRoute;
  } else if (quote.minOut < RELAY_MIN_OUT) {
    label = `Minimum ${HL_MIN_DEPOSIT_USDC} USDC on Hyperliquid`;
    hint = DEPOSIT.rhMin;
  } else {
    label = `Deposit ${sourceText(src, units)} ${src}`;
    go = () => s.runHlFlow(relayDepositFlow({ user, origin, source: src, amount: units, plan: quote }));
  }
  const preset = (pct: number) => {
    if (spendable === null) return;
    const u = (spendable * BigInt(pct)) / 100n;
    setAmt(sourceText(src, u));
  };
  const pick = (x: RelaySource) => {
    setSrc(x);
    setAmt('');
  };
  return (
    <>
      {where.sources.length > 1 ? (
        <div className="seg full" role="group" aria-label="Pay with" style={{ marginTop: 10 }}>
          {where.sources.map((x) => (
            <button key={x} className={src === x ? 'on' : ''} aria-pressed={src === x} onClick={() => pick(x)}>
              Pay with {x}
            </button>
          ))}
        </div>
      ) : null}
      <div className="fl" style={{ marginTop: 14 }}>
        <label htmlFor="dep-amt">You send</label>
        <span>
          {origin === 'ethereum' ? 'Ethereum wallet' : 'Wallet'}{' '}
          <b className="num">
            {have !== null ? `${sourceText(src, have)} ${src}` : readErr ? '—' : '…'}
            {have !== null && wad !== null && valueOf(src, wad) !== null ? ` · ${usd(valueOf(src, wad)!)}` : ''}
          </b>
        </span>
      </div>
      <div className="inp">
        <input id="dep-amt" {...amountInputProps(amt, HINT)} value={amt} placeholder={src === 'ETH' ? '0.01' : '10.00'} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">{src}</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)} disabled={!spendable}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="receipt" style={{ marginTop: 14 }}>
        <div>
          <span>You send (USD)</span>
          <b>{inUsd !== null ? `≈ ${usd(inUsd)}` : '—'}</b>
        </div>
        <div>
          <span>You receive on Hyperliquid</span>
          <b>{quote ? `≈ ${hlUsdcText(quote.out)} USDC` : units > 0n && !q.isError ? '…' : '—'}</b>
        </div>
        <div>
          <span>Minimum (guaranteed)</span>
          <b>{quote ? `${hlUsdcText(quote.minOut)} USDC` : '—'}</b>
        </div>
        <div>
          <span>Fees</span>
          <b>{quote && quote.feeUsd !== null ? `≈ $${quote.feeUsd.toFixed(2)}` : '—'}</b>
        </div>
        <div>
          <span>Route</span>
          <b>Relay · from {where.label}</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!go && !!user} onClick={go ?? (() => s.openModal({ kind: 'connect' }))}>
        {label}
      </button>
      <p className="hint" id={HINT}>
        {hint}
      </p>
      <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
        {DEPOSIT.rhFooter}
      </p>
    </>
  );
}

/** Native USDC on Arbitrum, sent to Hyperliquid's bridge. */
function ArbDeposit() {
  const s = useApp();
  const user = s.account?.addr;
  const bal = useArbBalances(user);
  const [amt, setAmt] = useState('');
  const b = bal.data ?? null;
  const plan = planDeposit(amt, b);
  let hint = '';
  let label: string;
  let go: (() => void) | undefined;
  if (!user) label = 'Connect wallet';
  else if (bal.isError) {
    label = 'Arbitrum unavailable';
    hint = DEPOSIT.arbDown;
  } else if (plan.ok) {
    label = `Deposit ${usdcText(plan.units)} USDC`;
    go = () => s.runHlFlow(depositFlow({ user, units: plan.units }));
  } else {
    label = LABEL[plan.reason];
    if (plan.reason === 'min') hint = DEPOSIT.minHint;
    if (plan.reason === 'balance' && b) hint = b.usdc === 0n ? DEPOSIT.noUsdc : DEPOSIT.holds(usdcText(b.usdc));
    if (plan.reason === 'gas') hint = DEPOSIT.gasHint;
  }
  if (b && b.usdc === 0n && !hint) hint = DEPOSIT.noUsdc;
  const preset = (pct: number) => b && setAmt(usdcText((b.usdc * BigInt(pct)) / 100n));
  return (
    <>
      <div className="fl" style={{ marginTop: 14 }}>
        <label htmlFor="dep-amt">Amount</label>
        <span>
          Arbitrum wallet <b className="num">{b ? `${usdcText(b.usdc)} USDC` : bal.isError ? '—' : '…'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="dep-amt" {...amountInputProps(amt, HINT)} value={amt} placeholder={`${HL_MIN_DEPOSIT_USDC}.00`} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDC</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)} disabled={!b || b.usdc === 0n}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="receipt" style={{ marginTop: 14 }}>
        <div>
          <span>To</span>
          <b>Your Hyperliquid account</b>
        </div>
        <div>
          <span>Gas (ETH on Arbitrum)</span>
          <b>{b ? (b.eth > 0n ? 'Available' : 'None') : '…'}</b>
        </div>
        <div>
          <span>Minimum</span>
          <b>{HL_MIN_DEPOSIT_USDC} USDC</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!go && !!user} onClick={go ?? (() => s.openModal({ kind: 'connect' }))}>
        {label}
      </button>
      <p className="hint" id={HINT}>
        {hint}
      </p>
      <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
        {DEPOSIT.footer}
      </p>
    </>
  );
}
