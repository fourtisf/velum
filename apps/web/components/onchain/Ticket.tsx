'use client';
/**
 * The order ticket in real (Phase 3) mode: same layout as the simulated ticket, quoted from the chain (the
 * oracle price the contracts use, the best maker offer, the pool's exact output), with the slippage limit,
 * fees and liquidation price shown before anything is signed.
 */
import { PROTOCOL } from '@velum/config';
import { useQuery } from '@tanstack/react-query';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { MIN_LEVERAGE } from '@/lib/calc';
import { CLOSED, ONCHAIN } from '@/lib/copy';
import { dp, fmt, fmtBal } from '@/lib/format';
import { useMarket } from '@/lib/markets';
import { SPOT_ABI } from '@/lib/onchain/abi';
import { publicClient } from '@/lib/chain';
import type { OnchainInfo } from '@/lib/onchain/deployment';
import { approx, exact, openFlow, swapFlow } from '@/lib/onchain/flows';
import { GUARD_COPY } from '@/lib/onchain/guard';
import { leverageHalf, minOut, openQuote, poolFee, slipBps } from '@/lib/onchain/quote';
import { PRICE_AGE, bestOffer, useOfferBook, useOraclePrice } from '@/lib/onchain/reads';
import { unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { useApp } from '@/lib/store';
import { I } from '../icons';
import { useOc } from './useOc';

type Btn = { label: string; cls: string; disabled: boolean; onClick?: () => void };
const HINT = { perps: 't-size-hint', spot: 't-spot-hint' };

function SubmitButton({ b }: { b: Btn }) {
  return (
    <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
      {b.label}
    </button>
  );
}

function Slippage() {
  const slip = useApp((s) => s.slip);
  const set = useApp((s) => s.set);
  return (
    <>
      <div className="fl">
        <span>Slippage limit</span>
      </div>
      <div className="seg full" role="group" aria-label="Slippage">
        {PROTOCOL.slippageOptionsPct.map((x) => (
          <button key={x} className={slip === x ? 'on' : ''} aria-pressed={slip === x} onClick={() => set({ slip: x })}>
            {x}%
          </button>
        ))}
      </div>
    </>
  );
}

/** "Price unavailable" unless the oracle has a recent price (the relay pushes every few seconds). */
function priceProblem(o: ReturnType<typeof useOraclePrice>['data'], closed: boolean): string | null {
  if (!o) return closed ? CLOSED.label : 'Price unavailable';
  if (o.now - o.updatedAt > PRICE_AGE.close) return 'Price unavailable';
  return null;
}

function PerpsTicket({ sym, oc }: { sym: string; oc: OnchainInfo }) {
  const s = useApp();
  const m = useMarket(sym);
  const c = useOc(oc);
  const connected = !!s.account;
  const deployed = oc.markets.includes(sym);
  const oracle = useOraclePrice(oc, deployed ? sym : null).data;
  const book = useOfferBook(oc).data;
  const ud = c.dec('USDG');
  const vs = c.proto?.valueScale;
  const free = c.acct?.vault.USDG ?? 0n;
  const sizeWad = amountOrZero(s.size);
  const units = ud === undefined ? null : wadToUnits(sizeWad, ud);
  const size = units?.ok ? units.units : 0n;
  const levHalf = leverageHalf(s.lev) ?? 2;
  const long = s.side === 'long';
  const slip = slipBps(s.slip);
  const token = oc.d.tokens[sym];
  const offer = book && token ? bestOffer(book.offers, token, size, c.addr, book.now) : null;
  const quoteOffer = offer ?? (book && token ? bestOffer(book.offers, token, 0n, c.addr, book.now) : null);
  const q = oracle && quoteOffer && vs ? openQuote({ price: oracle.price, size, levHalf, long, openBps: quoteOffer.openBps, slipBps: slip, valueScale: vs }) : null;
  const px = (v: string) => (q ? v : '—');
  const bad = amountHint(s.size);
  const problem = priceProblem(oracle, m.closed);
  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!deployed) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = ONCHAIN.notDeployed(sym);
  } else if (c.guard.blocked) {
    b = { label: GUARD_COPY.blockedShort, cls: 'btn-dark', disabled: true };
    hint = GUARD_COPY.blocked;
  } else if (oracle?.closeOnly) {
    b = { label: 'Close only', cls: 'btn-dark', disabled: true };
    hint = 'This market only accepts closes right now.';
  } else if (problem || !q) b = { label: problem ?? 'Loading…', cls: 'btn-dark', disabled: true };
  else if (bad) b = { label: 'Enter a valid size', cls: 'btn-dark', disabled: true };
  else if (units && !units.ok) {
    b = { label: 'Enter a valid size', cls: 'btn-dark', disabled: true };
    hint = `USDG has ${ud} decimals: use at most ${ud} decimal places.`;
  } else if (size <= 0n) b = { label: 'Enter a size', cls: 'btn-dark', disabled: true };
  else if (c.proto && size < c.proto.minPositionSize) {
    b = { label: 'Below the minimum size', cls: 'btn-dark', disabled: true };
    hint = `Positions must be at least ${exact(c.proto.minPositionSize, ud!, 'USDG')}.`;
  } else if (q.qty > 100n * 10n ** 18n) {
    b = { label: `Above the ${PROTOCOL.maxTokensPerPosition}-token limit`, cls: 'btn-dark', disabled: true };
    hint = `One position can hold up to ${PROTOCOL.maxTokensPerPosition} tokens.`;
  } else if (!offer) {
    b = { label: 'No maker offer for this size', cls: 'btn-dark', disabled: true };
    hint = 'No standing offer can fill this size right now. Lower the size, or try again later.';
  } else if (q.cost > free) {
    b = { label: 'Not enough USDG in your vault', cls: 'btn-dark', disabled: true };
    hint = 'Shield more USDG from Portfolio, or lower the size.';
  } else
    b = {
      label: `Open ${s.side}`,
      cls: long ? 'btn-up' : 'btn-down',
      disabled: !c.base,
      onClick: () => c.base && oracle && s.runTxFlow(openFlow(c.base, { sym, long, lev: s.lev, levHalf, size, offer, q, slip, oraclePrice: oracle.price })),
    };
  if (!hint && q && oracle?.lagging) hint = 'The onchain price is catching up with the market; opening waits for it.';

  const maxLev = Math.min(m.maxLev || PROTOCOL.maxLeverage, PROTOCOL.maxLeverage);
  const levRange = maxLev - MIN_LEVERAGE;
  /** Max: what the free vault balance allows at this leverage (margin + fee), in USDG. */
  const preset = (p: number) => {
    if (ud === undefined) return;
    const maxSize = (free * BigInt(levHalf) * 10_000n) / (2n * 10_000n + 6n * BigInt(levHalf));
    s.set({ size: unitsToInput((maxSize * BigInt(p)) / 100n, ud, 2) });
  };
  const funding = oracle ? Number(oracle.fundingRate) / 1e16 : null;
  return (
    <>
      <div className="sides" role="group" aria-label="Side">
        <button className={`long ${long ? 'on' : ''}`} aria-pressed={long} onClick={() => s.set({ side: 'long' })}>
          Long
        </button>
        <button className={`short ${!long ? 'on' : ''}`} aria-pressed={!long} onClick={() => s.set({ side: 'short' })}>
          Short
        </button>
      </div>
      <div className="fl">
        <label htmlFor="t-size">Size</label>
        <span>
          Available <b className="num">{connected && ud !== undefined ? fmtBal(unitsToWad(free, ud)) + ' USDG' : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-size" {...amountInputProps(s.size, HINT.perps)} value={s.size} onChange={(e) => s.set({ size: e.target.value })} />
        <span className="unit">USDG</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Size presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="fl">
        <label htmlFor="t-lev">Leverage</label>
        <b className="num">{s.lev.toFixed(1)}×</b>
      </div>
      <input
        type="range"
        id="t-lev"
        min={MIN_LEVERAGE}
        max={maxLev}
        step={PROTOCOL.leverageStep}
        value={s.lev}
        onChange={(e) => s.set({ lev: Number(e.target.value) })}
        style={{ ['--p' as string]: (levRange > 0 ? Math.min(1, (s.lev - MIN_LEVERAGE) / levRange) : 1) * 100 + '%' }}
      />
      <div className="ticks num">
        {Array.from({ length: Math.floor(levRange) + 1 }, (_, i) => (
          <span key={i}>{i + MIN_LEVERAGE}×</span>
        ))}
      </div>
      <Slippage />
      <div className="sumbox">
        <div>
          <span>Entry price</span>
          <b>{px(q ? fmt(q.entry) : '')}</b>
        </div>
        <div>
          <span>Price limit</span>
          <b>{px(q ? `${long ? '≤' : '≥'} ${fmt(q.priceLimit)}` : '')}</b>
        </div>
        <div>
          <span>Position</span>
          <b>{px(q ? `${fmt(q.qty, 4)} ${sym}` : '')}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{q && ud !== undefined ? approx(q.takerMargin, ud) : '0.00'} USDG</b>
        </div>
        <div>
          <span>Liquidation price</span>
          <b>{px(q ? (q.liq ? fmt(q.liq) : 'None') : '')}</b>
        </div>
        <div>
          <span>Fee (0.06%)</span>
          <b>{q && ud !== undefined ? approx(q.fee, ud) : '0.00'} USDG</b>
        </div>
        <div>
          <span>Funding</span>
          <b>{funding === null ? '—' : `${fmt(funding, 4)}% / h`}</b>
        </div>
      </div>
      <SubmitButton b={b} />
      <p className="hint" id={HINT.perps}>
        {hint}
      </p>
      <p className="note">
        <I.lock />
        <span>{ONCHAIN.perpsNote}</span>
      </p>
    </>
  );
}

function SpotTicket({ sym, oc }: { sym: string; oc: OnchainInfo }) {
  const s = useApp();
  const m = useMarket(sym);
  const c = useOc(oc);
  const connected = !!s.account;
  const deployed = oc.markets.includes(sym);
  const buy = s.spotSide === 'buy';
  const tin = buy ? 'USDG' : sym;
  const tout = buy ? sym : 'USDG';
  const dIn = c.dec(tin);
  const dOut = c.dec(tout);
  const have = c.acct?.vault[tin] ?? 0n;
  const units = dIn === undefined ? null : wadToUnits(amountOrZero(s.spotAmt), dIn);
  const amountIn = units?.ok ? units.units : 0n;
  const slip = slipBps(s.slip);
  const quote = useQuery({
    queryKey: ['oc-quote', oc.d.contracts.spotPools, tin, tout, amountIn.toString()],
    enabled: deployed && amountIn > 0n,
    refetchInterval: 5000,
    retry: false,
    queryFn: async () => {
      try {
        return await publicClient.readContract({ address: oc.d.contracts.spotPools as `0x${string}`, abi: SPOT_ABI, functionName: 'getAmountOut', args: [oc.d.tokens[tin] as `0x${string}`, oc.d.tokens[tout] as `0x${string}`, amountIn] });
      } catch {
        return null;
      }
    },
  });
  const out = quote.data ?? null;
  const min = out === null ? 0n : minOut(out, slip);
  const oracle = useOraclePrice(oc, deployed ? sym : null).data;
  const bad = amountHint(s.spotAmt);
  const fee = poolFee(amountIn);
  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!deployed) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = ONCHAIN.notDeployed(sym);
  } else if (c.guard.blocked) {
    b = { label: GUARD_COPY.blockedShort, cls: 'btn-dark', disabled: true };
    hint = GUARD_COPY.blocked;
  } else if (bad || (units && !units.ok)) {
    b = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
    if (!bad) hint = `${tin} has ${dIn} decimals: use at most ${dIn} decimal places.`;
  } else if (amountIn <= 0n) b = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (amountIn > have) {
    b = { label: `Not enough ${tin} in your vault`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmtBal(unitsToWad(have, dIn!), dp(tin))} ${tin} available.`;
  } else if (quote.isLoading) b = { label: 'Quoting…', cls: 'btn-dark', disabled: true };
  else if (out === null || out === 0n) {
    b = { label: 'No liquidity', cls: 'btn-dark', disabled: true };
    hint = `The ${sym} pool has no liquidity for this trade yet.`;
  } else if (min === 0n) {
    b = { label: 'Amount too small', cls: 'btn-dark', disabled: true };
    hint = 'This amount is too small to protect with a minimum.';
  } else
    b = {
      label: `${buy ? 'Buy' : 'Sell'} ${sym}`,
      cls: buy ? 'btn-up' : 'btn-down',
      disabled: !c.base,
      onClick: () =>
        c.base &&
        s.runTxFlow(
          swapFlow(c.base, { from: tin, to: tout, amountIn, quote: out, min, hops: 1, slip, fee: `${approx(fee, dIn!, dp(tin))} ${tin}`, title: `${buy ? 'Buy' : 'Sell'} ${sym}`, toast: `${buy ? 'Bought' : 'Sold'} ${sym}` }),
        ),
    };

  const setSide = (g: 'buy' | 'sell') => {
    const held = c.acct?.vault[sym] ?? 0n;
    const sd = c.dec(sym) ?? 18;
    const one = 10n ** BigInt(sd);
    s.set({ spotSide: g, spotAmt: g === 'buy' ? '500' : unitsToInput(held > 0n && held < one ? held : one, sd, 4) });
  };
  const priceTxt = oracle ? fmt(oracle.price) : m.noData ? '—' : '—';
  return (
    <>
      <div className="sides" role="group" aria-label="Buy or sell">
        <button className={`long ${buy ? 'on' : ''}`} aria-pressed={buy} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button className={`short ${!buy ? 'on' : ''}`} aria-pressed={!buy} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>
      <div className="fl">
        <label htmlFor="t-spot">You pay</label>
        <span>
          Available <b className="num">{connected && dIn !== undefined ? `${fmtBal(unitsToWad(have, dIn), dp(tin))} ${tin}` : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-spot" {...amountInputProps(s.spotAmt, HINT.spot)} value={s.spotAmt} onChange={(e) => s.set({ spotAmt: e.target.value })} />
        <span className="unit">{tin}</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => dIn !== undefined && s.set({ spotAmt: unitsToInput((have * BigInt(p)) / 100n, dIn, dp(tin)) })}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="fl">
        <span>You get (est.)</span>
      </div>
      <div className="inp">
        <output aria-label="You get (est.)">{out !== null && dOut !== undefined ? approx(out, dOut, dp(tout)) : amountIn > 0n ? '—' : '0.00'}</output>
        <span className="unit">{tout}</span>
      </div>
      <Slippage />
      <div className="sumbox">
        <div>
          <span>Oracle price</span>
          <b>{priceTxt}</b>
        </div>
        <div>
          <span>Pool fee (0.30%)</span>
          <b>{dIn !== undefined ? `${approx(fee, dIn, dp(tin))} ${tin}` : '—'}</b>
        </div>
        <div>
          <span>Minimum you get</span>
          <b>{out !== null && dOut !== undefined ? `${exact(min, dOut)} ${tout}` : '—'}</b>
        </div>
        <div>
          <span>Liquidation</span>
          <b>None</b>
        </div>
      </div>
      <SubmitButton b={b} />
      <p className="hint" id={HINT.spot}>
        {hint}
      </p>
      <p className="note">
        <I.lock />
        <span>{ONCHAIN.spotNote}</span>
      </p>
    </>
  );
}

export function OnchainTicket({ sym, mode, oc }: { sym: string; mode: 'spot' | 'perps'; oc: OnchainInfo }) {
  return (
    <aside className="card ticket" aria-label="Order ticket">
      {mode === 'perps' ? <PerpsTicket sym={sym} oc={oc} /> : <SpotTicket sym={sym} oc={oc} />}
    </aside>
  );
}

