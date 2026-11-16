'use client';
/**
 * Deposit USDC into the user's own Hyperliquid account without leaving Velum (lib/hyperliquid/deposit.ts): the user's
 * USDC on Arbitrum, an amount of at least 5 USDC, then the deposit flow dialog.
 */
import { HL_MIN_DEPOSIT_USDC } from '@velum/config/src/hyperliquid';
import { useState } from 'react';
import { amountInputProps } from '@/lib/amount';
import { DEPOSIT } from '@/lib/copy';
import { depositFlow, planDeposit, usdcText, useArbBalances, type DepositRefusal } from '@/lib/hyperliquid/deposit';
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

export function HlDepositModal() {
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
      <div className="m-head">
        <h3 id="m-title">{DEPOSIT.title}</h3>
        <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
          <I.x />
        </button>
      </div>
      <p className="m-text">{DEPOSIT.intro}</p>
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
