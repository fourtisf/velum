import { ENV } from '@/lib/env';

/** Required by the roadmap: visible whenever trades are simulated. */
export function DemoBanner() {
  return (
    <div className="demo-bar" role="note">
      {ENV.demoMode ? (
        <>
          <span className="badge acc hide-sm">Demo mode</span>
          <span>
            <span className="show-sm">Demo mode. </span>Trades are simulated.<span className="hide-sm"> Testnet.</span> Test tokens have no value.
          </span>
        </>
      ) : (
        <span>Testnet. Test tokens have no value.</span>
      )}
    </div>
  );
}
