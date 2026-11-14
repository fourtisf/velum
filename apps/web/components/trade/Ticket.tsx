'use client';
import { PROTOCOL, isLive } from '@velum/config';
import { parseWad } from '@velum/math';
import { maxSize, perpsCalc, spotCalc } from '@/lib/calc';
import { openPerps, spotTrade } from '@/lib/demo';
import { dp, floorTo, fmt } from '@/lib/format';
import { useMarket, useMarkets } from '@/lib/markets';
import { bal, useApp } from '@/lib/store';
import { COPY, METRICS } from '@/lib/copy';
import { I } from '../icons';

type Btn = { label: string; cls: string; disabled: boolean; onClick?: () => void };

function SubmitButton({ b }: { b: Btn }) {
  return (
    <button className={`btn btn-block ${b.cls}`} disabled={b.disabled} onClick={b.onClick}>
      {b.label}
    </button>
  );
}

function PerpsTicket({ sym }: { sym: string }) {
  useMarkets((s) => s.tick);
  const m = useMarket(sym);
  const s = useApp();
  const connected = !!s.account;
  const have = bal(s.ledger.priv, 'USDG');
  const c = perpsCalc({ sel: sym, side: s.side, lev: s.lev, size: s.size }, have);
  const live = isLive(sym);
  let hint = '';
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!live) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = COPY.notOnNetwork(sym);
  } else if (m.noData) b = { label: 'Price unavailable', cls: 'btn-dark', disabled: true };
  else if (c.check === 'no_size') b = { label: 'Enter a size', cls: 'btn-dark', disabled: true };
  else if (c.check === 'insufficient') {
    b = { label: 'Not enough private USDG', cls: 'btn-dark', disabled: true };
    hint = 'Shield more USDG from Portfolio, or lower the size.';
  } else if (c.check === 'over_limit') {
    b = { label: `Above the ${PROTOCOL.maxTokensPerPosition}-token limit`, cls: 'btn-dark', disabled: true };
    hint = `One position can hold up to ${PROTOCOL.maxTokensPerPosition} tokens.`;
  } else b = { label: `Open ${s.side} privately`, cls: s.side === 'long' ? 'btn-up' : 'btn-down', disabled: false, onClick: openPerps };

  const maxLev = Math.min(m.maxLev || PROTOCOL.maxLeverage, PROTOCOL.maxLeverage);
  const preset = (p: number) => {
    const size = floorTo((maxSize(have, s.lev) * BigInt(p)) / 100n, 2);
    s.set({ size });
  };
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
          Available <b className="num pv">{connected ? fmt(have) + ' USDG' : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-size" inputMode="decimal" value={s.size} autoComplete="off" onChange={(e) => s.set({ size: e.target.value })} />
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
        min={1}
        max={maxLev}
        step={PROTOCOL.leverageStep}
        value={s.lev}
        onChange={(e) => s.set({ lev: Number(e.target.value) })}
        style={{ ['--p' as string]: ((s.lev - 1) / (maxLev - 1)) * 100 + '%' }}
      />
      <div className="ticks num">
        {Array.from({ length: maxLev }, (_, i) => (
          <span key={i}>{i + 1}×</span>
        ))}
      </div>
      <div className="sumbox">
        <div>
          <span>Entry price</span>
          <b>{fmt(c.entry)}</b>
        </div>
        <div>
          <span>Position</span>
          <b>
            {fmt(c.qty, 4)} {sym}
          </b>
        </div>
        <div>
          <span>Margin</span>
          <b>{fmt(c.margin)} USDG</b>
        </div>
        <div>
          <span>Liquidation price</span>
          <b>{c.liq ? fmt(c.liq) : 'None'}</b>
        </div>
        <div>
          <span>Fee</span>
          <b>{fmt(c.fee)} USDG</b>
        </div>
        <div>
          <span>Funding</span>
          <b>{METRICS.real ? `${fmt(c.funding, 4)}% / h` : METRICS.dash}</b>
        </div>
      </div>
      <SubmitButton b={b} />
      <p className="hint">{hint}</p>
      <p className="note">
        <I.lock />
        <span>Size, side and entry stay encrypted. If no maker fills you within {PROTOCOL.makerFillWindowMinutes} minutes, your margin comes back.</span>
      </p>
    </>
  );
}

function SpotTicket({ sym }: { sym: string }) {
  useMarkets((s) => s.tick);
  const m = useMarket(sym);
  const s = useApp();
  const connected = !!s.account;
  const c = spotCalc({ sel: sym, spotSide: s.spotSide, spotAmt: s.spotAmt, slip: s.slip }, s.ledger.priv);
  const live = isLive(sym);
  let hint = '';
  let b: Btn;
  if (!connected) b = { label: 'Connect wallet', cls: 'btn-white', disabled: false, onClick: () => s.openModal({ kind: 'connect' }) };
  else if (!live) {
    b = { label: 'Coming soon', cls: 'btn-dark', disabled: true };
    hint = COPY.notOnNetwork(sym);
  } else if (m.noData) b = { label: 'Price unavailable', cls: 'btn-dark', disabled: true };
  else if (c.amt <= 0n) b = { label: 'Enter an amount', cls: 'btn-dark', disabled: true };
  else if (c.amt > c.have) {
    b = { label: `Not enough private ${c.tin}`, cls: 'btn-dark', disabled: true };
    hint = `You have ${fmt(c.have, dp(c.tin))} ${c.tin} available.`;
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
          Available <b className="num pv">{connected ? `${fmt(c.have, dp(c.tin))} ${c.tin}` : '—'}</b>
        </span>
      </div>
      <div className="inp">
        <input id="t-spot" inputMode="decimal" value={s.spotAmt} autoComplete="off" onChange={(e) => s.set({ spotAmt: e.target.value })} />
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
        <output aria-label="You get (est.)">{c.out > 0n ? fmt(c.out, dp(c.tout)) : '0.00'}</output>
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
          <b>{fmt(m.price)}</b>
        </div>
        <div>
          <span>Pool fee (0.30%)</span>
          <b>{fmt(c.feeAmt)} USDG</b>
        </div>
        <div>
          <span>Minimum you get</span>
          <b>
            {fmt(c.min, dp(c.tout))} {c.tout}
          </b>
        </div>
        <div>
          <span>Liquidation</span>
          <b>None</b>
        </div>
      </div>
      <SubmitButton b={b} />
      <p className="hint">{hint}</p>
      <p className="note">
        <I.lock />
        <span>Pool reserves and your trade stay private. You own the token, so nothing can be liquidated.</span>
      </p>
    </>
  );
}

export function Ticket({ sym }: { sym: string }) {
  const mode = useApp((s) => s.mode);
  return (
    <aside className="card ticket" aria-label="Order ticket">
      {mode === 'perps' ? <PerpsTicket sym={sym} /> : <SpotTicket sym={sym} />}
    </aside>
  );
}
