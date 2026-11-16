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
import { HL_MAX_LEVERAGE } from '@velum/config/src/hyperliquid';
import { ENV } from './env';
import { bpsPct } from './format';
import { HL_PERPS } from './hyperliquid/enabled';

/**
 * Protocol metrics (open interest, funding, pool sizes, APR, shielded value, proofs) only exist where
 * Velum contracts run. On mainnet there are none yet, so those show a dash instead of demo numbers.
 */
export const METRICS = { real: !IS_MAINNET, dash: '—' } as const;

/** The tooltip of a perps metric that comes from another venue's market (mainnet, lib/markets.ts `ref`). */
export const refTitle = (venue: string, sym?: string, hl = HL_PERPS): string =>
  venue === 'Hyperliquid'
    ? `${sym ? `${sym} perp` : "Each market's perp"} on Hyperliquid's XYZ stock market: live mark, funding and open interest.${hl ? " The Perps ticket trades this market for real from your own Hyperliquid account." : ''}`
    : `${sym ? `${sym} perp` : "Each market's perp"} on ${venue}, the perps venue of Robinhood Chain: live mark, funding and open interest, shown as a market reference until Velum's own perps are live.`;

/**
 * Whether a metric that is shown is demo data, and so carries a "Demo" label (DV-03): always on
 * testnet (Phase 2 has no real protocol data there), and wherever the API flags it `demo: true`.
 */
export const isDemoMetric = (flag?: boolean, mainnet = IS_MAINNET): boolean => !mainnet || flag === true;

/** Velum's social profiles: the one place their URLs and handles live (footer, /app brand line, link metadata). */
export const SOCIAL = {
  /** Velum on X (owner-provided; corrected to @velumtrade on 2026-11-16). */
  x: 'https://x.com/velumtrade',
  xHandle: '@velumtrade',
  xLabel: 'Velum on X',
} as const;

/** §5 numbers as copy (CLAUDE.md section 5; values in @velum/config PROTOCOL). */
export const P = {
  poolFee: bpsPct(PROTOCOL.spotPoolFeeBps),
  maxLev: `${PROTOCOL.maxLeverage}×`,
  exitDays: PROTOCOL.forcedExitDelayDays,
  penalty: bpsPct(PROTOCOL.liquidationPenaltyBps, 0),
  fillMinutes: PROTOCOL.makerFillWindowMinutes,
} as const;

/**
 * Where the prices on screen come from right now (lib/markets.ts priceOrigin). 'closed': a real source,
 * but every market is closed, so the prices are the last quotes (mainnet).
 */
export type PriceOrigin = 'uniswap' | 'robinhood' | 'chainlink' | 'closed' | 'demo' | 'loading' | 'none';

/**
 * One sentence naming the price source, only when it is the real one (audit web F2), and saying when
 * prices are not live (final audit W-07): markets closed, or the feed down ('none' replaces 'loading'
 * after repeated failures).
 */
export function priceSourceText(origin: PriceOrigin, mainnet = IS_MAINNET): string {
  switch (origin) {
    case 'uniswap':
      return 'Live onchain prices from Uniswap on Robinhood Chain, 24/7.';
    case 'robinhood':
      return "Prices from Robinhood's public Stock Token API.";
    case 'chainlink':
      return 'Prices from Chainlink price feeds.';
    case 'closed':
      return 'The stock market is closed: prices shown are the last quotes.';
    case 'loading':
      return 'Loading prices…';
    case 'demo':
      return mainnet ? 'Live prices are unavailable right now.' : 'Prices are demo data on testnet.';
    case 'none':
      return mainnet ? 'Live prices are unavailable right now.' : 'Prices are unavailable right now.';
  }
}

/** A market the API reports closed (staleReason marketClosed): last price shown, marked, not tradable on mainnet. */
/**
 * Real spot trading through Uniswap on Robinhood Chain mainnet (lib/uniswap): what the ticket, the swap page and the
 * banner say. Plain about what is real (spot swaps from the wallet, public onchain) and what is still simulated (perps,
 * the private account, privacy).
 */
export const UNI = {
  spotNote: 'A real trade from your wallet through Uniswap on Robinhood Chain. Public onchain, not private. Velum adds no fee, and you own the token, so nothing can be liquidated.',
  swapSub: 'Trade USDG and Stock Tokens through Uniswap on Robinhood Chain, straight from your wallet. Stock to stock routes through USDG in two swaps.',
  swapNote: 'Public onchain. The minimum protects you: if the price moves past it, the swap is refused and nothing is traded.',
  banner: HL_PERPS
    ? 'Spot trades are real Uniswap swaps from your wallet. Perps are real trades from your own Hyperliquid account. The private account is simulated.'
    : 'Spot trades are real Uniswap swaps from your wallet. Perps and the private account are simulated.',
  badge: 'Live spot',
  gasHint: 'You need a little ETH on Robinhood Chain to pay the gas.',
  noPools: (sym: string) => `${sym} has no curated Uniswap pool yet.`,
  noLiquidity: 'The Uniswap pools cannot fill this amount right now. Try a smaller amount.',
} as const;

/**
 * Real perps through the user's own Hyperliquid account (mainnet, lib/hyperliquid): what the Perps ticket and the
 * positions card say. Plain that it is real money, public on Hyperliquid, leveraged and liquidatable.
 */
export const HL = {
  perpsNote: 'A real leveraged trade from your own Hyperliquid account on its XYZ stock perps, isolated margin. Public on Hyperliquid, not private. Velum never holds your funds. Funding is paid hourly and a position can be liquidated.',
  unavailable: 'Hyperliquid cannot be reached right now. Try again in a moment.',
  noMarket: (sym: string) => `${sym} has no stock perp on Hyperliquid's XYZ market right now.`,
  depositHint: 'Fund your Hyperliquid account from here: deposit USDC from your wallet on Arbitrum (at least 5 USDC).',
  crossHint: (sym: string) => `You hold a cross-margin ${sym} position on Hyperliquid. Manage it on Hyperliquid: Velum trades isolated margin only.`,
  levLocked: (sym: string, lev: number) => `Adding to your ${sym} position keeps its ${lev}× leverage.`,
  levHint: (sym: string, lev: number) => `Your ${sym} position uses ${lev}× leverage, above Velum's ${HL_MAX_LEVERAGE}× limit. Add to it on Hyperliquid.`,
  notEnough: (amount: string) => `You have ${amount} USDC available on Hyperliquid. Deposit more, or lower the size.`,
  connectPositions: 'Connect your wallet to see your positions on Hyperliquid.',
  noAccount: 'No perps balance for this wallet yet. Deposit USDC from Arbitrum to start trading perps.',
  noPositions: 'No open positions on Hyperliquid. Pick long or short in the ticket to open one.',
  noFills: 'No Hyperliquid trades in these markets yet.',
} as const;

/**
 * The account card on mainnet (components/trade/AccountCard.tsx): the wallet's real balances and the perps account.
 * The private account is not live there, so it is named only as in development (no simulated balance on mainnet).
 */
export const ACCT = {
  title: 'Your account',
  badge: 'Live',
  connect: 'Connect your wallet to see your balances on Robinhood Chain and your perps account.',
  perps: 'Perps (Hyperliquid)',
  noDeposit: 'No deposit yet',
  privateLabel: 'Private account',
  privateState: 'In development',
  privateNote: 'Trades today are public. Encrypted balances and positions come next.',
} as const;

/** Depositing USDC into the user's own Hyperliquid account from inside Velum (components/hyperliquid/HlDeposit.tsx). */
export const DEPOSIT = {
  title: 'Deposit USDC',
  intro: 'Move USDC from your wallet on Arbitrum into your Hyperliquid account, without leaving Velum. It arrives at this same address, usually within a minute.',
  minHint: 'Hyperliquid loses deposits under 5 USDC, so Velum asks for at least 5.',
  noUsdc: 'This wallet has no USDC on Arbitrum yet. Send USDC on Arbitrum to this address (from an exchange or a bridge), then deposit it here.',
  holds: (amount: string) => `Your wallet holds ${amount} USDC on Arbitrum.`,
  gasHint: 'Your wallet needs a little ETH on Arbitrum to pay the gas.',
  arbDown: 'Arbitrum cannot be reached right now. Try again in a moment.',
  footer: 'Your wallet signs the transfer on Arbitrum. Velum never holds your funds.',
} as const;

export const CLOSED = {
  label: 'Market closed',
  tag: 'closed',
  title: 'Market closed: the last price is shown and trading is paused until it opens',
  hint: 'The stock market is closed. Trading resumes when it opens.',
} as const;

export const COPY = {
  chainLabel: ENV.localRpc ? 'the local test chain' : CHAIN.label,
  heroBadge: IS_MAINNET ? 'Demo' : 'Testnet',
  heroPill: IS_MAINNET ? 'Private trading demo on Robinhood Chain' : 'Simulated private perps on Robinhood Chain',
  /** The line under the landing terminal; testnet always carries the test-token notice (F11). */
  frameCap: (origin: PriceOrigin, connected: boolean, mainnet = IS_MAINNET): string =>
    mainnet
      ? `${priceSourceText(origin, true)} ${
          HL_PERPS
            ? connected
              ? 'Spot trades are real Uniswap swaps from your wallet and perps are real trades on Hyperliquid; your practice balance is simulated.'
              : 'Connect your wallet to buy Stock Tokens through Uniswap or trade stock perps on Hyperliquid.'
            : connected
              ? 'Spot trades are real Uniswap swaps from your wallet; perps and your practice balance are simulated.'
              : 'Connect your wallet to buy Stock Tokens through Uniswap or try a simulated private perp trade.'
        }`
      : `${origin === 'demo' || origin === 'loading' ? 'Live demo with test prices.' : priceSourceText(origin, false)} Connect a test wallet to try a simulated private trade. Testnet. Test tokens have no value.`,
  faqMoney: IS_MAINNET
    ? HL_PERPS
      ? "Yes. Spot: buying or selling on the Spot ticket or the Swap page is a real Uniswap trade from your own wallet on Robinhood Chain, public onchain, with the pool fee and gas to pay. Perps: the Perps ticket places real leveraged orders from your own Hyperliquid account (USDC you deposit on Hyperliquid), public there, with Hyperliquid's trading fee and hourly funding, and a position can be liquidated. The private account is still simulated; Velum's own contracts hold money only after an external audit."
      : "For spot, yes: buying or selling on the Spot ticket or the Swap page is a real Uniswap trade from your own wallet on Robinhood Chain, public onchain, with the pool fee and gas to pay. Perps and the private account are still simulated; Velum's own contracts hold money only after an external audit."
    : 'No. Velum runs on Robinhood Chain testnet. Test tokens have no value, so you can learn how private trading works without risk.',
  ctaSub: IS_MAINNET
    ? HL_PERPS
      ? 'Connect your wallet to buy Stock Tokens through Uniswap or trade stock perps on Hyperliquid, in under a minute.'
      : 'Connect your wallet to buy Stock Tokens through Uniswap, or try a simulated private perp trade, in under a minute.'
    : 'Get free test USDG from the faucet and make your first simulated private trade in under a minute.',
  // No claim about prices here (final audit W-07): this line is static, while prices can be closed,
  // stale or unavailable. The live state is said where prices are shown (frame caption, markets, banner).
  footer: IS_MAINNET
    ? HL_PERPS
      ? "An independent project on Robinhood Chain, not affiliated with Robinhood. Not affiliated with Uniswap or Hyperliquid either. Spot trades are real Uniswap swaps from your wallet and perps are real trades from your own Hyperliquid account; the private account is simulated. Velum's own contracts are not deployed or audited yet."
      : "An independent project on Robinhood Chain, not affiliated with Robinhood. Not affiliated with Uniswap or Lighter either. Spot trades are real Uniswap swaps from your wallet; perps and the private account are simulated. Velum's own contracts are not deployed or audited yet."
    : 'An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet with simulated trading. Test tokens have no value.',
  /** Required on every page (CLAUDE.md §1.7); the /app layout shows it as a small line (F11). */
  brand: 'An independent project on Robinhood Chain, not affiliated with Robinhood.',
  marketsSub: (origin: PriceOrigin, mainnet = IS_MAINNET): string =>
    mainnet
      ? `${priceSourceText(origin, true)} Spot trades are real Uniswap swaps; ${HL_PERPS ? 'perps trade for real on Hyperliquid from your own account.' : "perps are simulated until Velum's contracts launch."}`
      : `${priceSourceText(origin, false)} Trading here is simulated.`,
  networkNotice: IS_MAINNET ? '' : ' Test tokens have no value.',
  notOnNetwork: (sym: string) => `${sym} isn't on ${CHAIN.label} yet.`,
  switchTo: `Switch to ${ENV.localRpc ? 'the local test chain' : CHAIN.label}`,
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
    /**
     * The portfolio headline (final audit W-06). On mainnet it sits next to the real wallet, so it says it
     * is the simulated practice total (with the Simulated badge); testnet keeps the prototype's label.
     */
    balanceLabel: mainnet ? 'Practice balance' : 'Private balance',
    balanceBadge: mainnet,
    /** Under the private address: nothing can be received on mainnet, where transfers are simulated. */
    paddrNote: mainnet ? 'A demo address: nothing can be sent to it yet.' : 'Share this address to receive private transfers.',
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
    /** A toast from the demo engine (a simulated flow, a simulated liquidation): labelled as such (web audit W3-06). */
    toast: (msg: string) => `Simulated: ${msg}`,
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
    ? 'Velum is a private exchange for Stock Tokens, in development. Try private spot and perps trading on real Stock Token prices in a simulated demo.'
    : 'Velum is a private exchange for Stock Tokens, in development. Try private spot and perps trading in a simulated demo on Robinhood Chain testnet.',
  lead: 'Velum is a private exchange for Stock Tokens, in development. Spot and perps, designed to keep your balance, positions and P&L encrypted end to end.',
  statMarkets: IS_MAINNET ? 'Stock markets to try, spot and perps' : 'Stock markets, spot and perps',
  statLev: 'Max leverage, long or short',
  // DV-F3: "0" counts what Velum controls. Velum's contracts are designed with no key that can freeze or
  // withdraw funds; they do have a price-relay key (testnet) and an optional guardian (close-only switch),
  // and token issuers (Paxos for USDG, the Stock Token issuer) can freeze their own tokens.
  statAdmin: 'Velum keys that can freeze or withdraw funds, by design',
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
  freezeTitle: "Designed so Velum can't freeze your funds",
  // Sized to keep the card's line count at every width (the layout is the prototype's).
  freezeText: 'No Velum key can freeze or withdraw funds, by design. Token issuers can still freeze their tokens. If services go quiet, a forced exit settles.',
  /** The note under the bento card's "0" (DV-F3: there are other keys, none that can freeze or withdraw). */
  freezeBigNote: 'freeze keys',
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
  faqLongShort: HL_PERPS
    ? `Yes. Today the Perps ticket goes long or short on Hyperliquid's stock perps from your own Hyperliquid account, with up to ${HL_MAX_LEVERAGE}× leverage. Velum's own perps, with a maker taking the other side and up to ${P.maxLev} leverage, come later.`
    : `In the demo, yes. Perps will let you go long or short on each stock with up to ${P.maxLev} leverage. A maker will take the other side, and you will be able to close on your own at any time.`,
  faqWho: `${IS_MAINNET ? (HL_PERPS ? 'Today, spot trades are public Uniswap swaps anyone can see onchain, and perps are public trades on Hyperliquid.' : 'Today, spot trades are public Uniswap swaps anyone can see onchain, and simulated perps stay in this browser.') : 'Today, nobody: demo trades are simulated and stay in this browser.'} Once Velum launches, the maker on the other side will see that one position, against a one-time address. Two risk services will read what they need to liquidate. The public will only see that a position changed.`,
  faqAnon: 'No. Moving tokens in and out will be public. If you want deposits harder to link, vary amounts and timing and withdraw to a fresh wallet.',
  faqLoss: 'No. Each position is designed to have its own margin, and losses stop there. You could lose all of it, so start small once real trading opens.',
  faqOffline: `${IS_MAINNET ? (HL_PERPS ? 'Velum holds nothing today: spot trades settle straight to your wallet through Uniswap, and perps margin stays in your own Hyperliquid account.' : 'Velum holds nothing today: spot trades settle straight to your wallet through Uniswap, and perps are simulated.') : 'Nothing is at risk today: trades are simulated and your tokens never leave your wallet.'} Once Velum holds funds, it is designed so you can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after ${P.exitDays} days.`,
} as const;

/**
 * Copy for the real (Phase 3) mode, used only while a deployment is live (lib/onchain/deployment.ts).
 * Phase 3 contracts are public: deposits, vault balances, positions, swaps, pools and offers are visible
 * onchain, so nothing here calls them private. The privacy layer stays "designed to" (Phase 4), and the
 * features that only exist as a simulation (private transfers) say so. A function of the network so tests
 * can check both.
 */
export function onchainCopy(mainnet: boolean) {
  const net = ENV.localRpc ? 'the local test chain' : CHAIN.label;
  return {
    /** Account card and portfolio badge instead of "Simulated". */
    badge: 'Onchain',
    badgeTitle: 'Real transactions. Balances and trades are public onchain until the privacy layer launches.',
    accountTitle: 'Vault account',
    balanceLabel: 'Vault balance',
    portfolioSub: `Your vault balance is held by the Velum contracts on ${net}. In this phase it is public onchain; the privacy layer comes later.`,
    assetsTitle: 'Vault assets',
    assetsSub: 'Free balance you can trade or unshield. Public onchain until the privacy layer launches.',
    publicSub: 'Anyone can see this. Shield tokens to deposit them into your Velum vault balance.',
    acctConnect: 'Connect a wallet and sign once to open your account. It costs no gas.',
    // No "Guarded beta" here: that badge follows the vault's guarded() state (components/onchain/Banner.tsx,
    // web audit W3-11), so it disappears for good once the guard admin opens the vault to the public.
    banner: mainnet
      ? 'Trades are real onchain transactions, public until the privacy layer launches.'
      : 'Trades are real testnet transactions, public onchain until the privacy layer launches. Testnet. Test tokens have no value.',
    bannerBadge: 'Onchain',
    /**
     * A real build whose deployment the API has not confirmed (lib/onchain/deployment.ts, web audit W3-02):
     * the banner says why new trades and deposits are paused and that exits still work. Never the word
     * "real" (the banner says so only once trades are on) and never text from the API's answer.
     */
    verifyBanner: (status: 'checking' | 'unavailable' | 'missing' | 'mismatch', mismatch: string | null) =>
      ({
        checking: "Checking this build's contracts with the Velum API…",
        unavailable: 'The Velum API is unavailable, so new trades and deposits are paused. Withdrawals, closes and forced exits still work from the chain.',
        missing: "The Velum API does not list this build's contracts, so new trades and deposits are paused. Withdrawals, closes and forced exits still work from the chain.",
        mismatch: `The Velum API reports ${mismatch ?? 'different contracts'} for this build, so new trades and deposits are paused. Withdrawals, closes and forced exits still work with this build's contracts.`,
      })[status] + (mainnet ? '' : ' Testnet. Test tokens have no value.'),
    /** The trade button while new trades are paused. */
    pausedLabel: (status: 'checking' | 'unavailable' | 'missing' | 'mismatch') => (status === 'checking' ? 'Checking the contracts…' : 'New trades paused'),
    /** The hint under a paused trade or deposit button. */
    pausedHint: (status: 'checking' | 'unavailable' | 'missing' | 'mismatch', mismatch: string | null) =>
      status === 'checking'
        ? "New trades open once the Velum API confirms this build's contracts."
        : status === 'mismatch'
          ? `The Velum API reports ${mismatch ?? 'different contracts'}, so new trades and deposits are paused. Withdrawals, closes and forced exits still work.`
          : 'The Velum API cannot confirm the contracts right now, so new trades and deposits are paused. Withdrawals, closes and forced exits still work.',
    perpsNote: `This phase is public: size, side and entry are visible onchain. In the full version they will stay encrypted. Funding and the ${P.penalty} liquidation penalty apply.`,
    spotNote: 'This phase is public: pool reserves and your trade are visible onchain. You own the token, so nothing can be liquidated.',
    swapNote: 'This phase is public: pool reserves and your swap are visible onchain. The minimum protects you if the price moves.',
    swapSub: 'Trade USDG and Stock Tokens through the Velum pools, onchain. Stock to stock routes through USDG in one transaction.',
    earnSub: `Add to a Velum pool and earn ${P.poolFee} of every swap through it. In this phase pools and your share are public onchain.`,
    makersSub: "Back traders' positions from your vault balance and earn the spread. You take the other side of every fill.",
    visibleRow: ['Visible onchain', 'Your wallet, the amounts and the pool'] as [string, string],
    chainLastLabel: 'Last transaction',
    noTx: 'Nothing yet',
    moveText: (kind: 'shield' | 'unshield' | 'send') =>
      ({
        shield: 'Deposit tokens from your wallet into your Velum vault balance, ready to trade.',
        unshield: 'Withdraw tokens from your vault balance to a wallet address. Always available.',
        send: 'Private transfers arrive with the privacy layer.',
      })[kind],
    moveNote: (kind: 'shield' | 'unshield' | 'send') =>
      kind === 'send'
        ? 'Not available yet: private transfers need the privacy layer, which is still being built. Nothing can be sent privately.'
        : 'This step is public: anyone can see the wallet, token, amount and time.',
    notDeployed: (sym: string) => `${sym} isn't in the Velum contracts on ${net} yet.`,
    /** Landing and markets lines that describe trading as simulated, for when it is real. */
    footer: mainnet
      ? 'An independent project on Robinhood Chain, not affiliated with Robinhood. Trades are real onchain transactions, public until the privacy layer launches.'
      : 'An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet: trades are real testnet transactions, public until the privacy layer launches. Test tokens have no value.',
    faqWho: 'In this phase, anyone: trades are public onchain. Velum is designed so that, once the privacy layer launches, only the maker on the other side sees that one position, against a one-time address, and the public only sees that a position changed.',
    faqOffline: `Velum's contracts hold what you deposit. You can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after ${P.exitDays} days.${mainnet ? '' : ' On testnet, test tokens have no value.'}`,
    ctaSub: mainnet ? 'Connect your wallet and make your first trade in under a minute.' : 'Get free test USDG from the faucet and make your first testnet trade in under a minute.',
    /** The line under the landing terminal, which trades for real once a deployment is live. */
    frameCap: (origin: PriceOrigin) =>
      `${priceSourceText(origin, mainnet)} Trades in this terminal are real ${mainnet ? 'onchain' : 'testnet'} transactions, public onchain.${mainnet ? '' : ' Testnet. Test tokens have no value.'}`,
    marketsSub: (origin: PriceOrigin) => `${priceSourceText(origin, mainnet)} Trades are real ${mainnet ? 'onchain' : 'testnet'} transactions.`,
  };
}

export const ONCHAIN = onchainCopy(IS_MAINNET);
