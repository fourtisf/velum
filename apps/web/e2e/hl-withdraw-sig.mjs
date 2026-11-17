// Live check of the withdrawal signatures (lib/hyperliquid/withdraw.ts) against Hyperliquid's real API, with a
// throwaway key that holds nothing, so nothing can move: a sendAsset with a pinned nonce (as Relay's quote gives it) and
// a withdraw3, both signed on Robinhood Chain (signatureChainId 0x1237). Hyperliquid recovers the signer before it
// looks at balances, so an answer naming the throwaway address (no deposit, no balance) proves both are well formed.
// Run from apps/web: NODE_USE_ENV_PROXY=1 node e2e/hl-withdraw-sig.mjs
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RELAY_HL = '0x66cf0aace1b4e562593bec10ec7868fba9932224';
const acct = privateKeyToAccount(generatePrivateKey());
const nonce = Date.now() - 5_000;
const transport = new HttpTransport({ timeout: 15_000 });
const results = [];
const check = (label, ok, detail) => results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`);
const said = (e) => String(e?.message ?? e);
const names = (msg) => msg.toLowerCase().includes(acct.address.toLowerCase());

try {
  const ex = new ExchangeClient({ transport, wallet: acct, signatureChainId: '0x1237', nonceManager: () => nonce });
  await ex.sendAsset({ destination: RELAY_HL, sourceDex: '', destinationDex: '', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '12.000000', fromSubAccount: '' });
  check('sendAsset with a pinned nonce', false, 'accepted (unexpected for an empty account)');
} catch (e) {
  const m = said(e);
  check('sendAsset with a pinned nonce', names(m) || /insufficient|deposit/i.test(m), m.slice(0, 160));
}
try {
  const ex = new ExchangeClient({ transport, wallet: acct, signatureChainId: '0x1237' });
  await ex.withdraw3({ destination: acct.address, amount: '5.5' });
  check('withdraw3', false, 'accepted (unexpected for an empty account)');
} catch (e) {
  const m = said(e);
  check('withdraw3', names(m) || /insufficient|deposit/i.test(m), m.slice(0, 160));
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
