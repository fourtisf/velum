'use client';
/**
 * The Spot ticket on Robinhood Chain mainnet: a real buy or sell from the connected wallet through Uniswap (the
 * curated pools of packages/config uniswap-mainnet.json), in the prototype's ticket layout. The quote is the pools' own
 * on-chain quote for the exact amount (best pool wins); the minimum comes from the slippage setting; the flow dialog
 * shows every amount before anything is signed (lib/uniswap/flows.tsx).
 */
import { PROTOCOL } from '@velum/config';
import { UNISWAP, feePct, poolLabel } from '@velum/config/src/uniswap';
import { parseWad } from '@velum/math';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { usePublicBalances } from '@/lib/balances';
import { UNI } from '@/lib/copy';
import { dp, fmt, fmtBal, fmtFloor } from '@/lib/format';
import { slipBps } from '@/lib/onchain/quote';
import { unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';
import { minOutFor } from '@/lib/uniswap/encode';
import { uniTradeFlow } from '@/lib/uniswap/flows';
import { poolsOf, useUniQuote } from '@/lib/uniswap/quote';
import { useApp } from '@/lib/store';
import { I } from '../icons';

type Btn = { label: string; cls: string; disabled: boolean; onClick?: () => void };
const HINT = 't-spot-hint';

export function UniSpotTicket({ sym }: { sym: string }) {
  const s = useApp();
  const cfg = UNISWAP!;
  const connected = !!s.account;
  const pools = poolsOf(sym);
  const side = s.spotSide;
  const tin = side === 'buy' ? 'USDG' : sym;
  const tout = side === 'buy' ? sym : 'USDG';
  const dIn = tin === 'USDG' ? cfg.usdg.decimals : cfg.decimals[sym];
  const dOut = tout === 'USDG' ? cfg.usdg.decimals : cfg.decimals[sym];
  const pub = usePublicBalances(s.account?.addr);
  const haveWad = pub.data?.bal[tin] ?? null;
  const eth = pub.data?.bal.ETH ?? null;
  const units = dIn === undefined ? null : wadToUnits(amountOrZero(s.spotAmt), dIn);
  const amountIn = units?.ok ? units.units : 0n;
  const haveUnits = haveWad !== null && dIn !== undefined ? wadToUnits(haveWad, dIn) : null;
  const have = haveUnits?.ok ? haveUnits.units : null;
  const q = useUniQuote(pools.length ? sym : null, side, amountIn);
  const quote = q.data ?? null;
  const slip = slipBps(s.slip);
  const min = quote ? minOutFor(quote.amountOut, slip) : 0n;
  // Average execution price in USDG per token (fees and price impact included).
  const avg =
    quote && dIn !== undefined && dOut !== undefined
      ? side === 'buy'
        ? (unitsToWad(quote.amountIn, dIn) * 10n ** 18n) / unitsToWad(quote.amountOut, dOut)
        : (unitsToWad(quote.amountOut, dOut) * 10n ** 18n) / unitsToWad(quote.amountIn, dIn)
      : null;

  const bad = amountHint(s.spotAmt);
  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!pools.length || dIn === undefined || dOut === undefined) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = UNI.noPools(sym);
  } else if (bad || (units && !units.ok)) {
    b = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
    if (!bad) hint = `${tin} has ${dIn} decimals: use at most ${dIn} decimal places.`;
  } else if (amountIn <= 0n) b = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (have === null) b = { label: pub.isError ? 'Balance unavailable' : 'Reading your wallet…', cls: 'btn-dark', disabled: true };
  else if (amountIn > have) {
    b = { label: `Not enough ${tin} in your wallet`, cls: 'btn-dark', disabled: true };
    hint = `Your wallet holds ${fmtBal(unitsToWad(have, dIn), dp(tin))} ${tin}.`;
  } else if (eth !== null && eth === 0n) {
    b = { label: 'No ETH for gas', cls: 'btn-dark', disabled: true };
    hint = UNI.gasHint;
  } else if (q.isLoading) b = { label: 'Quoting…', cls: 'btn-dark', disabled: true };
  else if (!quote) {
    b = { label: 'No liquidity', cls: 'btn-dark', disabled: true };
    hint = UNI.noLiquidity;
  } else if (min <= 0n) {
    b = { label: 'Amount too small', cls: 'btn-dark', disabled: true };
    hint = 'This amount is too small to protect with a minimum.';
  } else {
    const verb = side === 'buy' ? 'Buy' : 'Sell';
    b = {
      label: `${verb} ${sym}`,
      cls: side === 'buy' ? 'btn-up' : 'btn-down',
      disabled: false,
      onClick: () =>
        s.runTxFlow(
          uniTradeFlow({
            account: s.account!.addr,
            from: tin,
            to: tout,
            amountIn,
            quoteOut: quote.amountOut,
            minOut: min,
            first: quote.hop,
            firstMin: min,
            title: `${verb} ${sym}`,
            toast: side === 'buy' ? `Bought ${sym}` : `Sold ${sym}`,
          }),
        ),
    };
  }

  const setSide = (g: 'buy' | 'sell') => {
    const held = pub.data?.bal[sym] ?? 0n;
    const one = parseWad('1')!;
    s.set({ spotSide: g, spotAmt: g === 'buy' ? '500' : unitsToInput(wadToUnitsOr0(held < one && held > 0n ? held : one, cfg.decimals[sym] ?? 18), cfg.decimals[sym] ?? 18, 4) });
  };
  const preset = (p: number) => {
    if (have === null || dIn === undefined) return;
    s.set({ spotAmt: unitsToInput((have * BigInt(p)) / 100n, dIn, dp(tin)) });
  };
  return (
    <>
      <div className="sides" role="group" aria-label="Buy or sell">
        <button className={`long ${side === 'buy' ? 'on' : ''}`} aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button className={`short ${side === 'sell' ? 'on' : ''}`} aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>
      <div className="fl">
        <label htmlFor="t-spot">You pay</label>
        <span>
          Wallet <b className="num">{connected && haveWad !== null ? `${fmtBal(haveWad, dp(tin))} ${tin}` : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-spot" {...amountInputProps(s.spotAmt, HINT)} value={s.spotAmt} onChange={(e) => s.set({ spotAmt: e.target.value })} />
        <span className="unit">{tin}</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)} disabled={have === null}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="fl">
        <span>You get (est.)</span>
      </div>
      <div className="inp">
        <output aria-label="You get (est.)">{quote && dOut !== undefined ? fmt(unitsToWad(quote.amountOut, dOut), dp(tout)) : amountIn > 0n && q.isLoading ? '…' : '0.00'}</output>
        <span className="unit">{tout}</span>
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
      <div className="sumbox">
        <div>
          <span>Price</span>
          <b>{avg === null ? '—' : `${fmt(avg)} USDG`}</b>
        </div>
        <div>
          <span>Pool fee</span>
          <b>{quote ? `${feePct(quote.hop.pool.fee)} (in the quote)` : '—'}</b>
        </div>
        <div>
          <span>Minimum you get</span>
          {/* Rounded down: never more than the onchain minimum (the review dialog shows it exactly). */}
          <b>{quote && dOut !== undefined ? `${fmtFloor(unitsToWad(min, dOut), dp(tout))} ${tout}` : '—'}</b>
        </div>
        <div>
          <span>Route</span>
          <b>{quote ? poolLabel(quote.hop.pool) : 'Uniswap'}</b>
        </div>
        <div>
          <span>Liquidation</span>
          <b>None</b>
        </div>
      </div>
      <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
        {b.label}
      </button>
      <p className="hint" id={HINT}>
        {hint}
      </p>
      <p className="note">
        <I.info />
        <span>{UNI.spotNote}</span>
      </p>
    </>
  );
}

/** Wad -> base units, 0 when it has more decimals than the token (never rounds up). */
function wadToUnitsOr0(w: bigint, decimals: number): bigint {
  const r = wadToUnits(w - (w % 10n ** BigInt(18 - decimals)), decimals);
  return r.ok ? r.units : 0n;
}
