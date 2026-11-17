'use client';
import { DEMO } from '@velum/config';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { compact, fmt, usd } from '@/lib/format';
import { PERP_VENUES, apiMetric, useMarkets, usePriceOrigin } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { useApp } from '@/lib/store';
import { COPY, METRICS, ONCHAIN, refTitle } from '@/lib/copy';
import { I } from '../icons';
import { Av, Chg, ComingSoon, DemoTag, Px, RefTag, Spark } from '../ui';

export function MarketsView() {
  const order = useMarkets((s) => s.order);
  const bySym = useMarkets((s) => s.bySym);
  const q = useApp((s) => s.q);
  const set = useApp((s) => s.set);
  const router = useRouter();
  const origin = usePriceOrigin();
  const oc = useOnchain();
  const stats = useQuery({ queryKey: ['stats'], queryFn: ({ signal }) => api.stats(signal), refetchInterval: 30_000, retry: 1 });
  const oi = order.reduce((a, s) => a + (bySym[s]!.oi ?? 0), 0);
  // Mainnet: some market's funding and open interest come from its perp on another venue (Hyperliquid or Lighter).
  const anyRef = !METRICS.real && order.some((s) => bySym[s]!.ref !== null);
  // Mainnet: the listed markets' open interest on that venue (the table's column, summed).
  const refOi = order.reduce((a, s) => a + (bySym[s]!.ref ? (bySym[s]!.oi ?? 0) : 0), 0);
  const needle = q.toLowerCase().trim();
  const match = (s: string) => !needle || (s + ' ' + bySym[s]!.name).toLowerCase().includes(needle);

  return (
    <>
      <div className="vhead">
        <div>
          <h1 className="vtitle">Markets</h1>
          <p className="vsub">{oc ? ONCHAIN.marketsSub(origin) : COPY.marketsSub(origin)}</p>
        </div>
        <label className="search">
          <I.search />
          <span className="sr">Search markets</span>
          <input
            id="mk-q"
            placeholder="Search stocks"
            autoComplete="off"
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !needle) return;
              const first = order.find(match);
              if (first) {
                set({ q: '' });
                router.push(`/app/trade/${first}`);
              }
            }}
          />
        </label>
      </div>
      <div className="stats">
        <div className="card stat">
          <small>Markets</small>
          <b className="num">{stats.data?.markets ?? order.length}</b>
        </div>
        <div className="card stat">
          <small>Open interest</small>
          <b className="num">
            {METRICS.real ? compact(apiMetric(stats.data?.openInterest) ?? oi) : anyRef ? compact(refOi) : METRICS.dash}
            {METRICS.real ? <DemoTag flag={stats.data?.demo} /> : anyRef ? <RefTag venue={PERP_VENUES.lighter} /> : null}
          </b>
        </div>
        <div className="card stat">
          <small>Shielded value</small>
          <b className="num">
            {METRICS.real ? compact(Number(stats.data?.shieldedValue ?? DEMO.shieldedValue)) : METRICS.dash}
            {METRICS.real ? <DemoTag flag={stats.data?.demo} /> : null}
          </b>
        </div>
        <div className="card stat">
          <small>Proofs verified today</small>
          <b className="num">
            {METRICS.real ? fmt(stats.data?.proofsToday ?? DEMO.proofsTodayBase, 0) : METRICS.dash}
            {METRICS.real ? <DemoTag flag={stats.data?.demo} /> : null}
          </b>
        </div>
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Market</th>
              <th className="r">Price</th>
              <th className="r">24h</th>
              <th className="hide-md">Last hour</th>
              <th className="r hide-md">
                Funding / h{METRICS.real ? <DemoTag /> : anyRef ? <RefTag venue={PERP_VENUES.lighter} /> : null}
              </th>
              <th className="r hide-md">
                Open interest{METRICS.real ? <DemoTag /> : anyRef ? <RefTag venue={PERP_VENUES.lighter} /> : null}
              </th>
              <th className="r hide-sm">Max leverage</th>
              <th className="r">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {order.map((s) => {
              const m = bySym[s]!;
              return (
                <tr
                  key={s}
                  hidden={!match(s)}
                  className={m.status === 'live' ? 'rowlink' : undefined}
                  // Picking a market opens it (owner request): anywhere on the row but its buttons.
                  onClick={m.status === 'live' ? (e) => !(e.target as HTMLElement).closest('a,button') && router.push(`/app/trade/${s}`) : undefined}
                >
                  <td>
                    <div className="mcell">
                      <Av sym={s} />
                      <div>
                        {m.status === 'live' ? (
                          <Link href={`/app/trade/${s}`} className="rowname">
                            <b>{s}</b>
                          </Link>
                        ) : (
                          <b>{s}</b>
                        )}
                        <small>{m.name}</small>
                      </div>
                    </div>
                  </td>
                  <Px sym={s} as="td" className="r num" />
                  <Chg sym={s} as="td" className="r num" />
                  <td className="hide-md">
                    <Spark sym={s} />
                  </td>
                  <td className="r num hide-md" title={!METRICS.real && m.ref ? refTitle(PERP_VENUES[m.ref], s) : undefined}>
                    {(METRICS.real || m.ref) && m.funding !== null ? `${fmt(m.funding, 4)}%` : METRICS.dash}
                  </td>
                  <td className="r num hide-md" title={!METRICS.real && m.ref ? refTitle(PERP_VENUES[m.ref], s) : undefined}>
                    {(METRICS.real || m.ref) && m.oi !== null ? usd(m.oi, 0) : METRICS.dash}
                  </td>
                  <td className="r num hide-sm">{m.maxLev}×</td>
                  <td className="r">
                    {m.status === 'live' ? (
                      <div className="rowbtns">
                        <Link className="btn btn-white btn-sm" href={`/app/trade/${s}?mode=spot`}>
                          Buy
                        </Link>
                        <Link className="btn btn-dark btn-sm" href={`/app/trade/${s}?mode=perps`}>
                          Long or short
                        </Link>
                      </div>
                    ) : (
                      <ComingSoon />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
