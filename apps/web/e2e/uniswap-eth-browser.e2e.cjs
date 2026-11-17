// Buying a Stock Token with ETH on the trade page, in the browser, against a local anvil fork of Robinhood Chain mainnet
// (chain 4663): the mainnet web build (NEXT_PUBLIC_RPC_URL on the fork), a mock EIP-6963 wallet signing with a throwaway
// key (e2e/wallet.cjs), the real Universal Router, pools and tokens on the fork. Checked: "Pay with ETH" shows the ETH
// balance, Max keeps a gas reserve, the review (route, no approval), exactly one transaction carrying exactly the ETH,
// and the TSLA received on chain matching the receipt. Nothing is sent to a public network.
//
// Run (fork on 127.0.0.1:8547, a local API for prices, the web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 FORK_RPC=http://127.0.0.1:8547 node apps/web/e2e/uniswap-eth-browser.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-eth-e2e');
mkdirSync(OUT, { recursive: true });
const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`) });

/** The "Received" amount of a receipt, in base units of a token with `decimals`. */
function received(text, decimals) {
  const m = /Received\s*([\d,]+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const [i, f = ''] = m[1].replace(/,/g, '').split('.');
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0').slice(0, decimals) || '0');
}

async function main() {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 2n * 10n ** 17n }); // 0.2 ETH
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await context.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/trade/TSLA?mode=spot`, { waitUntil: 'networkidle' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  // Mainnet without Velum contracts: the wallet connects without a signature (WALLET_ONLY).
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  check('connected without any signature request', !wallet.log.some((l) => l.method === 'personal_sign' || l.method === 'eth_signTypedData_v4'));

  await page.locator('.ticket button', { hasText: 'Pay with ETH' }).click();
  await page.locator('.ticket .fl', { hasText: '0.200000 ETH' }).waitFor({ timeout: 30_000 });
  check('Pay with ETH: the ticket shows the wallet ETH', true);
  // The ETH price comes from the WETH/USDG pool on the fork: the wallet line shows its dollar value.
  await page.locator('.ticket .fl', { hasText: /0\.200000 ETH · \$[\d,]+\.\d\d/ }).waitFor({ timeout: 40_000 });
  check('the wallet ETH shows its dollar value', true, await page.locator('.ticket .fl').first().innerText());
  await page.locator('.ticket .pcts button', { hasText: 'Max' }).click();
  const maxVal = await page.locator('#t-spot').inputValue();
  check('Max keeps 0.0005 ETH for gas', maxVal === '0.1995', maxVal);
  await page.locator('#t-spot').fill('0.05');
  const buy = page.locator('.ticket button.btn-block', { hasText: 'Buy TSLA with ETH' });
  await buy.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.ticket button.btn-block')?.hasAttribute('disabled'), null, { timeout: 30_000 });
  const sum = (await page.locator('.ticket .sumbox').innerText()).replace(/\n/g, ' | ');
  check('summary: ETH price, both pool fees, minimum, route', /ETH/.test(sum) && /0\.01% \+ 0\.\d+%/.test(sum) && /Minimum you get \| [\d.]+ TSLA/.test(sum) && /ETH → USDG → TSLA/.test(sum), sum);
  check('summary: the order value and the price in dollars', /Order value \| ≈ \$[\d,]+\.\d\d/.test(sum) && /Price \| [\d.]+ ETH ≈ \$[\d,]+\.\d\d/.test(sum), sum);
  const getsUsd = await page.locator('.ticket .fl', { hasText: 'You get (est.)' }).innerText();
  check('what you get shows its dollar value', /≈ \$[\d,]+\.\d\d/.test(getsUsd), getsUsd);
  await snap(page, 'ticket-eth');
  const tsla0 = await pub.readContract({ address: TSLA, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const eth0 = await pub.getBalance({ address: me });
  await buy.click();
  const m = page.locator('.modal');
  const start = m.locator('button', { hasText: 'Start trade' });
  await start.waitFor({ timeout: 30_000 });
  const review = await m.innerText();
  check('review: pay 0.05 ETH with its dollar value', /You pay\s*0\.05 ETH \(≈ \$[\d,]+\.\d\d\)/.test(review), review.replace(/\n/g, ' | ').slice(0, 200));
  check('review: pay 0.05 ETH, route through USDG, no approval', /You pay\s*0\.05 ETH/.test(review) && /ETH to USDG \(Uniswap v3, 0\.01%\)/.test(review) && /None: the ETH is sent with the swap/.test(review), review.replace(/\n/g, ' | ').slice(0, 300));
  await m.locator('input[type="checkbox"]').check();
  await start.click();
  const done = m.locator('button', { hasText: 'Done' });
  const alert = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 120_000 }), alert.waitFor({ timeout: 120_000 })]);
  const text = await m.innerText();
  await snap(page, 'eth-receipt');
  check('buy: confirmed', await done.isVisible(), text.replace(/\n/g, ' | ').slice(-300));
  const tsla1 = await pub.readContract({ address: TSLA, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const got = received(text, 18);
  check('the TSLA received on chain matches the receipt', got !== null && tsla1 - tsla0 === got, `${tsla1 - tsla0} vs ${got}`);
  check('one transaction (no approval)', wallet.sent.length === 1, String(wallet.sent.length));
  const tx = wallet.sent[0] ? await pub.getTransaction({ hash: wallet.sent[0] }) : null;
  const rc = wallet.sent[0] ? await pub.getTransactionReceipt({ hash: wallet.sent[0] }) : null;
  check('it carried exactly 0.05 ETH', tx && tx.value === 5n * 10n ** 16n, tx ? String(tx.value) : 'none');
  const eth1 = await pub.getBalance({ address: me });
  check('the wallet spent exactly 0.05 ETH plus gas', rc && eth0 - eth1 === 5n * 10n ** 16n + rc.gasUsed * rc.effectiveGasPrice, String(eth0 - eth1));

  // Portfolio: real only. The TSLA just bought is in the wallet's assets, the trade is in the activity read from the
  // chain, ETH is valued, and nothing simulated (practice balance, private address, Shield/Unshield) is shown.
  await m.locator('button', { hasText: 'Done' }).click();
  await page.locator('nav.tabs a', { hasText: 'Portfolio' }).click();
  await page.locator('.pf-hero').waitFor({ timeout: 30_000 });
  const tslaRow = page.locator('.tbl tr', { hasText: 'Tesla' });
  await tslaRow.waitFor({ timeout: 30_000 });
  const pf = await page.locator('main').innerText();
  check('portfolio: no simulated parts', !/Practice balance|Simulated|Private assets|Shield|Unshield|Send privately/.test(pf), pf.replace(/\n/g, ' | ').slice(0, 300));
  check('portfolio: wallet value in dollars', /Wallet value[\s\S]{0,40}\$[\d,]+\.\d\d/.test(pf), pf.replace(/\n/g, ' | ').slice(0, 200));
  const ethRow = (await page.locator('.tbl tr', { hasText: 'ETH on Robinhood Chain' }).innerText()).replace(/\s+/g, ' ');
  check('portfolio: Robinhood Chain ETH with its price and value', /ETH ETH on Robinhood Chain [\d.]+ \$[\d,]+\.\d\d \$[\d,]+\.\d\d/.test(ethRow), ethRow);
  check('portfolio: ETH has its logo', (await page.locator('.tbl tr', { hasText: 'ETH on Robinhood Chain' }).locator('.av.logo svg').count()) === 1);
  check('portfolio: TSLA bought is in your assets', /TSLA/.test(await tslaRow.innerText()));
  const act = page.locator('.act', { hasText: /Bought [\d.]+ TSLA/ });
  await act.waitFor({ timeout: 90_000 }).catch(() => undefined);
  const actText = (await act.count()) ? (await act.first().innerText()).replace(/\n/g, ' | ') : (await page.locator('main').innerText()).slice(-400);
  check('portfolio: the buy is in the wallet activity, paid with ETH', /Bought [\d.]+ TSLA/.test(actText) && /Paid 0\.050000 ETH/.test(actText), actText);
  await snap(page, 'portfolio');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(`\nscreenshots: ${OUT}`);
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
