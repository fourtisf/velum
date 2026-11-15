'use client';
/**
 * Positions and activity in real (Phase 3) mode: open positions read from the chain (ids from the API's
 * index plus any this browser just opened), activity from the API. Same table and rows as the simulated
 * views; "Manage" replaces the simulated "Chain view" (add or remove margin, forced exit).
 */
import { useState } from 'react';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { publicClient } from '@/lib/chain';
import { ago, fmt, fmtLev, pct, sgnUsd } from '@/lib/format';
import { activityRow } from '@/lib/onchain/activity';
import { PERPS_ABI } from '@/lib/onchain/abi';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { claimBondFlow, closeFlow, exact, forcedExitFlow, marginFlow, settleExitFlow } from '@/lib/onchain/flows';
import { closeFee, exitPrice, liquidationPrice, liquidationQuote, slipBps, takerPnl } from '@/lib/onchain/quote';
import { SCAN_POSITIONS, priceUsable, useChainPositions, useOnchainActivity, useOraclePrice, type ChainPosition } from '@/lib/onchain/reads';
import { unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { useApp } from '@/lib/store';
import { toNumber } from '@velum/math';
import { Icon } from '../icons';
import { TxLink } from '../modals/TxFlow';
import { Av } from '../ui';
import { useOc } from './useOc';

const lev = (h: number) => fmtLev(h / 2);

function usePnl(oc: OnchainInfo, p: ChainPosition) {
  const c = useOc(oc);
  const o = useOraclePrice(oc, p.sym).data;
  const vs = c.proto?.valueScale;
  const ud = c.dec('USDG');
  if (!o || !vs || ud === undefined) return { pnl: null as bigint | null, price: o?.price ?? null, ud, vs };
  const t = takerPnl(p.long, p.qty, p.entry, o.price, vs);
  return { pnl: p.role === 'taker' ? t : -t, price: o.price, ud, vs };
}

function PnlCell({ oc, p }: { oc: OnchainInfo; p: ChainPosition }) {
  const { pnl, ud } = usePnl(oc, p);
  if (pnl === null || ud === undefined) return <td className="r num">—</td>;
  const margin = p.role === 'taker' ? p.takerMargin : p.makerMargin;
  const w = unitsToWad(pnl, ud);
  const r = margin > 0n ? (toNumber(w) / toNumber(unitsToWad(margin, ud))) * 100 : 0;
  return (
    <td className="r num">
      <span className={pnl >= 0n ? 'up' : 'down'}>
        {sgnUsd(w)} <small>{pct(r, 1)}</small>
      </span>
    </td>
  );
}

function CloseButton({ oc, p }: { oc: OnchainInfo; p: ChainPosition }) {
  const c = useOc(oc);
  const o = useOraclePrice(oc, p.sym).data;
  const slip = useApp((s) => s.slip);
  const runTxFlow = useApp((s) => s.runTxFlow);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (p.role !== 'taker') return null;
  const ok = priceUsable(o, 'close') && !!c.base && !!c.proto;
  const go = async () => {
    if (!o || !c.base || !c.proto) return;
    setBusy(true);
    try {
      const perps = oc.d.contracts.perpsMarkets as `0x${string}`;
      const exit = exitPrice(o.price, p.long, p.closeBps);
      const fee = closeFee(p.qty, exit, c.proto.valueScale);
      // A liquidatable position settles as a liquidation with the taker as liquidator: quote that route (W3-10).
      const [liquidatable, claim, claimAtPrice] = await Promise.all([
        publicClient.readContract({ address: perps, abi: PERPS_ABI, functionName: 'isLiquidatable', args: [p.id] }).catch(() => false),
        publicClient.readContract({ address: perps, abi: PERPS_ABI, functionName: 'takerClaimAt', args: [p.id, exit] }),
        publicClient.readContract({ address: perps, abi: PERPS_ABI, functionName: 'takerClaimAt', args: [p.id, o.price] }),
      ]);
      const liq = liquidatable ? liquidationQuote({ takerClaim: claimAtPrice, takerMargin: p.takerMargin, makerMargin: p.makerMargin, qty: p.qty, price: o.price, valueScale: c.proto.valueScale, rewardCap: c.proto.rewardCap }) : null;
      const est = claim - fee;
      runTxFlow(closeFlow(c.base, { pos: p, price: o.price, exit, fee, estOut: est > 0n ? est : 0n, slip: slipBps(slip), liq }));
    } catch {
      toast('Could not quote the close. Try again.', true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-dark btn-sm" disabled={!ok || busy} title={ok ? undefined : o?.lagging ? 'Price catching up' : 'Price unavailable'} onClick={() => void go()}>
      Close
    </button>
  );
}

export function OcPosTable({ oc, list, wide }: { oc: OnchainInfo; list: ChainPosition[]; wide?: boolean }) {
  const openModal = useApp((s) => s.openModal);
  const c = useOc(oc);
  const ud = c.dec('USDG');
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            {wide ? <th>Side</th> : null}
            <th className="r">Size</th>
            <th className="r">Entry</th>
            {wide ? <th className="r">Mark</th> : null}
            <th className="r hide-sm">Liq. price</th>
            {wide ? <th className="r hide-sm">Margin</th> : null}
            <th className="r">P&amp;L</th>
            <th className="r">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => {
            const Side = p.long ? 'Long' : 'Short';
            const sc = p.long ? 'up' : 'down';
            const margin = p.role === 'taker' ? p.takerMargin : p.makerMargin;
            const liq = p.role === 'taker' && c.proto ? liquidationPrice({ long: p.long, qty: p.qty, entry: p.entry, margin: p.takerMargin, valueScale: c.proto.valueScale }) : null;
            return (
              <tr key={p.id.toString()}>
                <td>
                  <div className="mcell">
                    <Av sym={p.sym} size="sm" />
                    <div>
                      <b>{p.sym}</b>
                      <small className={wide ? '' : sc}>{(wide ? lev(p.levHalf) : `${Side} ${lev(p.levHalf)}`) + (p.role === 'maker' ? ' · maker' : '')}</small>
                    </div>
                  </div>
                </td>
                {wide ? (
                  <td className={sc} style={{ fontWeight: 500 }}>
                    {p.role === 'maker' ? `Maker (${Side.toLowerCase()} taker)` : Side}
                  </td>
                ) : null}
                <td className="r num">{fmt(p.qty, 4)}</td>
                <td className="r num">{fmt(p.entry)}</td>
                {wide ? <MarkCell oc={oc} sym={p.sym} /> : null}
                <td className="r num hide-sm">{p.role === 'maker' ? '—' : liq ? fmt(liq) : 'None'}</td>
                {wide ? <td className="r num hide-sm">{ud === undefined ? '—' : fmt(unitsToWad(margin, ud))}</td> : null}
                <PnlCell oc={oc} p={p} />
                <td className="r">
                  <div className="rowbtns">
                    <button className="btn btn-ghost btn-sm" onClick={() => openModal({ kind: 'manage', id: p.id.toString() })}>
                      Manage
                    </button>
                    <CloseButton oc={oc} p={p} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MarkCell({ oc, sym }: { oc: OnchainInfo; sym: string }) {
  const o = useOraclePrice(oc, sym).data;
  return <td className="r num">{o ? fmt(o.price) : '—'}</td>;
}

export function OcActList({ oc, n }: { oc: OnchainInfo; n: number }) {
  const addr = useApp((s) => s.account?.addr);
  const q = useOnchainActivity(oc, addr);
  const syms = new Set(Object.keys(oc.d.tokens));
  const rows = (q.data ?? []).map((a) => activityRow(a, addr ?? '', syms));
  if (!rows.length)
    return (
      <div className="empty">
        <p>{!oc.verified ? 'Activity shows once the Velum API confirms this build’s contracts.' : q.isLoading ? 'Loading activity…' : q.isError ? 'Activity is unavailable right now.' : 'No activity yet.'}</p>
      </div>
    );
  return (
    <>
      {rows.slice(0, n).map((h, i) => (
        <div className="act" key={h.tx + ':' + i}>
          <span className="ic">
            <Icon name={h.icon} />
          </span>
          <div>
            <b>{h.title}</b>
            <small>
              {h.sub ? `${h.sub} · ` : ''}
              <TxLink hash={h.tx} />
            </small>
          </div>
          <small className="faint" suppressHydrationWarning>
            {h.t ? ago(h.t) : ''}
          </small>
        </div>
      ))}
    </>
  );
}

/** Says that positions could not be read from the index (or at all), never "No open positions" in its place (W3-05). */
export function PositionsNote({ indexError, failed, empty }: { indexError: boolean; failed: boolean; empty: boolean }) {
  if (failed) return <p>Your positions could not be read right now. Try again in a moment; nothing has changed onchain.</p>;
  if (!indexError) return null;
  return empty ? (
    <p>The Velum API’s position index is unavailable. No open position of yours was found onchain among the newest {SCAN_POSITIONS.toLocaleString('en-US')} positions and the ones this browser knows.</p>
  ) : (
    <p className="ph-sub" style={{ padding: '8px 2px 0' }}>
      The Velum API’s position index is unavailable: these positions were read from the chain (the newest {SCAN_POSITIONS.toLocaleString('en-US')} and the ones this browser knows).
    </p>
  );
}

export function OcPositionsCard({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const connected = !!s.account;
  const read = useChainPositions(oc, s.account?.addr);
  const positions = read.data?.list ?? [];
  const indexError = !!read.data?.indexError;
  let body: React.ReactNode;
  if (s.ptab === 'pos') {
    if (!connected)
      body = (
        <div className="empty">
          <p>Connect your wallet to see your positions.</p>
          <button className="btn btn-white btn-sm" onClick={() => s.openModal({ kind: 'connect' })}>
            Connect wallet
          </button>
        </div>
      );
    else if (!read.data)
      body = (
        <div className="empty">
          {read.isError ? <PositionsNote indexError={false} failed empty /> : <p>Loading your positions…</p>}
        </div>
      );
    else if (!positions.length)
      body = (
        <div className="empty">
          {indexError ? <PositionsNote indexError failed={false} empty /> : <p>No open positions. Pick long or short in the ticket to open one.</p>}
        </div>
      );
    else
      body = (
        <>
          <OcPosTable oc={oc} list={positions} />
          <PositionsNote indexError={indexError} failed={false} empty={false} />
        </>
      );
  } else
    body = connected ? (
      <OcActList oc={oc} n={10} />
    ) : (
      <div className="empty">
        <p>Connect your wallet to see your activity.</p>
      </div>
    );
  return (
    <section className="card posbox">
      <div className="ptabs" role="tablist">
        <button role="tab" aria-selected={s.ptab === 'pos'} className={s.ptab === 'pos' ? 'on' : ''} onClick={() => s.set({ ptab: 'pos' })}>
          Positions<span className="count num">{positions.length}</span>
        </button>
        <button role="tab" aria-selected={s.ptab === 'hist'} className={s.ptab === 'hist' ? 'on' : ''} onClick={() => s.set({ ptab: 'hist' })}>
          Activity
        </button>
      </div>
      <div role="tabpanel">{body}</div>
    </section>
  );
}

/** Dialog body: add or remove margin, request or settle a forced exit, claim a bond refund. */
export function ManageModal({ oc, id }: { oc: OnchainInfo; id: string }) {
  const s = useApp();
  const c = useOc(oc);
  const positions = useChainPositions(oc, s.account?.addr).data?.list;
  const o = useOraclePrice(oc, positions?.find((p) => p.id.toString() === id)?.sym ?? null).data;
  const [amt, setAmt] = useState('');
  const p = positions?.find((x) => x.id.toString() === id);
  const close = () => s.closeModal(true);
  const head = (
    <div className="m-head">
      <h3 id="m-title">Manage position #{id}</h3>
      <button className="xbtn" aria-label="Close" onClick={close}>
        <Icon name="x" />
      </button>
    </div>
  );
  if (!p || !c.proto || !c.base)
    return (
      <>
        {head}
        <p className="m-text">{positions ? 'This position is closed or not yours.' : 'Loading…'}</p>
      </>
    );
  const ud = c.proto.decimals.USDG!;
  const units = wadToUnits(amountOrZero(amt), ud);
  const a = units.ok ? units.units : 0n;
  const bad = amountHint(amt) || (!units.ok ? `USDG has ${ud} decimals.` : '');
  const free = c.acct?.vault.USDG ?? 0n;
  const margin = p.role === 'taker' ? p.takerMargin : p.makerMargin;
  const requested = p.exitRequestedAt > 0n;
  const settleAt = p.exitRequestedAt + c.proto.exitDelay;
  const now = o?.now ?? 0n;
  const base = c.base;
  return (
    <>
      {head}
      <div className="receipt">
        <div>
          <span>Market</span>
          <b>
            {p.sym} {p.long ? 'long' : 'short'} {lev(p.levHalf)}
            {p.role === 'maker' ? ' (you are the maker)' : ''}
          </b>
        </div>
        <div>
          <span>Your margin</span>
          <b>{exact(margin, ud, 'USDG')}</b>
        </div>
        {p.openTx ? (
          <div>
            <span>Opened in</span>
            <b>
              <TxLink hash={p.openTx} />
            </b>
          </div>
        ) : null}
        <div>
          <span>Forced exit</span>
          <b>{requested ? (now >= settleAt ? 'Ready to settle' : `Settles from ${new Date(Number(settleAt) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`) : 'Not requested'}</b>
        </div>
      </div>
      <div className="fl">
        <label htmlFor="mg-amt">Margin amount</label>
        <span>
          In vault <b className="num">{exact(free, ud, 'USDG')}</b>
        </span>
      </div>
      <div className="inp">
        <input id="mg-amt" {...amountInputProps(amt, 'mg-hint')} placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDG</span>
      </div>
      <div className="row2" style={{ marginTop: 10 }}>
        <button className="btn btn-white" disabled={!!bad || a <= 0n || a > free || c.guard.blocked} onClick={() => s.runTxFlow(marginFlow(base, p, true, a))}>
          Add margin
        </button>
        {p.role === 'taker' ? (
          <button className="btn btn-dark" disabled={!!bad || a <= 0n || a > p.takerMargin} onClick={() => s.runTxFlow(marginFlow(base, p, false, a))}>
            Remove margin
          </button>
        ) : null}
      </div>
      <p className="hint" id="mg-hint">
        {bad || (a > free ? 'Not enough USDG in your vault.' : c.guard.blocked ? 'Adding margin needs a module approval, which the guarded beta allows only for allowlisted wallets.' : '')}
      </p>
      <div className="boxnote">
        <Icon name="info" />
        <span>
          A forced exit is the escape hatch if the services go quiet: post a {exact(c.proto.bond, 18, 'ETH')} bond, and after {Number(c.proto.exitDelay / 86_400n)} days anyone can settle the position. The bond is refunded when it closes.
        </span>
      </div>
      {!requested ? (
        <button className="btn btn-dark btn-block" style={{ marginTop: 12 }} disabled={(c.acct?.eth ?? 0n) < c.proto.bond} onClick={() => s.runTxFlow(forcedExitFlow(base, p))}>
          Request forced exit
        </button>
      ) : (
        <button className="btn btn-dark btn-block" style={{ marginTop: 12 }} disabled={now < settleAt} onClick={() => s.runTxFlow(settleExitFlow(base, p))}>
          Settle forced exit
        </button>
      )}
      {(c.acct?.bondRefund ?? 0n) > 0n ? (
        <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => s.runTxFlow(claimBondFlow(base, c.acct!.bondRefund))}>
          Claim bond refund
        </button>
      ) : null}
    </>
  );
}
