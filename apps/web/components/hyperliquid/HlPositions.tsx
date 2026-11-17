'use client';
/**
 * The positions card on Robinhood Chain mainnet: the user's real positions in the Velum markets on Hyperliquid's XYZ
 * stock perps, read from Hyperliquid every 6 s, each with its take profit / stop loss and TP/SL, Margin and Close
 * (dialogs in HlManage.tsx), the open orders (limit, TP, SL) under Orders with Cancel, and recent fills under Activity.
 * Same layout as the simulated card (components/trade/Positions.tsx).
 */
import { parseWad } from '@velum/math';
import { HL } from '@/lib/copy';
import { ago, fmt, fmtLev } from '@/lib/format';
import { useHlBalances, useHlFills, useHlMarkets, useHlMid, useHlMode, type HlFill, type HlPosition } from '@/lib/hyperliquid/client';
import { cancelFlow, useHlOpenOrders } from '@/lib/hyperliquid/manage';
import { KIND_LABEL, tpslOf, type OpenOrder } from '@/lib/hyperliquid/risk';
import { useApp } from '@/lib/store';
import { I } from '../icons';
import { Av } from '../ui';

/** A decimal string from Hyperliquid for display (dash when malformed). */
const dec = (v: string | null, d = 2): string => {
  const w = v === null ? null : parseWad(v.replace(/^-/, ''));
  return w === null ? '—' : (v!.startsWith('-') ? '-' : '') + fmt(w, d);
};
const nonzero = (v: string): boolean => {
  const w = parseWad(v.replace(/^-/, ''));
  return w !== null && w !== 0n;
};
const signed = (v: string): string => (v.startsWith('-') ? `-$${dec(v.slice(1))}` : `+$${dec(v)}`);

function RowButtons({ p }: { p: HlPosition }) {
  const s = useApp();
  const markets = useHlMarkets();
  const market = markets.data?.[p.symbol] ?? null;
  const mid = useHlMid(market?.coin ?? null);
  const ready = !!market && !!mid.data;
  return (
    <div className="rowbtns">
      <button className="btn btn-dark btn-sm" disabled={!market} onClick={() => s.openModal({ kind: 'hl-tpsl', sym: p.symbol })}>
        TP/SL
      </button>
      <button className="btn btn-dark btn-sm" disabled={!market || !p.isolated} title={p.isolated ? undefined : 'Isolated positions only'} onClick={() => s.openModal({ kind: 'hl-margin', sym: p.symbol })}>
        Margin
      </button>
      <button className="btn btn-dark btn-sm" disabled={!ready} title={ready ? undefined : 'Price unavailable'} onClick={() => s.openModal({ kind: 'hl-close', sym: p.symbol })}>
        Close
      </button>
    </div>
  );
}

function HlPosTable({ list, user }: { list: HlPosition[]; user: `0x${string}` }) {
  const orders = useHlOpenOrders(user);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Market</th>
            <th className="r">Size</th>
            <th className="r">Entry</th>
            <th className="r hide-sm">Liq. price</th>
            <th className="r hide-sm">TP / SL</th>
            <th className="r">P&amp;L</th>
            <th className="r">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => {
            const long = !p.szi.startsWith('-');
            const roe = Number(p.returnOnEquity);
            const up = !p.unrealizedPnl.startsWith('-');
            const ts = tpslOf(orders.data ?? [], p.coin);
            return (
              <tr key={p.coin}>
                <td>
                  <div className="mcell">
                    <Av sym={p.symbol} size="sm" />
                    <div>
                      <b>{p.symbol}</b>
                      <small className={long ? 'up' : 'down'}>
                        {long ? 'Long' : 'Short'} {fmtLev(p.leverage)}
                      </small>
                    </div>
                  </div>
                </td>
                <td className="r num">{dec(p.szi.replace(/^-/, ''), 3)}</td>
                <td className="r num">{dec(p.entryPx)}</td>
                <td className="r num hide-sm">{p.liquidationPx ? dec(p.liquidationPx) : 'None'}</td>
                <td className="r num hide-sm tpsl-cell">
                  <span className="up">{ts.tp ? dec(ts.tp.px) : '—'}</span> / <span className="down">{ts.sl ? dec(ts.sl.px) : '—'}</span>
                </td>
                <td className="r num">
                  <span className={up ? 'up' : 'down'}>
                    {signed(p.unrealizedPnl)} <small>{Number.isFinite(roe) ? `${roe >= 0 ? '+' : ''}${(roe * 100).toFixed(1)}%` : ''}</small>
                  </span>
                </td>
                <td className="r">
                  <RowButtons p={p} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Fills({ list }: { list: HlFill[] }) {
  if (!list.length)
    return (
      <div className="empty">
        <p>{HL.noFills}</p>
      </div>
    );
  return (
    <>
      {list.slice(0, 10).map((f) => (
        <div className="act" key={`${f.oid}:${f.time}:${f.coin}`}>
          <span className="ic">
            <I.trade />
          </span>
          <div>
            <b>
              {f.dir || 'Trade'} {dec(f.sz, 3)} {f.symbol}
            </b>
            <small>
              at {dec(f.px)}
              {nonzero(f.closedPnl) ? ` · P&L ${signed(f.closedPnl)}` : ''}
            </small>
          </div>
          <small className="faint" suppressHydrationWarning>
            {ago(f.time)}
          </small>
        </div>
      ))}
    </>
  );
}

/** The open orders (limit, take profit, stop loss) in the Velum markets, each with Cancel. */
function Orders({ user }: { user: `0x${string}` }) {
  const s = useApp();
  const orders = useHlOpenOrders(user);
  if (orders.isError)
    return (
      <div className="empty">
        <p>{HL.unavailable}</p>
      </div>
    );
  if (!orders.data)
    return (
      <div className="empty" aria-busy="true">
        <p>Reading your orders…</p>
      </div>
    );
  if (!orders.data.length)
    return (
      <div className="empty">
        <p>No open orders. Limit orders and take profit / stop loss show here.</p>
      </div>
    );
  const list = orders.data;
  return (
    <div className="tbl-wrap">
      <table className="tbl orders-tbl">
        <thead>
          <tr>
            <th>Market</th>
            <th>Type</th>
            <th className="r">Size</th>
            <th className="r">Price</th>
            <th className="r">
              {list.length > 1 ? (
                <button className="btn btn-dark btn-sm" onClick={() => s.runHlFlow(cancelFlow({ user, orders: list }))}>
                  Cancel all
                </button>
              ) : (
                <span className="sr">Actions</span>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((o: OpenOrder) => (
            <tr key={o.oid}>
              <td>
                <div className="mcell">
                  <Av sym={o.symbol} size="sm" />
                  <div>
                    <b>{o.symbol}</b>
                    <small className={o.isBuy ? 'up' : 'down'}>{o.isBuy ? 'Buy' : 'Sell'}</small>
                  </div>
                </div>
              </td>
              <td>
                {KIND_LABEL[o.kind]}
                {o.reduceOnly && o.kind === 'limit' ? <small className="faint"> · reduce-only</small> : null}
              </td>
              <td className="r num">{o.position || !nonzero(o.sz) ? 'Position' : dec(o.sz, 3)}</td>
              <td className="r num">{dec(o.px)}</td>
              <td className="r">
                <button className="btn btn-dark btn-sm" onClick={() => s.runHlFlow(cancelFlow({ user, orders: [o] }))}>
                  Cancel
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The positions body: connect, account state, empty or the table. */
function PositionsBody({ user, onConnect, onDeposit }: { user: `0x${string}` | undefined; onConnect: () => void; onDeposit: () => void }) {
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  if (!user)
    return (
      <div className="empty">
        <p>{HL.connectPositions}</p>
        <button className="btn btn-white btn-sm" onClick={onConnect}>
          Connect wallet
        </button>
      </div>
    );
  if (mode.isError || bal.isError)
    return (
      <div className="empty">
        <p>{HL.unavailable}</p>
      </div>
    );
  if (!bal.data)
    return (
      <div className="empty" aria-busy="true">
        <p>Reading your perps account…</p>
      </div>
    );
  if (!bal.data.funded)
    return (
      <div className="empty">
        <p>{HL.noAccount}</p>
        <button className="btn btn-white btn-sm" onClick={onDeposit}>
          Deposit USDC
        </button>
      </div>
    );
  if (!bal.data.positions.length)
    return (
      <div className="empty">
        <p>{HL.noPositions}</p>
      </div>
    );
  return <HlPosTable list={bal.data.positions} user={user} />;
}

/** The Portfolio page's open positions on mainnet: the same real positions, read from Hyperliquid. */
export function HlPortfolioPositions() {
  const s = useApp();
  return <PositionsBody user={s.account?.addr} onConnect={() => s.openModal({ kind: 'connect' })} onDeposit={() => s.openModal({ kind: 'hl-deposit' })} />;
}

/** The Portfolio page's perps trades on mainnet: the wallet's latest fills on Hyperliquid. */
export function HlPortfolioActivity() {
  const user = useApp((s) => s.account?.addr);
  const fills = useHlFills(user, !!user);
  if (fills.isError)
    return (
      <div className="empty">
        <p>{HL.unavailable}</p>
      </div>
    );
  return fills.data ? (
    <Fills list={fills.data} />
  ) : (
    <div className="empty" aria-busy="true">
      <p>Reading your perps trades…</p>
    </div>
  );
}

export function HlPositionsCard() {
  const s = useApp();
  const user = s.account?.addr;
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const fills = useHlFills(user, s.ptab === 'hist');
  const orders = useHlOpenOrders(user);
  const positions = bal.data?.positions ?? [];
  const onConnect = () => s.openModal({ kind: 'connect' });
  let body: React.ReactNode;
  if (s.ptab === 'pos' || !user) body = <PositionsBody user={user} onConnect={onConnect} onDeposit={() => s.openModal({ kind: 'hl-deposit' })} />;
  else if (s.ptab === 'orders') body = <Orders user={user} />;
  else if (fills.isError)
    body = (
      <div className="empty">
        <p>{HL.unavailable}</p>
      </div>
    );
  else
    body = fills.data ? (
      <Fills list={fills.data} />
    ) : (
      <div className="empty" aria-busy="true">
        <p>Reading your perps trades…</p>
      </div>
    );
  return (
    <section className="card posbox">
      <div className="ptabs" role="tablist">
        <button role="tab" aria-selected={s.ptab === 'pos'} className={s.ptab === 'pos' ? 'on' : ''} onClick={() => s.set({ ptab: 'pos' })}>
          Positions<span className="count num">{positions.length}</span>
        </button>
        <button role="tab" aria-selected={s.ptab === 'orders'} className={s.ptab === 'orders' ? 'on' : ''} onClick={() => s.set({ ptab: 'orders' })}>
          Orders<span className="count num">{orders.data?.length ?? 0}</span>
        </button>
        <button role="tab" aria-selected={s.ptab === 'hist'} className={s.ptab === 'hist' ? 'on' : ''} onClick={() => s.set({ ptab: 'hist' })}>
          Activity
        </button>
      </div>
      <div role="tabpanel">{body}</div>
    </section>
  );
}
