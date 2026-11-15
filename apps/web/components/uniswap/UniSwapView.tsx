'use client';
/**
 * The swap page on Robinhood Chain mainnet: real swaps from the connected wallet through Uniswap, in the prototype's
 * layout. USDG <-> Stock Token is one swap through the best curated pool; Stock Token <-> Stock Token is two swaps
 * through USDG (quoted leg by leg on chain), with the overall minimum enforced by the second swap.
 */
import { PROTOCOL } from '@velum/config';
import { UNISWAP, feePct } from '@velum/config/src/uniswap';
import { useQuery } from '@tanstack/react-query';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { usePublicBalances } from '@/lib/balances';
import { UNI } from '@/lib/copy';
import { dp, fmt, fmtBal, fmtFloor, sig4 } from '@/lib/format';
import { slipBps } from '@/lib/onchain/quote';
import { unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { minOutFor } from '@/lib/uniswap/encode';
import { uniTradeFlow } from '@/lib/uniswap/flows';
import { bestQuote, poolsOf } from '@/lib/uniswap/quote';
import { useApp } from '@/lib/store';
import { I } from '../icons';

export function UniSwapView() {
  const s = useApp();
  const cfg = UNISWAP!;
  const connected = !!s.account;
  const markets = Object.keys(cfg.pools).filter((m) => poolsOf(m).length > 0);
  const toks = ['USDG', ...markets];
  const f = toks.includes(s.swapFrom) ? s.swapFrom : 'USDG';
  const t = toks.includes(s.swapTo) ? s.swapTo : (markets[0] ?? 'USDG');
  const same = f === t;
  const two = f !== 'USDG' && t !== 'USDG';
  const decOf = (x: string) => (x === 'USDG' ? cfg.usdg.decimals : cfg.decimals[x]!);
  const dIn = decOf(f);
  const dOut = decOf(t);
  const pub = usePublicBalances(s.account?.addr);
  const haveWad = pub.data?.bal[f] ?? null;
  const haveU = haveWad !== null ? wadToUnits(haveWad, dIn) : null;
  const have = haveU?.ok ? haveU.units : null;
  const eth = pub.data?.bal.ETH ?? null;
  const units = wadToUnits(amountOrZero(s.swapAmt), dIn);
  const amountIn = units.ok ? units.units : 0n;
  const slip = slipBps(s.slip);

  const q = useQuery({
    queryKey: ['uni-swap', f, t, amountIn.toString()],
    enabled: !same && amountIn > 0n,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
    queryFn: async () => {
      if (!two) {
        const sym = f === 'USDG' ? t : f;
        const r = await bestQuote(poolsOf(sym), f === 'USDG' ? 'buy' : 'sell', amountIn);
        return r ? { first: r, second: null } : null;
      }
      const a = await bestQuote(poolsOf(f), 'sell', amountIn);
      if (!a) return null;
      // The second leg is quoted for the first leg's estimated output; the overall minimum below allows the slippage on
      // both legs, and the second swap is re-quoted for the exact USDG the first one paid out when it runs.
      const b = await bestQuote(poolsOf(t), 'buy', a.amountOut);
      return b ? { first: a, second: b } : null;
    },
  });
  const r = q.data ?? null;
  const out = r ? (r.second ?? r.first).amountOut : null;
  const firstMin = r ? minOutFor(r.first.amountOut, slip) : 0n;
  // Two legs: the overall minimum allows the slippage once on each leg.
  const min = out === null ? 0n : two ? minOutFor(minOutFor(out, slip), slip) : minOutFor(out, slip);
  const rate = out !== null && amountIn > 0n ? (unitsToWad(out, dOut) * 10n ** 18n) / unitsToWad(amountIn, dIn) : null;

  const bad = amountHint(s.swapAmt);
  let hint = bad;
  let btn: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!connected) btn = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (same) btn = { label: 'Choose two different tokens', cls: 'btn-dark', disabled: true };
  else if (bad || !units.ok) {
    btn = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
    if (!bad) hint = `${f} has ${dIn} decimals: use at most ${dIn} decimal places.`;
  } else if (amountIn <= 0n) btn = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (have === null) btn = { label: pub.isError ? 'Balance unavailable' : 'Reading your wallet…', cls: 'btn-dark', disabled: true };
  else if (amountIn > have) {
    btn = { label: `Not enough ${f} in your wallet`, cls: 'btn-dark', disabled: true };
    hint = `Your wallet holds ${fmtBal(unitsToWad(have, dIn), dp(f))} ${f}.`;
  } else if (eth !== null && eth === 0n) {
    btn = { label: 'No ETH for gas', cls: 'btn-dark', disabled: true };
    hint = UNI.gasHint;
  } else if (q.isLoading) btn = { label: 'Quoting…', cls: 'btn-dark', disabled: true };
  else if (!r || out === null) {
    btn = { label: 'No liquidity', cls: 'btn-dark', disabled: true };
    hint = UNI.noLiquidity;
  } else if (min <= 0n || firstMin <= 0n) {
    btn = { label: 'Amount too small', cls: 'btn-dark', disabled: true };
    hint = 'This amount is too small to protect with a minimum.';
  } else
    btn = {
      label: 'Swap',
      cls: 'btn-white',
      disabled: false,
      onClick: () =>
        s.runTxFlow(
          uniTradeFlow({
            account: s.account!.addr,
            from: f,
            to: t,
            amountIn,
            quoteOut: out,
            minOut: min,
            first: r.first.hop,
            firstMin: two ? firstMin : min,
            ...(r.second ? { second: r.second.hop } : {}),
            title: `Swap ${f} for ${t}`,
            toast: `Swapped ${f} for ${t}`,
          }),
        ),
    };

  const select = (id: string, label: string, value: string, onChange: (v: string) => void) => (
    <select className="sel" id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {toks.map((x) => (
        <option key={x} value={x}>
          {x}
        </option>
      ))}
    </select>
  );
  const fees = r ? [r.first, r.second].filter((x) => x !== null).map((x) => feePct(x!.hop.pool.fee)) : [];

  return (
    <div className="swap-wrap">
      <div className="vhead">
        <div>
          <h1 className="vtitle">Swap</h1>
          <p className="vsub">{UNI.swapSub}</p>
        </div>
      </div>
      <div className="card swapcard">
        <div className="sbox">
          <div className="lb">
            <span>You pay</span>
            <span>
              Wallet <b className="num">{connected && haveWad !== null ? `${fmtBal(haveWad, dp(f))} ${f}` : '—'}</b>
            </span>
          </div>
          <div className="srow">
            <input id="sw-in" {...amountInputProps(s.swapAmt, 'sw-hint')} value={s.swapAmt} aria-label="Amount to pay" onChange={(e) => s.set({ swapAmt: e.target.value })} />
            {select('sw-from', 'Token to pay', f, (v) => s.set({ swapFrom: v }))}
          </div>
          <div className="seg full pcts" role="group" aria-label="Amount presets">
            {[25, 50, 100].map((p) => (
              <button key={p} disabled={have === null} onClick={() => have !== null && s.set({ swapAmt: unitsToInput((have * BigInt(p)) / 100n, dIn, dp(f)) })}>
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
            <output aria-label="You get (est.)">{same || amountIn <= 0n ? '0.00' : out !== null ? fmt(unitsToWad(out, dOut), dp(t)) : q.isLoading ? '…' : '—'}</output>
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
                {two ? (
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
            <span>Pool fee{two ? ' (2 pools)' : ''}</span>
            <b>{fees.length ? `${fees.join(' + ')} (in the quote)` : '—'}</b>
          </div>
          <div>
            <span>Minimum you get</span>
            {/* Rounded down: never more than the onchain minimum (the review dialog shows it exactly). */}
            <b>{out !== null ? `${fmtFloor(unitsToWad(min, dOut), dp(t))} ${t}` : '—'}</b>
          </div>
          <div>
            <span>Venue</span>
            <b>Uniswap, public onchain</b>
          </div>
        </div>
        <button className={`btn btn-block ${btn.cls}`} disabled={btn.disabled} onClick={btn.onClick}>
          {btn.label}
        </button>
        <p className="hint" id="sw-hint">
          {hint}
        </p>
        <p className="note">
          <I.info />
          <span>{UNI.swapNote}</span>
        </p>
      </div>
    </div>
  );
}
