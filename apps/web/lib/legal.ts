/**
 * Velum's Terms of Use and Risk Disclosure (app/terms, app/risk), and the version of them the perps statement refers to
 * (components/hyperliquid/HlTerms.tsx). Plain text, one source: bump LEGAL_VERSION when a change needs every perps user
 * to accept again. A draft written for the product as it is; to be reviewed by a lawyer before it is relied on.
 */
export const LEGAL_VERSION = '2026-11-17';
export const LEGAL_UPDATED = 'November 17, 2026';
/** Where perps are not offered (the API's default PERPS_BLOCKED_COUNTRIES; the statement names them). */
export const PERPS_RESTRICTED = 'the United States, Cuba, Iran, North Korea or Syria, or any country or region under comprehensive sanctions';

export interface LegalSection {
  h: string;
  p: string[];
}

export const TERMS: LegalSection[] = [
  {
    h: 'What Velum is',
    p: [
      'Velum is an independent software interface on Robinhood Chain. It lets you trade Stock Tokens through Uniswap pools and open perpetual futures ("perps") from your own account on a third-party exchange, straight from your own wallet.',
      'Velum is not a broker, exchange, bank, custodian or investment adviser. Velum is an independent project on Robinhood Chain and is not affiliated with Robinhood, Uniswap, Relay or the exchange that holds your perps account.',
    ],
  },
  {
    h: 'You keep control of your funds',
    p: [
      'Velum never holds your funds or your keys. Spot trades are swaps your wallet signs on Robinhood Chain. Perps orders are placed from your own perps account at your own address, signed by a trading key kept only in your browser; that key can place orders and move money between your own balances, but it can never withdraw. Deposits and withdrawals are signed by your wallet.',
      'You are responsible for your wallet, its recovery phrase and your device. Transactions on a blockchain cannot be reversed.',
    ],
  },
  {
    h: 'Who may use Velum',
    p: [
      'You must be at least 18 years old and able to enter into a binding agreement. You may not use Velum if you are on a sanctions list, or if using it breaks the laws that apply to you.',
      'Perps are not offered to residents or citizens of the United States, or to anyone in Cuba, Iran, North Korea, Syria or any country or region under comprehensive sanctions. Velum may block access by location and may refuse access at any time. Do not use tools to hide your location.',
    ],
  },
  {
    h: 'Third-party services',
    p: [
      'Trades, prices and transfers go through services Velum does not run: Robinhood Chain, Uniswap, Relay (cross-chain transfers), the perps exchange and its markets, wallets, RPC providers and price sources. Their terms and risks apply, and Velum is not responsible for their availability, prices, fills, liquidations, fees or failures.',
    ],
  },
  {
    h: 'No advice, no guarantees',
    p: [
      'Nothing on Velum is investment, legal or tax advice, or an offer or recommendation to buy or sell anything. Prices, P&L, liquidation prices and other figures are estimates and may be wrong or late.',
      'Velum is provided "as is" and "as available", without warranties of any kind. To the fullest extent the law allows, the people behind Velum are not liable for any loss of funds, profits or data arising from your use of Velum or of any third-party service.',
    ],
  },
  {
    h: 'The VELUM token',
    p: [
      'The VELUM token gives no ownership, profit share, dividend or claim on anyone. Only trust the contract address shown on velumtrade.com and posted by @velumtrade.',
    ],
  },
  {
    h: 'Privacy',
    p: [
      'Velum does not ask for your name or email. Connecting a wallet asks for no signature. Velum keeps no record that links your wallet to you; error reports sent from the app contain no wallet address. If you turn on Telegram alerts, Velum keeps the link between your wallet and your Telegram chat to send them, until you send /stop. A referral link records once which link a wallet arrived through. Your activity on public blockchains and on the perps exchange is public. Private accounts are in development and not live.',
    ],
  },
  {
    h: 'Changes',
    p: ['These terms may change. The date below says when they last did; using Velum after a change means you accept it. Material changes to perps terms are shown again before your next perps trade.'],
  },
];

export const RISKS: LegalSection[] = [
  {
    h: 'Leverage and liquidation',
    p: [
      'Perps use leverage: a small price move against you causes a large loss. If your margin falls to the maintenance level, the position is liquidated automatically and you can lose all the margin in it. Prices can gap, and a stop loss can fill at a worse price than its trigger, or not at all.',
      'Funding is paid every hour between longs and shorts and can cost you money even when the price does not move.',
    ],
  },
  {
    h: 'Stock Tokens are not shares',
    p: [
      'Stock Tokens track the price of a company\'s shares but are not the shares: they give no voting rights, no dividends unless their issuer provides them, and no claim on the company. Their price can differ from the stock\'s, especially when markets are closed or liquidity is thin, and the issuer\'s own risks apply.',
    ],
  },
  {
    h: 'Smart contracts, bridges and chains',
    p: [
      'Pools, bridges, the perps exchange and the chains they run on are software and can fail, be paused, be exploited or change. Cross-chain transfers through Relay depend on Relay completing them; a stuck or failed transfer may take time to refund.',
    ],
  },
  {
    h: 'Prices and oracles',
    p: [
      'Prices come from pools, the exchange and outside sources. They can be wrong, late or manipulated, and that can trigger liquidations or bad fills.',
    ],
  },
  {
    h: 'Your own setup',
    p: [
      'Lost keys, a compromised device, a malicious browser extension or a signature you did not read can lose your funds. Velum never asks for your recovery phrase.',
    ],
  },
  {
    h: 'Law and taxes',
    p: [
      'The rules for tokens and derivatives differ by country and change. You are responsible for following yours and for your taxes; the Portfolio\'s CSV export is a convenience, not tax advice.',
    ],
  },
];
