// Deposit into Hyperliquid straight from Robinhood Chain (ETH via Relay), in the browser: the mainnet web build, a mock
// EIP-6963 wallet on a local fork of Robinhood Chain (4663), Relay's real quote API (for this throwaway address) and
// Relay's real depository contract on the fork. What the fork cannot show is answered by models: Relay's status turns
// "success" once the depository holds the deposit on the fork, and Hyperliquid then credits the quoted USDC. Checked: the
// dialog (balances in dollars, live quote, minimum, refusals), the review, exactly one transaction on Robinhood Chain to
// the pinned depository carrying exactly the amount, the receipt, and the perps ticket funded afterwards.
//
// Run (fork on 127.0.0.1:8547, a local API for prices, the mainnet web on WEB_URL, network access to api.relay.link):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-relay.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, http } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-relay-e2e');
mkdirSync(OUT, { recursive: true });
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const chain = { id: 4663, name: 'rh-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RH] } } };
const pub = createPublicClient({ chain, transport: http(RH, { timeout: 60_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RH, { timeout: 60_000 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`) });

async function main() {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 10n ** 17n }); // 0.1 ETH on the Robinhood Chain fork
  const dep0 = await pub.getBalance({ address: DEPOSITORY });

  // Models: Relay's status and Hyperliquid's balance follow the depository on the fork.
  const m = { quotes: 0, lastOut: null, credited: 0 };
  const landed = async () => (await pub.getBalance({ address: DEPOSITORY })) > dep0;
  const state = (dex) => ({ marginSummary: { accountValue: dex ? '0.0' : String(m.credited), totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: dex ? '0.0' : String(m.credited), assetPositions: [], time: Date.now() });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await context.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.relay.link/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (rq.url().includes('/intents/status')) {
      const ok = await landed();
      if (ok && !m.credited) m.credited = Number(m.lastOut ?? 0) / 1e8;
      return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ status: ok ? 'success' : 'waiting' }) });
    }
    // Quotes: Relay's real API (fetched by Node, which goes through the machine's proxy when there is one).
    const resp = await fetch(rq.url(), { method: rq.method(), headers: { 'content-type': 'application/json' }, body: rq.method() === 'POST' ? rq.postData() : undefined });
    const body = await resp.text();
    try {
      const j = JSON.parse(body);
      if (j.details?.currencyOut?.amount) {
        m.quotes++;
        m.lastOut = j.details.currencyOut.amount;
      }
    } catch { /* error body */ }
    return r.fulfill({ status: resp.status, headers: { ...cors, 'content-type': 'application/json' }, body });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const b = JSON.parse(rq.postData() || '{}');
    const body = (() => {
      switch (b.type) {
        case 'meta': return meta;
        case 'allMids': return { 'xyz:TSLA': '384.50' };
        case 'userAbstraction': return 'default';
        case 'extraAgents': return [];
        case 'clearinghouseState': return state(b.dex);
        case 'spotClearinghouseState': return { balances: [] };
        case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: '384.50' };
        case 'userFills': return [];
        default: return null;
      }
    })();
    return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });

  const depBtn = page.locator('.ticket button.btn-block', { hasText: 'Deposit USDC' });
  await depBtn.waitFor({ timeout: 30_000 });
  check('no perps balance: the ticket offers the deposit and says Robinhood Chain works', /Robinhood Chain/.test(await page.locator('.ticket').innerText()));
  await depBtn.click();
  const dlg = page.locator('.modal');
  await dlg.locator('button[aria-pressed="true"]', { hasText: 'From Robinhood Chain' }).waitFor({ timeout: 10_000 });
  check('the dialog opens on "From Robinhood Chain", paying with ETH', (await dlg.locator('button[aria-pressed="true"]', { hasText: 'Pay with ETH' }).count()) === 1);
  await dlg.locator('.fl', { hasText: /0\.1 ETH · \$[\d,]+\.\d\d/ }).waitFor({ timeout: 30_000 });
  check('the wallet ETH on Robinhood Chain, with its dollar value', true, (await dlg.locator('.fl').first().innerText()).replace(/\n/g, ' '));
  const btn = dlg.locator('button.btn-block').first();
  await page.locator('#dep-amt').fill('0.2');
  await page.waitForTimeout(300);
  check('more than the wallet holds is refused', /Not enough ETH/.test(await btn.innerText()) && (await btn.isDisabled()), await btn.innerText());
  await page.locator('#dep-amt').fill('0.02');
  const go = dlg.locator('button', { hasText: 'Deposit 0.02 ETH' });
  await go.waitFor({ timeout: 40_000 });
  const rec = (await dlg.locator('.receipt').innerText()).replace(/\n/g, ' | ');
  check('live Relay quote: what Hyperliquid receives, the guaranteed minimum, fees, route', /You receive on Hyperliquid \| ≈ [\d.]+ USDC/.test(rec) && /Minimum \(guaranteed\) \| [\d.]+ USDC/.test(rec) && /Fees \| ≈ \$[\d.]+/.test(rec) && /Relay/.test(rec), rec);
  check('the quote came from Relay\'s real API', m.quotes > 0, String(m.quotes));
  await snap(page, 'relay-form');
  await go.click();

  const start = dlg.locator('button', { hasText: /^Deposit$/ });
  await start.waitFor({ timeout: 20_000 });
  const review = (await dlg.innerText()).replace(/\n/g, ' | ');
  check('review: 0.02 ETH from Robinhood Chain, USDC on Hyperliquid at this address, minimum, Relay', /You send \| 0\.02 ETH from your wallet on Robinhood Chain/.test(review) && /USDC in your Hyperliquid account/.test(review) && /guaranteed by Relay/.test(review) && /this same address/.test(review), review.slice(0, 400));
  check('confirm stays off until the statement is ticked', await start.isDisabled());
  await dlg.locator('input[type="checkbox"]').check();
  await snap(page, 'relay-review');
  const eth0 = await pub.getBalance({ address: me });
  await start.click();
  const done = dlg.locator('button', { hasText: 'Done' });
  const alert = dlg.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 180_000 }), alert.waitFor({ timeout: 180_000 })]);
  await sleep(300);
  const text = (await dlg.innerText()).replace(/\n/g, ' | ');
  await snap(page, 'relay-result');
  check('deposit: receipt', await done.isVisible(), text.slice(-400));
  check('steps: confirmed on Robinhood Chain, delivered by Relay', /Confirmed on Robinhood Chain/.test(text) && /USDC delivered/.test(text), text.slice(0, 400));

  // On chain: exactly one transaction, on Robinhood Chain, to the pinned depository, carrying exactly 0.02 ETH.
  check('one transaction, on Robinhood Chain', wallet.sentOn.length === 1 && wallet.sentOn[0].chainId === 4663, JSON.stringify(wallet.sentOn));
  const tx = wallet.sentOn[0] ? await pub.getTransaction({ hash: wallet.sentOn[0].hash }) : null;
  const rc = wallet.sentOn[0] ? await pub.getTransactionReceipt({ hash: wallet.sentOn[0].hash }) : null;
  check('to Relay\'s depository, exactly 0.02 ETH, succeeded', tx && tx.to.toLowerCase() === DEPOSITORY && tx.value === 2n * 10n ** 16n && rc.status === 'success', tx ? `${tx.to} ${tx.value} ${rc.status}` : 'none');
  const dep1 = await pub.getBalance({ address: DEPOSITORY });
  check('the depository received exactly 0.02 ETH on the fork', dep1 - dep0 === 2n * 10n ** 16n, String(dep1 - dep0));
  const eth1 = await pub.getBalance({ address: me });
  check('the wallet spent exactly 0.02 ETH plus gas', rc && eth0 - eth1 === 2n * 10n ** 16n + rc.gasUsed * rc.effectiveGasPrice, String(eth0 - eth1));
  await done.click();

  // The perps ticket is funded and ready.
  await page.waitForFunction(() => /\d+\.\d\d USDC/.test(document.querySelector('.ticket')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => undefined);
  check('ticket: the Hyperliquid balance shows the deposit, with "+ Deposit" for more', (await page.locator('.ticket .linkbtn', { hasText: '+ Deposit' }).count()) === 1, (await page.locator('.ticket .fl').first().innerText()).replace(/\n/g, ' '));
  await page.locator('#t-size').fill('30');
  const open = page.locator('.ticket button.btn-block', { hasText: 'Open long on Hyperliquid' });
  await open.waitFor({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('.ticket button.btn-block')].find((x) => x.textContent.includes('Open long on Hyperliquid')); return b && !b.disabled; }, null, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const look = (await open.count()) ? await open.evaluate((el) => ({ disabled: el.disabled, opacity: getComputedStyle(el).opacity })) : null;
  check('ticket: ready to open a position (button enabled)', !!look && !look.disabled && look.opacity === '1', JSON.stringify(look));
  await snap(page, 'ticket-funded');
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
