'use client';
/** The swap page in real (Phase 3) mode: same layout, quoted by SpotPools.getAmountOut, minimum from the slippage setting. */
import { useQuery } from '@tanstack/react-query';
import { PROTOCOL } from '@velum/config';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { publicClient } from '@/lib/chain';
import { ONCHAIN } from '@/lib/copy';
import { dp, fmtBal, sig4 } from '@/lib/format';
import { SPOT_ABI } from '@/lib/onchain/abi';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { approx, exact, swapFlow } from '@/lib/onchain/flows';
import { GUARD_COPY } from '@/lib/onchain/guard';
import { minOut, poolFee, slipBps } from '@/lib/onchain/quote';
import { unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { useApp } from '@/lib/store';
import { I } from '../icons';
import { useOc } from './useOc';

type A = `0x${string}`;

export function OcSwapView({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const c = useOc(oc);
  const connected = !!s.account;
  const toks = ['USDG', ...oc.markets];
  const f = toks.includes(s.swapFrom) ? s.swapFrom : 'USDG';
  const t = toks.includes(s.swapTo) ? s.swapTo : (oc.markets[0] ?? 'USDG');
  const same = f === t;
  const hops: 1 | 2 = f !== 'USDG' && t !== 'USDG' ? 2 : 1;
  const dIn = c.dec(f);
  const dOut = c.dec(t);
  const have = c.acct?.vault[f] ?? 0n;
  const units = dIn === undefined ? null : wadToUnits(amountOrZero(s.swapAmt), dIn);
  const amountIn = units?.ok ? units.units : 0n;
  const slip = slipBps(s.slip);
  const sp = oc.d.contracts.spotPools as A;
  const quote = useQuery({
    queryKey: ['oc-quote', sp, f, t, amountIn.toString()],
    enabled: !same && amountIn > 0n,
    refetchInterval: 5000,
    retry: false,
    queryFn: async () => {
      try {
        const out = await publicClient.readContract({ address: sp, abi: SPOT_ABI, functionName: 'getAmountOut', args: [oc.d.tokens[f] as A, oc.d.tokens[t] as A, amountIn] });
        // Two hops: the USDG leg, for the second pool's fee.
        const mid = hops === 2 ? await publicClient.readContract({ address: sp, abi: SPOT_ABI, functionName: 'getAmountOut', args: [oc.d.tokens[f] as A, oc.d.tokens.USDG as A, amountIn] }) : null;
        return { out, mid };
      } catch {
        return null;
      }
    },
  });
  const out = quote.data?.out ?? null;
  const min = out === null ? 0n : minOut(out, slip);
  const ud = c.dec('USDG');
  const feeText =
    dIn === undefined || ud === undefined
      ? '—'
      : hops === 2
        ? `${approx(poolFee(amountIn), dIn, dp(f))} ${f} + ${quote.data?.mid ? approx(poolFee(quote.data.mid), ud) : '—'} USDG`
        : `${approx(poolFee(amountIn), dIn, dp(f))} ${f}`;
  const bad = amountHint(s.swapAmt);
  let hint = bad;
  let btn: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!connected) btn = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (same) btn = { label: 'Choose two different tokens', cls: 'btn-dark', disabled: true };
  else if (c.guard.blocked) {
    btn = { label: GUARD_COPY.blockedShort, cls: 'btn-dark', disabled: true };
    hint = GUARD_COPY.blocked;
  } else if (bad || (units && !units.ok)) {
    btn = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
    if (!bad) hint = `${f} has ${dIn} decimals: use at most ${dIn} decimal places.`;
  } else if (amountIn <= 0n) btn = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (amountIn > have) {
    btn = { label: `Not enough ${f} in your vault`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmtBal(unitsToWad(have, dIn!), dp(f))} ${f} available.`;
  } else if (quote.isLoading) btn = { label: 'Quoting…', cls: 'btn-dark', disabled: true };
  else if (out === null || out === 0n) {
    btn = { label: 'No liquidity', cls: 'btn-dark', disabled: true };
    hint = 'A pool on this route has no liquidity for this trade yet.';
  } else if (min === 0n) {
    btn = { label: 'Amount too small', cls: 'btn-dark', disabled: true };
    hint = 'This amount is too small to protect with a minimum.';
  } else btn = { label: 'Swap', cls: 'btn-white', disabled: !c.base, onClick: () => c.base && s.runTxFlow(swapFlow(c.base, { from: f, to: t, amountIn, quote: out, min, hops, slip, fee: feeText })) };
  const rate = out !== null && amountIn > 0n && dIn !== undefined && dOut !== undefined ? (unitsToWad(out, dOut) * 10n ** 18n) / unitsToWad(amountIn, dIn) : null;
  const [visK, visV] = ONCHAIN.visibleRow;

  const select = (id: string, label: string, value: string, onChange: (v: string) => void) => (
    <select className="sel" id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {toks.map((x) => (
        <option key={x} value={x}>
          {x}
        </option>
      ))}
    </select>
  );

  return (
    <div className="swap-wrap">
      <div className="vhead">
        <div>
          <h1 className="vtitle">Swap</h1>
          <p className="vsub">{ONCHAIN.swapSub}</p>
        </div>
      </div>
      <div className="card swapcard">
        <div className="sbox">
          <div className="lb">
            <span>You pay</span>
            <span>
              Available <b className="num">{connected && dIn !== undefined ? `${fmtBal(unitsToWad(have, dIn), dp(f))} ${f}` : '—'}</b>
            </span>
          </div>
          <div className="srow">
            <input id="sw-in" {...amountInputProps(s.swapAmt, 'sw-hint')} value={s.swapAmt} aria-label="Amount to pay" onChange={(e) => s.set({ swapAmt: e.target.value })} />
            {select('sw-from', 'Token to pay', f, (v) => s.set({ swapFrom: v }))}
          </div>
          <div className="seg full pcts" role="group" aria-label="Amount presets">
            {[25, 50, 100].map((p) => (
              <button key={p} onClick={() => dIn !== undefined && s.set({ swapAmt: unitsToInput((have * BigInt(p)) / 100n, dIn, dp(f)) })}>
                {p === 100 ? 'Max' : p + '%'}
              </button>
            ))}
          </div>
        </div>
        <button className="flipbtn" aria-label="Switch tokens" onClick={() => s.set({ swapFrom: t, swapTo: f })}>
          <I.flip />
        </button>
        <div className="sbox">
          <div className="lb">
            <span>You get (est.)</span>
            <span className="num">{same ? '' : `1 ${f} = ${rate !== null ? sig4(rate) : '—'} ${t}`}</span>
          </div>
          <div className="srow">
            <output aria-label="You get (est.)">{same || amountIn <= 0n ? '0.00' : out !== null && dOut !== undefined ? approx(out, dOut, dp(t)) : '—'}</output>
            {select('sw-to', 'Token to receive', t, (v) => s.set({ swapTo: v }))}
          </div>
        </div>
        <div className="fl">
          <span>Slippage limit</span>
        </div>
        <div className="seg full" role="group" aria-label="Slippage">
          {PROTOCOL.slippageOptionsPct.map((x) => (
            <button key={x} className={s.slip === x ? 'on' : ''} aria-pressed={s.slip === x} onClick={() => s.set({ slip: x })}>
              {x}%
            </button>
          ))}
        </div>
        <div className="sumbox" style={{ borderTop: 0, padding: '4px 4px 0' }}>
          <div>
            <span>Route</span>
            <b>
              <span className="route">
                {f}
                <I.chev />
                {hops === 2 ? (
                  <>
                    USDG
                    <I.chev />
                  </>
                ) : null}
                {t}
              </span>
            </b>
          </div>
          <div>
            <span>Pool fee{hops === 2 ? ' (2 pools)' : ''}</span>
            <b>{same ? '—' : feeText}</b>
          </div>
          <div>
            <span>Minimum you get</span>
            <b>{out !== null && dOut !== undefined ? `${exact(min, dOut)} ${t}` : '—'}</b>
          </div>
          <div>
            <span>{visK}</span>
            <b>{visV}</b>
          </div>
        </div>
        <button className={`btn btn-block ${btn.cls}`} disabled={btn.disabled} onClick={btn.onClick}>
          {btn.label}
        </button>
        <p className="hint" id="sw-hint">
          {hint}
        </p>
        <p className="note">
          <I.lock />
          <span>{ONCHAIN.swapNote}</span>
        </p>
      </div>
    </div>
  );
}
