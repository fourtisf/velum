'use client';
/**
 * The Perps ticket on Robinhood Chain mainnet: a real long or short from the user's own Hyperliquid account on
 * Hyperliquid's XYZ stock perps (lib/hyperliquid), in the prototype's ticket layout. Size is the position value in USD,
 * leverage a whole number up to Velum's 5x (Hyperliquid takes integers), isolated margin. The order is an immediate
 * limit order at the mid price moved by the slippage setting; the flow dialog shows every number before anything is
 * signed (lib/hyperliquid/flows.ts).
 */
import { PROTOCOL } from '@velum/config';
import { HL_MAX_LEVERAGE, HL_MAX_TOKENS, HL_MIN_ORDER_USD } from '@velum/config/src/hyperliquid';
import { parseWad, toDecimalString } from '@velum/math';
import { amountHint, amountInputProps } from '@/lib/amount';
import { HL } from '@/lib/copy';
import { fmt, fmtLev } from '@/lib/format';
import { BUILDER, builderRate, useHlBalances, useHlMarkets, useHlMid, useHlMode } from '@/lib/hyperliquid/client';
import { openFlow } from '@/lib/hyperliquid/flows';
import { liqEstimate, planOpen, type OpenRefusal } from '@/lib/hyperliquid/order';
import { PERP_VENUES, useMarket } from '@/lib/markets';
import { slipBps } from '@/lib/onchain/quote';
import { useApp } from '@/lib/store';
import { I } from '../icons';
import { RefTag } from '../ui';

type Btn = { label: string; cls: string; disabled: boolean; onClick?: () => void; href?: string };
const HINT = 't-size-hint';
const WAD = 10n ** 18n;

/** A USD amount (number from Hyperliquid's balances) as a wad, rounded down to cents. */
const usdWad = (n: number): bigint => (Number.isFinite(n) && n > 0 ? (parseWad((Math.floor(n * 100) / 100).toFixed(2)) ?? 0n) : 0n);

const REFUSAL: Record<OpenRefusal, { label: string; hint: string }> = {
  size: { label: 'Enter a size', hint: '' },
  min: { label: `Minimum ${HL_MIN_ORDER_USD} USD`, hint: `Orders must be at least ${HL_MIN_ORDER_USD} USD.` },
  max: { label: `Above the ${HL_MAX_TOKENS}-token limit`, hint: `One position can hold up to ${HL_MAX_TOKENS} tokens.` },
  leverage: { label: 'Leverage not allowed', hint: `Velum trades up to ${HL_MAX_LEVERAGE}×.` },
  price: { label: 'Price unavailable', hint: '' },
};

export function HlPerpsTicket({ sym }: { sym: string }) {
  const s = useApp();
  const m = useMarket(sym);
  const user = s.account?.addr;
  const connected = !!user;
  const markets = useHlMarkets();
  const market = markets.data?.[sym] ?? null;
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const mid = useHlMid(market?.coin ?? null);
  const px = mid.data ?? null;
  const pxW = px ? parseWad(px) : null;
  const pos = market ? (bal.data?.positions.find((p) => p.coin === market.coin) ?? null) : null;
  const maxLev = Math.min(HL_MAX_LEVERAGE, market?.maxLeverage ?? HL_MAX_LEVERAGE);
  // Adding to a position keeps its leverage (Hyperliquid refuses lowering an isolated position's leverage).
  const lockedLev = pos ? pos.leverage : null;
  const lev = lockedLev ?? Math.min(maxLev, Math.max(1, Math.floor(s.lev)));
  const long = s.side === 'long';
  const avail = bal.data ? bal.data.xyzAvailable + bal.data.mainAvailable : null;
  const slip = slipBps(s.slip);
  const bad = amountHint(s.size);
  const res = market && px && !bad ? planOpen({ market, long, notionalUsd: s.size.trim() || '0', leverage: lev, markPx: px, slipBps: slip, currentSzi: pos?.szi }) : null;
  const plan = res?.ok ? res.plan : null;
  const liq = plan && pxW && market ? liqEstimate(pxW, long, lev, market.maxLeverage) : null;
  const refVenue = m.ref ? PERP_VENUES[m.ref] : null;

  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (markets.isLoading) b = { label: 'Loading perps…', cls: 'btn-dark', disabled: true };
  else if (markets.isError) {
    b = { label: 'Perps unavailable', cls: 'btn-dark', disabled: true };
    hint = HL.unavailable;
  } else if (!market) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = HL.noMarket(sym);
  } else if (mode.isError || bal.isError) {
    b = { label: 'Perps unavailable', cls: 'btn-dark', disabled: true };
    hint = HL.unavailable;
  } else if (!bal.data) b = { label: 'Reading your perps account…', cls: 'btn-dark', disabled: true };
  else if (!bal.data.funded) {
    b = { label: 'Deposit USDC', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'hl-deposit' }) };
    hint = HL.depositHint;
  } else if (pos && !pos.isolated) {
    b = { label: 'Cross position open', cls: 'btn-dark', disabled: true };
    hint = HL.crossHint(sym);
  } else if (!px) b = { label: mid.isLoading ? 'Reading the price…' : 'Price unavailable', cls: 'btn-dark', disabled: true };
  else if (bad) b = { label: 'Enter a valid size', cls: 'btn-dark', disabled: true };
  else if (!res || !res.ok) {
    const r = REFUSAL[res && !res.ok ? res.reason : 'size'];
    b = { label: r.label, cls: 'btn-dark', disabled: true };
    hint = res && !res.ok && res.reason === 'leverage' && lockedLev !== null ? HL.levHint(sym, lockedLev) : r.hint;
  } else if (usdWad(avail ?? 0) < (parseWad(res.plan.margin) ?? 0n)) {
    b = { label: 'Not enough USDC in your perps account', cls: 'btn-dark', disabled: true };
    hint = HL.notEnough(fmt(usdWad(avail ?? 0)));
  } else {
    const p = res.plan;
    b = {
      label: `Open ${s.side}`,
      cls: long ? 'btn-up' : 'btn-down',
      disabled: false,
      onClick: () =>
        s.runHlFlow(
          openFlow({
            user: user!,
            sym,
            market,
            plan: p,
            mode: mode.data!,
            xyzAvailable: bal.data!.xyzAvailable,
            mainAvailable: bal.data!.mainAvailable,
            slipPct: s.slip,
            liqEst: liq === null ? 'None' : fmt(liq),
          }),
        ),
    };
  }

  /** 25/50/75/Max of what the balance allows at this leverage (margin plus the fee allowance), under the token cap. */
  const preset = (pct: number) => {
    if (avail === null || !pxW) return;
    const byBal = (usdWad(avail) * WAD) / (WAD / BigInt(lev) + WAD / 1000n);
    const held = pos ? (parseWad(pos.szi.replace(/^-/, '')) ?? 0n) : 0n;
    const same = pos ? pos.szi.startsWith('-') !== long : true;
    const room = BigInt(HL_MAX_TOKENS) * WAD - (same ? held : -held);
    // 0.5% under the cap at the current price, so a small move cannot tip the order over it.
    const byCap = room > 0n ? (((room * pxW) / WAD) * 995n) / 1000n : 0n;
    const v = ((byBal < byCap ? byBal : byCap) * BigInt(pct)) / 100n;
    s.set({ size: toDecimalString((v / 10n ** 16n) * 10n ** 16n, 2) });
  };
  const levRange = maxLev - 1;
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
          Perps balance <b className="num">{connected && avail !== null ? `${fmt(usdWad(avail))} USDC` : '—'}</b>
          {connected && bal.data?.funded ? (
            <button type="button" className="linkbtn" onClick={() => s.openModal({ kind: 'hl-deposit' })}>
              + Deposit
            </button>
          ) : null}
        </span>
      </div>
      <div className="inp">
        <input id="t-size" {...amountInputProps(s.size, HINT)} value={s.size} onChange={(e) => s.set({ size: e.target.value })} />
        <span className="unit">USD</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Size presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => preset(p)} disabled={avail === null || !pxW}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="fl">
        <label htmlFor="t-lev">Leverage</label>
        <b className="num">{fmtLev(lev)}</b>
      </div>
      <input
        type="range"
        id="t-lev"
        min={1}
        max={maxLev}
        step={1}
        value={Math.min(lev, maxLev)}
        disabled={lockedLev !== null}
        aria-describedby={lockedLev !== null ? 't-lev-note' : undefined}
        onChange={(e) => s.set({ lev: Number(e.target.value) })}
        style={{ ['--p' as string]: (levRange > 0 ? Math.min(1, (Math.min(lev, maxLev) - 1) / levRange) : 1) * 100 + '%' }}
      />
      <div className="ticks num">
        {Array.from({ length: levRange + 1 }, (_, i) => (
          <span key={i}>{i + 1}×</span>
        ))}
      </div>
      {lockedLev !== null ? (
        <p className="muted" id="t-lev-note" style={{ fontSize: 12.5, marginTop: 6, textAlign: 'center' }}>
          {HL.levLocked(sym, lockedLev)}
        </p>
      ) : null}
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
          <b>{pxW ? fmt(pxW) : '—'}</b>
        </div>
        <div>
          <span>Position</span>
          <b>{plan ? `${plan.size} ${sym}` : '—'}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{plan ? `${plan.margin} USDC` : '—'}</b>
        </div>
        <div>
          <span>Liquidation price (est.)</span>
          <b>{plan ? (liq === null ? 'None' : fmt(liq)) : '—'}</b>
        </div>
        <div>
          <span>Fee</span>
          <b>{BUILDER ? `Exchange fee + ${builderRate(BUILDER.f)}` : 'Exchange fee only'}</b>
        </div>
        <div>
          <span>Funding{refVenue ? <RefTag venue={refVenue} sym={sym} /> : null}</span>
          <b>{refVenue && m.funding !== null ? `${fmt(m.funding, 4)}% / h` : '—'}</b>
        </div>
      </div>
      {b.href ? (
        <a className={`btn btn-block ${b.cls}`} href={b.href} target="_blank" rel="noopener noreferrer">
          {b.label}
        </a>
      ) : (
        <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
          {b.label}
        </button>
      )}
      <p className="hint" id={HINT}>
        {hint}
      </p>
      <p className="note">
        <I.info />
        <span>{HL.perpsNote}</span>
      </p>
    </>
  );
}
