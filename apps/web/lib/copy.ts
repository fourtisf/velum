/**
 * Copy that depends on the network. Testnet keeps the prototype's wording verbatim; mainnet
 * says what is actually true there in Phase 2: real wallet and balances, simulated prices and
 * trades, and tokens that never leave the wallet.
 */
import { CHAIN, IS_MAINNET } from '@velum/config';

/**
 * Protocol metrics (open interest, funding, pool sizes, APR, shielded value, proofs) only exist where
 * Velum contracts run. On mainnet there are none yet, so those show a dash instead of demo numbers.
 */
export const METRICS = { real: !IS_MAINNET, dash: '—' } as const;

export const COPY = {
  chainLabel: CHAIN.label,
  heroBadge: IS_MAINNET ? 'Demo' : 'Testnet',
  heroPill: IS_MAINNET ? 'Private trading demo on Robinhood Chain' : 'Private perps are live on Robinhood Chain',
  frameCap: IS_MAINNET
    ? 'Live Robinhood Chain prices. Connect your wallet to try a simulated private trade.'
    : 'Live demo with test prices. Connect a test wallet to place a private trade.',
  faqMoney: IS_MAINNET
    ? 'Not yet. Velum connects to Robinhood Chain so you can see your real balances, but every trade here is simulated and your tokens never leave your wallet. Real trading starts only after an external audit.'
    : 'No. Velum runs on Robinhood Chain testnet. Test tokens have no value, so you can learn how private trading works without risk.',
  ctaSub: IS_MAINNET
    ? 'Connect your wallet and try a simulated private trade in under a minute.'
    : 'Get free test USDG from the faucet and make your first private trade in under a minute.',
  footer: IS_MAINNET
    ? 'An independent project on Robinhood Chain, not affiliated with Robinhood. Prices are live; trades are simulated and your tokens never leave your wallet. No contracts are deployed or audited yet.'
    : 'An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet with simulated trading. Test tokens have no value.',
  marketsSub: IS_MAINNET ? 'Live prices from Robinhood. Trading here is simulated until contracts launch.' : 'Every market settles privately. Prices are demo data on testnet.',
  networkNotice: IS_MAINNET ? '' : ' Test tokens have no value.',
  notOnNetwork: (sym: string) => `${sym} isn't on ${CHAIN.label} yet.`,
  switchTo: `Switch to ${CHAIN.label}`,
} as const;
