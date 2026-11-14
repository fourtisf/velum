/**
 * Copy that depends on the network. Testnet keeps the prototype's wording verbatim; mainnet
 * says what is actually true there in Phase 2: real wallet and balances, simulated prices and
 * trades, and tokens that never leave the wallet. No Velum contract exists on mainnet, so the
 * landing page describes contract properties (no admin keys, forced exit, unshield with your own
 * wallet, proofs, relayer) as how Velum is designed to work, not as facts (audit web L13).
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

/**
 * In-app copy around simulated actions (audit round 2, M2). Testnet keeps the prototype's words,
 * which describe the testnet demo's simulated chain view. Mainnet has no Velum contract, so nothing
 * is ever on-chain there: no commitments, blocks, "visible onchain" rows or contract steps, and
 * balances are a practice account, not decrypted notes. A function of the network so tests can
 * check both; use SIM.
 */
export function simCopy(mainnet: boolean) {
  const shortTo = (to: string) => to.slice(0, 6) + '…' + to.slice(-4);
  return {
    /** Account card badge. */
    accountBadge: mainnet ? 'Simulated' : 'Encrypted',
    portfolioSub: mainnet
      ? 'Your private balance here is a simulated practice account, kept in this browser only. Your public wallet is real.'
      : 'Everything below is decrypted on this device only.',
    /** Mainnet: what the account card says instead of a commitment and block. */
    nothingOnchain: 'Nothing is on-chain: demo trades are simulated',
    /** The positions table's "Chain view" (simulated commitment and block) exists on testnet only. */
    chainView: !mainnet,
    /** A summary row about public visibility (Swap, Add liquidity): [label, value]. */
    visibleRow: (value: string): [string, string] => (mainnet ? ['Demo', 'Simulated, nothing is sent onchain'] : ['Visible onchain', value]),
    /** Flow dialog title: mainnet says up front that the action is simulated. */
    flowTitle: (title: string) => (mainnet ? `Simulated: ${title}` : title),
    /** The row every mainnet receipt ends with. */
    receiptDemoRow: ['Demo', 'Simulated, nothing was sent onchain'] as [string, string],
    moveText: (kind: 'shield' | 'unshield' | 'send') =>
      ({
        shield: mainnet
          ? 'Add tokens from your public wallet to your practice balance. Nothing is sent: your tokens stay in your wallet.'
          : 'Move tokens from your public wallet into your private balance.',
        unshield: mainnet ? 'Take tokens out of your practice balance. Nothing is sent to any address.' : 'Move tokens from your private balance back to a public address.',
        send: mainnet ? 'Try a private transfer. Nothing is sent, and the recipient gets nothing.' : 'Send to another private address. The amount and both parties stay hidden.',
      })[kind],
    /** The box under the shield / unshield / send form. */
    moveNote: (kind: 'shield' | 'unshield' | 'send') =>
      kind === 'send'
        ? mainnet
          ? 'Simulated: nothing is sent. Once Velum launches, nothing about a private transfer will be published in readable form.'
          : 'Nothing about this transfer is published in readable form.'
        : mainnet
          ? 'Simulated: nothing is sent and your wallet is not touched. Once Velum launches, this step will be public: anyone will see the wallet, token, amount and time.'
          : 'This step is public: anyone can see the wallet, token, amount and time. Vary amounts and wait between moves to make them harder to link.',
    shieldSteps: (t: string) =>
      mainnet
        ? [
            { t: `Checking your public ${t} balance`, d: 'Read only: no approval is asked of your wallet', ms: 600 },
            { t: 'Simulating the deposit', d: 'Nothing is sent onchain', ms: 800 },
            { t: 'Adding to your practice balance', d: 'Kept in this browser only', ms: 900 },
          ]
        : [
            { t: `Approving ${t}`, d: 'Lets the Velum contract receive this token', ms: 600 },
            { t: 'Sending public deposit', d: 'Visible onchain: wallet, token, amount, time', ms: 800 },
            { t: 'Adding a note to your private balance', d: 'Usually within a block or two', ms: 900 },
          ],
    unshieldLast: (to: string) =>
      mainnet
        ? { t: 'Simulating the transfer', d: `To ${shortTo(to || '0x0000000000')}. Nothing is sent onchain`, ms: 700 }
        : { t: 'Sending tokens to the public address', d: shortTo(to || '0x0000000000'), ms: 700 },
    sendLast: mainnet ? { t: 'Simulating the private transfer', d: 'Nothing is sent; the recipient gets nothing', ms: 600 } : { t: 'Creating an encrypted note for the recipient', d: 'Only they can read it', ms: 600 },
    shieldSub: mainnet ? 'Practice deposit, your tokens stay in your wallet' : 'Public deposit from your wallet',
    unshieldSub: (to: string) => (mainnet ? `Practice withdrawal to ${shortTo(to)}` : `Public transfer to ${shortTo(to)}`),
  };
}

export const SIM = simCopy(IS_MAINNET);

/** Landing page copy. Testnet: verbatim from prototype/index.html. Mainnet: same facts as design, not claims. */
const LANDING_TESTNET = {
  metaDescription: 'Velum is a private exchange for tokenized stocks. Spot and perps with balances, positions and P&L encrypted end to end.',
  lead: 'Velum is a private exchange for tokenized stocks. Spot and perps, with your balance, positions and P&L encrypted end to end.',
  statMarkets: 'Stock markets, spot and perps',
  statAdmin: 'Admin keys that can touch funds',
  statProof: 'To prove a trade in your browser',
  privateText: 'Your balance, positions and profit live in encrypted notes that only your device can read. Everyone else sees a commitment.',
  longShortText: "Post margin, pick a side, and a maker's standing offer fills you. Close on your own at any time.",
  proofsText: 'Your browser proves each trade follows the rules. The chain checks the math, never the trade.',
  freezeTitle: 'Nobody can freeze your funds',
  freezeText: 'No admin key, no pause on balances. If services go quiet, a forced exit settles your position.',
  earnText: 'Add to a pool and keep 0.30% of each trade through it. Your share stays private.',
  buildersText: 'Read markets with a plain HTTP API. Make proofs on the client with the SDK. The relayer submits them and never holds a key.',
  relayEndpoint: 'Submit a proof you already made',
  stepShield: 'Move USDG or stock tokens from your wallet into your private balance. This deposit is public.',
  stepProve: 'Pick a trade. Your browser builds a zero-knowledge proof that it follows the rules.',
  stepRelay: 'A relayer submits the proof and pays gas, so your wallet never shows up on the trade.',
  stepSettle: 'The contract checks the proof and updates your encrypted notes. Only you can read the result.',
  privacyLead: "On a public chain anyone can copy your trades or hunt your liquidation price. Here they can't.",
  faqLongShort: 'Yes. Perps let you go long or short on each stock with up to 5× leverage. A maker takes the other side, and you can close on your own at any time.',
  faqWho: 'You can. The maker on the other side sees that one position, against a one-time address. Two risk services can read what they need to liquidate. The public only sees that a position changed.',
  faqAnon: 'No. Moving tokens in and out is public. If you want deposits harder to link, vary amounts and timing and withdraw to a fresh wallet.',
  faqLoss: 'No. Each position has its own margin and losses stop there. You can lose all of it, so start small.',
  faqOffline: 'Your free balance is yours. You can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after 7 days.',
} as const;

const LANDING_MAINNET: Record<keyof typeof LANDING_TESTNET, string> = {
  metaDescription: 'Velum is a private exchange for tokenized stocks, in development. Try private spot and perps trading on live prices in a simulated demo.',
  lead: 'Velum is a private exchange for tokenized stocks, in development. Spot and perps, designed to keep your balance, positions and P&L encrypted end to end.',
  statMarkets: 'Stock markets to try, spot and perps',
  statAdmin: 'Admin keys that can touch funds, by design',
  statProof: 'Target time to prove a trade in your browser',
  privateText: 'Your balance, positions and profit will live in encrypted notes that only your device can read. Everyone else will see a commitment.',
  longShortText: "Post margin, pick a side, and a maker's standing offer will fill you. You will be able to close on your own at any time.",
  proofsText: 'Your browser will prove each trade follows the rules. The chain will check the math, never the trade.',
  freezeTitle: 'Designed so nobody can freeze your funds',
  freezeText: 'The contracts are designed with no admin key and no pause on balances. If services go quiet, a forced exit will settle your position.',
  earnText: 'Once pools launch, add to one and keep 0.30% of each trade through it. Your share will stay private.',
  buildersText: 'Read markets with a plain HTTP API today. Next, the SDK will make proofs on the client, and a relayer will submit them without ever holding a key.',
  relayEndpoint: 'Submit a proof you already made (planned)',
  stepShield: 'Move USDG or stock tokens from your wallet into your private balance. This deposit will be public.',
  stepProve: 'Pick a trade. Your browser will build a zero-knowledge proof that it follows the rules.',
  stepRelay: 'A relayer will submit the proof and pay gas, so your wallet never shows up on the trade.',
  stepSettle: 'The contract will check the proof and update your encrypted notes. Only you will be able to read the result.',
  privacyLead: "On a public chain anyone can copy your trades or hunt your liquidation price. Velum is designed so they can't.",
  faqLongShort: 'In the demo, yes. Perps will let you go long or short on each stock with up to 5× leverage. A maker will take the other side, and you will be able to close on your own at any time.',
  faqWho: 'Today, nobody: demo trades are simulated and stay in this browser. Once Velum launches, the maker on the other side will see that one position, against a one-time address. Two risk services will read what they need to liquidate. The public will only see that a position changed.',
  faqAnon: 'No. Moving tokens in and out will be public. If you want deposits harder to link, vary amounts and timing and withdraw to a fresh wallet.',
  faqLoss: 'No. Each position is designed to have its own margin, and losses stop there. You could lose all of it, so start small once real trading opens.',
  faqOffline: 'Nothing is at risk today: trades are simulated and your tokens never leave your wallet. Once Velum holds funds, it is designed so you can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after 7 days.',
};

export const LANDING: Record<keyof typeof LANDING_TESTNET, string> = IS_MAINNET ? LANDING_MAINNET : LANDING_TESTNET;
