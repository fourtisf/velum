'use client';
import { IS_MAINNET } from '@velum/config';
import { ENV } from '@/lib/env';
import { useMarkets } from '@/lib/markets';

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/**
 * Required by the roadmap: visible whenever trades are simulated. Testnet keeps the prototype's words.
 * Mainnet never simulates prices (no local fallback): when the live feed is stale it says trading is
 * paused instead (audit round 2, M4).
 */
export function DemoBanner() {
  const feedStale = useMarkets((s) => s.feedStale);
  const lastOkAt = useMarkets((s) => s.lastOkAt);
  if (!ENV.demoMode)
    return (
      <div className="demo-bar" role="note">
        <span>{IS_MAINNET ? 'Mainnet.' : 'Testnet. Test tokens have no value.'}</span>
      </div>
    );
  return (
    <div className="demo-bar" role="note">
      <span className="badge acc hide-sm">Demo mode</span>
      <span aria-live="polite">
        <span className="show-sm">Demo mode. </span>
        {IS_MAINNET ? (
          <>
            {feedStale ? (
              <b className="stale-msg">
                Live prices are unavailable{lastOkAt ? ` since ${hhmm(lastOkAt)}` : ''}, so trading is paused.{' '}
              </b>
            ) : null}
            Trades are simulated. Your tokens never leave your wallet.
          </>
        ) : (
          <>
            Trades are simulated.<span className="hide-sm"> Testnet.</span> Test tokens have no value.
          </>
        )}
      </span>
    </div>
  );
}
