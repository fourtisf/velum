// Real perps through Hyperliquid in the browser (mainnet web build): the trade page's Perps ticket, the flow dialog and
// the positions card, with a mock EIP-6963 wallet (e2e/wallet.cjs, throwaway key) and Hyperliquid's API answered by a
// small in-test model of an account (page.route on api.hyperliquid.xyz), so nothing reaches Hyperliquid. Every
// /exchange request is checked the way Hyperliquid checks it: the signer recovered from the signature must be the
// user (approveAgent, EIP-712 on chain 0x1237) or the browser's agent (orders, leverage, transfers: L1 action hash of
// @nktkas/hyperliquid, whose hashing e2e/hyperliquid-live.e2e.ts checks against the live API), and each action must
// carry exactly the reviewed numbers. Also checked: the user's wallet signs once (the approval), the agent key never
// leaves the browser, a cancelled IOC order reads plainly and can be retried, and an account without a deposit is sent
// to Hyperliquid to deposit.
//
// Run (the mainnet web build served on WEB_URL; no Velum API needed):
//   NEXT_PUBLIC_VELUM_NETWORK=mainnet NEXT_PUBLIC_CHAIN_ID=4663 pnpm --filter @velum/web build
//   pnpm --filter @velum/web exec next start -p 3100 &
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-browser.e2e.cjs
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { recoverTypedDataAddress } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.READ_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-hyperliquid-e2e');
mkdirSync(OUT, { recursive: true });
const ZERO = '0x0000000000000000000000000000000000000000';
const MIDS = { 'xyz:TSLA': '383.93', 'xyz:NVDA': '160.1' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`), animations: 'disabled' });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

/** Hyperliquid's API for one account, as a model: balances, agents, leverage, one xyz:TSLA position, fills. */
function hyperliquid(user, { funded = true } = {}) {
  const hl = { user: user.toLowerCase(), agents: [], xyzW: funded ? 50 : 0, mainW: funded ? 500 : 0, leverage: { type: 'cross', value: 20 }, position: null, fills: [], exchange: [], orderReplies: [], unknown: [] };
  const state = (dex) =>
    dex === 'xyz'
      ? {
          marginSummary: { accountValue: String(hl.xyzW + (hl.position ? 333.25 : 0)), totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
          crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
          crossMaintenanceMarginUsed: '0',
          withdrawable: hl.xyzW.toFixed(6),
          assetPositions: hl.position ? [{ type: 'oneWay', position: hl.position }] : [],
          time: Date.now(),
        }
      : {
          marginSummary: { accountValue: hl.mainW.toFixed(6), totalNtlPos: '0', totalRawUsd: hl.mainW.toFixed(6), totalMarginUsed: '0' },
          crossMarginSummary: { accountValue: hl.mainW.toFixed(6), totalNtlPos: '0', totalRawUsd: hl.mainW.toFixed(6), totalMarginUsed: '0' },
          crossMaintenanceMarginUsed: '0',
          withdrawable: hl.mainW.toFixed(6),
          assetPositions: [],
          time: Date.now(),
        };
  hl.info = (b) => {
    switch (b.type) {
      case 'meta':
        return b.dex === 'xyz' ? meta : null;
      case 'allMids':
        return b.dex === 'xyz' ? MIDS : {};
      case 'userAbstraction':
        return 'disabled';
      case 'extraAgents':
        return hl.agents;
      case 'clearinghouseState':
        return state(b.dex);
      case 'spotClearinghouseState':
        return { balances: [] };
      case 'activeAssetData':
        return { user: b.user, coin: b.coin, leverage: hl.leverage, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: MIDS[b.coin] };
      case 'userFills':
        return hl.fills;
      case 'maxBuilderFee':
        return 0;
      default:
        hl.unknown.push(b.type);
        return null;
    }
  };
  return hl;
}

let createL1ActionHash;
/** The address that signed an /exchange request, recovered the way Hyperliquid does. */
async function signerOf(body, typedFromWallet) {
  const signature = { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) };
  if (body.action.signatureChainId) {
    // User-signed action: the EIP-712 data the wallet was asked to sign, which must describe this very action.
    const t = typedFromWallet;
    if (!t) return null;
    const { EIP712Domain: _d, ...types } = t.types;
    return (await recoverTypedDataAddress({ domain: t.domain, types, primaryType: t.primaryType, message: t.message, signature })).toLowerCase();
  }
  const connectionId = createL1ActionHash({ action: body.action, nonce: body.nonce, vaultAddress: body.vaultAddress ?? undefined, expiresAfter: body.expiresAfter ?? undefined });
  return (
    await recoverTypedDataAddress({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primaryType: 'Agent',
      message: { source: 'a', connectionId },
      signature,
    })
  ).toLowerCase();
}

async function route(context, hl, wallet) {
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(rq.postData() || '{}');
    const json = (o) => r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (rq.url().endsWith('/info')) return json(hl.info(body));
    const a = body.action;
    const typed = a.signatureChainId ? wallet.typed[wallet.typed.length - 1]?.typed : null;
    const signer = await signerOf(body, typed);
    hl.exchange.push({ type: a.type, action: a, signer, typed });
    const agent = hl.agents[0]?.address;
    const ok = () => json({ status: 'ok', response: { type: 'default' } });
    const refuse = (msg) => json({ status: 'err', response: msg });
    if (a.type === 'approveAgent') {
      if (signer !== hl.user) return refuse(`Must deposit before performing actions. User: ${signer}`);
      hl.agents = [{ address: a.agentAddress.toLowerCase(), name: a.agentName.replace(/ valid_until \d+$/, ''), validUntil: Number(a.agentName.split(' ').pop()) }];
      return ok();
    }
    if (!agent || signer !== agent) return refuse(`User or API Wallet ${signer} does not exist.`);
    if (a.type === 'agentSendAsset') {
      const amt = Number(a.amount);
      hl.mainW -= amt;
      hl.xyzW += amt;
      return ok();
    }
    if (a.type === 'updateLeverage') {
      hl.leverage = { type: a.isCross ? 'cross' : 'isolated', value: a.leverage };
      return ok();
    }
    if (a.type === 'order') {
      const o = a.orders[0];
      const reply = hl.orderReplies.shift();
      if (reply) return json({ status: 'ok', response: { type: 'order', data: { statuses: [reply] } } });
      const px = o.b ? '384.12' : '383.70';
      const oid = 4242 + hl.fills.length;
      if (o.r) {
        hl.position = null;
        hl.xyzW += 334.26;
      } else {
        const lev = hl.leverage.value;
        hl.position = {
          coin: 'xyz:TSLA',
          szi: (o.b ? '' : '-') + o.s,
          leverage: { type: 'isolated', value: lev, rawUsd: '-665.5' },
          entryPx: px,
          positionValue: (Number(o.s) * 383.93).toFixed(4),
          unrealizedPnl: '-0.49',
          returnOnEquity: '-0.0015',
          liquidationPx: o.b ? '262.9' : '499.1',
          marginUsed: (Number(o.s) * 384.12 / lev).toFixed(4),
          maxLeverage: 20,
          cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
        };
        hl.xyzW -= Number(o.s) * 384.12 / lev;
      }
      hl.fills.unshift({ coin: 'xyz:TSLA', px, sz: o.s, side: o.b ? 'B' : 'A', time: Date.now(), startPosition: '0', dir: o.r ? 'Close Long' : o.b ? 'Open Long' : 'Open Short', closedPnl: o.r ? '-1.09' : '0.0', hash: '0x' + '0'.repeat(64), oid, crossed: true, fee: '0.05', tid: oid, feeToken: 'USDC' });
      return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: o.s, avgPx: px, oid } }] } } });
    }
    return refuse(`unexpected action ${a.type}`);
  });
}

async function connect(page) {
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Test Wallet' }).click();
  await page.locator('.modal button', { hasText: 'Sign message' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
}

/** Confirms the open dialog (ticking the risk box when there is one) and waits for the receipt or a failure. */
async function confirm(page, label, confirmText) {
  const m = page.locator('.modal');
  const btn = m.locator('button', { hasText: confirmText });
  await btn.waitFor({ timeout: 20_000 });
  const review = await m.innerText();
  if ((await m.locator('input[type="checkbox"]').count()) > 0) {
    check(`${label}: confirm stays off until the risk box is ticked`, await btn.isDisabled());
    await m.locator('input[type="checkbox"]').check();
  }
  await snap(page, `${label}-review`);
  await btn.click();
  return { review, ...(await outcome(page, label)) };
}

async function outcome(page, label) {
  const m = page.locator('.modal');
  const done = m.locator('button', { hasText: 'Done' });
  const alert = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 60_000 }), alert.waitFor({ timeout: 60_000 })]);
  await sleep(200);
  const text = await m.innerText();
  const ok = await done.isVisible();
  await snap(page, `${label}-${ok ? 'receipt' : 'failed'}`);
  return { ok, text };
}

const flat = (t) => t.replace(/\s*\n\s*/g, ' | ');

async function main() {
  ({ createL1ActionHash } = await import(pathToFileURL(req.resolve('@nktkas/hyperliquid/signing')).href));
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663 });
  const hl = hyperliquid(me);
  await route(context, hl, wallet);
  const page = await context.newPage();
  const errors = [];
  const bodies = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/\/api\//.test(m.location()?.url || '') && errors.push(m.text()));
  page.on('request', (r) => r.postData() && bodies.push(r.postData()));

  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'domcontentloaded' });
  await page.locator('.demo-bar', { hasText: 'Perps are real trades from your own Hyperliquid account' }).waitFor({ timeout: 30_000 });
  check('the banner says perps are real Hyperliquid trades', true);
  await connect(page);
  await page.locator('.ticket .fl', { hasText: '550.00 USDC' }).waitFor({ timeout: 30_000 });
  check('the ticket shows the Hyperliquid balance (xyz 50 + main 500)', true);

  // Open: long 1000 USD at 3x.
  await page.locator('#t-size').fill('1000');
  await page.locator('#t-lev').fill('3');
  const openBtn = page.locator('.ticket button.btn-block', { hasText: 'Open long on Hyperliquid' });
  await openBtn.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('.ticket button.btn-block')?.hasAttribute('disabled'), null, { timeout: 20_000 });
  const sum = flat(await page.locator('.ticket .sumbox').innerText());
  check('ticket: price, position, margin, liquidation estimate', /Price \| 383\.93/.test(sum) && /Position \| 2\.604 TSLA/.test(sum) && /Margin \| 334\.26 USDC/.test(sum) && /Liquidation price \(est\.\) \| 262\.5[12]/.test(sum), sum);
  await snap(page, 'ticket-long');
  await openBtn.click();
  const o = await confirm(page, 'open-long', 'Start trade');
  check('open review: every number', /Size \| 2\.604 TSLA \(about 999\.75 USD\)/.test(flat(o.review)) && /Margin \| 334\.26 USDC/.test(flat(o.review)) && /At most 385\.84 \(0\.5% slippage\)/.test(o.review) && /Velum adds none/.test(o.review), flat(o.review).slice(0, 500));
  check('open: receipt', o.ok && /Filled \| 2\.604 TSLA/.test(flat(o.text)) && /384\.12 USDC/.test(o.text) && /#4242 on Hyperliquid/.test(o.text), flat(o.text).slice(-400));
  const ex = hl.exchange;
  check('open: approveAgent, agentSendAsset, updateLeverage, order, in that order', ex.map((e) => e.type).join(',') === 'approveAgent,agentSendAsset,updateLeverage,order', ex.map((e) => e.type).join(','));
  const agent = hl.agents[0]?.address;
  const ap = ex[0];
  check('approveAgent: signed by the user on chain 0x1237, for this agent, named velum, 30 days', ap?.signer === me.toLowerCase() && ap.action.signatureChainId === '0x1237' && ap.typed?.domain.chainId === 4663 && ap.typed?.message.agentAddress.toLowerCase() === agent && /^velum valid_until \d+$/.test(ap.action.agentName) && Math.abs(Number(ap.action.agentName.split(' ').pop()) - (Date.now() + 30 * 86_400_000)) < 600_000, JSON.stringify(ap?.action));
  check('agentSendAsset: signed by the agent, the shortfall 284.26 USDC from main to xyz, to the user', ex[1]?.signer === agent && ex[1].action.amount === '284.26' && ex[1].action.sourceDex === '' && ex[1].action.destinationDex === 'xyz' && ex[1].action.destination.toLowerCase() === me.toLowerCase(), JSON.stringify(ex[1]?.action));
  check('updateLeverage: signed by the agent, TSLA (110001), isolated, 3x', ex[2]?.signer === agent && ex[2].action.asset === 110001 && ex[2].action.isCross === false && ex[2].action.leverage === 3, JSON.stringify(ex[2]?.action));
  const ord = ex[3]?.action;
  check('order: signed by the agent, the reviewed IOC buy, no builder fee', ex[3]?.signer === agent && JSON.stringify(ord.orders) === JSON.stringify([{ a: 110001, b: true, p: '385.84', s: '2.604', r: false, t: { limit: { tif: 'Ioc' } } }]) && ord.grouping === 'na' && !ord.builder, JSON.stringify(ord));
  await page.locator('.modal button', { hasText: 'Done' }).click();

  // The position appears; close it.
  const row = page.locator('.posbox tbody tr', { hasText: 'TSLA' });
  await row.waitFor({ timeout: 20_000 });
  const rowText = flat(await row.innerText());
  check('positions: the real position with side, leverage, size, entry', /Long 3×/.test(rowText) && /2\.604/.test(rowText) && /384\.12/.test(rowText), rowText);
  await snap(page, 'position');
  await row.locator('button', { hasText: 'Close' }).click();
  const c = await confirm(page, 'close', 'Close position');
  check('close review: the whole position and its limit', /Long 2\.604 TSLA/.test(c.review) && /At least 382\.01/.test(c.review), flat(c.review));
  check('close: receipt, the agent reused (no new approval)', c.ok && /Closed \| 2\.604 TSLA/.test(flat(c.text)) && /Already done/.test(c.text), flat(c.text).slice(-300));
  const cl = hl.exchange[4];
  check('close order: signed by the agent, reduce-only IOC sell of the whole size', hl.exchange.length === 5 && cl.signer === agent && JSON.stringify(cl.action.orders) === JSON.stringify([{ a: 110001, b: false, p: '382.01', s: '2.604', r: true, t: { limit: { tif: 'Ioc' } } }]), JSON.stringify(cl?.action));
  await page.locator('.modal button', { hasText: 'Done' }).click();
  await page.locator('.posbox .empty', { hasText: 'No open positions on Hyperliquid' }).waitFor({ timeout: 20_000 });
  check('positions: empty after the close', true);

  // A cancelled IOC order reads plainly; Try again re-sends only the order.
  await page.locator('.ticket .sides button', { hasText: 'Short' }).click();
  await page.locator('#t-size').fill('100');
  const shortBtn = page.locator('.ticket button.btn-block', { hasText: 'Open short on Hyperliquid' });
  await shortBtn.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('.ticket button.btn-block')?.hasAttribute('disabled'), null, { timeout: 20_000 });
  hl.orderReplies.push({ error: 'Order could not immediately match against any resting orders. asset=110001' });
  await shortBtn.click();
  const f = await confirm(page, 'short-cancelled', 'Start trade');
  check('cancelled IOC: plain sentence, nothing traded', !f.ok && /price moved past your slippage limit/.test(f.text), flat(f.text).slice(-300));
  check('cancelled IOC: the steps before it were skipped (agent, margin, leverage already set)', (f.text.match(/Already done/g) || []).length === 3, flat(f.text));
  const before = hl.exchange.length;
  await page.locator('.modal button', { hasText: 'Try again' }).click();
  const g = await outcome(page, 'short-retry');
  check('retry: filled, only the order was sent again', g.ok && hl.exchange.length === before + 1 && hl.exchange[before].action.orders[0].b === false && hl.exchange[before].action.orders[0].s === '0.26' && hl.exchange[before].action.orders[0].p === '382.01', JSON.stringify(hl.exchange.slice(before).map((e) => e.action)));
  await page.locator('.modal button', { hasText: 'Done' }).click();

  // Activity: the fills.
  await page.locator('.posbox .ptabs button', { hasText: 'Activity' }).click();
  await page.locator('.posbox .act', { hasText: 'Open Short' }).waitFor({ timeout: 20_000 });
  check('activity: the Hyperliquid fills', (await page.locator('.posbox .act').count()) === 3);

  check("the user's wallet signed once (the agent approval) for three trades", wallet.typed.length === 1, String(wallet.typed.length));
  const pk = await page.evaluate((u) => JSON.parse(localStorage.getItem(`velum:hl-agent:${u}`) || '{}').pk, me.toLowerCase());
  check('the agent key is stored in this browser', typeof pk === 'string' && /^0x[0-9a-f]{64}$/.test(pk));
  check('the agent key was never sent anywhere', !bodies.some((b) => b.toLowerCase().includes(pk.slice(2))), String(bodies.length));
  check('no unknown Hyperliquid reads', hl.unknown.length === 0, hl.unknown.join(','));

  // Phone width: no horizontal scroll, the ticket fits.
  await page.setViewportSize({ width: 360, height: 800 });
  await sleep(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('360 px: no horizontal scroll', overflow <= 0, String(overflow));
  await page.locator('.ticket').scrollIntoViewIfNeeded();
  await snap(page, 'mobile-ticket');

  // An account without a deposit is sent to Hyperliquid first.
  const key2 = generatePrivateKey();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const wallet2 = await installWallet(ctx2, { privateKey: key2, rpc: RPC, chainId: 4663, anvilChainId: 4663 });
  const hl2 = hyperliquid(privateKeyToAccount(key2).address, { funded: false });
  await route(ctx2, hl2, wallet2);
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'domcontentloaded' });
  await connect(p2);
  const dep = p2.locator('.ticket a.btn-block', { hasText: 'Deposit USDC on Hyperliquid' });
  await dep.waitFor({ timeout: 30_000 });
  check('no deposit: the ticket links to Hyperliquid to deposit', (await dep.getAttribute('href')) === 'https://app.hyperliquid.xyz' && (await dep.getAttribute('rel')) === 'noopener noreferrer');
  check('no deposit: the positions card says so', await p2.locator('.posbox .empty', { hasText: 'No Hyperliquid account for this wallet yet' }).isVisible());
  await snap(p2, 'no-deposit');
  check('no deposit: nothing was signed or sent', wallet2.typed.length === 0 && hl2.exchange.length === 0);

  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '));
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
