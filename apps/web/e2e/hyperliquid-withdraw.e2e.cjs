// Withdrawals from the perps account, in the browser: the mainnet web build, a mock EIP-6963 wallet on a local fork of
// Robinhood Chain (it refuses typed data for another chain, like MetaMask), Relay's real quote API and its real
// /authorize (for this throwaway address: Relay itself checks Velum's signature), and a model of the user's Hyperliquid
// account that recovers the signer of every action. Relay's status turns "success" once the model received the transfer
// Relay's quote asked for. Checked: the dialog (free balance, refusals, live quotes to Robinhood Chain and Ethereum, the
// Arbitrum fee), the review, the stock perps balance freed by the agent, Relay's authorization signed on Robinhood Chain,
// one sendAsset of exactly the amount to Relay's pinned address with Relay's nonce, the exchange's own withdrawal to
// Arbitrum, no gas spent, the venue named only in the review, and the 360 px layout.
//
// Run (fork on 127.0.0.1:8547, a local API for prices, the mainnet web on WEB_URL, network access to api.relay.link):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-withdraw.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { createTestClient, http, recoverTypedDataAddress } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-withdraw-e2e');
mkdirSync(OUT, { recursive: true });
const RELAY_HL = '0x66cf0aace1b4e562593bec10ec7868fba9932224';
const USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';
const ZERO = '0x0000000000000000000000000000000000000000';
const chain = { id: 4663, name: 'rh-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RH] } } };
const test = createTestClient({ chain, mode: 'anvil', transport: http(RH, { timeout: 60_000 }) });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`) });
let createL1ActionHash;

/** The user's Hyperliquid account (standard: a main USDC balance and the xyz stock perps balance), as a model. */
function hyperliquid(user) {
  const hl = { user: user.toLowerCase(), agents: [], mainW: 4.25, xyzW: 20.5, exchange: [], sends: [], withdraws: [], moves: [], refused: [] };
  const state = (dex) => {
    const w = dex === 'xyz' ? hl.xyzW : hl.mainW;
    const s = { accountValue: w.toFixed(6), totalNtlPos: '0', totalRawUsd: w.toFixed(6), totalMarginUsed: '0' };
    return { marginSummary: s, crossMarginSummary: s, crossMaintenanceMarginUsed: '0', withdrawable: w.toFixed(6), assetPositions: [], time: Date.now() };
  };
  hl.info = (b) => {
    switch (b.type) {
      case 'meta': return b.dex === 'xyz' ? meta : null;
      case 'allMids': return b.dex === 'xyz' ? { 'xyz:TSLA': '384.50' } : {};
      case 'l2Book': {
        const lv = (k, d) => ({ px: (384.5 + d * (k * 0.02 + 0.01)).toFixed(2), sz: (1.5 + k).toFixed(3), n: 1 });
        return { coin: b.coin, time: Date.now(), levels: [Array.from({ length: 12 }, (_, k) => lv(k, -1)), Array.from({ length: 12 }, (_, k) => lv(k, 1))] };
      }
      case 'userAbstraction': return 'default';
      case 'extraAgents': return hl.agents;
      case 'clearinghouseState': return state(b.dex);
      case 'spotClearinghouseState': return { balances: [] };
      case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: '384.50' };
      case 'userFills': return [];
      case 'maxBuilderFee': return 0;
      default: return null;
    }
  };
  return hl;
}

/** The address that signed an /exchange request, recovered the way Hyperliquid does. */
async function signerOf(body, typed) {
  const signature = { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) };
  if (body.action.signatureChainId) {
    if (!typed) return null;
    const { EIP712Domain: _d, ...types } = typed.types;
    return (await recoverTypedDataAddress({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message, signature })).toLowerCase();
  }
  const connectionId = createL1ActionHash({ action: body.action, nonce: body.nonce, vaultAddress: body.vaultAddress ?? undefined, expiresAfter: body.expiresAfter ?? undefined });
  return (await recoverTypedDataAddress({ domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'a', connectionId }, signature })).toLowerCase();
}

async function routes(context, hl, wallet, relay) {
  await context.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(rq.postData() || '{}');
    const json = (o) => r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (rq.url().endsWith('/info')) return json(hl.info(body));
    const a = body.action;
    const typed = a.signatureChainId ? wallet.typed[wallet.typed.length - 1]?.typed : null;
    const signer = await signerOf(body, typed);
    hl.exchange.push({ type: a.type, action: a, signer, typed, nonce: body.nonce });
    const ok = () => json({ status: 'ok', response: { type: 'default' } });
    const refuse = (msg) => {
      hl.refused.push(msg);
      return json({ status: 'err', response: msg });
    };
    const agent = hl.agents[0]?.address;
    if (a.type === 'approveAgent') {
      if (signer !== hl.user) return refuse(`bad approveAgent signer ${signer}`);
      hl.agents = [{ address: a.agentAddress.toLowerCase(), name: 'velum', validUntil: Number(a.agentName.split(' ').pop()) }];
      return ok();
    }
    if (a.type === 'agentSendAsset') {
      if (!agent || signer !== agent) return refuse(`User or API Wallet ${signer} does not exist.`);
      if (a.destination.toLowerCase() !== hl.user || a.token !== USDC_TOKEN) return refuse('agent may only move the user\'s own USDC');
      const amt = Number(a.amount);
      if (a.sourceDex === 'xyz' && a.destinationDex === '') { hl.xyzW -= amt; hl.mainW += amt; }
      else if (a.sourceDex === '' && a.destinationDex === 'xyz') { hl.mainW -= amt; hl.xyzW += amt; }
      hl.moves.push(a);
      return ok();
    }
    if (a.type === 'sendAsset') {
      if (signer !== hl.user) return refuse(`bad sendAsset signer ${signer}`);
      const amt = Number(a.amount);
      if (a.sourceDex !== '' || amt > hl.mainW + 1e-9) return refuse('Insufficient balance for token transfer');
      hl.mainW -= amt;
      hl.sends.push({ ...a, nonce: body.nonce });
      return ok();
    }
    if (a.type === 'withdraw3') {
      if (signer !== hl.user) return refuse(`bad withdraw3 signer ${signer}`);
      const amt = Number(a.amount);
      if (amt > hl.mainW + 1e-9) return refuse('Insufficient balance for withdrawal');
      hl.mainW -= amt;
      hl.withdraws.push({ ...a, nonce: body.nonce });
      return ok();
    }
    return refuse(`unexpected action ${a.type}`);
  });
  await context.route('https://api.relay.link/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const url = rq.url();
    if (url.includes('/intents/status')) {
      // Success once the account sent Relay what the quote asked for (to its address, with its nonce).
      const done = hl.sends.some((s) => s.destination.toLowerCase() === RELAY_HL && relay.nonces.includes(s.nonce));
      return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ status: done ? 'success' : 'waiting', txHashes: done ? ['0x' + '5e'.repeat(32)] : [] }) });
    }
    // Quotes and the authorization: Relay's real API (fetched by Node, through the machine's proxy when there is one).
    const resp = await fetch(url, { method: rq.method(), headers: { 'content-type': 'application/json' }, body: rq.method() === 'POST' ? rq.postData() : undefined });
    const text = await resp.text();
    if (url.includes('/quote')) {
      relay.quotes.push(JSON.parse(rq.postData() || '{}'));
      try {
        const j = JSON.parse(text);
        const n = j.steps?.[0]?.items?.[0]?.data?.sign?.value?.nonce;
        if (n) relay.nonces.push(n);
      } catch { /* an error body */ }
    }
    if (url.includes('/authorize')) relay.authorized.push({ status: resp.status, body: JSON.parse(rq.postData() || '{}'), answer: text });
    return r.fulfill({ status: resp.status, headers: { ...cors, 'content-type': 'application/json' }, body: text });
  });
}

async function connect(page) {
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
}

async function runFlow(page, confirmText) {
  const dlg = page.locator('.modal');
  const start = dlg.locator('button.btn-block', { hasText: new RegExp(`^${confirmText}$`) });
  await start.waitFor({ timeout: 20_000 });
  const review = (await dlg.innerText()).replace(/\n/g, ' | ');
  const offFirst = await start.isDisabled();
  await dlg.locator('input[type="checkbox"]').check();
  await start.click();
  const done = dlg.locator('button', { hasText: 'Done' });
  const alert = dlg.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 120_000 }), alert.waitFor({ timeout: 120_000 })]);
  await page.waitForTimeout(300);
  return { review, offFirst, ok: await done.isVisible(), text: (await dlg.innerText()).replace(/\n/g, ' | ') };
}

async function main() {
  ({ createL1ActionHash } = await import(pathToFileURL(req.resolve('@nktkas/hyperliquid/signing')).href));
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 10n ** 16n });
  const hl = hyperliquid(me);
  const relay = { quotes: [], nonces: [], authorized: [] };

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await routes(context, hl, wallet, relay);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await connect(page);

  // ---------- The ticket offers Withdraw next to Deposit ----------
  await page.locator('.ticket .fl', { hasText: /Perps balance\s*24\.75 USDC/ }).waitFor({ timeout: 30_000 });
  const wdLink = page.locator('.ticket .linkbtn', { hasText: 'Withdraw' });
  check('ticket: "Withdraw" next to "+ Deposit" under the perps balance', (await wdLink.count()) === 1 && (await page.locator('.ticket .linkbtn', { hasText: '+ Deposit' }).count()) === 1, (await page.locator('.ticket .fl').first().innerText()).replace(/\n/g, ' '));
  await wdLink.click();
  const dlg = page.locator('.modal');
  await dlg.locator('h3', { hasText: 'Withdraw from perps' }).waitFor({ timeout: 10_000 });
  await dlg.locator('.fl', { hasText: /Free\s*24\.75 USDC/ }).waitFor({ timeout: 20_000 });
  check('dialog: Robinhood Chain and "Receive USDG" preselected, 24.75 USDC free', (await dlg.locator('button[aria-pressed="true"]', { hasText: 'Robinhood Chain' }).count()) === 1 && (await dlg.locator('button[aria-pressed="true"]', { hasText: 'Receive USDG' }).count()) === 1);
  const dialogText = await dlg.innerText();
  check('dialog: the venue is not named', !/Hyperliquid/i.test(dialogText), dialogText.replace(/\n/g, ' | ').slice(0, 300));
  const btn = dlg.locator('button.btn-block').first();
  await page.locator('#wd-amt').fill('30');
  await page.waitForTimeout(300);
  check('more than is free is refused, saying how much is free', /More than you can withdraw/.test(await btn.innerText()) && (await btn.isDisabled()) && /24\.75 USDC free/.test(await dlg.locator('.hint').innerText()), await dlg.locator('.hint').innerText());
  await page.locator('#wd-amt').fill('0.5');
  await page.waitForTimeout(300);
  check('under the Relay minimum is refused', /Minimum 1 USDC/.test(await btn.innerText()) && (await btn.isDisabled()), await btn.innerText());
  await page.locator('#wd-amt').fill('12');
  const go = dlg.locator('button.btn-block', { hasText: 'Withdraw 12.00 USDC' });
  await go.waitFor({ timeout: 40_000 });
  const rec = (await dlg.locator('.receipt').innerText()).replace(/\n/g, ' | ');
  check('live Relay quote: USDG on Robinhood Chain, guaranteed minimum, fees, route', /You receive on Robinhood Chain \| ≈ \d+\.\d\d USDG/.test(rec) && /Minimum \(guaranteed\) \| \d+\.\d\d USDG/.test(rec) && /Fees \| ≈ \$[\d.]+/.test(rec) && /Relay · to Robinhood Chain/.test(rec), rec);
  const q0 = relay.quotes[relay.quotes.length - 1];
  check("the quote came from Relay's real API, out of Hyperliquid, for exactly 12 USDC", q0 && q0.originChainId === 1337 && q0.destinationChainId === 4663 && q0.amount === '1200000000' && q0.user.toLowerCase() === me.toLowerCase(), JSON.stringify(q0));
  await snap(page, 'withdraw-form');
  await go.click();

  const r1 = await runFlow(page, 'Withdraw');
  check('review: 12 USDC from the perps account, USDG on Robinhood Chain at this address, minimum, Relay, two signatures', /You withdraw \| 12\.00 USDC from your perps account/.test(r1.review) && /USDG on Robinhood Chain/.test(r1.review) && /guaranteed by Relay/.test(r1.review) && /this same address/.test(r1.review) && /Venue \| Hyperliquid/.test(r1.review) && /Two in your wallet, no gas/.test(r1.review), r1.review.slice(0, 500));
  check('confirm stays off until the statement is ticked', r1.offFirst);
  await snap(page, 'withdraw-result');
  check('Relay withdrawal: receipt', r1.ok, r1.text.slice(-400));
  check('steps: freed 7.75 USDC, signed, sent, delivered', /Moved 7\.75 USDC to the main balance/.test(r1.text) && /Signed in your wallet/.test(r1.text) && /Sent 12\.00 USDC/.test(r1.text) && /USDG delivered on Robinhood Chain/.test(r1.text), r1.text.slice(0, 600));
  const ap = hl.exchange.find((e) => e.type === 'approveAgent');
  const mv = hl.moves[0];
  check('the stock perps balance was freed by the agent: exactly 7.75 USDC from xyz to the main balance, to this user', !!ap && mv && mv.sourceDex === 'xyz' && mv.destinationDex === '' && mv.amount === '7.75' && mv.destination.toLowerCase() === me.toLowerCase() && hl.exchange.find((e) => e.type === 'agentSendAsset').signer === hl.agents[0].address, JSON.stringify(mv));
  const auth = relay.authorized[0];
  const authTyped = wallet.typed.find((t) => t.typed.primaryType === 'NonceMapping');
  check("Relay's authorization: signed on Robinhood Chain (4663) and accepted by Relay's real API", auth && auth.status === 200 && /Success/.test(auth.answer) && auth.body.signatureChainId === 4663 && authTyped?.typed.domain.chainId === 4663 && authTyped.typed.domain.name === 'RelayNonceMapping', auth ? `${auth.status} ${auth.answer} chain ${auth.body.signatureChainId}` : 'none');
  const sent = hl.sends[0];
  const sendSig = hl.exchange.find((e) => e.type === 'sendAsset');
  check("one transfer: exactly 12 USDC from the main balance to Relay's pinned address, with Relay's nonce, signed by the user on 0x1237", hl.sends.length === 1 && sent.destination.toLowerCase() === RELAY_HL && Number(sent.amount) === 12 && sent.token === USDC_TOKEN && sent.sourceDex === '' && sent.destinationDex === '' && sent.nonce === auth.body.nonce && sendSig.signer === me.toLowerCase() && sendSig.action.signatureChainId === '0x1237', JSON.stringify(sent));
  check('balances after: main 0, stock perps 12.75', Math.abs(hl.mainW) < 1e-9 && Math.abs(hl.xyzW - 12.75) < 1e-9, `${hl.mainW} ${hl.xyzW}`);
  await dlg.locator('button', { hasText: 'Done' }).click();
  await page.locator('.ticket .fl', { hasText: /Perps balance\s*12\.75 USDC/ }).waitFor({ timeout: 20_000 }).catch(() => undefined);
  check('ticket: the balance shows what is left', /12\.75 USDC/.test(await page.locator('.ticket .fl').first().innerText()), (await page.locator('.ticket .fl').first().innerText()).replace(/\n/g, ' '));

  // ---------- Ethereum: ETH only ----------
  await page.locator('.ticket .linkbtn', { hasText: 'Withdraw' }).click();
  await dlg.locator('h3', { hasText: 'Withdraw from perps' }).waitFor();
  await dlg.locator('.seg-src button', { hasText: 'Ethereum' }).click();
  await page.locator('#wd-amt').fill('5');
  await dlg.locator('button.btn-block', { hasText: 'Withdraw 5.00 USDC' }).waitFor({ timeout: 40_000 });
  const recL1 = (await dlg.locator('.receipt').innerText()).replace(/\n/g, ' | ');
  const qL1 = relay.quotes[relay.quotes.length - 1];
  check('Ethereum: no token choice, a live quote in ETH on chain 1', (await dlg.locator('button', { hasText: 'Receive USDG' }).count()) === 0 && /You receive on Ethereum \| ≈ 0\.\d+ ETH/.test(recL1) && qL1.destinationChainId === 1 && qL1.destinationCurrency === ZERO, recL1);
  await snap(page, 'withdraw-ethereum');

  // ---------- Arbitrum: the exchange's own withdrawal ----------
  await dlg.locator('.seg-src button', { hasText: 'Arbitrum' }).click();
  await page.locator('#wd-amt').fill('1.5');
  await page.waitForTimeout(300);
  check('Arbitrum: under 2 USDC is refused (the exchange keeps 1 USDC)', /Minimum 2 USDC/.test(await dlg.locator('button.btn-block').first().innerText()), await dlg.locator('.hint').innerText());
  await page.locator('#wd-amt').fill('5.5');
  const goArb = dlg.locator('button.btn-block', { hasText: 'Withdraw 5.50 USDC' });
  await goArb.waitFor({ timeout: 10_000 });
  const recArb = (await dlg.locator('.receipt').innerText()).replace(/\n/g, ' | ');
  check('Arbitrum: 4.50 USDC arrives, 1 USDC fee, direct route', /You receive on Arbitrum \| 4\.50 USDC/.test(recArb) && /Fee \| 1 USDC/.test(recArb) && /Direct to Arbitrum/.test(recArb), recArb);
  const typedBefore = wallet.typed.length;
  await goArb.click();
  const r2 = await runFlow(page, 'Withdraw');
  check('Arbitrum review: 5.50 USDC, 4.50 arrives, the fee, about 5 minutes', /You withdraw \| 5\.50 USDC/.test(r2.review) && /You receive \| 4\.50 USDC on Arbitrum/.test(r2.review) && /1 USDC, charged by the exchange/.test(r2.review) && /about 5 minutes/.test(r2.review), r2.review.slice(0, 400));
  check('Arbitrum withdrawal: receipt', r2.ok && /on its way to Arbitrum/.test(r2.text), r2.text.slice(-300));
  const wd = hl.withdraws[0];
  const wdSig = hl.exchange.find((e) => e.type === 'withdraw3');
  check("withdraw3: exactly 5.5 USDC to this address, signed by the user on 0x1237 (the agent's move needed no new signature)", hl.withdraws.length === 1 && wd.destination.toLowerCase() === me.toLowerCase() && wd.amount === '5.5' && wdSig.signer === me.toLowerCase() && wdSig.action.signatureChainId === '0x1237' && wallet.typed.length === typedBefore + 1 && hl.moves.length === 2 && hl.moves[1].amount === '5.5', JSON.stringify(wd));
  check('no gas: nothing was sent on chain', wallet.sent.length === 0, String(wallet.sent.length));
  check('the exchange refused nothing', hl.refused.length === 0, hl.refused.join(' | '));
  await snap(page, 'withdraw-arb');
  await dlg.locator('button', { hasText: 'Done' }).click();

  // ---------- Portfolio entry ----------
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: 'load' });
  const pfBtn = page.locator('.pf-actions button', { hasText: 'Withdraw from perps' });
  await pfBtn.waitFor({ timeout: 20_000 });
  await pfBtn.click();
  check('Portfolio: "Withdraw from perps" opens the dialog', await dlg.locator('h3', { hasText: 'Withdraw from perps' }).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---------- 360 px ----------
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const hl2 = hyperliquid(me);
  const wallet2 = await installWallet(ctx2, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await routes(ctx2, hl2, wallet2, { quotes: [], nonces: [], authorized: [] });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await connect(p2);
  const line = p2.locator('.ticket .fl', { hasText: /Perps balance/ });
  await line.waitFor({ timeout: 30_000 });
  await line.scrollIntoViewIfNeeded();
  const fit = await line.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, h: Math.round(el.getBoundingClientRect().height) }));
  await p2.locator('aside.ticket').screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-ticket-360.png`) });
  await p2.locator('.ticket .linkbtn', { hasText: 'Withdraw' }).click();
  const d2 = p2.locator('.modal');
  await d2.locator('.fl', { hasText: /Free\s*24\.75 USDC/ }).waitFor({ timeout: 20_000 });
  await p2.locator('#wd-amt').fill('12');
  await d2.locator('button.btn-block', { hasText: 'Withdraw 12.00 USDC' }).waitFor({ timeout: 40_000 });
  const pageOver = await p2.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const modalOver = await d2.evaluate((el) => el.scrollWidth - el.clientWidth);
  await d2.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-withdraw-360.png`) });
  check('360 px: the balance line fits, the dialog and page do not overflow', fit.over <= 0 && pageOver <= 0 && modalOver <= 0, `line ${JSON.stringify(fit)} page ${pageOver} modal ${modalOver}`);
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
