'use client';
import { IS_MAINNET } from '@velum/config';
import { ENV } from '@/lib/env';
import { useMarkets } from '@/lib/markets';

/** Required by the roadmap: visible whenever trades are simulated. Says so about prices too, when they are. */
export function DemoBanner() {
  const simulatedPrices = useMarkets((s) => s.source !== 'api' || Object.values(s.bySym).some((m) => m.priceSource !== 'chainlink' && m.priceSource !== 'robinhood'));
  if (!ENV.demoMode)
    return (
      <div className="demo-bar" role="note">
        <span>{IS_MAINNET ? 'Mainnet.' : 'Testnet. Test tokens have no value.'}</span>
      </div>
    );
  const what = simulatedPrices ? 'Prices and trades are simulated.' : 'Trades are simulated.';
  return (
    <div className="demo-bar" role="note">
      <span className="badge acc hide-sm">Demo mode</span>
      <span>
        <span className="show-sm">Demo mode. </span>
        {IS_MAINNET ? (
          <>
            {what} Your tokens never leave your wallet.
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
