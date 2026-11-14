import { ENV } from '@/lib/env';

/** Required by the roadmap: visible whenever trades are simulated. */
export function DemoBanner() {
  return (
    <div className="demo-bar" role="note">
      {ENV.demoMode ? (
        <>
          <span className="badge acc">Demo mode</span>
          <span>Trades are simulated. Testnet. Test tokens have no value.</span>
        </>
      ) : (
        <span>Testnet. Test tokens have no value.</span>
      )}
    </div>
  );
}
