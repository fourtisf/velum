// Terms, risk, the perps geoblock and error reports in the browser (mainnet build, a mock EIP-6963 wallet on a local fork
// of Robinhood Chain, a funded model perps account). The API's /v1/geo answer is set per context. Checked: a blocked
// region cannot open or deposit but sees why; an allowed visitor accepts the perps statement once (all three boxes) and
// then gets the order button; /terms and /risk render with the brand line and are linked from the footers; an uncaught
// error is reported to /v1/client-errors with no address and no query string.
//
// Run (fork on 127.0.0.1:8547, a local API, the mainnet web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/compliance.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { generatePrivateKey } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-compliance-e2e');
mkdirSync(OUT, { recursive: true });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

async function setup(browser, { perps, terms }) {
  const key = generatePrivateKey();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet', perpsTerms: terms });
  const reports = [];
  await context.route(`${API}/**`, async (r) => {
    const url = r.request().url();
    if (url.endsWith('/v1/geo')) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'access-control-expose-headers': 'Date' }, body: JSON.stringify({ country: perps === 'blocked' ? 'US' : 'ID', perps }) });
    if (url.endsWith('/v1/client-errors')) {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      reports.push(JSON.parse(r.request().postData() || '{}'));
      return r.fulfill({ status: 204, headers: cors });
    }
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const b = JSON.parse(rq.postData() || '{}');
    const st = (w) => ({ marginSummary: { accountValue: w, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: w, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: w, assetPositions: [], time: Date.now() });
    const body = { meta: b.dex === 'xyz' ? meta : null, allMids: b.dex === 'xyz' ? { 'xyz:TSLA': '384.00' } : {}, userAbstraction: 'disabled', extraAgents: [], clearinghouseState: st(b.dex === 'xyz' ? '500' : '0'), spotClearinghouseState: { balances: [] }, activeAssetData: { user: b.user, coin: b.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: '384.00' }, userFills: [], maxBuilderFee: 0, frontendOpenOrders: [], l2Book: { coin: b.coin, time: Date.now(), levels: [[{ px: '383.99', sz: '1', n: 1 }], [{ px: '384.01', sz: '1', n: 1 }]] } }[b.type] ?? null;
    return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  return { context, page, wallet, reports, errors };
}

async function main() {
  const browser = await chromium.launch();

  // ---------- Blocked region ----------
  const a = await setup(browser, { perps: 'blocked', terms: true });
  const btn = a.page.locator('.ticket button.btn-block');
  await a.page.waitForFunction(() => /Not available in your region/.test(document.querySelector('.ticket button.btn-block')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => undefined);
  check('blocked region: no order, saying why and that closing and withdrawing still work', /Not available in your region/.test(await btn.innerText()) && (await btn.isDisabled()) && /close positions and withdraw/.test(await a.page.locator('.ticket .hint').innerText()), `${await btn.innerText()} | ${await a.page.locator('.ticket .hint').innerText()}`);
  await a.page.locator('.ticket .linkbtn', { hasText: 'Deposit' }).click();
  await a.page.locator('.modal h3', { hasText: 'Deposit' }).waitFor({ timeout: 10_000 });
  const dep = await a.page.locator('.modal').innerText();
  check('blocked region: the deposit dialog explains instead of offering a deposit', /not available in your region/.test(dep) && (await a.page.locator('.modal .seg-src').count()) === 0, dep.replace(/\n/g, ' | '));
  await a.page.locator('.modal .xbtn').click();
  await a.page.locator('.ticket .linkbtn', { hasText: 'Withdraw' }).click();
  check('blocked region: withdrawing stays available', await a.page.locator('.modal h3', { hasText: 'Withdraw from perps' }).waitFor({ timeout: 10_000 }).then(() => true, () => false));
  await a.context.close();

  // ---------- Allowed, statement not yet accepted ----------
  const b = await setup(browser, { perps: 'allowed', terms: false });
  const review = b.page.locator('.ticket button.btn-block', { hasText: 'Review perps terms' });
  await review.waitFor({ timeout: 20_000 });
  check('first perps trade: the ticket asks to review the perps terms', true);
  await review.click();
  const m = b.page.locator('.modal');
  await m.locator('h3', { hasText: 'Before you trade perps' }).waitFor();
  const accept = m.locator('button', { hasText: 'Accept and continue' });
  const boxes = m.locator('input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const mText = await m.innerText();
  check('the statement: three boxes (residence, terms and risks, leverage); accept stays off until all are ticked', (await boxes.count()) === 3 && (await accept.isDisabled()) && /United States/.test(mText) && /Terms of Use/.test(mText) && /Risk Disclosure/.test(mText) && /lose all the margin/.test(mText), mText.replace(/\n/g, ' | ').slice(0, 300));
  await m.screenshot({ path: path.join(OUT, '01-perps-terms.png') });
  await boxes.nth(2).check();
  await accept.click();
  await b.page.locator('.ticket button.btn-block', { hasText: 'Open long' }).waitFor({ timeout: 10_000 });
  check('after accepting: the order button, and the choice is remembered for this wallet', (await b.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('velum.perpsTerms.')).length)) === 1);
  await b.page.reload({ waitUntil: 'networkidle' });
  await b.page.locator('.walletbtn').waitFor({ timeout: 20_000 }).catch(() => undefined);
  await b.page.locator('.ticket button.btn-block', { hasText: /Open long|Connect wallet/ }).waitFor({ timeout: 20_000 });
  check('after a reload: no statement again', (await b.page.locator('.ticket button.btn-block', { hasText: 'Review perps terms' }).count()) === 0);

  // ---------- Error report from the production build ----------
  await b.page.evaluate(() => setTimeout(() => { throw new Error('Test failure for 0x92ef4c8d8df09a9ae7ed9a12409bc9a84fb70e7b'); }, 0));
  await b.page.waitForTimeout(1500);
  const rep = b.reports[0];
  check('an uncaught error is reported, with no address and no query string', !!rep && rep.message === 'Test failure for 0x…' && rep.kind === 'error' && rep.path === '/app/trade/TSLA' && !JSON.stringify(b.reports).includes('92ef4c8d'), JSON.stringify(rep));

  // ---------- Terms and risk pages ----------
  for (const [url, h] of [['/terms', 'Terms of Use'], ['/risk', 'Risk Disclosure']]) {
    await b.page.goto(`${BASE}${url}`, { waitUntil: 'load' });
    const body = await b.page.locator('main').innerText();
    check(`${url}: renders with the brand line`, (await b.page.locator('h1', { hasText: h }).count()) === 1 && /not affiliated with Robinhood/.test(body) && /Last updated/.test(body), body.slice(0, 120).replace(/\n/g, ' | '));
  }
  await b.page.goto(`${BASE}/`, { waitUntil: 'load' });
  check('landing footer links Terms of Use and Risk Disclosure', (await b.page.locator('footer a[href="/terms"]').count()) === 1 && (await b.page.locator('footer a[href="/risk"]').count()) === 1);
  await b.page.goto(`${BASE}/app/markets`, { waitUntil: 'load' });
  check('app brand line links Terms and Risks', (await b.page.locator('.app-brand a[href="/terms"]').count()) === 1 && (await b.page.locator('.app-brand a[href="/risk"]').count()) === 1);
  check('no page errors other than the test one', b.errors.filter((e) => !/Test failure/.test(e)).length === 0 && a.errors.length === 0, [...a.errors, ...b.errors].slice(0, 3).join(' | '));
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
