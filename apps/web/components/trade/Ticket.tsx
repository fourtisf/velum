'use client';
import { PROTOCOL, isLive } from '@velum/config';
import { parseWad } from '@velum/math';
import { amountHint, amountInputProps } from '@/lib/amount';
import { MIN_LEVERAGE, perpsCalc, presetSize, spotCalc } from '@/lib/calc';
import { openPerps, spotTrade } from '@/lib/demo';
import { dp, floorTo, fmt, fmtBal, fmtFloor } from '@/lib/format';
import { PERP_VENUES, useLivePrice, useMarket, usePriceTick } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';
import { CLOSED, COPY, METRICS, P, UI } from '@/lib/copy';
import { I } from '../icons';
import { DemoTag, RefTag } from '../ui';
import { OnchainTicket } from '../onchain/lazy';
import { UniSpotTicket } from '../uniswap/lazy';
import { UNISWAP } from '@velum/config/src/uniswap';
import { useTradeMode } from './mode';
import { useOnchain } from '@/lib/onchain/deployment';

type Btn = { label: string; cls: string; disabled: boolean; onClick?: () => void };

/** Hint paragraph ids, so each input can point at its hint (aria-describedby). */
const HINT = { perps: 't-size-hint', spot: 't-spot-hint' };

function SubmitButton({ b }: { b: Btn }) {
  return (
    <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
      {b.label}
    </button>
  );
}

function PerpsTicket({ sym }: { sym: string }) {
  usePriceTick();
  const m = useMarket(sym);
  const price = useLivePrice(sym);
  const s = useApp();
  const connected = !!s.account;
  const have = bal(s.ledger.priv, 'USDG');
  const c = perpsCalc({ sel: sym, side: s.side, lev: s.lev, size: s.size }, have, price);
  const live = isLive(sym);
  // Mainnet: the funding rate of the market's perp on Lighter (a labelled reference; Velum perps are simulated there).
  const refVenue = !METRICS.real && m.ref ? PERP_VENUES[m.ref] : null;
  /** Price-derived figures show a dash without a live price (audit round 2, M4). */
  const px = (v: string) => (c.priced ? v : '—');
  const bad = amountHint(s.size);
  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!live) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = COPY.notOnNetwork(sym);
  } else if (!c.priced) {
    b = { label: m.closed ? CLOSED.label : 'Price unavailable', cls: 'btn-dark', disabled: true };
    if (m.closed) hint = CLOSED.hint;
  } else if (bad) b = { label: 'Enter a valid size', cls: 'btn-dark', disabled: true };
  else if (c.check === 'no_size') b = { label: 'Enter a size', cls: 'btn-dark', disabled: true };
  else if (c.check === 'insufficient') {
    b = { label: 'Not enough private USDG', cls: 'btn-dark', disabled: true };
    hint = 'Shield more USDG from Portfolio, or lower the size.';
  } else if (c.check === 'over_limit') {
    b = { label: `Above the ${PROTOCOL.maxTokensPerPosition}-token limit`, cls: 'btn-dark', disabled: true };
    hint = `One position can hold up to ${PROTOCOL.maxTokensPerPosition} tokens.`;
  } else b = { label: `Open ${s.side} privately`, cls: s.side === 'long' ? 'btn-up' : 'btn-down', disabled: false, onClick: openPerps };

  // m.maxLev is validated to 1..PROTOCOL max (lib/markets apiMaxLeverage, final audit W-15); at 1× the slider has no range.
  const maxLev = Math.min(m.maxLev || PROTOCOL.maxLeverage, PROTOCOL.maxLeverage);
  const levRange = maxLev - MIN_LEVERAGE;
  const preset = (p: number) => s.set({ size: floorTo(presetSize(have, s.lev, c.entry, p), 2) });
  return (
    <>
      <div className="sides" role="group" aria-label="Side">
        <button className={`long ${s.side === 'long' ? 'on' : ''}`} aria-pressed={s.side === 'long'} onClick={() => s.set({ side: 'long' })}>
          Long
        </button>
        <button className={`short ${s.side === 'short' ? 'on' : ''}`} aria-pressed={s.side === 'short'} onClick={() => s.set({ side: 'short' })}>
          Short
        </button>
      </div>
      <div className="fl">
        <label htmlFor="t-size">Size</label>
        <span>
          Available <b className="num pv">{connected ? fmtBal(have) + ' USDG' : '—'}</b>
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
      <div className="sumbox">
        <div>
          <span>Entry price</span>
          <b>{px(fmt(c.entry))}</b>
        </div>
        <div>
          <span>Position</span>
          <b>{px(`${fmt(c.qty, 4)} ${sym}`)}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{fmt(c.margin)} USDG</b>
        </div>
        <div>
          <span>Liquidation price</span>
          <b>{px(c.liq ? fmt(c.liq) : 'None')}</b>
        </div>
        <div>
          <span>Fee</span>
          <b>{fmt(c.fee)} USDG</b>
        </div>
        <div>
          <span>
            Funding{refVenue ? <RefTag venue={refVenue} sym={sym} /> : METRICS.real ? <DemoTag flag={m.demo} /> : null}
          </span>
          <b>{(METRICS.real || refVenue) && c.funding !== null ? `${fmt(c.funding, 4)}% / h` : METRICS.dash}</b>
        </div>
      </div>
      <SubmitButton b={b} />
      <p className="hint" id={HINT.perps}>
        {hint}
      </p>
      <p className="note">
        <I.lock />
        <span>{UI.perpsNote}</span>
      </p>
    </>
  );
}

function SpotTicket({ sym }: { sym: string }) {
  usePriceTick();
  const m = useMarket(sym);
  const price = useLivePrice(sym);
  const s = useApp();
  const connected = !!s.account;
  const c = spotCalc({ sel: sym, spotSide: s.spotSide, spotAmt: s.spotAmt, slip: s.slip }, s.ledger.priv, price);
  const px = (v: string) => (c.priced ? v : '—');
  const live = isLive(sym);
  const bad = amountHint(s.spotAmt);
  let hint = bad;
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!live) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = COPY.notOnNetwork(sym);
  } else if (!c.priced) {
    b = { label: m.closed ? CLOSED.label : 'Price unavailable', cls: 'btn-dark', disabled: true };
    if (m.closed) hint = CLOSED.hint;
  } else if (bad) b = { label: 'Enter a valid amount', cls: 'btn-dark', disabled: true };
  else if (c.amt <= 0n) b = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (c.amt > c.have) {
    b = { label: `Not enough private ${c.tin}`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmtBal(c.have, dp(c.tin))} ${c.tin} available.`;
  } else b = { label: `${s.spotSide === 'buy' ? 'Buy' : 'Sell'} ${sym} privately`, cls: s.spotSide === 'buy' ? 'btn-up' : 'btn-down', disabled: false, onClick: spotTrade };

  const setSide = (g: 'buy' | 'sell') => {
    const held = bal(s.ledger.priv, sym);
    const one = parseWad('1')!;
    s.set({ spotSide: g, spotAmt: g === 'buy' ? '500' : floorTo((held < one ? held : one) || one, 4) });
  };
  return (
    <>
      <div className="sides" role="group" aria-label="Buy or sell">
        <button className={`long ${s.spotSide === 'buy' ? 'on' : ''}`} aria-pressed={s.spotSide === 'buy'} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button className={`short ${s.spotSide === 'sell' ? 'on' : ''}`} aria-pressed={s.spotSide === 'sell'} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>
      <div className="fl">
        <label htmlFor="t-spot">You pay</label>
        <span>
          Available <b className="num pv">{connected ? `${fmtBal(c.have, dp(c.tin))} ${c.tin}` : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-spot" {...amountInputProps(s.spotAmt, HINT.spot)} value={s.spotAmt} onChange={(e) => s.set({ spotAmt: e.target.value })} />
        <span className="unit">{c.tin}</span>
      </div>
      <div className="seg full pcts" role="group" aria-label="Amount presets">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => s.set({ spotAmt: floorTo((c.have * BigInt(p)) / 100n, dp(c.tin)) })}>
            {p === 100 ? 'Max' : p + '%'}
          </button>
        ))}
      </div>
      <div className="fl">
        <span>You get (est.)</span>
      </div>
      <div className="inp">
        <output aria-label="You get (est.)">{px(c.out > 0n ? fmt(c.out, dp(c.tout)) : '0.00')}</output>
        <span className="unit">{c.tout}</span>
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
          <b>{c.price === null ? '—' : fmt(c.price)}</b>
        </div>
        <div>
          <span>Pool fee ({P.poolFee})</span>
          <b>{c.priced || s.spotSide === 'buy' ? `${fmt(c.feeAmt)} USDG` : '—'}</b>
        </div>
        <div>
          <span>Minimum you get</span>
          <b>{px(`${fmtFloor(c.min, dp(c.tout))} ${c.tout}`)}</b>
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
        <span>{UI.spotNote}</span>
      </p>
    </>
  );
}

export function Ticket({ sym }: { sym: string }) {
  const mode = useTradeMode();
  // Real transactions once a deployment is live (lib/onchain/deployment.ts); otherwise the simulated ticket, except
  // Spot on mainnet, which trades for real through Uniswap from the wallet (lib/uniswap).
  const oc = useOnchain();
  if (oc) return <OnchainTicket sym={sym} mode={mode} oc={oc} />;
  return (
    <aside className="card ticket" aria-label="Order ticket">
      {mode === 'perps' ? <PerpsTicket sym={sym} /> : UNISWAP ? <UniSpotTicket sym={sym} /> : <SpotTicket sym={sym} />}
    </aside>
  );
}
