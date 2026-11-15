/**
 * Copy that depends on the network, on what is simulated, or on a protocol number.
 *
 * Phase 2 has no Velum contract on either network: wallets and public balances are real, every
 * trade and every privacy feature (notes, proofs, relayer, encryption) is simulated in the browser.
 * So privacy and contract properties are described as how Velum is designed to work, on testnet
 * and mainnet alike (audit web L13, owner decision of 2026-11-15). Robinhood Chain brand rules: say
 * "Stock Tokens" in full (never the "tokenized" wording), and name a price source only when it is real.
 * Protocol numbers (fees, leverage, delays) come from PROTOCOL so the copy cannot drift (RC-02).
 */
import { CHAIN, IS_MAINNET, PROTOCOL } from '@velum/config';
import { bpsPct } from './format';

/**
 * Protocol metrics (open interest, funding, pool sizes, APR, shielded value, proofs) only exist where
 * Velum contracts run. On mainnet there are none yet, so those show a dash instead of demo numbers.
 */
export const METRICS = { real: !IS_MAINNET, dash: '—' } as const;

/**
 * Whether a metric that is shown is demo data, and so carries a "Demo" label (DV-03): always on
 * testnet (Phase 2 has no real protocol data there), and wherever the API flags it `demo: true`.
 */
export const isDemoMetric = (flag?: boolean, mainnet = IS_MAINNET): boolean => !mainnet || flag === true;

/** §5 numbers as copy (CLAUDE.md section 5; values in @velum/config PROTOCOL). */
export const P = {
  poolFee: bpsPct(PROTOCOL.spotPoolFeeBps),
  maxLev: `${PROTOCOL.maxLeverage}×`,
  exitDays: PROTOCOL.forcedExitDelayDays,
  penalty: bpsPct(PROTOCOL.liquidationPenaltyBps, 0),
  fillMinutes: PROTOCOL.makerFillWindowMinutes,
} as const;

/** Where the prices on screen come from right now (lib/markets.ts priceOrigin). */
export type PriceOrigin = 'robinhood' | 'chainlink' | 'demo' | 'loading' | 'none';

/** One sentence naming the price source, only when it is the real one (audit web F2). */
export function priceSourceText(origin: PriceOrigin, mainnet = IS_MAINNET): string {
  switch (origin) {
    case 'robinhood':
      return "Prices from Robinhood's public Stock Token API.";
    case 'chainlink':
      return 'Prices from Chainlink price feeds.';
    case 'loading':
      return 'Loading prices…';
    case 'demo':
      return mainnet ? 'Live prices are unavailable right now.' : 'Prices are demo data on testnet.';
    case 'none':
      return mainnet ? 'Live prices are unavailable right now.' : 'Prices are unavailable right now.';
  }
}

/** A market the API reports closed (staleReason marketClosed): last price shown, marked, not tradable on mainnet. */
export const CLOSED = {
  label: 'Market closed',
  tag: 'closed',
  title: 'Market closed: the last price is shown and trading is paused until it opens',
  hint: 'The stock market is closed. Trading resumes when it opens.',
} as const;

export const COPY = {
  chainLabel: CHAIN.label,
  heroBadge: IS_MAINNET ? 'Demo' : 'Testnet',
  heroPill: IS_MAINNET ? 'Private trading demo on Robinhood Chain' : 'Simulated private perps on Robinhood Chain',
  /** The line under the landing terminal; testnet always carries the test-token notice (F11). */
  frameCap: (origin: PriceOrigin, connected: boolean, mainnet = IS_MAINNET): string =>
    mainnet
      ? `${priceSourceText(origin, true)} ${connected ? 'Demo mode: trades and your practice balance are simulated, and your tokens never leave your wallet.' : 'Connect your wallet to try a simulated private trade.'}`
      : `${origin === 'demo' || origin === 'loading' ? 'Live demo with test prices.' : priceSourceText(origin, false)} Connect a test wallet to try a simulated private trade. Testnet. Test tokens have no value.`,
  faqMoney: IS_MAINNET
    ? 'Not yet. Velum connects to Robinhood Chain so you can see your real balances, but every trade here is simulated and your tokens never leave your wallet. Real trading starts only after an external audit.'
    : 'No. Velum runs on Robinhood Chain testnet. Test tokens have no value, so you can learn how private trading works without risk.',
  ctaSub: IS_MAINNET
    ? 'Connect your wallet and try a simulated private trade in under a minute.'
    : 'Get free test USDG from the faucet and make your first simulated private trade in under a minute.',
  footer: IS_MAINNET
    ? 'An independent project on Robinhood Chain, not affiliated with Robinhood. Prices are live; trades are simulated and your tokens never leave your wallet. No contracts are deployed or audited yet.'
    : 'An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet with simulated trading. Test tokens have no value.',
  /** Required on every page (CLAUDE.md §1.7); the /app layout shows it as a small line (F11). */
  brand: 'An independent project on Robinhood Chain, not affiliated with Robinhood.',
  marketsSub: (origin: PriceOrigin, mainnet = IS_MAINNET): string =>
    mainnet
      ? `${priceSourceText(origin, true)} Trading here is simulated until contracts launch.`
      : `${priceSourceText(origin, false)} Trading here is simulated.`,
  networkNotice: IS_MAINNET ? '' : ' Test tokens have no value.',
  notOnNetwork: (sym: string) => `${sym} isn't on ${CHAIN.label} yet.`,
  switchTo: `Switch to ${CHAIN.label}`,
} as const;

/**
 * Words in the app around the private account and the simulated privacy layer. No keys exist in
 * Phase 2: the signature only derives a demo private address in the browser (lib/account.ts; the
 * signed message itself is unchanged so existing users keep their address).
 */
export const UI = {
  connectIntro: 'Your wallet is your public address. Next, one signature opens your demo private account.',
  signIntro: 'Sign one message to open your demo private account: this browser turns the signature into a demo private address. It costs no gas and sends nothing to a server. The same wallet opens the same account on any device.',
  signDeriving: 'Opening your demo account…',
  accountNote:
    'Nothing onchain links these two addresses. The private one is a demo address made in this browser from your signature. Disconnecting forgets it here (your practice balance stays saved in this browser); signing again opens the same one.',
  portfolioConnect: 'One signature opens your demo private account in this browser. It costs no gas, and the same wallet opens the same account on any device.',
  acctConnect: 'Connect a wallet and sign once to open a simulated private balance. It costs no gas.',
  perpsNote: `In the full version, size, side and entry stay encrypted, and if no maker fills you within ${P.fillMinutes} minutes your margin comes back.`,
  spotNote: 'In the full version, pool reserves and your trade stay private. You own the token, so nothing can be liquidated.',
  swapNote: 'In the full version, pool reserves are private, so nobody can work out your trade from public data.',
  swapSub: 'Trade USDG and Stock Tokens through private pools, simulated in this demo. Stock to stock routes through USDG in one action.',
  earnSub: `Add to a private pool (simulated in this demo) and earn ${P.poolFee} of every swap through it. Public pool sizes will be rounded and published hourly.`,
  earnNote: `In the full version, hourly totals only appear when an hour has at least ${PROTOCOL.publicAggregate.minFills} fills from at least ${PROTOCOL.publicAggregate.minMakers} makers, rounded to ${PROTOCOL.publicAggregate.sigFigs === 2 ? 'two' : PROTOCOL.publicAggregate.sigFigs} significant figures, so no single trade stands out.`,
  makersSeeTitle: 'What others will see about you',
} as const;

/**
 * In-app copy around simulated actions (audit round 2, M2; owner decision of 2026-11-15). Nothing is
 * on-chain on either network in Phase 2, so flows say they are simulated, name the real step only as
 * what the full version will do, and receipts end by saying nothing was sent. Testnet keeps its
 * simulated chain view, labelled as simulated. A function of the network so tests can check both.
 */
export function simCopy(mainnet: boolean) {
  const shortTo = (to: string) => to.slice(0, 6) + '…' + to.slice(-4);
  return {
    /** Account card badge. */
    accountBadge: 'Simulated',
    portfolioSub: 'Your private balance here is a simulated practice account, kept in this browser only. Your public wallet is real.',
    /** Mainnet: what the account card says instead of a commitment and block. */
    nothingOnchain: 'Nothing is on-chain: demo trades are simulated',
    /** The positions table's "Chain view" (simulated commitment and block) exists on testnet only. */
    chainView: !mainnet,
    /** Testnet's simulated chain view, account card and position rows. */
    chainLastLabel: 'Last simulated chain event',
    chainSeesLabel: 'Simulated chain view',
    /** A summary row about public visibility (Swap, Add liquidity): [label, value]. */
    visibleRow: (_value: string): [string, string] => ['Demo', 'Simulated, nothing is sent onchain'],
    /** Flow dialog title: says up front that the action is simulated. */
    flowTitle: (title: string) => `Simulated: ${title}`,
    /** The row every receipt ends with. */
    receiptDemoRow: ['Demo', 'Simulated, nothing was sent onchain'] as [string, string],
    /** Flow steps for the parts of the privacy layer that do not exist yet. */
    step: {
      lock: (what: string, d: string) => ({ t: `Setting aside ${what}`, d: `${d} (simulated private note)` }),
      proof: (d: string) => ({ t: 'Simulating the proof', d: `In the full version, your browser makes a proof that ${d}` }),
      relay: (d = 'submits the proof and pays gas') => ({ t: 'Simulating the relayer', d: `In the full version, a relayer ${d}` }),
    },
    moveText: (kind: 'shield' | 'unshield' | 'send') =>
      ({
        shield: 'Add tokens from your public wallet to your practice balance. Nothing is sent: your tokens stay in your wallet.',
        unshield: 'Take tokens out of your practice balance. Nothing is sent to any address.',
        send: 'Try a private transfer. Nothing is sent, and the recipient gets nothing.',
      })[kind],
    /** The box under the shield / unshield / send form. */
    moveNote: (kind: 'shield' | 'unshield' | 'send') =>
      kind === 'send'
        ? 'Simulated: nothing is sent. Once Velum launches, nothing about a private transfer will be published in readable form.'
        : 'Simulated: nothing is sent and your wallet is not touched. Once Velum launches, this step will be public: anyone will see the wallet, token, amount and time.',
    shieldSteps: (t: string) => [
      { t: `Checking your public ${t} balance`, d: 'Read only: no approval is asked of your wallet', ms: 600 },
      { t: 'Simulating the deposit', d: 'Nothing is sent onchain', ms: 800 },
      { t: 'Adding to your practice balance', d: 'Kept in this browser only', ms: 900 },
    ],
    unshieldLast: (to: string) => ({ t: 'Simulating the transfer', d: `To ${shortTo(to || '0x0000000000')}. Nothing is sent onchain`, ms: 700 }),
    sendLast: { t: 'Simulating the private transfer', d: 'Nothing is sent; the recipient gets nothing', ms: 600 },
    shieldSub: 'Practice deposit, your tokens stay in your wallet',
    unshieldSub: (to: string) => `Practice withdrawal to ${shortTo(to)}`,
  };
}

export const SIM = simCopy(IS_MAINNET);

/** Landing page copy: the prototype's layout and words, with privacy and contract claims as design. */
export const LANDING = {
  metaDescription: IS_MAINNET
    ? 'Velum is a private exchange for Stock Tokens, in development. Try private spot and perps trading on live prices in a simulated demo.'
    : 'Velum is a private exchange for Stock Tokens, in development. Try private spot and perps trading in a simulated demo on Robinhood Chain testnet.',
  lead: 'Velum is a private exchange for Stock Tokens, in development. Spot and perps, designed to keep your balance, positions and P&L encrypted end to end.',
  statMarkets: IS_MAINNET ? 'Stock markets to try, spot and perps' : 'Stock markets, spot and perps',
  statLev: 'Max leverage, long or short',
  statAdmin: 'Admin keys that can touch funds, by design',
  statProof: 'Target time to prove a trade in your browser',
  privateText: 'Your balance, positions and profit will live in encrypted notes that only your device can read. Everyone else will see a commitment.',
  longShortTitle: `Long or short, up to ${P.maxLev}`,
  longShortText: "Post margin, pick a side, and a maker's standing offer will fill you. You will be able to close on your own at any time.",
  proofsText: 'Your browser will prove each trade follows the rules. The chain will check the math, never the trade.',
  /** The mini steps in the proofs card: the proof time is a target, not a measurement. */
  stepsMini: [
    ['Lock margin in a private note', ''],
    ['Generate proof in your browser', 'target ~2s'],
    ['Relayer submits and pays gas', ''],
  ] as Array<[string, string]>,
  freezeTitle: 'Designed so nobody can freeze your funds',
  freezeText: 'The contracts are designed with no admin key and no pause on balances. If services go quiet, a forced exit will settle your position.',
  exitBig: `${P.exitDays}d`,
  earnText: `Once pools launch, add to one and keep ${P.poolFee} of each trade through it. Your share will stay private.`,
  poolBadge: (apr: string | null) => (apr === null ? `${P.poolFee} fee` : `${apr}% est. APR (demo)`),
  buildersText: 'Read markets with a plain HTTP API today. Next, the SDK will make proofs on the client, and a relayer will submit them without ever holding a key.',
  relayEndpoint: 'Submit a proof you already made (planned)',
  stepShield: 'Move USDG or Stock Tokens from your wallet into your private balance. This deposit will be public.',
  stepProve: 'Pick a trade. Your browser will build a zero-knowledge proof that it follows the rules.',
  stepRelay: 'A relayer will submit the proof and pay gas, so your wallet never shows up on the trade.',
  stepSettle: 'The contract will check the proof and update your encrypted notes. Only you will be able to read the result.',
  privacyLead: "On a public chain anyone can copy your trades or hunt your liquidation price. Velum is designed so they can't.",
  faqLongShort: `In the demo, yes. Perps will let you go long or short on each stock with up to ${P.maxLev} leverage. A maker will take the other side, and you will be able to close on your own at any time.`,
  faqWho: 'Today, nobody: demo trades are simulated and stay in this browser. Once Velum launches, the maker on the other side will see that one position, against a one-time address. Two risk services will read what they need to liquidate. The public will only see that a position changed.',
  faqAnon: 'No. Moving tokens in and out will be public. If you want deposits harder to link, vary amounts and timing and withdraw to a fresh wallet.',
  faqLoss: 'No. Each position is designed to have its own margin, and losses stop there. You could lose all of it, so start small once real trading opens.',
  faqOffline: `Nothing is at risk today: trades are simulated and your tokens never leave your wallet. Once Velum holds funds, it is designed so you can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after ${P.exitDays} days.`,
} as const;
