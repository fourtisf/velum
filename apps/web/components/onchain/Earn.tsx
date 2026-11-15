'use client';
/**
 * Earn (pools) and the maker desk in real (Phase 3) mode. Pool sizes, your share and offers are read from
 * the chain; adding liquidity swaps half the USDG into the stock and adds both (two transactions, each with
 * its own minimum), or, for an empty pool, adds USDG and stock from the vault at the oracle price.
 */
import { MARKETS, POOLS } from '@velum/config';
import { useState } from 'react';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { ONCHAIN, P } from '@/lib/copy';
import { compact, fmt, fmtBal, usd, usdBal } from '@/lib/format';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { exact, lpAddFlow, lpRemoveFlow, postOfferFlow, withdrawOfferFlow } from '@/lib/onchain/flows';
import { GUARD_COPY } from '@/lib/onchain/guard';
import { OFFER_SPREAD, lpAddPlan, slipBps, stockForUsdg } from '@/lib/onchain/quote';
import { useAllOracle, useOfferBook, usePools, type PoolRead } from '@/lib/onchain/reads';
import { tokenValue } from '@/lib/onchain/totals';
import { unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { OFFER_EXPIRIES as EXPIRIES, useApp } from '@/lib/store';
import { I } from '../icons';
import { Av, Px } from '../ui';
import { useOc } from './useOc';

function PoolCard({ oc, sym, pool }: { oc: OnchainInfo; sym: string; pool: PoolRead | undefined }) {
  const s = useApp();
  const c = useOc(oc);
  const prices = useAllOracle(oc).data;
  const deployed = oc.markets.includes(sym);
  const ud = c.dec('USDG');
  const sd = c.dec(sym);
  const px = prices?.[sym]?.price ?? null;
  const size = pool && px && ud !== undefined && sd !== undefined ? pool.usdgReserve + tokenValue(pool.stockReserve, sd, px, ud) : null;
  const mine = pool && pool.mine > 0n && pool.totalShares > 0n && size !== null ? (size * pool.mine) / pool.totalShares : pool && pool.mine > 0n ? -1n : 0n;
  const add = () => (s.account ? s.openModal({ kind: 'lpadd', sym }) : s.openModal({ kind: 'connect' }));
  const remove = () => pool && c.base && s.runTxFlow(lpRemoveFlow(c.base, sym, pool.mine, pool, slipBps(s.slip)));
  return (
    <div className="card pool">
      <div className="pool-h">
        <span className="pair">
          <Av sym={sym} size="sm" />
          <Av sym="USDG" size="sm" />
        </span>
        <b>{sym} / USDG</b>
        <span className="badge">{P.poolFee} fee</span>
      </div>
      <div className="kv">
        <div>
          <small>Pool size</small>
          <b>{!deployed ? '—' : size === null || ud === undefined ? '—' : size === 0n ? 'Empty' : `~${compact(Number(unitsToWad(size, ud) / 10n ** 18n))}`}</b>
        </div>
        <div>
          <small>Est. APR</small>
          <b>—</b>
        </div>
        <div>
          <small>Your liquidity</small>
          <b className={mine ? 'pv' : ''}>{mine === -1n ? 'Yes' : mine && ud !== undefined ? usdBal(unitsToWad(mine, ud)) : 'None'}</b>
        </div>
        <div>
          <small>Price</small>
          <Px sym={sym} as="b" />
        </div>
      </div>
      <div className="rowbtns">
        {pool && pool.mine > 0n ? (
          <button className="btn btn-dark btn-sm" disabled={!c.base} onClick={remove}>
            Remove
          </button>
        ) : null}
        {deployed ? (
          <button className="btn btn-white btn-sm" onClick={add}>
            Add liquidity
          </button>
        ) : (
          <button className="btn btn-dark btn-sm" disabled>
            Coming soon
          </button>
        )}
      </div>
    </div>
  );
}

export function OcLiquidityView({ oc }: { oc: OnchainInfo }) {
  const addr = useApp((s) => s.account?.addr);
  const pools = usePools(oc, addr).data ?? {};
  const syms = [...oc.markets, ...POOLS.map((p) => p.symbol).filter((x) => !oc.markets.includes(x))];
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Earn</h1>
          <p className="vsub">{ONCHAIN.earnSub}</p>
        </div>
      </div>
      <div className="pools">
        {syms.map((x) => (
          <PoolCard key={x} oc={oc} sym={x} pool={pools[x]} />
        ))}
      </div>
      <div className="boxnote" style={{ maxWidth: 760 }}>
        <I.info />
        <span>Pools are constant-product pools with a {P.poolFee} fee that stays in the pool. In this phase every pool, swap and share is public onchain.</span>
      </div>
    </>
  );
}

export function OcLpAddModal({ oc, sym }: { oc: OnchainInfo; sym: string }) {
  const s = useApp();
  const c = useOc(oc);
  const [amt, setAmt] = useState('1000');
  const pool = usePools(oc, c.addr).data?.[sym];
  const px = useAllOracle(oc).data?.[sym]?.price ?? null;
  const ud = c.dec('USDG');
  const sd = c.dec(sym);
  const units = ud === undefined ? null : wadToUnits(amountOrZero(amt), ud);
  const a = units?.ok ? units.units : 0n;
  const half = a / 2n;
  const have = c.acct?.vault.USDG ?? 0n;
  const stockHave = c.acct?.vault[sym] ?? 0n;
  const empty = !!pool && pool.totalShares === 0n;
  const firstStock = empty && px && c.proto ? stockForUsdg(half, px, c.proto.valueScale) : 0n;
  const slip = slipBps(s.slip);
  // The swap and the add, with both minimums, planned from these reserves as the user reviews them (W3-07).
  const plan = pool && !empty && a > 0n ? lpAddPlan(pool, a, slip) : null;
  const bad = amountHint(amt) || (units && !units.ok ? `USDG has ${ud} decimals.` : '');
  const basic = !!bad || a <= 0n || !c.base || !pool || ud === undefined || sd === undefined;
  /** Why the deposit cannot go ahead (a hint), '' while loading, or null when it can. */
  const why: string | null = c.paused
    ? c.paused.hint
    : basic
      ? bad
      : c.guard.blocked
        ? GUARD_COPY.blocked
        : a > have
          ? `You have ${fmtBal(unitsToWad(have, ud!))} USDG in your vault.`
          : empty && !px
            ? `No onchain price for ${sym} yet.`
            : empty && firstStock > stockHave
              ? `This pool is empty: the first deposit adds ${exact(firstStock, sd!, sym)} and USDG from your vault. Shield ${sym} first.`
              : !empty && (!plan || plan.minStock === 0n || plan.minShares === 0n)
                ? 'This amount is too small to protect with a minimum.'
                : null;
  const disabled = basic || why !== null;
  const hint = why ?? '';
  const go = () => {
    if (!c.base || !pool) return;
    s.runTxFlow(lpAddFlow(c.base, { sym, usdgUnits: a, pool, first: empty ? { stock: firstStock, usdg: half } : null, slip }));
  };
  return (
    <>
      <div className="m-head">
        <h3 id="m-title">Add liquidity to {sym}</h3>
        <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
          <I.x />
        </button>
      </div>
      <p className="m-text">{empty ? `This pool is empty: the first deposit adds USDG and ${sym} from your vault at the oracle price, and sets the pool price.` : `Pays from your vault USDG. Half is swapped into ${sym} first, then both are added (two transactions).`}</p>
      <div className="fl">
        <label htmlFor="lp-amt">Amount</label>
        <span>
          Available <b className="num pv">{ud === undefined ? '—' : `${fmtBal(unitsToWad(have, ud))} USDG`}</b>
        </span>
      </div>
      <div className="inp">
        <input id="lp-amt" {...amountInputProps(amt, 'lp-hint')} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDG</span>
      </div>
      <div className="sumbox">
        <div>
          <span>Added as USDG</span>
          <b>{ud === undefined ? '—' : `${exact(a - half, ud)} USDG`}</b>
        </div>
        <div>
          <span>Added as {sym}</span>
          <b>{sd === undefined ? '—' : empty ? `${fmt(unitsToWad(firstStock, sd), 4)} ${sym}` : plan ? `~${fmt(unitsToWad(plan.stockOut, sd), 4)} ${sym}` : '—'}</b>
        </div>
        <div>
          <span>You earn</span>
          <b>{P.poolFee} of swaps</b>
        </div>
        <div>
          <span>{ONCHAIN.visibleRow[0]}</span>
          <b>{ONCHAIN.visibleRow[1]}</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" disabled={disabled} onClick={go}>
        Add liquidity
      </button>
      <p className="hint" id="lp-hint">
        {hint}
      </p>
    </>
  );
}

const DURATION: Record<string, bigint> = { '6 hours': 6n * 3600n, '24 hours': 24n * 3600n, '7 days': 7n * 86_400n };
const INT_RE = /^\d{1,3}$/;

function Offers({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const c = useOc(oc);
  const book = useOfferBook(oc, c.addr, c.proto?.minPositionSize).data;
  if (!s.account)
    return (
      <div className="empty">
        <p>Connect your wallet to post and manage offers.</p>
      </div>
    );
  const mine = (book?.offers ?? []).filter((o) => o.active && c.addr && o.maker.toLowerCase() === c.addr.toLowerCase());
  const symOf = (a: string) => Object.entries(oc.d.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0] ?? '?';
  const ud = c.dec('USDG');
  if (!mine.length)
    return (
      <div className="empty">
        <p>{book ? 'No offers yet. Post one to start backing trades.' : 'Loading offers…'}</p>
      </div>
    );
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            <th className="r">Backing left</th>
            <th className="r">Largest fill</th>
            <th className="r hide-sm">Spreads</th>
            <th className="r hide-sm">Ends</th>
            <th className="r">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {mine.map((o) => {
            const sym = symOf(o.market);
            const hours = book ? Number(o.expiry - book.now) / 3600 : 0;
            return (
              <tr key={o.id.toString()}>
                <td>
                  <div className="mcell">
                    <Av sym={sym} size="sm" />
                    <b>
                      {sym} <small className="faint">#{o.id.toString()}</small>
                    </b>
                  </div>
                </td>
                <td className="r num">{ud === undefined ? '—' : `${fmtBal(unitsToWad(o.backing, ud), 0)} USDG`}</td>
                <td className="r num">{ud === undefined ? '—' : `${fmtBal(unitsToWad(o.largestFill, ud), 0)} USDG`}</td>
                <td className="r num hide-sm">
                  {o.openBps} / {o.closeBps} bps
                </td>
                <td className="r hide-sm faint">{hours <= 0 ? 'Ended' : hours < 48 ? `in ${Math.ceil(hours)} h` : `in ${Math.ceil(hours / 24)} days`}</td>
                <td className="r">
                  <button className="btn btn-dark btn-sm" disabled={!c.base} onClick={() => c.base && s.runTxFlow(withdrawOfferFlow(c.base, o, sym))}>
                    Withdraw
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OcMakersView({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const c = useOc(oc);
  const [sym, setSym] = useState(oc.markets.includes(s.sel) ? s.sel : (oc.markets[0] ?? 'TSLA'));
  const [back, setBack] = useState('5000');
  const [max, setMax] = useState('1000');
  const [open, setOpen] = useState('8');
  const [close, setClose] = useState('5');
  const ud = c.dec('USDG');
  const bu = ud === undefined ? null : wadToUnits(amountOrZero(back), ud);
  const mu = ud === undefined ? null : wadToUnits(amountOrZero(max), ud);
  const backing = bu?.ok ? bu.units : 0n;
  const largest = mu?.ok ? mu.units : 0n;
  const openBps = INT_RE.test(open.trim()) ? Number(open.trim()) : null;
  const closeBps = INT_RE.test(close.trim()) ? Number(close.trim()) : null;
  const have = c.acct?.vault.USDG ?? 0n;
  const badBack = amountHint(back) || (bu && !bu.ok ? `USDG has ${ud} decimals.` : '');
  const badMax = amountHint(max) || (mu && !mu.ok ? `USDG has ${ud} decimals.` : '');
  let hint = badBack || badMax;
  let b: { label: string; cls: string; disabled: boolean; onClick?: () => void };
  if (!s.account) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (c.paused) {
    b = { label: c.paused.label, cls: 'btn-dark', disabled: true };
    hint = c.paused.hint;
  } else if (c.guard.blocked) {
    b = { label: GUARD_COPY.blockedShort, cls: 'btn-dark', disabled: true };
    hint = GUARD_COPY.blocked;
  } else if (badBack) b = { label: 'Check your backing', cls: 'btn-dark', disabled: true };
  else if (backing <= 0n) b = { label: 'Enter backing', cls: 'btn-dark', disabled: true };
  else if (backing > have) {
    b = { label: 'Not enough USDG in your vault', cls: 'btn-dark', disabled: true };
    hint = `You have ${fmtBal(unitsToWad(have, ud!))} USDG available.`;
  } else if (openBps === null || closeBps === null || openBps < OFFER_SPREAD.minOpen || openBps > OFFER_SPREAD.max || closeBps > OFFER_SPREAD.max) {
    b = { label: 'Check your spreads', cls: 'btn-dark', disabled: true };
    hint = `Whole basis points: open spread ${OFFER_SPREAD.minOpen} to ${OFFER_SPREAD.max}, close spread 0 to ${OFFER_SPREAD.max}.`;
  } else if (badMax || largest <= 0n || largest > backing) {
    b = { label: 'Check your largest fill', cls: 'btn-dark', disabled: true };
    hint = badMax || 'The largest fill must be above zero and no more than your backing.';
  } else
    b = {
      label: 'Post offer',
      cls: 'btn-white',
      disabled: !c.base,
      onClick: () => c.base && s.runTxFlow(postOfferFlow(c.base, { sym, backing, largestFill: largest, openBps, closeBps, duration: DURATION[s.ofExp] ?? DURATION['24 hours']!, durationLabel: s.ofExp })),
    };
  const earn = backing > 0n && openBps !== null ? usd((10n ** 18n * BigInt(openBps)) / 10n) : usd(0);
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Maker desk</h1>
          <p className="vsub">{ONCHAIN.makersSub}</p>
        </div>
      </div>
      <div className="mk-grid">
        <section className="card form">
          <h2>Post a standing offer</h2>
          <div className="fl">
            <label htmlFor="of-mkt">Market</label>
          </div>
          <select className="sel full" id="of-mkt" value={sym} onChange={(e) => setSym(e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m.symbol} value={m.symbol} disabled={!oc.markets.includes(m.symbol)}>
                {oc.markets.includes(m.symbol) ? m.symbol : `${m.symbol} (coming soon)`}
              </option>
            ))}
          </select>
          <div className="fl">
            <label htmlFor="of-back">Backing</label>
            <span>
              Available <b className="num pv">{s.account && ud !== undefined ? fmtBal(unitsToWad(have, ud)) + ' USDG' : '—'}</b>
            </span>
          </div>
          <div className="inp sm">
            <input id="of-back" {...amountInputProps(back, 'of-hint')} value={back} onChange={(e) => setBack(e.target.value)} />
            <span className="unit">USDG</span>
          </div>
          <div className="fl">
            <label htmlFor="of-max">Largest single fill</label>
          </div>
          <div className="inp sm">
            <input id="of-max" {...amountInputProps(max, 'of-hint')} value={max} onChange={(e) => setMax(e.target.value)} />
            <span className="unit">USDG</span>
          </div>
          <div className="row2">
            <div>
              <div className="fl">
                <label htmlFor="of-open">Open spread</label>
              </div>
              <div className="inp sm">
                <input id="of-open" inputMode="numeric" autoComplete="off" maxLength={3} aria-describedby="of-hint" aria-invalid={openBps === null || undefined} value={open} onChange={(e) => setOpen(e.target.value)} />
                <span className="unit">bps</span>
              </div>
            </div>
            <div>
              <div className="fl">
                <label htmlFor="of-close">Close spread</label>
              </div>
              <div className="inp sm">
                <input id="of-close" inputMode="numeric" autoComplete="off" maxLength={3} aria-describedby="of-hint" aria-invalid={closeBps === null || undefined} value={close} onChange={(e) => setClose(e.target.value)} />
                <span className="unit">bps</span>
              </div>
            </div>
          </div>
          <div className="fl">
            <span>Offer ends in</span>
          </div>
          <div className="seg full" role="group" aria-label="Offer ends in">
            {EXPIRIES.map((x) => (
              <button key={x} className={s.ofExp === x ? 'on' : ''} aria-pressed={s.ofExp === x} onClick={() => s.set({ ofExp: x })}>
                {x}
              </button>
            ))}
          </div>
          <div className="sumbox">
            <div>
              <span>You earn per $1,000 opened</span>
              <b>{earn}</b>
            </div>
            <div>
              <span>Takers pay to close</span>
              <b>{closeBps ?? '—'} bps</b>
            </div>
            <div>
              <span>Backing locked</span>
              <b>{ud === undefined ? '—' : `${fmt(unitsToWad(backing, ud))} USDG`}</b>
            </div>
            <div>
              <span>Exposure</span>
              <b>Up to 5 × backing</b>
            </div>
          </div>
          <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
            {b.label}
          </button>
          <p className="hint" id="of-hint">
            {hint}
          </p>
          <p className="note">
            <I.info />
            <span>Backing is your margin: each fill takes 20% of its size from it, so exposure can reach 5 × backing, all on one side. Your close spread is a promise: takers can close against you at any time without your signature.</span>
          </p>
        </section>
        <div className="stack2">
          <section className="card">
            <h2 className="ph">Your offers</h2>
            <div style={{ marginTop: 8 }}>
              <Offers oc={oc} />
            </div>
          </section>
          <section className="card">
            <h2 className="ph">What others see about you</h2>
            <div className="tbl-wrap" style={{ marginTop: 8 }}>
              <table className="tbl">
                <tbody>
                  <tr>
                    <td>Public chain</td>
                    <td className="muted">Your address, your offers and every fill (Phase 3 is public)</td>
                  </tr>
                  <tr>
                    <td>Your takers</td>
                    <td className="muted">Your address and your offer terms</td>
                  </tr>
                  <tr>
                    <td>In the full version</td>
                    <td className="muted">A one-time address and your offer terms, for the coordinator only</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="ph-sub" style={{ paddingBottom: 16 }}>
              The privacy layer is designed to hide which maker backs a fill. Until it launches, everything here is public.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

