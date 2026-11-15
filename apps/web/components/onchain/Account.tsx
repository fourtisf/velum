'use client';
/**
 * The account card, the portfolio page and the shield / unshield dialog in real (Phase 3) mode. The
 * "private balance" of the prototype is the Velum vault balance here, which is public onchain in this
 * phase, so it is labelled as such. Shield = deposit into the vault, unshield = withdraw; private transfers
 * need the privacy layer and are not offered.
 */
import { getMarket } from '@velum/config';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getAddress } from 'viem';
import { checkPublicAddress } from '@/lib/account';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { COPY, ONCHAIN } from '@/lib/copy';
import { dp, fmt, fmtBal, shortH, usdBal } from '@/lib/format';
import { activityRow } from '@/lib/onchain/activity';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { claimBondFlow, depositFlow, exact, withdrawFlow } from '@/lib/onchain/flows';
import { GUARD_COPY, MAX_UINT256, depositRefusal, type GuardView } from '@/lib/onchain/guard';
import { useAllOracle, useChainPositions, useOfferBook, useOnchainActivity, usePools } from '@/lib/onchain/reads';
import { tokenValue, vaultTotals } from '@/lib/onchain/totals';
import { unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { useApp } from '@/lib/store';
import { I } from '../icons';
import { TxLink } from '../modals/TxFlow';
import { Av, Pv } from '../ui';
import { OcActList, OcPosTable } from './Positions';
import { useOc, type OcContext } from './useOc';

const DUST_UNITS = 0n;
const tokName = (t: string) => (t === 'USDG' ? 'Global Dollar' : t === 'ETH' ? 'Gas token' : (getMarket(t)?.name ?? t));

/** Totals of what the account holds in the contracts, in USDG base units (null while a price is missing). */
function useTotals(oc: OnchainInfo, c: OcContext) {
  const prices = useAllOracle(oc).data;
  const positions = useChainPositions(oc, c.addr).data ?? [];
  const book = useOfferBook(oc).data;
  const pools = usePools(oc, c.addr).data ?? {};
  const mine = (book?.offers ?? []).filter((o) => o.active && c.addr && o.maker.toLowerCase() === c.addr.toLowerCase());
  if (!c.proto || !c.acct || !prices) return { total: null, inPositions: null, prices, positions };
  const p = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v?.price ?? null]));
  return { ...vaultTotals({ vault: c.acct.vault, decimals: c.proto.decimals, prices: p, positions, offers: mine, pools, valueScale: c.proto.valueScale }), prices, positions };
}

/** The total next to the address in the header: what the account holds in the contracts. */
export function OcWalletTotal({ oc }: { oc: OnchainInfo }) {
  const c = useOc(oc);
  const t = useTotals(oc, c);
  const ud = c.dec('USDG');
  return <span className="b num pv">{ud === undefined ? '—' : usdBal(t.total === null ? null : unitsToWad(t.total, ud))}</span>;
}

export function GuardBadge({ g }: { g: GuardView }) {
  if (!g.guarded) return null;
  return (
    <span className="badge" title="The vault is in its guarded beta: an allowlist and deposit caps apply.">
      {GUARD_COPY.badge}
    </span>
  );
}

/** Allowlist status and remaining deposit limit (USDG), shown while the guard is active. */
function GuardRows({ c }: { c: OcContext }) {
  if (!c.guard.guarded || !c.addr) return null;
  const ud = c.dec('USDG');
  const left = c.guard.limits?.USDG;
  return (
    <>
      {c.guard.status ? (
        <div className="r">
          <span>Beta allowlist</span>
          <b className={c.guard.status === 'allowlisted' ? 'up' : 'down'}>{c.guard.status === 'allowlisted' ? GUARD_COPY.allowlisted : GUARD_COPY.notAllowlisted}</b>
        </div>
      ) : null}
      {left !== undefined && ud !== undefined ? (
        <div className="r">
          <span>Deposit limit left</span>
          <b className="num">{left === MAX_UINT256 ? 'No limit' : `${fmtBal(unitsToWad(left, ud))} USDG`}</b>
        </div>
      ) : null}
    </>
  );
}

export function OcAccountCard({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const c = useOc(oc);
  const t = useTotals(oc, c);
  const act = useOnchainActivity(oc, c.addr).data;
  if (!s.account)
    return (
      <aside className="card acct">
        <h2>{ONCHAIN.accountTitle}</h2>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
          {ONCHAIN.acctConnect}
        </p>
        <button className="btn btn-dark btn-sm" style={{ marginTop: 12 }} onClick={() => s.openModal({ kind: 'connect' })}>
          Connect wallet
        </button>
      </aside>
    );
  const ud = c.dec('USDG');
  const last = act?.[0] ? activityRow(act[0], c.addr ?? '') : null;
  return (
    <aside className="card acct">
      <h2>
        {ONCHAIN.accountTitle}{' '}
        <span className="badge acc" title={ONCHAIN.badgeTitle}>
          <span className="d" />
          {ONCHAIN.badge}
        </span>{' '}
        <GuardBadge g={c.guard} />
      </h2>
      <div className="bigv num pv">{ud === undefined ? '—' : usdBal(t.total === null ? null : unitsToWad(t.total, ud))}</div>
      <div className="r">
        <span>Free balance</span>
        <b className="num pv">{ud === undefined || !c.acct ? '—' : `${fmtBal(unitsToWad(c.acct.vault.USDG ?? 0n, ud))} USDG`}</b>
      </div>
      <div className="r">
        <span>In positions</span>
        <b className="num pv">{ud === undefined ? '—' : usdBal(t.inPositions === null ? null : unitsToWad(t.inPositions, ud))}</b>
      </div>
      <GuardRows c={c} />
      <div className="lastc">
        {ONCHAIN.chainLastLabel}
        <b>{last ? last.title : ONCHAIN.noTx}</b>
        {last ? (
          <code>
            <TxLink hash={last.tx} />
          </code>
        ) : null}
      </div>
    </aside>
  );
}

const head = (
  <thead>
    <tr>
      <th>Asset</th>
      <th className="r">Amount</th>
      <th className="r hide-sm">Price</th>
      <th className="r">Value</th>
    </tr>
  </thead>
);

function Row({ t, units, dec, price, usdgDec, pub }: { t: string; units: bigint; dec: number; price: bigint | null; usdgDec: number; pub?: boolean }) {
  const amount = fmtBal(unitsToWad(units, dec), dp(t));
  const value = t === 'USDG' ? unitsToWad(units, dec) : price === null ? null : unitsToWad(tokenValue(units, dec, price, usdgDec), usdgDec);
  return (
    <tr>
      <td>
        <div className="mcell">
          <Av sym={t} size="sm" />
          <div>
            <b>{t}</b>
            <small>{tokName(t)}</small>
          </div>
        </div>
      </td>
      <td className="r num">{pub ? amount : <Pv>{amount}</Pv>}</td>
      <td className="r num hide-sm">{t === 'USDG' ? '$1.00' : price === null ? '—' : `$${fmt(price)}`}</td>
      <td className="r num">{pub ? usdBal(value) : <Pv>{usdBal(value)}</Pv>}</td>
    </tr>
  );
}

export function OcPortfolio({ oc }: { oc: OnchainInfo }) {
  const s = useApp();
  const c = useOc(oc);
  const t = useTotals(oc, c);
  if (!s.account || !c.addr) return null;
  const ud = c.dec('USDG');
  const syms = ['USDG', ...oc.markets];
  const vaultToks = syms.filter((x) => (c.acct?.vault[x] ?? 0n) > DUST_UNITS);
  const walletToks = syms.filter((x) => (c.acct?.wallet[x] ?? 0n) > DUST_UNITS);
  const px = (x: string) => t.prices?.[x]?.price ?? null;
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(c.addr!).catch(() => undefined);
    s.toast('Wallet address copied');
  };
  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Portfolio</h1>
          <p className="vsub">{ONCHAIN.portfolioSub}</p>
        </div>
      </div>
      <div className="pf">
        <section className="card pf-hero">
          <div>
            <span className="muted" style={{ fontSize: 13.5 }}>
              {ONCHAIN.balanceLabel}{' '}
              <span className="badge acc" title={ONCHAIN.badgeTitle}>
                <span className="d" />
                {ONCHAIN.badge}
              </span>{' '}
              <GuardBadge g={c.guard} />
            </span>
            <div className="pf-big num pv">{ud === undefined ? '—' : usdBal(t.total === null ? null : unitsToWad(t.total, ud))}</div>
            <div className="pf-sub">
              <span className="paddr">
                {shortH(c.addr)}
                <button className="icb" aria-label="Copy wallet address" onClick={copy}>
                  <I.copy />
                </button>
              </span>
              <span>Your vault balance belongs to this wallet.</span>
            </div>
          </div>
          <div className="pf-actions">
            <button className="btn btn-white" onClick={() => s.openModal({ kind: 'move', move: 'shield' })}>
              Shield
            </button>
            <button className="btn btn-dark" onClick={() => s.openModal({ kind: 'move', move: 'unshield' })}>
              Unshield
            </button>
            <button className="btn btn-dark" disabled title="Private transfers arrive with the privacy layer.">
              Send privately
            </button>
          </div>
        </section>
        {c.guard.guarded ? (
          <div className="boxnote" role="note">
            <I.info />
            <span>
              {c.guard.blocked ? GUARD_COPY.blocked : 'Guarded beta: deposits are limited to allowlisted wallets and capped per wallet. Withdrawals and closes always work.'}
              {c.guard.limits && ud !== undefined
                ? ` Deposit limit left: ${syms
                    .filter((x) => c.guard.limits![x] !== undefined)
                    .map((x) => (c.guard.limits![x] === MAX_UINT256 ? `${x} no limit` : `${exact(c.guard.limits![x]!, c.dec(x) ?? 18)} ${x}`))
                    .join(', ')}.`
                : ''}
            </span>
          </div>
        ) : null}
        {c.acct && c.acct.bondRefund > 0n && c.base ? (
          <div className="boxnote" role="note">
            <I.info />
            <span>
              A forced-exit bond of {exact(c.acct.bondRefund, 18, 'ETH')} is waiting for you.{' '}
              <button className="btn btn-ghost btn-sm" onClick={() => s.runTxFlow(claimBondFlow(c.base!, c.acct!.bondRefund))}>
                Claim bond refund
              </button>
            </span>
          </div>
        ) : null}
        <div className="pf-grid">
          <section className="card">
            <h2 className="ph">{ONCHAIN.assetsTitle}</h2>
            <p className="ph-sub">{ONCHAIN.assetsSub}</p>
            <div className="tbl-wrap">
              <table className="tbl">
                {head}
                <tbody>
                  {vaultToks.length && ud !== undefined ? (
                    vaultToks.map((x) => <Row key={x} t={x} units={c.acct!.vault[x]!} dec={c.dec(x)!} price={px(x)} usdgDec={ud} />)
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty">
                        {c.acct ? 'Nothing here yet. Shield tokens to start.' : 'Reading your vault…'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <h2 className="ph">Public wallet</h2>
            <p className="ph-sub">{ONCHAIN.publicSub}</p>
            <div className="tbl-wrap">
              <table className="tbl">
                {head}
                <tbody>
                  {c.acct && ud !== undefined ? (
                    <>
                      <Row t="ETH" units={c.acct.eth} dec={18} price={null} usdgDec={ud} pub />
                      {walletToks.map((x) => (
                        <Row key={x} t={x} units={c.acct!.wallet[x]!} dec={c.dec(x)!} price={px(x)} usdgDec={ud} pub />
                      ))}
                    </>
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty">{`Reading your wallet on ${COPY.chainLabel}…`}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <section className="card">
          <h2 className="ph">Open positions</h2>
          {t.positions.length ? (
            <div style={{ marginTop: 8 }}>
              <OcPosTable oc={oc} list={t.positions} wide />
            </div>
          ) : (
            <div className="empty">
              <p>No open positions.</p>
              <Link className="btn btn-dark btn-sm" href={`/app/trade/${s.sel}?mode=perps`}>
                Open a position
              </Link>
            </div>
          )}
        </section>
        <section className="card">
          <h2 className="ph">Activity</h2>
          <div style={{ marginTop: 8 }}>
            <OcActList oc={oc} n={12} />
          </div>
        </section>
      </div>
    </>
  );
}

const ADDRESS_HINT = {
  format: 'Enter a public address: 0x followed by 40 characters.',
  checksum: 'This address fails its checksum, so it may have a typo. Copy it again from your wallet.',
  zero: 'This is the zero address. Tokens sent there are lost for good.',
} as const;

export function OcMoveModal({ oc, kind }: { oc: OnchainInfo; kind: 'shield' | 'unshield' | 'send' }) {
  const s = useApp();
  const c = useOc(oc);
  const syms = ['USDG', ...oc.markets];
  const src = kind === 'shield' ? c.acct?.wallet : c.acct?.vault;
  const toks = syms.filter((x) => (src?.[x] ?? 0n) > 0n);
  const [tok, setTok] = useState('');
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState(c.addr ?? '');
  const [hint, setHint] = useState('');
  const t = tok || toks[0] || '';
  useEffect(() => {
    if (!tok && toks[0]) setTok(toks[0]);
  }, [tok, toks]);
  const title = { shield: 'Shield tokens', unshield: 'Unshield tokens', send: 'Send privately' }[kind];
  const head = (
    <div className="m-head">
      <h3 id="m-title">{title}</h3>
      <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
        <I.x />
      </button>
    </div>
  );
  if (kind === 'send')
    return (
      <>
        {head}
        <p className="m-text">{ONCHAIN.moveText('send')}</p>
        <div className="boxnote">
          <I.info />
          <span>{ONCHAIN.moveNote('send')}</span>
        </div>
      </>
    );
  const d = t ? c.dec(t) : undefined;
  const have = t ? (src?.[t] ?? 0n) : 0n;
  const units = d === undefined ? null : wadToUnits(amountOrZero(amt), d);
  const a = units?.ok ? units.units : 0n;
  const bad = amountHint(amt) || (units && !units.ok ? `${t} has ${d} decimals: use at most ${d} decimal places.` : '');
  const over = a > have;
  const refusal = kind === 'shield' && t ? depositRefusal(c.guard, t, a) : null;
  const go = () => {
    if (!c.base || !t) return;
    if (kind === 'unshield') {
      const dest = to.trim();
      const check = checkPublicAddress(dest);
      if (check !== 'ok') return setHint(ADDRESS_HINT[check]);
      s.runTxFlow(withdrawFlow(c.base, t, a, getAddress(dest.toLowerCase())));
      return;
    }
    s.runTxFlow(depositFlow(c.base, t, a));
  };
  const left = t ? c.guard.limits?.[t] : undefined;
  return (
    <>
      {head}
      <p className="m-text">{ONCHAIN.moveText(kind)}</p>
      {kind === 'shield' && c.guard.blocked ? (
        <div className="boxnote warn" role="alert">
          <I.info />
          <span>{GUARD_COPY.blocked}</span>
        </div>
      ) : null}
      <div className="fl">
        <label htmlFor="mv-tok">Token</label>
      </div>
      <select className="sel full" id="mv-tok" value={t} onChange={(e) => setTok(e.target.value)}>
        {toks.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      {!toks.length ? (
        <p className="m-text" style={{ marginTop: 10, fontSize: 13 }}>
          {!c.acct ? 'Reading your balances…' : kind === 'shield' ? 'No USDG or listed Stock Tokens in this wallet yet.' : 'Nothing in your vault balance yet.'}
        </p>
      ) : null}
      <div className="fl">
        <label htmlFor="mv-amt">Amount</label>
        <span>
          {kind === 'shield' ? 'In wallet' : 'In vault'}{' '}
          <b className="num">
            {d === undefined ? '—' : fmtBal(unitsToWad(have, d), dp(t))} {t}
          </b>
        </span>
      </div>
      <div className="inp">
        <input
          id="mv-amt"
          {...amountInputProps(amt, 'mv-hint')}
          placeholder="0.00"
          value={amt}
          onChange={(e) => {
            setAmt(e.target.value);
            setHint('');
          }}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => d !== undefined && setAmt(unitsToInput(have, d, d))}>
          Max
        </button>
      </div>
      {kind === 'shield' && left !== undefined && d !== undefined ? (
        <p className="ph-sub" style={{ paddingTop: 6 }}>
          Guarded beta deposit limit left: {left === MAX_UINT256 ? 'no limit' : exact(left, d, t)}
        </p>
      ) : null}
      {kind === 'unshield' ? (
        <>
          <div className="fl">
            <label htmlFor="mv-to">To public address</label>
          </div>
          <div className="inp sm">
            <input id="mv-to" autoComplete="off" spellCheck={false} maxLength={42} aria-describedby="mv-hint" style={{ fontSize: 13 }} value={to} onChange={(e) => (setTo(e.target.value), setHint(''))} />
          </div>
        </>
      ) : null}
      <div className="boxnote warn">
        <I.info />
        <span>{ONCHAIN.moveNote(kind)}</span>
      </div>
      <button className="btn btn-white btn-block" disabled={!t || !!bad || a <= 0n || over || !!refusal || !c.base} onClick={go}>
        {kind === 'shield' ? 'Shield' : 'Unshield'} {t}
      </button>
      <p className="hint" id="mv-hint">
        {hint || bad || (over ? `You have ${d === undefined ? '' : fmtBal(unitsToWad(have, d), dp(t))} ${t} available.` : refusal === 'not-allowlisted' ? GUARD_COPY.blockedShort + '.' : refusal === 'over-limit' ? GUARD_COPY.overLimit : '')}
      </p>
    </>
  );
}
