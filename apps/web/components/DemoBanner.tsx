'use client';
import { IS_MAINNET } from '@velum/config';
import { ONCHAIN } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { useMarkets } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { GuardBannerBadge } from './onchain/lazy';

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/**
 * Required by the roadmap: visible whenever trades are simulated. Testnet keeps the prototype's words,
 * with "Testnet. Test tokens have no value." in full at every width (CLAUDE.md §1.4).
 * Mainnet never simulates prices (no local fallback): when the live feed is stale it says trading is
 * paused instead (audit round 2, M4).
 */
export function DemoBanner() {
  const feedStale = useMarkets((s) => s.feedStale);
  const lastOkAt = useMarkets((s) => s.lastOkAt);
  const oc = useOnchain();
  // Real transactions (a live Phase 3 deployment): say so, with the testnet notice in full on testnet.
  if (oc)
    return (
      <div className="demo-bar" role="note">
        <span className="badge acc hide-sm">{ONCHAIN.bannerBadge}</span>
        <GuardBannerBadge oc={oc} />
        <span aria-live="polite">{ONCHAIN.banner}</span>
      </div>
    );
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
          // The full notice at every width, 360 px included (audit web F11).
          <>Trades are simulated. Testnet. Test tokens have no value.</>
        )}
      </span>
    </div>
  );
}
