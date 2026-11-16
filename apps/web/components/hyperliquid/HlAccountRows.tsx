'use client';
/** The perps lines of the mainnet account card: the user's USDC on Hyperliquid and open positions (lib/hyperliquid). */
import { ACCT } from '@/lib/copy';
import { fmt } from '@/lib/format';
import { useHlBalances, useHlMode } from '@/lib/hyperliquid/client';
import { useApp } from '@/lib/store';

export function HlAccountRows() {
  const user = useApp((s) => s.account?.addr);
  const mode = useHlMode(user);
  const bal = useHlBalances(user, mode.data);
  const d = bal.data;
  const value = mode.isError || bal.isError ? '—' : !d ? '…' : d.funded ? `${fmt(Math.floor((d.xyzAvailable + d.mainAvailable) * 100) / 100)} USDC` : ACCT.noDeposit;
  return (
    <>
      <div className="r">
        <span>{ACCT.perps}</span>
        <b className="num pv">{value}</b>
      </div>
      {d && d.positions.length ? (
        <div className="r">
          <span>Open positions</span>
          <b className="num">{d.positions.length}</b>
        </div>
      ) : null}
    </>
  );
}
