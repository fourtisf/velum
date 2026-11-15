// No-deployment regression (from the web audit of the real-transaction wiring): two builds made WITHOUT a
// deployment file (a reference commit and this tree), driven the same way. /api/* is forwarded to a running
// API (the local stack's Nginx). Compares the API paths called (never /v1/deployment), page errors, CSP
// violations, console errors and the masked page text of 8 routes (signed in from the second route on).
// Usage: node regress.cjs <reference base URL> <current base URL> <API base URL>; exits 1 on any difference.
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const { installWallet } = require('./adv-wallet.cjs');
const req = createRequire(path.join(__dirname, '..', '..', 'package.json'));
const { generatePrivateKey } = req('viem/accounts');
const [, , parentUrl, currentUrl, apiBase] = process.argv;
const ROUTES = ['/', '/app/trade/TSLA', '/app/trade/TSLA?mode=spot', '/app/markets', '/app/swap', '/app/portfolio', '/app/liquidity', '/app/makers'];
// Random per session, so masked first: the demo's simulated commit hashes and the private address (its sign
// message names the page's origin, and the two builds run on different ports).
const mask = (t) =>
  t
    .replace(/\s+/g, ' ')
    .replace(/velum1[0-9a-f]+(…[0-9a-f]+)?/g, 'PADDR')
    .replace(/0x[0-9a-fA-F]+…[0-9a-fA-F]+/g, 'ADDR')
    .replace(/[+-]?\$?[\d,]+(\.\d+)?%?/g, '#')
    .replace(/(Just now|# ?(s|m|h|d|min) ago)/g, 'AGO');
async function run(base, pk) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const api = [];
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1') return route.abort();
    if (u.pathname.startsWith('/api/')) { api.push(u.pathname.replace(/0x[0-9a-fA-F]{40}/, 'ADDR')); const r = await route.fetch({ url: apiBase + u.pathname + u.search }); return route.fulfill({ response: r }); }
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const wallet = await installWallet(context, { privateKey: pk, rpc: 'http://127.0.0.1:1', chainId: 46630 });
  const page = await context.newPage();
  const errors = [];
  const consoleErr = [];
  const csp = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 160)); });
  const out = {};
  for (const [i, r] of ROUTES.entries()) {
    await page.goto(base + r, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    if (i === 1) {
      await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
      await page.locator('.modal .wopt', { hasText: 'Test Wallet' }).click();
      await page.locator('.modal button', { hasText: 'Sign message' }).click();
      await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
    }
    out[r] = mask(await page.locator('body').innerText());
    csp.push(...(await page.evaluate(() => window.__csp.splice(0))));
  }
  await browser.close();
  return { out, api: [...new Set(api)].sort(), errors, consoleErr, csp, sent: wallet.txs.length };
}
(async () => {
  const pk = generatePrivateKey();
  const a = await run(parentUrl, pk);
  const b = await run(currentUrl, pk);
  let diff = 0;
  console.log('API paths reference:', a.api.join(' '));
  console.log('API paths current  :', b.api.join(' '));
  if (a.api.join(' ') !== b.api.join(' ')) diff++;
  const dep = b.api.some((x) => x.includes('/v1/deployment'));
  console.log('current requested /v1/deployment:', dep);
  if (dep) diff++;
  console.log('page errors reference/current:', a.errors.length, b.errors.length, b.errors.slice(0, 2).join(' | '));
  console.log('console errors reference/current:', a.consoleErr.length, b.consoleErr.length, b.consoleErr.slice(0, 2).join(' | '));
  console.log('CSP violations reference/current:', a.csp.length, b.csp.length, b.csp.slice(0, 2).join(' | '));
  console.log('wallet transaction requests reference/current:', a.sent, b.sent);
  if (b.errors.length || b.consoleErr.length > a.consoleErr.length || b.csp.length || b.sent) diff++;
  for (const r of ROUTES) {
    const same = a.out[r] === b.out[r];
    console.log(`${same ? 'SAME ' : 'DIFF '} ${r}`);
    if (!same) {
      diff++;
      const x = a.out[r].split(/(?<=[.:])\s/), y = b.out[r].split(/(?<=[.:])\s/);
      console.log('   reference only:', JSON.stringify(x.filter((s) => !y.includes(s)).slice(0, 4)).slice(0, 400));
      console.log('   current only  :', JSON.stringify(y.filter((s) => !x.includes(s)).slice(0, 4)).slice(0, 400));
    }
  }
  console.log(diff ? `REGRESSION: ${diff} difference(s)` : 'REGRESSION: none (same API calls, never /v1/deployment, same text on every route, no errors)');
  process.exit(diff ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
