'use client';
/**
 * Withdraw free USDC from the user's own perps account back to their wallet (lib/hyperliquid/withdraw.ts), to:
 *  - Robinhood Chain (default): as USDG or ETH, through Relay, with a live, validated quote;
 *  - Ethereum: as ETH, through Relay;
 *  - Arbitrum: as USDC, the exchange's own withdrawal (1 USDC fee).
 * The flow dialog shows every amount before the wallet signs.
 */
import { HL_MIN_ARB_WITHDRAW_USDC, HL_MIN_RELAY_WITHDRAW_USDC, HL_WITHDRAW_FEE_USDC } from '@velum/config/src/hyperliquid';
import { useEffect, useState } from 'react';
import { amountInputProps } from '@/lib/amount';
import { WITHDRAW } from '@/lib/copy';
import { useHlBalances, useHlMode } from '@/lib/hyperliquid/client';
import {
  DESTS,
  arbWithdrawFlow,
  microExact,
  microText,
  outText,
  parseUsdc,
  relaySourceDex,
  relayWithdrawFlow,
  useRelayWithdrawQuote,
  withdrawRefusal,
  withdrawableMicro,
  type RelayDest,
  type WithdrawAsset,
  type WithdrawTo,
} from '@/lib/hyperliquid/withdraw';
import { useApp } from '@/lib/store';
import { I } from '../icons';

const HINT = 'wd-hint';
const TO: Array<[WithdrawTo, string]> = [
  ['robinhood', 'Robinhood Chain'],
  ['ethereum', 'Ethereum'],
  ['arb', 'Arbitrum'],
];

/** A value that settles `ms` after it stops changing (quotes are requested for the settled amount only). */
function useSettled<T>(v: T, ms: number): T {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
}

export function HlWithdrawModal() {
  const s = useApp();
  const user = s.account?.addr;
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const [to, setTo] = useState<WithdrawTo>('robinhood');
  const [asset, setAsset] = useState<WithdrawAsset>('USDG');
  const [amt, setAmt] = useState('');
  const free = bal.data ? withdrawableMicro(bal.data) : null;
  const locked = !!bal.data?.positions.length;
  const parsed = parseUsdc(amt);
  const units = parsed ?? 0n;
  const settled = useSettled(units, 450);
  const relayTo: RelayDest = to === 'arb' ? 'robinhood' : to;
  const assetNow: WithdrawAsset = DESTS[relayTo].assets.includes(asset) ? asset : 'ETH';
  const refusal = withdrawRefusal(parsed, free, to);
  const q = useRelayWithdrawQuote(to !== 'arb' && !refusal ? user : undefined, relayTo, assetNow, settled, mode.data ? relaySourceDex(mode.data) : null);
  const quote = to !== 'arb' && settled === units ? (q.data ?? null) : null;

  let hint = '';
  let label: string;
  let go: (() => void) | undefined;
  if (!user) label = 'Connect wallet';
  else if (mode.isError || bal.isError) label = 'Perps account unavailable';
  else if (amt.trim() !== '' && parsed === null) label = 'Enter a valid amount';
  else if (refusal === 'amount') {
    label = 'Enter an amount';
    if (free === 0n) hint = locked ? WITHDRAW.locked : WITHDRAW.empty;
  } else if (refusal === 'loading') label = 'Reading your perps account…';
  else if (refusal === 'balance') {
    label = 'More than you can withdraw';
    hint = `${WITHDRAW.over(microText(free ?? 0n))}${locked ? ` ${WITHDRAW.locked}` : ''}`;
  } else if (refusal === 'min') {
    label = `Minimum ${to === 'arb' ? HL_MIN_ARB_WITHDRAW_USDC : HL_MIN_RELAY_WITHDRAW_USDC} USDC`;
    hint = to === 'arb' ? WITHDRAW.arbMin(HL_MIN_ARB_WITHDRAW_USDC, HL_WITHDRAW_FEE_USDC) : WITHDRAW.relayMin(HL_MIN_RELAY_WITHDRAW_USDC);
  } else if (to === 'arb') {
    label = `Withdraw ${microText(units)} USDC`;
    go = () => s.runHlFlow(arbWithdrawFlow({ user, amount: units }));
  } else if (!quote && (q.isFetching || settled !== units)) label = 'Getting a quote…';
  else if (q.isError || !quote) {
    label = 'No route right now';
    hint = q.error instanceof Error ? q.error.message : WITHDRAW.noRoute;
  } else {
    label = `Withdraw ${microText(units)} USDC`;
    go = () => s.runHlFlow(relayWithdrawFlow({ user, to: relayTo, asset: assetNow, amount: units, plan: quote }));
  }
  const preset = (pct: number) => {
    if (!free) return;
    setAmt(microExact(pct === 100 ? free : ((free * BigInt(pct)) / 100n / 10_000n) * 10_000n));
  };
  const pickTo = (k: WithdrawTo) => {
    setTo(k);
    if (k === 'ethereum') setAsset('ETH');
    if (k === 'robinhood') setAsset('USDG');
  };
  const fee = BigInt(HL_WITHDRAW_FEE_USDC) * 1_000_000n;
  return (
    <>
      <div className="m-head">
        <h3 id="m-title">{WITHDRAW.title}</h3>
        <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
          <I.x />
        </button>
      </div>
      <p className="m-text">{WITHDRAW.intro}</p>
      <div className="fl" style={{ marginTop: 14 }}>
        <span>Withdraw to</span>
      </div>
      <div className="seg full seg-src" role="group" aria-label="Withdraw to">
        {TO.map(([k, l]) => (
          <button key={k} className={to === k ? 'on' : ''} aria-pressed={to === k} onClick={() => pickTo(k)}>
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
      {to === 'robinhood' ? (
        <div className="seg full" role="group" aria-label="Receive" style={{ marginTop: 10 }}>
          {DESTS.robinhood.assets.map((x) => (
            <button key={x} className={assetNow === x ? 'on' : ''} aria-pressed={assetNow === x} onClick={() => setAsset(x)}>
              Receive {x}
            </button>
          ))}
        </div>
      ) : null}
      <div className="fl" style={{ marginTop: 14 }}>
        <label htmlFor="wd-amt">You withdraw</label>
        <span>
          Free <b className="num">{free !== null ? `${microText(free)} USDC` : mode.isError || bal.isError ? '—' : '…'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="wd-amt" {...amountInputProps(amt, HINT)} value={amt} placeholder="10.00" onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDC</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)} disabled={!free}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      {to === 'arb' ? (
        <div className="receipt" style={{ marginTop: 14 }}>
          <div>
            <span>You receive on Arbitrum</span>
            <b>{units > fee ? `${microText(units - fee)} USDC` : '—'}</b>
          </div>
          <div>
            <span>Fee</span>
            <b>{HL_WITHDRAW_FEE_USDC} USDC (exchange)</b>
          </div>
          <div>
            <span>Route</span>
            <b>Direct to Arbitrum</b>
          </div>
        </div>
      ) : (
        <div className="receipt" style={{ marginTop: 14 }}>
          <div>
            <span>You receive on {DESTS[relayTo].label}</span>
            <b>{quote ? `≈ ${outText(assetNow, quote.out)} ${assetNow}` : units > 0n && !q.isError && !refusal ? '…' : '—'}</b>
          </div>
          <div>
            <span>Minimum (guaranteed)</span>
            <b>{quote ? `${outText(assetNow, quote.minOut)} ${assetNow}` : '—'}</b>
          </div>
          <div>
            <span>Fees</span>
            <b>{quote && quote.feeUsd !== null ? `≈ $${quote.feeUsd.toFixed(2)}` : '—'}</b>
          </div>
          <div>
            <span>Route</span>
            <b>Relay · to {DESTS[relayTo].label}</b>
          </div>
        </div>
      )}
      <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!go && !!user} onClick={go ?? (() => s.openModal({ kind: 'connect' }))}>
        {label}
      </button>
      <p className="hint" id={HINT}>
        {hint}
      </p>
      <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
        {to === 'arb' ? WITHDRAW.arbFooter : WITHDRAW.relayFooter}
      </p>
    </>
  );
}
