'use client';
import { IS_MAINNET } from '@velum/config';
import { ONCHAIN, UNI } from '@/lib/copy';
import { UNISWAP } from '@velum/config/src/uniswap';
import { ENV } from '@/lib/env';
import { useMarkets } from '@/lib/markets';
import { useOnchain } from '@/lib/onchain/deployment';
import { GuardBannerBadge } from './onchain/lazy';

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/**
 * Required by the roadmap: visible whenever trades are simulated. On mainnet, where Spot trades for real through
 * Uniswap (lib/uniswap), it says which trades are real and which are simulated. Testnet keeps the prototype's words,
 * with "Testnet. Test tokens have no value." in full at every width (CLAUDE.md §1.4).
 * Mainnet never simulates prices (no local fallback): when the live feed is stale it says trading is
 * paused instead (audit round 2, M4).
 */
export function DemoBanner() {
  const feedStale = useMarkets((s) => s.feedStale);
  const lastOkAt = useMarkets((s) => s.lastOkAt);
  const oc = useOnchain();
  // A real build (a Phase 3 deployment compiled in): never the demo, from the first paint (web audit W3-02).
  // Real transactions once the API confirms the deployment; until then why new trades are paused.
  if (oc)
    return (
      <div className="demo-bar" role="note">
        <span className="badge acc hide-sm">{ONCHAIN.bannerBadge}</span>
        <GuardBannerBadge oc={oc} />
        {oc.verified ? (
          <span aria-live="polite">{ONCHAIN.banner}</span>
        ) : (
          <span aria-live="polite" className={oc.status === 'checking' ? undefined : 'stale-msg'}>
            {ONCHAIN.verifyBanner(oc.status === 'on' ? 'checking' : oc.status, oc.mismatch)}
          </span>
        )}
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
      <span className="badge acc hide-sm">{UNISWAP ? UNI.badge : 'Demo mode'}</span>
      <span aria-live="polite">
        {UNISWAP ? null : <span className="show-sm">Demo mode. </span>}
        {IS_MAINNET ? (
          <>
            {feedStale ? (
              <b className="stale-msg">
                Live prices are unavailable{lastOkAt ? ` since ${hhmm(lastOkAt)}` : ''}, so trading is paused.{' '}
              </b>
            ) : null}
            {UNISWAP ? UNI.banner : 'Trades are simulated. Your tokens never leave your wallet.'}
          </>
        ) : (
          // The full notice at every width, 360 px included (audit web F11).
          <>Trades are simulated. Testnet. Test tokens have no value.</>
        )}
      </span>
    </div>
  );
}
