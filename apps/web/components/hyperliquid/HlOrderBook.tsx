'use client';
/** The live order book of the selected stock perp, next to the chart in Perps mode (lib/hyperliquid/book.ts). */
import { HL_MARKETS } from '@velum/config/src/hyperliquid';
import { useHlBook, type BookLevel } from '@/lib/hyperliquid/book';

const pxDigits = (px: number) => (px >= 1000 ? 1 : px >= 1 ? 2 : 4);
const fmtPx = (px: number) => px.toLocaleString('en-US', { minimumFractionDigits: pxDigits(px), maximumFractionDigits: pxDigits(px) });
const fmtSz = (sz: number) => sz.toLocaleString('en-US', { maximumFractionDigits: sz >= 100 ? 1 : 3 });
const fmtUsd = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));

function Row({ l, side, max }: { l: BookLevel; side: 'bid' | 'ask'; max: number }) {
  const w = max > 0 ? Math.min(100, (l.cum / max) * 100) : 0;
  return (
    <div className={`ob-row ${side}`}>
      <span className="ob-bar" style={{ width: `${w}%` }} aria-hidden="true" />
      <span className="ob-px num">{fmtPx(l.px)}</span>
      <span className="r num">{fmtSz(l.sz)}</span>
      <span className="r num ob-tot">{fmtUsd(l.cumUsd)}</span>
    </div>
  );
}

export function HlOrderBook({ sym, depth = 12 }: { sym: string; depth?: number }) {
  const book = useHlBook(sym, depth);
  const b = book.data;
  const coinOk = !!HL_MARKETS[sym];
  return (
    <section className="card obook" aria-label={`${sym} order book`}>
      <div className="ob-head">
        <h2>Order book</h2>
        <span className="faint num" aria-live="off">
          {b && b.spread !== null && b.spreadPct !== null ? `Spread ${fmtPx(b.spread)} · ${b.spreadPct.toFixed(3)}%` : ''}
        </span>
      </div>
      <div className="ob-cols">
        <span>Price</span>
        <span className="r">Size ({sym})</span>
        <span className="r">Total (USD)</span>
      </div>
      {!coinOk ? (
        <p className="ob-msg">No perp market for {sym}.</p>
      ) : book.isError && !b ? (
        <p className="ob-msg">The order book cannot be loaded right now.</p>
      ) : !b ? (
        <p className="ob-msg" aria-busy="true">
          Loading the order book…
        </p>
      ) : (
        <>
          <div className="ob-side asks">
            {[...b.asks].reverse().map((l) => (
              <Row key={`a${l.px}`} l={l} side="ask" max={b.maxCum} />
            ))}
          </div>
          <div className="ob-mid">
            <b className="num">{b.mid !== null ? fmtPx(b.mid) : '—'}</b>
            <span className="faint">Mid price</span>
          </div>
          <div className="ob-side bids">
            {b.bids.map((l) => (
              <Row key={`b${l.px}`} l={l} side="bid" max={b.maxCum} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
