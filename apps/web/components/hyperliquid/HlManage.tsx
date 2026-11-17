'use client';
/**
 * Dialogs for managing a real perps position (lib/hyperliquid/manage.ts, risk.ts):
 *  - Close: all or a share of the position (25 / 50 / 75 / 100%) with a reduce-only immediate order;
 *  - TP/SL: set or replace the position's take profit and stop loss, with the P&L each would realise;
 *  - Margin: add margin to the isolated position or remove some, with the new liquidation price estimate.
 * Each opens the flow dialog (review, then steps) before anything is signed.
 */
import { parseWad, toDecimalString } from '@velum/math';
import { useState } from 'react';
import { amountInputProps } from '@/lib/amount';
import { fmt, fmtLev } from '@/lib/format';
import { useHlBalances, useHlMarkets, useHlMid, useHlMode, type HlPosition } from '@/lib/hyperliquid/client';
import { cancelFlow, marginFlow, partialCloseFlow, tpslFlow, useHlOpenOrders } from '@/lib/hyperliquid/manage';
import { liqAfterMargin, ntliOf, planPartialClose, planTpsl, tpslOf, type TpslRefusal } from '@/lib/hyperliquid/risk';
import { slipBps } from '@/lib/onchain/quote';
import { useApp } from '@/lib/store';
import { I } from '../icons';

const usd = (v: string | null) => {
  const w = v === null ? null : parseWad(v.replace(/^-/, ''));
  return w === null ? '—' : fmt(w);
};
const pnlText = (v: string) => (v.startsWith('-') ? `-$${usd(v)}` : `+$${usd(v)}`);

function Head({ title }: { title: string }) {
  const s = useApp();
  return (
    <div className="m-head">
      <h3 id="m-title">{title}</h3>
      <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
        <I.x />
      </button>
    </div>
  );
}

/** The user's position in `sym`, and what the dialogs need around it. */
function usePosition(sym: string) {
  const s = useApp();
  const user = s.account?.addr;
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const markets = useHlMarkets();
  const market = markets.data?.[sym] ?? null;
  const mid = useHlMid(market?.coin ?? null);
  const pos: HlPosition | null = market ? (bal.data?.positions.find((p) => p.coin === market.coin) ?? null) : null;
  return { s, user, mode, bal, market, mid: mid.data ?? null, pos };
}

function Missing({ title, sym }: { title: string; sym: string }) {
  return (
    <>
      <Head title={title} />
      <p className="m-text">No open {sym} position right now.</p>
    </>
  );
}

const Summary = ({ pos }: { pos: HlPosition }) => {
  const long = !pos.szi.startsWith('-');
  return (
    <div className="receipt" style={{ marginTop: 12 }}>
      <div>
        <span>Position</span>
        <b className={long ? 'up' : 'down'}>
          {long ? 'Long' : 'Short'} {pos.szi.replace(/^-/, '')} {pos.symbol} · {fmtLev(pos.leverage)}
        </b>
      </div>
      <div>
        <span>Entry</span>
        <b>{usd(pos.entryPx)}</b>
      </div>
      <div>
        <span>Liquidation</span>
        <b>{pos.liquidationPx ? usd(pos.liquidationPx) : 'None'}</b>
      </div>
      <div>
        <span>Unrealized P&amp;L</span>
        <b className={pos.unrealizedPnl.startsWith('-') ? 'down' : 'up'}>{pnlText(pos.unrealizedPnl)}</b>
      </div>
    </div>
  );
};

export function HlCloseModal({ sym }: { sym: string }) {
  const { s, user, market, mid, pos } = usePosition(sym);
  const [pct, setPct] = useState(100);
  if (!pos || !market || !user) return <Missing title={`Close ${sym}`} sym={sym} />;
  const r = mid ? planPartialClose({ market, szi: pos.szi, markPx: mid, slipBps: slipBps(s.slip), pct }) : null;
  let label = pct === 100 ? 'Close position' : `Close ${pct}%`;
  let hint = '';
  let go: (() => void) | undefined;
  if (!r) label = 'Price unavailable';
  else if (!r.ok) {
    label = r.reason === 'min' ? 'Below the 10 USD minimum' : 'Cannot close this share';
    hint = r.reason === 'min' ? 'A partial close must be at least 10 USD. Pick a larger share, or close it all.' : '';
  } else go = () => s.runHlFlow(partialCloseFlow({ user, sym, plan: r.plan, slipPct: s.slip, pnl: pos.unrealizedPnl }));
  return (
    <>
      <Head title={`Close ${sym}`} />
      <Summary pos={pos} />
      <div className="fl" style={{ marginTop: 14 }}>
        <span>Share to close</span>
        <b className="num">{r && r.ok ? `${r.plan.size} ${sym} · about $${fmt(parseWad(r.plan.notional) ?? 0n)}` : '—'}</b>
      </div>
      <div className="seg full pcts" role="group" aria-label="Share to close">
        {[25, 50, 75, 100].map((x) => (
          <button key={x} className={pct === x ? 'on' : ''} aria-pressed={pct === x} onClick={() => setPct(x)}>
            {x === 100 ? 'All' : `${x}%`}
          </button>
        ))}
      </div>
      <button className="btn btn-white btn-block" style={{ marginTop: 14 }} disabled={!go} onClick={go}>
        {label}
      </button>
      <p className="hint">{hint}</p>
      <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 6 }}>
        A market order within your {s.slip}% slippage limit. It can only close, never open the other way.
      </p>
    </>
  );
}

const TPSL_HINT: Record<Exclude<TpslRefusal, 'none'>, string> = {
  tpPrice: 'Enter a take profit price, or leave it empty.',
  slPrice: 'Enter a stop loss price, or leave it empty.',
  tpSide: 'A long takes profit above its entry, a short below it.',
  slSide: 'A long stops below its entry, a short above it.',
  slLiq: 'The position would be liquidated before this stop loss. Move it closer to the entry.',
};

export function HlTpslModal({ sym }: { sym: string }) {
  const { s, user, market, pos } = usePosition(sym);
  const orders = useHlOpenOrders(user);
  const cur = market ? tpslOf(orders.data ?? [], market.coin) : { tp: null, sl: null };
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  if (!pos || !market || !user) return <Missing title={`TP/SL for ${sym}`} sym={sym} />;
  const long = !pos.szi.startsWith('-');
  const size = pos.szi.replace(/^-/, '');
  const liq = pos.liquidationPx ? parseWad(pos.liquidationPx) : null;
  const r = planTpsl({ market, long, size, entryPx: pos.entryPx, tp, sl, liqPx: liq });
  const replace = r.ok ? [r.orders.some((o) => o.kind === 'tp') ? cur.tp : null, r.orders.some((o) => o.kind === 'sl') ? cur.sl : null].filter((x) => x !== null) : [];
  let label = 'Set TP/SL';
  let hint = '';
  let go: (() => void) | undefined;
  if (!r.ok) {
    label = r.reason === 'none' ? 'Enter a take profit or a stop loss' : 'Check the prices';
    hint = r.reason === 'none' ? '' : TPSL_HINT[r.reason];
  } else go = () => s.runHlFlow(tpslFlow({ user, sym, market, long, size, orders: r.orders, replace }));
  const existing = [cur.tp, cur.sl].filter((x) => x !== null);
  return (
    <>
      <Head title={`TP/SL for ${sym}`} />
      <Summary pos={pos} />
      <div className="receipt" style={{ marginTop: 10 }}>
        <div>
          <span>Take profit now</span>
          <b>{cur.tp ? usd(cur.tp.px) : 'None'}</b>
        </div>
        <div>
          <span>Stop loss now</span>
          <b>{cur.sl ? usd(cur.sl.px) : 'None'}</b>
        </div>
      </div>
      <div className="tpsl-grid">
        {(['tp', 'sl'] as const).map((k) => {
          const o = r.ok ? r.orders.find((x) => x.kind === k) : undefined;
          const v = k === 'tp' ? tp : sl;
          return (
            <div key={k}>
              <label htmlFor={`m-${k}`}>{k === 'tp' ? 'New take profit' : 'New stop loss'}</label>
              <div className="inp sm">
                <input id={`m-${k}`} {...amountInputProps(v, 'tpsl-hint')} value={v} placeholder={k === 'tp' ? (long ? 'Above entry' : 'Below entry') : long ? 'Below entry' : 'Above entry'} onChange={(e) => (k === 'tp' ? setTp(e.target.value) : setSl(e.target.value))} />
              </div>
              <small className={o ? (o.pnl.startsWith('-') ? 'down' : 'up') : 'faint'}>{o ? `${pnlText(o.pnl)} at trigger` : '—'}</small>
            </div>
          );
        })}
      </div>
      <button className="btn btn-white btn-block" style={{ marginTop: 14 }} disabled={!go} onClick={go}>
        {label}
      </button>
      <p className="hint" id="tpsl-hint">
        {hint}
      </p>
      {existing.length ? (
        <button className="btn btn-dark btn-block btn-sm" style={{ marginTop: 6 }} onClick={() => s.runHlFlow(cancelFlow({ user, orders: existing }))}>
          Remove current TP/SL
        </button>
      ) : null}
      <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
        When the price reaches a trigger, a market order closes the position (filled at most 10% past the trigger). They follow the position as it changes.
      </p>
    </>
  );
}

export function HlMarginModal({ sym }: { sym: string }) {
  const { s, user, mode, bal, market, pos } = usePosition(sym);
  const [add, setAdd] = useState(true);
  const [amt, setAmt] = useState('');
  if (!pos || !market || !user || !mode.data) return <Missing title={`Margin · ${sym}`} sym={sym} />;
  const long = !pos.szi.startsWith('-');
  const avail = bal.data ? bal.data.xyzAvailable + bal.data.mainAvailable : 0;
  // Removable: what the position holds above the margin its leverage needs (the exchange has the final say).
  const used = Number(pos.marginUsed);
  const need = Number(pos.positionValue) / Math.max(1, pos.leverage);
  const removable = Math.max(0, Math.floor((used - need) * 100) / 100);
  const max = add ? Math.floor(avail * 100) / 100 : removable;
  const ntli = ntliOf(amt, add);
  const delta = ntli === null ? 0n : (BigInt(ntli) * 10n ** 12n);
  const liqAfter = ntli === null ? null : liqAfterMargin(pos.liquidationPx, delta, pos.szi, market.maxLeverage);
  let label = add ? 'Add margin' : 'Remove margin';
  let hint = '';
  let go: (() => void) | undefined;
  if (!pos.isolated) {
    label = 'Isolated positions only';
    hint = 'Velum manages margin for isolated positions only.';
  } else if (ntli === null) label = 'Enter an amount';
  else if (Math.abs(ntli) / 1e6 > max + 1e-9) {
    label = add ? 'More than your balance' : 'More than you can remove';
    hint = add ? `You have ${fmt(parseWad(max.toFixed(2)) ?? 0n)} USDC free in your perps account.` : `About ${fmt(parseWad(max.toFixed(2)) ?? 0n)} USDC can come out of this position.`;
  } else
    go = () =>
      s.runHlFlow(
        marginFlow({ user, sym, market, long, ntli, mode: mode.data!, liqNow: pos.liquidationPx ? usd(pos.liquidationPx) : 'None', liqAfter: liqAfter === null ? '—' : fmt(liqAfter) }),
      );
  return (
    <>
      <Head title={`Margin · ${sym}`} />
      <Summary pos={pos} />
      <div className="seg full" role="group" aria-label="Add or remove" style={{ marginTop: 14 }}>
        <button className={add ? 'on' : ''} aria-pressed={add} onClick={() => setAdd(true)}>
          Add margin
        </button>
        <button className={!add ? 'on' : ''} aria-pressed={!add} onClick={() => setAdd(false)}>
          Remove margin
        </button>
      </div>
      <div className="fl">
        <label htmlFor="mg-amt">Amount</label>
        <span>
          {add ? 'Free' : 'Removable'} <b className="num">{fmt(parseWad(max.toFixed(2)) ?? 0n)} USDC</b>
          <button type="button" className="linkbtn" onClick={() => setAmt(toDecimalString(parseWad(max.toFixed(2)) ?? 0n, 2))}>
            Max
          </button>
        </span>
      </div>
      <div className="inp">
        <input id="mg-amt" {...amountInputProps(amt, 'mg-hint')} value={amt} placeholder="10.00" onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDC</span>
      </div>
      <div className="receipt" style={{ marginTop: 12 }}>
        <div>
          <span>Margin in the position</span>
          <b>{usd(pos.marginUsed)} USDC</b>
        </div>
        <div>
          <span>Liquidation after (est.)</span>
          <b>{liqAfter === null ? '—' : fmt(liqAfter)}</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!go} onClick={go}>
        {label}
      </button>
      <p className="hint" id="mg-hint">
        {hint}
      </p>
    </>
  );
}
