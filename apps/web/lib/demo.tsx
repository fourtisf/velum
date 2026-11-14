'use client';
/**
 * Demo trading (DEMO_MODE, Phase 2). Each action runs the prototype's timed flow and receipt,
 * then updates the browser-only ledger. Phase 3 replaces the timers with real tx events.
 *
 * Every price comes from livePrice() and is read again when the flow completes: if the market has
 * lost its price meanwhile, the action is cancelled and nothing changes (audit round 2, M4).
 * On mainnet nothing is on-chain, so flows record no simulated chain event (audit round 2, M2).
 */
import { DEMO, IS_MAINNET, isLive } from '@velum/config';
import { WAD, bps, fromNumber, isLiquidatable, liquidationReturn, perpsClose, perpsOpen, wmul, type Wad } from '@velum/math';
import type { ReactNode } from 'react';
import { DEMO_PARAMS, PARAMS, perpsCalc, spotCalc, swapCalc } from './calc';
import { SIM } from './copy';
import { dp, fmt, fmtFloor, fmtLev, receiptId, sgnUsd, sig4, uid, usd } from './format';
import { livePrice, mk, tokPx } from './markets';
import { NO_COMMIT, addBal, bal, chainSaw, demoChainEvent, logAct, useApp, type FlowResult, type Ledger, type Offer } from './store';

const app = () => useApp.getState();
const rid = () => '#' + receiptId();
const Up = ({ v, children }: { v: boolean; children: React.ReactNode }) => <span className={v ? 'up' : 'down'}>{children}</span>;

type Row = [ReactNode, ReactNode];
/** A receipt's "Visible onchain" row: testnet only, since nothing is on-chain on mainnet. */
const visible = (v: string): Row[] => (IS_MAINNET ? [] : [['Visible onchain', v]]);

/** What a receipt shows: mainnet receipts end by saying nothing touched the chain. */
export function receiptRows(rows: Row[], mainnet = IS_MAINNET): Row[] {
  return mainnet ? [...rows.filter(([k]) => k !== 'Visible onchain'), SIM.receiptDemoRow] : rows;
}

/** The result of a flow whose market lost its price before it completed: nothing was applied. */
export const PRICE_GONE: FlowResult = { rows: [['Status', 'Cancelled: price unavailable']], toast: 'Price unavailable', warn: true };

export function openPerps() {
  const s = app();
  const m = mk(s.sel);
  if (!isLive(m.sym) || livePrice(m.sym) === null) return;
  const c = perpsCalc(s, bal(s.ledger.priv, 'USDG'));
  const { side, lev } = s;
  const Side = side === 'long' ? 'Long' : 'Short';
  s.runFlow({
    title: `Open ${side} ${m.sym}`,
    steps: [
      { t: 'Locking margin in a private note', d: `${fmt(c.margin)} USDG leaves your free balance`, ms: 700 },
      { t: 'Generating proof in your browser', d: 'Proves the trade follows the rules without revealing it', ms: 1900, proof: true },
      { t: 'Relayer submitting proof', d: 'The relayer pays gas, so your wallet stays off the trade', ms: 800 },
      { t: 'Matching with a maker', d: 'Waiting for a standing offer', ms: 1100 },
    ],
    done: () => {
      // Fill at the price when the maker matches, like the prototype; no price, no fill.
      const price = livePrice(m.sym);
      if (price === null) return PRICE_GONE;
      const q = perpsOpen({ price, size: c.size, leverage: lev, side }, PARAMS, DEMO_PARAMS);
      const [lo, hi] = DEMO.closeSpreadBpsRange;
      const cs = bps(lo) + BigInt(Math.floor(Math.random() * Number(bps(hi) - bps(lo))));
      const ev = demoChainEvent(`A ${m.sym} position changed`);
      const p = { id: uid(), sym: m.sym, side, lev, margin: q.margin, qty: q.qty, entry: q.entry, liq: q.liq, cs, commit: ev?.commit ?? NO_COMMIT, block: ev?.block ?? 0, openedAt: Date.now() };
      app().setLedger((l) =>
        logAct(
          { ...l, priv: addBal(l.priv, 'USDG', -(q.margin + q.fee)), positions: [p, ...l.positions], lastChain: ev ?? l.lastChain },
          `Opened ${side} ${m.sym} ${fmtLev(lev)}`,
          `${usd(c.size)} position, ${fmt(q.margin)} USDG margin`,
          'trade',
        ),
      );
      return {
        rows: [
          ['Market', `${m.sym} perp`],
          ['Side', <Up key="s" v={side === 'long'}>{Side} {fmtLev(lev)}</Up>],
          ['Position', `${fmt(q.qty, 4)} ${m.sym}`],
          ['Entry', fmt(q.entry)],
          ['Liquidation', q.liq ? fmt(q.liq) : 'None'],
          ['Fee', `${fmt(q.fee)} USDG`],
          ...visible('A position changed'),
          ['Receipt', rid()],
        ],
        toast: `${Side} opened on ${m.sym}`,
      };
    },
  });
}

export function spotTrade() {
  const s = app();
  const m = mk(s.sel);
  if (!isLive(m.sym) || livePrice(m.sym) === null) return;
  const c = spotCalc(s, s.ledger.priv);
  const buy = s.spotSide === 'buy';
  s.runFlow({
    title: `${buy ? 'Buy' : 'Sell'} ${m.sym}`,
    steps: [
      { t: 'Locking your tokens in a private swap request', d: `${fmt(c.amt, dp(c.tin))} ${c.tin}`, ms: 650 },
      { t: 'Generating proof in your browser', d: 'Shows the swap is valid without revealing it', ms: 1700, proof: true },
      { t: 'Relayer submitting proof', d: 'Your wallet stays off the trade', ms: 700 },
      { t: 'Filling against the private pool', d: `Only at or above ${fmtFloor(c.min, dp(c.tout))} ${c.tout}`, ms: 800 },
    ],
    done: () => {
      if (livePrice(m.sym) === null) return PRICE_GONE;
      app().setLedger((l) =>
        logAct(
          chainSaw({ ...l, priv: addBal(addBal(l.priv, c.tin, -c.amt), c.tout, c.out) }, `The ${m.sym} pool changed`),
          `${buy ? 'Bought' : 'Sold'} ${fmt(buy ? c.out : c.amt, 4)} ${m.sym}`,
          `Private swap through the ${m.sym} pool`,
          'trade',
        ),
      );
      return {
        rows: [
          ['You paid', `${fmt(c.amt, dp(c.tin))} ${c.tin}`],
          ['You got', `${fmt(c.out, dp(c.tout))} ${c.tout}`],
          ['Pool fee', `${fmt(c.feeAmt)} USDG`],
          ...visible('The pool changed'),
          ['Receipt', rid()],
        ],
        toast: `${buy ? 'Bought' : 'Sold'} ${m.sym}`,
      };
    },
  });
}

export function closePos(id: string) {
  const s = app();
  const p = s.ledger.positions.find((x) => x.id === id);
  if (!p || livePrice(p.sym) === null) return;
  s.runFlow({
    title: `Close ${p.side} ${p.sym}`,
    steps: [
      { t: 'Generating proof in your browser', d: 'Proves you own this position', ms: 1500, proof: true },
      { t: 'Relayer submitting proof', d: 'No maker signature needed', ms: 700 },
      { t: 'Settling at the oracle price', d: 'Minus the close spread your maker committed to', ms: 700 },
    ],
    done: () => {
      if (!app().ledger.positions.some((x) => x.id === id)) return { rows: [['Status', 'Already settled']], toast: 'Position already closed' };
      // Settle only at a live price; without one the position stays open, untouched.
      const price = livePrice(p.sym);
      if (price === null) return PRICE_GONE;
      const c = perpsClose(p, price, p.cs, PARAMS);
      app().setLedger((l) =>
        logAct(
          chainSaw({ ...l, priv: addBal(l.priv, 'USDG', c.returned), positions: l.positions.filter((x) => x.id !== id) }, `A ${p.sym} position changed`),
          `Closed ${p.side} ${p.sym}`,
          `P&L ${sgnUsd(c.pnl)}, ${fmt(c.returned)} USDG back to your private balance`,
          'trade',
        ),
      );
      return {
        rows: [
          ['Exit price', fmt(c.exit)],
          ['P&L', <Up key="p" v={c.pnl >= 0n}>{sgnUsd(c.pnl)}</Up>],
          ['Fee', `${fmt(c.fee)} USDG`],
          ['Returned', `${fmt(c.returned)} USDG`],
          ['Receipt', rid()],
        ],
        toast: 'Position closed',
      };
    },
  });
}

/**
 * Runs every demo tick: liquidates positions below maintenance at the current price. Markets
 * without a live price are skipped: nobody is liquidated at a seed or stale price.
 */
export function checkLiq() {
  const s = app();
  if (!s.account || !s.ledger.positions.length) return;
  const hit = s.ledger.positions.flatMap((p) => {
    const price = livePrice(p.sym);
    return price !== null && isLiquidatable(p, price, PARAMS) ? [{ p, price }] : [];
  });
  if (!hit.length) return;
  s.setLedger((l) => {
    let next: Ledger = l;
    for (const { p, price } of hit) {
      if (!next.positions.some((x) => x.id === p.id)) continue;
      const back = liquidationReturn(p, price, PARAMS);
      next = logAct(
        { ...next, priv: addBal(next.priv, 'USDG', back), positions: next.positions.filter((x) => x.id !== p.id) },
        `Liquidated ${p.side} ${p.sym}`,
        `${fmt(back)} USDG returned after the 1% penalty`,
        'trade',
      );
    }
    return next;
  });
  for (const { p } of hit) s.toast(`${p.sym} ${p.side} liquidated`, true);
}

/** Demo maker fills and LP fee growth (prototype tick). */
export function demoTick() {
  const s = app();
  if (!s.account) return;
  const { offers, lp } = s.ledger;
  if (!offers.length && !Object.keys(lp).length) return;
  s.setLedger((l) => ({
    ...l,
    offers: l.offers.map((o) => (Math.random() < 0.06 ? { ...o, fills: o.fills + 1, earned: o.earned + fromNumber(Number((0.4 + Math.random() * 2.8).toFixed(4))) } : o)),
    lp: Object.fromEntries(Object.entries(l.lp).map(([k, v]) => [k, (v * 10_000_025n) / 10_000_000n])),
  }));
}

export function doSwap() {
  const s = app();
  const f = s.swapFrom;
  const t = s.swapTo;
  const c = swapCalc(f, t, s.swapAmt, s.slip, s.ledger.priv);
  if (!c.priced) return;
  const pool = f === 'USDG' ? t : f;
  s.runFlow({
    title: `Swap ${f} for ${t}`,
    steps: [
      { t: 'Locking your tokens in a private swap request', d: `${fmt(c.a, dp(f))} ${f}`, ms: 650 },
      { t: 'Generating proof in your browser', d: 'Shows the swap is valid without revealing it', ms: 1700, proof: true },
      { t: 'Relayer submitting proof', d: 'Your wallet stays off the trade', ms: 700 },
      { t: c.hops === 2 ? 'Filling both pools in one action' : 'Filling against the private pool', d: `Only at or above ${sig4(c.min, 'floor')} ${t}`, ms: 800 },
    ],
    done: () => {
      if (tokPx(f) === null || tokPx(t) === null) return PRICE_GONE;
      app().setLedger((l) =>
        logAct(
          chainSaw({ ...l, priv: addBal(addBal(l.priv, f, -c.a), t, c.out) }, c.hops === 2 ? 'Two pools changed' : `The ${pool} pool changed`),
          `Swapped ${fmt(c.a, dp(f))} ${f} for ${sig4(c.out)} ${t}`,
          c.hops === 2 ? 'Routed through USDG in one action' : `Private swap through the ${pool} pool`,
          'swapI',
        ),
      );
      return {
        rows: [
          ['You paid', `${fmt(c.a, dp(f))} ${f}`],
          ['You got', `${sig4(c.out)} ${t}`],
          ['Pool fees', `${fmt(c.fee)} USDG`],
          ['Receipt', rid()],
        ],
        toast: 'Swapped',
      };
    },
  });
}

export function lpGo(sym: string, a: Wad) {
  if (livePrice(sym) === null) return;
  app().runFlow({
    title: `Add liquidity to ${sym}`,
    steps: [
      { t: 'Generating proof in your browser', d: 'Shows you own the USDG you are adding', ms: 1600, proof: true },
      { t: 'Relayer submitting proof', d: 'Your wallet stays off the deposit', ms: 700 },
      { t: `Swapping half into ${sym} and adding both`, d: 'One action, no in-between balance', ms: 800 },
    ],
    done: () => {
      if (livePrice(sym) === null) return PRICE_GONE;
      app().setLedger((l) =>
        logAct(chainSaw({ ...l, priv: addBal(l.priv, 'USDG', -a), lp: addBal(l.lp, sym, a) }, `The ${sym} pool changed`), `Added ${fmt(a)} USDG to the ${sym} pool`, 'Your share stays private', 'drop'),
      );
      return { rows: [['Pool', `${sym} / USDG`], ['Added', `${fmt(a)} USDG in value`], ['Receipt', rid()]], toast: 'Liquidity added' };
    },
  });
}

export function lpRemove(sym: string) {
  app().runFlow({
    title: `Remove liquidity from ${sym}`,
    steps: [
      { t: 'Generating proof in your browser', d: 'Proves you own this share', ms: 1400, proof: true },
      { t: 'Relayer submitting proof', d: 'Your wallet stays off the withdrawal', ms: 700 },
      { t: 'Returning your share as USDG', d: 'Into your private balance', ms: 700 },
    ],
    done: () => {
      // Credit the share as it stands when the withdrawal completes, fees earned meanwhile included (audit web I9).
      const v = bal(app().ledger.lp, sym);
      if (v <= 0n) return { rows: [['Status', 'Already removed']], toast: 'Liquidity already removed' };
      app().setLedger((l) => {
        const lp = { ...l.lp };
        delete lp[sym];
        return logAct(chainSaw({ ...l, priv: addBal(l.priv, 'USDG', v), lp }, `The ${sym} pool changed`), `Removed liquidity from the ${sym} pool`, `${fmt(v)} USDG back to your private balance`, 'drop');
      });
      return { rows: [['Returned', `${fmt(v)} USDG`], ['Receipt', rid()]], toast: 'Liquidity removed' };
    },
  });
}

export type MoveKind = 'shield' | 'unshield' | 'send';

export function moveGo(kind: MoveKind, t: string, a: Wad, to: string) {
  const s = app();
  const own = !!s.account && to.toLowerCase() === s.account.addr.toLowerCase();
  const F = {
    shield: {
      title: `Shield ${t}`,
      steps: SIM.shieldSteps(t),
      apply: (l: Ledger) =>
        logAct(chainSaw({ ...l, priv: addBal(l.priv, t, a), shielded: addBal(l.shielded, t, a) }, `Public deposit of ${fmt(a, dp(t))} ${t}`), `Shielded ${fmt(a, dp(t))} ${t}`, SIM.shieldSub, 'shieldIn'),
      toast: `Shielded ${t}`,
    },
    unshield: {
      title: `Unshield ${t}`,
      steps: [
        { t: 'Generating proof in your browser', d: 'Proves you own these tokens', ms: 1500, proof: true },
        { t: 'Relayer submitting proof', d: 'The relayer pays gas', ms: 700 },
        SIM.unshieldLast(to),
      ],
      apply: (l: Ledger) => {
        const shielded = own ? { ...l.shielded, [t]: bal(l.shielded, t) > a ? bal(l.shielded, t) - a : 0n } : l.shielded;
        return logAct(chainSaw({ ...l, priv: addBal(l.priv, t, -a), shielded }, `Public withdrawal of ${fmt(a, dp(t))} ${t}`), `Unshielded ${fmt(a, dp(t))} ${t}`, SIM.unshieldSub(to), 'shieldOut');
      },
      toast: `Unshielded ${t}`,
    },
    send: {
      title: `Send ${t} privately`,
      steps: [
        { t: 'Generating proof in your browser', d: 'Proves you own these tokens', ms: 1500, proof: true },
        { t: 'Relayer submitting proof', d: 'The relayer pays gas', ms: 700 },
        SIM.sendLast,
      ],
      apply: (l: Ledger) => logAct(chainSaw({ ...l, priv: addBal(l.priv, t, -a) }, 'An encrypted note was created'), `Sent ${fmt(a, dp(t))} ${t} privately`, `To ${to.slice(0, 12)}…`, 'send'),
      toast: `Sent ${t} privately`,
    },
  }[kind];
  s.runFlow({
    title: F.title,
    steps: F.steps,
    done: () => {
      app().setLedger(F.apply);
      return {
        rows: [
          ['Token', t],
          ['Amount', fmt(a, dp(t))],
          ...visible(kind === 'send' ? 'Nothing readable' : 'Wallet, token, amount, time'),
          ['Receipt', rid()],
        ],
        toast: F.toast,
      };
    },
  });
}

export interface OfferInput {
  sym: string;
  back: Wad;
  max: Wad;
  open: number;
  close: number;
}

export function postOffer(v: OfferInput) {
  const exp = app().ofExp;
  app().runFlow({
    title: `Post ${v.sym} offer`,
    steps: [
      { t: 'Locking backing in a private note', d: `${fmt(v.back)} USDG`, ms: 650 },
      { t: 'Generating proof in your browser', d: 'Proves you hold the backing', ms: 1500, proof: true },
      { t: 'Sending your offer to the coordinator', d: 'Against a one-time address', ms: 700 },
    ],
    done: () => {
      const o: Offer = { id: uid(), ...v, exp, fills: 0, earned: 0n };
      app().setLedger((l) => logAct(chainSaw({ ...l, priv: addBal(l.priv, 'USDG', -v.back), offers: [o, ...l.offers] }, 'A private note was locked'), `Posted a ${v.sym} offer`, `${fmt(v.back)} USDG backing, ${v.open}/${v.close} bps`, 'offer'));
      return {
        rows: [
          ['Market', `${v.sym} perp`],
          ['Backing', `${fmt(v.back)} USDG`],
          ['Spreads', `${v.open} / ${v.close} bps`],
          ['Ends in', exp],
          ['Receipt', rid()],
        ],
        toast: 'Offer posted',
      };
    },
  });
}

export function withdrawOffer(id: string) {
  const o = app().ledger.offers.find((x) => x.id === id);
  if (!o) return;
  app().runFlow({
    title: `Withdraw ${o.sym} offer`,
    steps: [
      { t: 'Generating proof in your browser', d: 'Proves this offer is yours', ms: 1300, proof: true },
      { t: 'Relayer submitting proof', d: 'The relayer pays gas', ms: 700 },
      { t: 'Releasing unused backing', d: 'Back to your private balance', ms: 600 },
    ],
    done: () => {
      // Read the offer as it stands now; if it is gone (withdrawn meanwhile), credit nothing.
      const cur = app().ledger.offers.find((x) => x.id === id);
      if (!cur) return { rows: [['Status', 'Already withdrawn']], toast: 'Offer already withdrawn' };
      const back = cur.back + cur.earned;
      app().setLedger((l) => logAct(chainSaw({ ...l, priv: addBal(l.priv, 'USDG', back), offers: l.offers.filter((x) => x.id !== id) }, 'A private note was released'), `Withdrew the ${cur.sym} offer`, `${fmt(back)} USDG back, including ${usd(cur.earned)} earned`, 'offer'));
      return { rows: [['Returned', `${fmt(back)} USDG`], ['Earned', usd(cur.earned)], ['Receipt', rid()]], toast: 'Offer withdrawn' };
    },
  });
}

/** Earn per $1,000 opened = open spread bps / 10 (prototype). */
export const earnPer1000 = (openBps: number): Wad => wmul(fromNumber(openBps), WAD / 10n);
