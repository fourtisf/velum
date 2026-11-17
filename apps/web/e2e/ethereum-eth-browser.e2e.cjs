// ETH on Ethereum mainnet (the "ERC20" network) in the mainnet Portfolio, in the browser: the mainnet web build with a
// mock EIP-6963 wallet; Robinhood Chain is a local anvil fork (4663) and Ethereum is a local anvil with chain ID 1 that
// answers in place of the public Ethereum RPC (packages/config/src/ethereum.ts). Checked: the Ethereum row and its
// value, the total of both networks (Portfolio, account cards, wallet button), and that an unreachable RPC or one that
// is not chain 1 is shown as unreadable and left out of the total, saying so. Nothing is sent to a public network.
//
// Run (fork on 127.0.0.1:8547, Ethereum stand-in on 127.0.0.1:8549, a local API for prices, the web on WEB_URL):
//   anvil --chain-id 1 --port 8549
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/ethereum-eth-browser.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createTestClient, http } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const L1 = process.env.L1_RPC || 'http://127.0.0.1:8549';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const ETH_RPC = 'https://ethereum-rpc.publicnode.com';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-l1-e2e');
mkdirSync(OUT, { recursive: true });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const usdOf = (t) => {
  const m = /\$([\d,]+\.\d\d)/.exec(t);
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
};
const lastUsd = (t) => {
  const all = [...t.matchAll(/\$([\d,]+\.\d\d)/g)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : NaN;
};

/** A browser context whose Ethereum RPC is answered by `mode`: 'l1' (chain 1 stand-in), 'down' (503) or 'wrong' (chain 4663). */
async function open(browser, key, mode) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installWallet(ctx, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await ctx.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await ctx.route(`${ETH_RPC}/**`, async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (mode === 'down') return r.fulfill({ status: 503, headers: cors, body: 'unavailable' });
    const res = await fetch(mode === 'wrong' ? RH : L1, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rq.postData() });
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: 'networkidle' });
  await page.locator('button', { hasText: 'Connect wallet' }).last().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.pf-hero').waitFor({ timeout: 20_000 });
  return { ctx, page, errors };
}

async function main() {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const rh = createTestClient({ chain: { id: 4663, name: 'rh', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RH] } } }, mode: 'anvil', transport: http(RH) });
  const l1 = createTestClient({ chain: { id: 1, name: 'l1', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [L1] } } }, mode: 'anvil', transport: http(L1) });
  await rh.setBalance({ address: me, value: 10n ** 17n }); // 0.1 ETH on Robinhood Chain
  await l1.setBalance({ address: me, value: 4n * 10n ** 17n }); // 0.4 ETH on Ethereum
  const browser = await chromium.launch();

  // Ethereum answers: its ETH is listed and counted.
  const a = await open(browser, key, 'l1');
  const row = a.page.locator('.tbl tr', { hasText: 'ETH on Ethereum (ERC20)' });
  await row.waitFor({ timeout: 30_000 });
  const rowText = (await row.innerText()).replace(/\s+/g, ' ');
  check('the Ethereum row: 0.4 ETH with its price and value', /ETH ETH on Ethereum \(ERC20\) 0\.400000 \$[\d,]+\.\d\d \$[\d,]+\.\d\d/.test(rowText), rowText);
  check('the Ethereum row has the ETH logo', (await row.locator('.av.logo svg').count()) === 1);
  const rhRow = (await a.page.locator('.tbl tr', { hasText: 'ETH on Robinhood Chain' }).innerText()).replace(/\s+/g, ' ');
  check('Robinhood Chain ETH is listed separately', /0\.100000/.test(rhRow), rhRow);
  await a.page.waitForFunction(() => /\$\d/.test(document.querySelector('.pf-big')?.textContent ?? ''), null, { timeout: 30_000 });
  const total = usdOf(await a.page.locator('.pf-big').innerText());
  const sum = lastUsd(rowText) + lastUsd(rhRow);
  check('the wallet value adds both networks', Math.abs(total - sum) <= 0.02, `${total} vs ${sum}`);
  const card = (await a.page.locator('.card.acct').innerText()).replace(/\s+/g, ' ');
  check('the account card shows ETH (Ethereum)', /ETH \(Ethereum\) \$[\d,]+\.\d\d/.test(card), card.slice(0, 200));
  const navTotal = usdOf(await a.page.locator('.walletbtn').innerText());
  check('the wallet button shows the same total', Math.abs(navTotal - total) <= 0.01, `${navTotal} vs ${total}`);
  check('no note that Ethereum is left out', (await a.page.locator('.pf-hero', { hasText: 'not in this total' }).count()) === 0);
  await a.page.locator('.pf-grid').screenshot({ path: path.join(OUT, 'l1-portfolio.png') });
  await a.page.locator('nav.tabs a', { hasText: 'Trade' }).click();
  const tcard = a.page.locator('aside.card.acct');
  await tcard.locator('.r', { hasText: 'ETH (Ethereum)' }).waitFor({ timeout: 20_000 });
  await a.page.waitForFunction(() => /0\.4000 ETH · \$/.test(document.querySelector('aside.card.acct')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => undefined);
  const trow = (await tcard.locator('.r', { hasText: 'ETH (Ethereum)' }).innerText()).replace(/\s+/g, ' ');
  check('the trade page account card: 0.4 ETH on Ethereum with its value', /0\.4000 ETH · \$[\d,]+\.\d\d/.test(trow), trow);
  check('no page errors (Ethereum answering)', a.errors.length === 0, a.errors.slice(0, 2).join(' | '));
  await a.ctx.close();

  // Unreachable, or not chain 1: shown as unreadable and left out of the total, saying so.
  for (const mode of ['down', 'wrong']) {
    const b = await open(browser, key, mode);
    const bad = b.page.locator('.tbl tr', { hasText: 'ETH on Ethereum: could not be read' });
    await bad.waitFor({ timeout: 45_000 }).catch(() => undefined);
    check(`${mode}: the Ethereum row says it could not be read`, (await bad.count()) === 1);
    const note = b.page.locator('.pf-hero', { hasText: 'ETH on Ethereum could not be read right now, so it is not in this total.' });
    await note.waitFor({ timeout: 20_000 }).catch(() => undefined);
    check(`${mode}: the total says Ethereum is left out`, (await note.count()) === 1);
    const t = usdOf(await b.page.locator('.pf-big').innerText());
    check(`${mode}: the total is Robinhood Chain only`, Math.abs(t - lastUsd(rhRow)) <= 0.02, `${t} vs ${lastUsd(rhRow)}`);
    check(`${mode}: no page errors`, b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
    await b.ctx.close();
  }
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
