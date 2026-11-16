// Deposit into Hyperliquid from inside Velum, in the browser, against the real contracts on a local Arbitrum fork: native
// USDC (0xaf88…5831) and Hyperliquid's bridge (0x2df1…3df7). The mainnet web build runs with a test wallet that knows
// two local chains (the Robinhood Chain fork and the Arbitrum fork); the page's Arbitrum RPC is answered by the fork, and
// Hyperliquid's API by a small model that credits the deposit once the bridge received it on the fork. Checked: the 5
// USDC minimum, the review, the wallet switching to Arbitrum and back, exactly one transfer of exactly the amount from
// the user to the bridge (balances on the fork), the credit wait, the receipt, and the ticket then trading-ready.
// Nothing reaches a public network or Hyperliquid.
//
// Run (forks, mainnet web build on WEB_URL with NEXT_PUBLIC_RPC_URL on the Robinhood fork, a local API for prices):
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8547
//   anvil --fork-url https://arb1.arbitrum.io/rpc --chain-id 42161 --port 8548
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-deposit.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, createWalletClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const ARB = process.env.ARB_FORK_RPC || 'http://127.0.0.1:8548';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-deposit-e2e');
mkdirSync(OUT, { recursive: true });
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const arbChain = { id: 42161, name: 'arb-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ARB] } } };
const pub = createPublicClient({ chain: arbChain, transport: http(ARB, { timeout: 60_000 }) });
const test = createTestClient({ chain: arbChain, mode: 'anvil', transport: http(ARB, { timeout: 60_000 }) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const bal = (who) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [who] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
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
  // ETH for gas on Arbitrum, and 50 USDC moved from the bridge itself (it holds millions) to the throwaway wallet.
  await test.setBalance({ address: me, value: 10n ** 16n });
  await test.impersonateAccount({ address: BRIDGE });
  await test.setBalance({ address: BRIDGE, value: 10n ** 18n });
  const w = createWalletClient({ account: BRIDGE, chain: arbChain, transport: http(ARB) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [me, 50_000000n], chain: arbChain }) });
  await test.stopImpersonatingAccount({ address: BRIDGE });
  check('funded the throwaway wallet with 50 USDC on the Arbitrum fork', (await bal(me)) === 50_000000n);
  const bridge0 = await bal(BRIDGE);

  // Hyperliquid model: nothing until the bridge has received the deposit on the fork, then the USDC is credited.
  const hl = { credited: 0, infoCalls: 0 };
  const credit = async () => {
    if (hl.credited) return;
    const got = (await bal(BRIDGE)) - bridge0;
    if (got > 0n) hl.credited = Number(got) / 1e6;
  };
  const state = (dex) => ({ marginSummary: { accountValue: dex ? '0.0' : String(hl.credited), totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: dex ? '0.0' : String(hl.credited), assetPositions: [], time: Date.now() });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, chains: { 4663: RH, 42161: ARB }, name: 'Browser Wallet' });
  await context.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://arb1.arbitrum.io/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const res = await fetch(ARB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rq.postData() });
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const b = JSON.parse(rq.postData() || '{}');
    hl.infoCalls++;
    await credit();
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
  await page.locator('.modal button', { hasText: 'Sign message' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });

  // No Hyperliquid balance yet: the ticket offers the in-app deposit (no link to another site).
  const depBtn = page.locator('.ticket button.btn-block', { hasText: 'Deposit USDC' });
  await depBtn.waitFor({ timeout: 30_000 });
  check('no deposit yet: the ticket offers "Deposit USDC" inside Velum, no external link', (await page.locator('.ticket a[href*="hyperliquid.xyz"]').count()) === 0);
  await depBtn.click();
  const m = page.locator('.modal');
  await m.locator('.fl', { hasText: '50.00 USDC' }).waitFor({ timeout: 30_000 });
  check('the dialog shows the USDC on Arbitrum', true);
  await page.locator('#dep-amt').fill('4.99');
  const btn = m.locator('button.btn-block').first();
  check('under 5 USDC is refused (Hyperliquid would lose it)', (await btn.innerText()).includes('Minimum 5 USDC') && (await btn.isDisabled()), await btn.innerText());
  await page.locator('#dep-amt').fill('80');
  check('more than the balance is refused', (await btn.innerText()).includes('Not enough USDC on Arbitrum') && (await btn.isDisabled()));
  await page.locator('#dep-amt').fill('20');
  const go = m.locator('button', { hasText: 'Deposit 20.00 USDC' });
  await go.waitFor();
  await page.waitForTimeout(400);
  const look = await go.evaluate((el) => ({ disabled: el.disabled, opacity: getComputedStyle(el).opacity }));
  check('20 USDC: the deposit button is enabled and drawn enabled', !look.disabled && look.opacity === '1', JSON.stringify(look));
  await snap(page, 'deposit-form');
  await m.locator('button', { hasText: 'Deposit 20.00 USDC' }).click();

  // Review, then run.
  const start = m.locator('button', { hasText: /^Deposit$/ });
  await start.waitFor({ timeout: 20_000 });
  const review = await m.innerText();
  check('review: amount, from Arbitrum, to the same address on Hyperliquid, minimum note', /20\.00 USDC/.test(review) && /Your wallet on Arbitrum/.test(review) && /this same address/.test(review) && /under 5 USDC are lost/.test(review), review.replace(/\n/g, ' | ').slice(0, 300));
  check('confirm stays off until the statement is ticked', await start.isDisabled());
  await m.locator('input[type="checkbox"]').check();
  await snap(page, 'deposit-review');
  await start.click();
  const done = m.locator('button', { hasText: 'Done' });
  const alert = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 240_000 }), alert.waitFor({ timeout: 240_000 })]);
  await sleep(300);
  const text = await m.innerText();
  await snap(page, 'deposit-result');
  check('deposit: receipt', await done.isVisible(), text.replace(/\n/g, ' | ').slice(-400));
  check('steps: switched to Arbitrum, confirmed, credited, switched back', /Switched to Arbitrum/.test(text) && /Confirmed on Arbitrum/.test(text) && /20\.00 USDC credited/.test(text) && /Switched back/.test(text), text.replace(/\n/g, ' | ').slice(0, 500));

  // On chain: exactly 20 USDC from the wallet to the bridge, in one transaction on Arbitrum; the wallet back on Robinhood Chain.
  const meAfter = await bal(me);
  const bridgeAfter = await bal(BRIDGE);
  check('fork: the wallet paid exactly 20 USDC', 50_000000n - meAfter === 20_000000n, String(meAfter));
  check('fork: the bridge received exactly 20 USDC', bridgeAfter - bridge0 === 20_000000n, String(bridgeAfter - bridge0));
  const arbTx = wallet.sentOn.filter((s) => s.chainId === 42161);
  check('one transaction on Arbitrum, none anywhere else', arbTx.length === 1 && wallet.sentOn.length === 1, JSON.stringify(wallet.sentOn));
  const tx = arbTx[0] ? await pub.getTransaction({ hash: arbTx[0].hash }) : null;
  check('that transaction is a USDC transfer to the bridge', tx && tx.to.toLowerCase() === USDC.toLowerCase() && tx.input.startsWith('0xa9059cbb') && tx.input.toLowerCase().includes(BRIDGE.slice(2)), tx ? tx.input.slice(0, 74) : 'none');
  check('the wallet is back on Robinhood Chain', wallet.chainId === 4663, String(wallet.chainId));
  await done.click();

  // The ticket is now funded and offers top-ups in place.
  await page.locator('.ticket .fl', { hasText: '20.00 USDC' }).waitFor({ timeout: 30_000 });
  check('ticket: the Hyperliquid balance shows the deposit, with "+ Deposit" for more', (await page.locator('.ticket .linkbtn', { hasText: '+ Deposit' }).count()) === 1);
  await page.locator('#t-size').fill('30');
  await page.locator('.ticket button.btn-block', { hasText: 'Open long on Hyperliquid' }).waitFor({ timeout: 20_000 });
  check('ticket: ready to open a position', true);
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
