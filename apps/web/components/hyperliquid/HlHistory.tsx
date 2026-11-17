'use client';
/**
 * The Portfolio's perps results: realized P&L, fees, funding and net over the fills shown (the latest 2000) and the last
 * 90 days of funding, with an Export CSV of every trade and funding payment (lib/hyperliquid/history.ts).
 */
import { HL } from '@/lib/copy';
import { usd } from '@/lib/format';
import { useHlFills } from '@/lib/hyperliquid/client';
import { HISTORY_DAYS, download, historyCsv, historySummary, useHlFunding } from '@/lib/hyperliquid/history';
import { useApp } from '@/lib/store';

const signed = (v: number) => (v > 0 ? `+${usd(v)}` : usd(v));
const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export function HlHistory() {
  const user = useApp((s) => s.account?.addr);
  const fills = useHlFills(user, !!user);
  const funding = useHlFunding(user, !!user);
  if (!user) return null;
  if (fills.isError || funding.isError)
    return (
      <div className="empty">
        <p>{HL.unavailable}</p>
      </div>
    );
  if (!fills.data || !funding.data)
    return (
      <div className="empty" aria-busy="true">
        <p>Reading your perps history…</p>
      </div>
    );
  const sum = historySummary(fills.data, funding.data);
  const empty = !fills.data.length && !funding.data.length;
  const save = () => download(`velum-perps-history-${new Date().toISOString().slice(0, 10)}.csv`, historyCsv(fills.data!, funding.data!));
  return (
    <div className="hl-history">
      <div className="hl-stats">
        <div>
          <span>Realized P&amp;L</span>
          <b className={tone(sum.realized)}>{signed(sum.realized)}</b>
        </div>
        <div>
          <span>Fees paid</span>
          <b>{usd(sum.fees)}</b>
        </div>
        <div>
          <span>Funding</span>
          <b className={tone(sum.funding)}>{signed(sum.funding)}</b>
        </div>
        <div>
          <span>Net</span>
          <b className={tone(sum.net)}>{signed(sum.net)}</b>
        </div>
      </div>
      <div className="hl-history-foot">
        <small className="faint">
          {sum.trades} trades · {usd(sum.volume)} volume · funding over the last {HISTORY_DAYS} days
        </small>
        <button className="btn btn-dark btn-sm" disabled={empty} onClick={save}>
          Export CSV
        </button>
      </div>
    </div>
  );
}
