// Real spot trading through Uniswap in the browser, against a local anvil fork of Robinhood Chain mainnet (chain
// 4663): the mainnet web build (NEXT_PUBLIC_RPC_URL on the fork), a mock EIP-6963 wallet signing with a throwaway key
// (e2e/wallet.cjs), real Stock Tokens and USDG on the fork. It buys TSLA on the trade page, sells part of it back,
// then swaps TSLA for META on the swap page (two legs through USDG), and checks every amount on chain against what
// the receipts show. Nothing is sent to a public network.
//
// Run (fork on 127.0.0.1:8547 with --chain-id 4663, the API serving prices, the web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 FORK_RPC=http://127.0.0.1:8547 node apps/web/e2e/uniswap-browser.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, createWalletClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-uniswap-e2e');
mkdirSync(OUT, { recursive: true });
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const META = '0xc0d6457c16cc70d6790dd43521c899c87ce02f35';
/** A curated pool the trades below do not route through (TSLA v3 1%), used only as the funding holder. */
const HOLDER = '0xb349fb08c2712f3a70bad40a4d006b68d67e888b';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const bal = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`), animations: 'disabled' });

async function runFlow(page, label) {
  const m = page.locator('.modal');
  await m.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  const review = await m.innerText();
  check(`${label}: confirm stays off until the risk box is ticked`, await m.locator('button', { hasText: 'Start trade' }).isDisabled());
  await m.locator('input[type="checkbox"]').check();
  await snap(page, `${label}-review`);
  await m.locator('button', { hasText: 'Start trade' }).click();
  const done = m.locator('button', { hasText: 'Done' });
  const failedNote = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 180_000 }), failedNote.waitFor({ timeout: 180_000 })]);
  await sleep(300);
  const text = await m.innerText();
  await snap(page, `${label}-${(await done.isVisible()) ? 'receipt' : 'failed'}`);
  const ok = await done.isVisible();
  check(`${label}: confirmed`, ok, ok ? '' : text.split('\n').slice(-5).join(' | ').slice(0, 400));
  if (ok) await done.click();
  return { ok, review, text };
}

/** The "Received" amount of a receipt as base units of a token with `decimals`. */
function received(text, decimals) {
  const m = /Received\s*([\d,]+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const [i, f = ''] = m[1].replace(/,/g, '').split('.');
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0').slice(0, decimals) || '0');
}

async function main() {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 10n ** 17n });
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: 10n ** 18n });
  const w = createWalletClient({ account: HOLDER, chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: ERC20, functionName: 'transfer', args: [me, 300_000000n], chain }) });
  await test.stopImpersonatingAccount({ address: HOLDER });
  check('funded the throwaway wallet with 300 USDG on the fork', (await bal(USDG, me)) === 300_000000n);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Trade page, Spot: buy TSLA with 200 USDG.
  await page.goto(`${BASE}/app/trade/TSLA?mode=spot`, { waitUntil: 'networkidle' });
  await page.locator('.demo-bar', { hasText: 'real Uniswap swaps' }).waitFor({ timeout: 20_000 });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Test Wallet' }).click();
  // Mainnet without Velum contracts: the wallet connects without a signature (WALLET_ONLY).
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await page.locator('.ticket .fl', { hasText: '300.00 USDG' }).waitFor({ timeout: 30_000 });
  check('the ticket shows the wallet balance', true);
  await page.locator('#t-spot').fill('200');
  const buy = page.locator('.ticket button.btn-block', { hasText: 'Buy TSLA' });
  await buy.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.ticket button.btn-block')?.hasAttribute('disabled'), null, { timeout: 30_000 });
  await snap(page, 'ticket-buy');
  const usdg0 = await bal(USDG, me);
  const tsla0 = await bal(TSLA, me);
  await buy.click();
  const b = await runFlow(page, 'buy-tsla');
  check('buy review: pay 200 USDG, minimum, route, public', /You pay\s*200 USDG/.test(b.review) && /Minimum you get\s*[\d.]+ TSLA/.test(b.review) && /Uniswap v[34]/.test(b.review) && /public Uniswap trade/.test(b.review), b.review.replace(/\n/g, ' | ').slice(0, 300));
  const tsla1 = await bal(TSLA, me);
  const got = received(b.text, 18);
  check('buy: exactly 200 USDG left the wallet', usdg0 - (await bal(USDG, me)) === 200_000000n);
  check('buy: the TSLA received on chain matches the receipt', got !== null && tsla1 - tsla0 === got, `${tsla1 - tsla0} vs ${got}`);
  check('buy: three transactions (approval, router allowance, swap)', wallet.sent.length === 3, String(wallet.sent.length));

  // Sell half of it back.
  await page.locator('.ticket .sides button', { hasText: 'Sell' }).click();
  const half = (tsla1 - tsla0) / 2n;
  const halfStr = (Number(half / 10n ** 14n) / 1e4).toFixed(4);
  await page.locator('#t-spot').fill(halfStr);
  await page.waitForFunction(() => /Sell TSLA/.test(document.querySelector('.ticket button.btn-block')?.textContent || '') && !document.querySelector('.ticket button.btn-block')?.hasAttribute('disabled'), null, { timeout: 30_000 });
  const usdgBefore = await bal(USDG, me);
  await page.locator('.ticket button.btn-block', { hasText: 'Sell TSLA' }).click();
  const s = await runFlow(page, 'sell-tsla');
  const usdgGot = received(s.text, 6);
  check('sell: the USDG received on chain matches the receipt', usdgGot !== null && (await bal(USDG, me)) - usdgBefore === usdgGot, `${(await bal(USDG, me)) - usdgBefore} vs ${usdgGot}`);

  // Swap page: TSLA -> META, two legs through USDG.
  await page.goto(`${BASE}/app/swap`, { waitUntil: 'networkidle' });
  await page.locator('#sw-from').selectOption('TSLA');
  await page.locator('#sw-to').selectOption('META');
  await page.locator('#sw-in').fill('0.1');
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.swapcard button.btn-block')][0];
    return b && b.textContent === 'Swap' && !b.hasAttribute('disabled');
  }, null, { timeout: 30_000 });
  await snap(page, 'swap-tsla-meta');
  const meta0 = await bal(META, me);
  const sent0 = wallet.sent.length;
  await page.locator('.swapcard button.btn-block', { hasText: 'Swap' }).click();
  const x = await runFlow(page, 'swap-tsla-meta');
  const metaGot = received(x.text, 18);
  check('two-leg swap: the META received on chain matches the receipt', metaGot !== null && (await bal(META, me)) - meta0 === metaGot, `${(await bal(META, me)) - meta0} vs ${metaGot}`);
  check('two-leg swap: six transactions at most (approvals skipped when given)', wallet.sent.length - sent0 >= 2 && wallet.sent.length - sent0 <= 6, String(wallet.sent.length - sent0));
  check('no wallet transaction on another chain', wallet.wrongChainSends === 0);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  for (const r of results) console.log(r);
  if (failed) {
    console.error(`FAILED: ${failed} check(s); screenshots in ${OUT}`);
    process.exit(1);
  }
  console.log(`OK: buy, sell and a two-leg swap through Uniswap in the browser; screenshots in ${OUT}`);
}

main().catch((e) => {
  for (const r of results) console.log(r);
  console.error(e);
  process.exit(1);
});
