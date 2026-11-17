// Perps risk tools in the browser: the mainnet web build, a mock EIP-6963 wallet on a local fork of Robinhood Chain and a
// model of the user's Hyperliquid account that recovers the signer of every action and keeps positions, resting limit
// orders and TP/SL triggers. Checked: a market long with take profit and stop loss (the order, then position TP/SL sized
// to the position), the TP/SL shown on the position and under Orders, replacing the take profit, adding margin (the
// liquidation price moves away), closing half, a resting limit order and its cancel, cancelling all, the 360 px layout,
// no unknown reads, no page errors, and the venue named only in reviews.
//
// Run (fork on 127.0.0.1:8547, a local API for prices, the mainnet web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-risk.e2e.cjs
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
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-risk-e2e');
mkdirSync(OUT, { recursive: true });
const ZERO = '0x0000000000000000000000000000000000000000';
const TSLA = 'xyz:TSLA';
const MID = 384;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
let shot = 0;
const snap = (page, label) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`) });
const flat = (t) => t.replace(/\s*\n\s*/g, ' | ');
let createL1ActionHash;

/** The user's account: one isolated TSLA position at most, resting limit orders and TP/SL triggers. */
function hyperliquid(user) {
  const hl = { user: user.toLowerCase(), agents: [], usdc: 2000, lev: { type: 'cross', value: 20 }, pos: null, orders: [], oid: 500, exchange: [], unknown: [] };
  const mm = 1 / 20; // max leverage 10
  const liq = (p) => (p.long ? p.entry - (p.margin - mm * p.size * p.entry) / p.size / (1 - mm) : p.entry + (p.margin - mm * p.size * p.entry) / p.size / (1 + mm));
  const position = () => {
    const p = hl.pos;
    if (!p) return null;
    const pnl = (MID - p.entry) * p.size * (p.long ? 1 : -1);
    return { coin: TSLA, szi: (p.long ? '' : '-') + p.size.toFixed(3), leverage: { type: 'isolated', value: p.lev, rawUsd: '0' }, entryPx: p.entry.toFixed(2), positionValue: (p.size * MID).toFixed(4), unrealizedPnl: pnl.toFixed(6), returnOnEquity: (pnl / p.margin).toFixed(6), liquidationPx: liq(p).toFixed(2), marginUsed: (p.margin + pnl).toFixed(6), maxLeverage: 10, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } };
  };
  const free = () => hl.usdc - (hl.pos ? hl.pos.margin : 0) - hl.orders.filter((o) => o.kind === 'limit').reduce((n, o) => n + (o.sz * o.px) / o.lev, 0);
  hl.info = (b) => {
    switch (b.type) {
      case 'meta': return b.dex === 'xyz' ? meta : null;
      case 'allMids': return b.dex === 'xyz' ? { [TSLA]: MID.toFixed(2) } : {};
      case 'l2Book': {
        const lv = (k, d) => ({ px: (MID + d * (k * 0.02 + 0.01)).toFixed(2), sz: (1.5 + k).toFixed(3), n: 1 });
        return { coin: b.coin, time: Date.now(), levels: [Array.from({ length: 12 }, (_, k) => lv(k, -1)), Array.from({ length: 12 }, (_, k) => lv(k, 1))] };
      }
      case 'userAbstraction': return 'disabled';
      case 'extraAgents': return hl.agents;
      case 'clearinghouseState': {
        if (b.dex !== 'xyz') return { marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '0.0', assetPositions: [], time: Date.now() };
        const p = position();
        const s = { accountValue: hl.usdc.toFixed(6), totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' };
        return { marginSummary: s, crossMarginSummary: s, crossMaintenanceMarginUsed: '0', withdrawable: Math.max(0, free()).toFixed(6), assetPositions: p ? [{ type: 'oneWay', position: p }] : [], time: Date.now() };
      }
      case 'spotClearinghouseState': return { balances: [] };
      case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: hl.lev, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: MID.toFixed(2) };
      case 'userFills': return [];
      case 'maxBuilderFee': return 0;
      case 'frontendOpenOrders':
        return hl.orders.map((o) => ({ coin: TSLA, side: o.isBuy ? 'B' : 'A', limitPx: o.limitPx, sz: o.position ? '0.0' : o.sz.toFixed(3), oid: o.oid, timestamp: o.time, origSz: o.position ? '0.0' : o.sz.toFixed(3), triggerCondition: o.trigger ? `Price ${o.kind === 'tp' ? 'above' : 'below'} ${o.triggerPx}` : 'N/A', isTrigger: !!o.trigger, triggerPx: o.trigger ? o.triggerPx : '0.0', children: [], isPositionTpsl: !!o.position, reduceOnly: !!o.reduceOnly, orderType: o.kind === 'tp' ? 'Take Profit Market' : o.kind === 'sl' ? 'Stop Market' : 'Limit', tif: o.trigger ? null : 'Gtc', cloid: null }));
      default:
        hl.unknown.push(b.type);
        return null;
    }
  };
  return hl;
}

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

async function routes(context, hl, wallet) {
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
    hl.exchange.push({ type: a.type, action: a, signer });
    const refuse = (msg) => json({ status: 'err', response: msg });
    if (a.type === 'approveAgent') {
      if (signer !== hl.user) return refuse('bad signer');
      hl.agents = [{ address: a.agentAddress.toLowerCase(), name: 'velum', validUntil: Number(a.agentName.split(' ').pop()) }];
      return json({ status: 'ok', response: { type: 'default' } });
    }
    if (!hl.agents[0] || signer !== hl.agents[0].address) return refuse(`User or API Wallet ${signer} does not exist.`);
    if (a.type === 'updateLeverage') {
      hl.lev = { type: a.isCross ? 'cross' : 'isolated', value: a.leverage };
      return json({ status: 'ok', response: { type: 'default' } });
    }
    if (a.type === 'updateIsolatedMargin') {
      if (!hl.pos) return refuse('No position');
      hl.pos.margin += a.ntli / 1e6;
      return json({ status: 'ok', response: { type: 'default' } });
    }
    if (a.type === 'cancel') {
      const statuses = a.cancels.map((c) => {
        const i = hl.orders.findIndex((o) => o.oid === c.o);
        if (i < 0) return { error: 'Order was never placed, already canceled, or filled.' };
        hl.orders.splice(i, 1);
        return 'success';
      });
      return json({ status: 'ok', response: { type: 'cancel', data: { statuses } } });
    }
    if (a.type === 'order') {
      const statuses = [];
      for (const [i, o] of a.orders.entries()) {
        const oid = ++hl.oid;
        if (o.t.trigger) {
          hl.orders.push({ oid, kind: o.t.trigger.tpsl, isBuy: o.b, sz: Number(o.s), px: Number(o.p), limitPx: o.p, trigger: true, triggerPx: o.t.trigger.triggerPx, reduceOnly: o.r, position: a.grouping === 'positionTpsl', time: Date.now() + i });
          statuses.push(a.grouping === 'normalTpsl' ? 'waitingForFill' : 'waitingForTrigger');
          continue;
        }
        if (o.t.limit.tif === 'Gtc') {
          hl.orders.push({ oid, kind: 'limit', isBuy: o.b, sz: Number(o.s), px: Number(o.p), limitPx: o.p, lev: hl.lev.value, reduceOnly: o.r, time: Date.now() + i });
          statuses.push({ resting: { oid } });
          continue;
        }
        // IOC at the mid.
        const sz = Number(o.s);
        if (o.r) {
          if (!hl.pos) { statuses.push({ error: 'Reduce only order would increase position.' }); continue; }
          const share = sz / hl.pos.size;
          hl.pos.margin *= 1 - share;
          hl.pos.size = Math.round((hl.pos.size - sz) * 1000) / 1000;
          if (hl.pos.size <= 0) { hl.pos = null; hl.orders = hl.orders.filter((x) => !x.position); }
        } else {
          hl.pos = { long: o.b, size: sz, entry: MID, lev: hl.lev.value, margin: (sz * MID) / hl.lev.value };
        }
        statuses.push({ filled: { totalSz: o.s, avgPx: MID.toFixed(2), oid } });
      }
      return json({ status: 'ok', response: { type: 'order', data: { statuses } } });
    }
    return refuse(`unexpected action ${a.type}`);
  });
}

async function connect(page) {
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
}

/** Confirms the flow dialog now open (ticking the statement when there is one) and waits for the receipt or a failure. */
async function confirm(page, confirmText) {
  const m = page.locator('.modal');
  const btn = m.locator('button.btn-block', { hasText: new RegExp(`^${confirmText}$`) });
  await btn.waitFor({ timeout: 20_000 });
  const review = flat(await m.innerText());
  if ((await m.locator('input[type="checkbox"]').count()) > 0) await m.locator('input[type="checkbox"]').check();
  await btn.click();
  const done = m.locator('button', { hasText: 'Done' });
  const alert = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 60_000 }), alert.waitFor({ timeout: 60_000 })]);
  await page.waitForTimeout(200);
  const ok = await done.isVisible();
  const text = flat(await m.innerText());
  if (ok) await done.click();
  await m.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  return { review, ok, text };
}

const lastOrder = (hl) => [...hl.exchange].reverse().find((e) => e.type === 'order');

async function main() {
  ({ createL1ActionHash } = await import(pathToFileURL(req.resolve('@nktkas/hyperliquid/signing')).href));
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const hl = hyperliquid(me);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await routes(context, hl, wallet);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await connect(page);
  await page.locator('.ticket .fl', { hasText: /Perps balance\s*2,000\.00 USDC/ }).waitFor({ timeout: 30_000 });

  // ---------- 1. Market long with TP/SL ----------
  check('ticket: Market / Limit order types, Market first', (await page.locator('[aria-label="Order type"] button[aria-pressed="true"]', { hasText: 'Market' }).count()) === 1);
  await page.locator('#t-size').fill('1000');
  const lev = page.locator('#t-lev');
  await lev.focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('.tpsl-toggle input').check();
  await page.locator('#t-tp').fill('420');
  await page.locator('#t-sl').fill('390');
  await page.waitForTimeout(300);
  const badSl = page.locator('.ticket button.btn-block');
  check('a stop loss above a long\'s entry is refused, saying why', /Check the stop loss/.test(await badSl.innerText()) && (await badSl.isDisabled()) && /stops below its entry/.test(await page.locator('.ticket .hint').innerText()), await page.locator('.ticket .hint').innerText());
  await page.locator('#t-sl').fill('360');
  const openBtn = page.locator('.ticket button.btn-block', { hasText: 'Open long' });
  await openBtn.waitFor({ timeout: 20_000 });
  const est = flat(await page.locator('.tpsl-grid').innerText());
  check('TP/SL: the P&L at each trigger, in dollars', /\+\$93\.\d\d at trigger/.test(est) && /-\$62\.\d\d at trigger/.test(est), est);
  await snap(page, 'ticket-tpsl');
  await openBtn.click();
  const o1 = await confirm(page, 'Start trade');
  check('review: market order, the take profit and stop loss with their P&L', /Order \| Market, fills now/.test(o1.review) && /Take profit \| 420 \(P&L about \+\$93/.test(o1.review) && /Stop loss \| 360 \(P&L about -\$62/.test(o1.review), o1.review.slice(0, 500));
  check('market + TP/SL: receipt after the fill and the TP/SL step', o1.ok && /Set take profit and stop loss/.test(o1.text) && /TP 420 · SL 360/.test(o1.text), o1.text.slice(0, 500));
  const orders1 = hl.exchange.filter((e) => e.type === 'order');
  const ioc = orders1[0].action;
  const tpsl = orders1[1].action;
  check('the order: one IOC buy of 2.604 TSLA, no triggers attached', ioc.grouping === 'na' && ioc.orders.length === 1 && ioc.orders[0].t.limit.tif === 'Ioc' && ioc.orders[0].s === '2.604', JSON.stringify(ioc.orders));
  check('then position TP/SL: two reduce-only trigger sells sized to the position (2.604), TP 420 and SL 360, signed by the agent', tpsl.grouping === 'positionTpsl' && tpsl.orders.length === 2 && tpsl.orders.every((o) => o.r === true && o.b === false && o.s === '2.604') && tpsl.orders[0].t.trigger.tpsl === 'tp' && tpsl.orders[0].t.trigger.triggerPx === '420' && tpsl.orders[1].t.trigger.tpsl === 'sl' && tpsl.orders[1].t.trigger.triggerPx === '360' && orders1[1].signer === hl.agents[0].address, JSON.stringify(tpsl.orders));

  // ---------- 2. TP/SL on the position and under Orders ----------
  const row = page.locator('.posbox tbody tr', { hasText: 'TSLA' });
  await row.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => /420\.00\s*\/\s*360\.00/.test(document.querySelector('.posbox .tpsl-cell')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => undefined);
  check('the position shows its TP / SL', /420\.00\s*\/\s*360\.00/.test(await row.locator('.tpsl-cell').innerText()), await row.locator('.tpsl-cell').innerText());
  check('the position offers TP/SL, Margin and Close', (await row.locator('button', { hasText: 'TP/SL' }).count()) === 1 && (await row.locator('button', { hasText: 'Margin' }).count()) === 1 && (await row.locator('button', { hasText: 'Close' }).count()) === 1);
  await page.locator('.posbox .ptabs button', { hasText: 'Orders' }).click();
  await page.locator('.orders-tbl tbody tr').nth(1).waitFor({ timeout: 20_000 });
  const ordersText = flat(await page.locator('.orders-tbl').innerText());
  check('Orders: the take profit and the stop loss, on the position', /Take profit/.test(ordersText) && /Stop loss/.test(ordersText) && /Position/.test(ordersText) && /420\.00/.test(ordersText) && /360\.00/.test(ordersText) && /Cancel all/.test(ordersText), ordersText);
  await snap(page, 'orders');
  await page.locator('.posbox .ptabs button', { hasText: 'Positions' }).click();

  // ---------- 3. Replace the take profit ----------
  await row.locator('button', { hasText: 'TP/SL' }).click();
  const dlg = page.locator('.modal');
  await dlg.locator('.receipt', { hasText: /Take profit now\s*420\.00/ }).waitFor({ timeout: 20_000 });
  await page.locator('#m-tp').fill('430');
  await dlg.locator('button.btn-block', { hasText: 'Set TP/SL' }).click();
  const t1 = await confirm(page, 'Set TP/SL');
  const cancel1 = hl.exchange.filter((e) => e.type === 'cancel').pop();
  const tp2 = lastOrder(hl).action;
  check('replacing the TP: the review names what it replaces; the old TP cancelled, the new one set on the position', t1.ok && /Replaces \| Take profit at 420/.test(t1.review) && cancel1 && cancel1.action.cancels.length === 1 && tp2.grouping === 'positionTpsl' && tp2.orders.length === 1 && tp2.orders[0].t.trigger.triggerPx === '430' && hl.orders.filter((o) => o.kind === 'tp').length === 1, `${t1.review.slice(0, 200)} ${JSON.stringify(cancel1?.action)}`);

  // ---------- 4. Add margin ----------
  const liq0 = Number(await row.locator('td').nth(3).innerText().then((t) => t.replace(/,/g, '')));
  await row.locator('button', { hasText: 'Margin' }).click();
  await dlg.locator('button[aria-pressed="true"]', { hasText: 'Add margin' }).waitFor({ timeout: 20_000 });
  await page.locator('#mg-amt').fill('50');
  await page.waitForTimeout(300);
  const mgText = flat(await dlg.locator('.receipt').last().innerText());
  await dlg.locator('button.btn-block', { hasText: 'Add margin' }).click();
  const m1 = await confirm(page, 'Add margin');
  const mg = hl.exchange.filter((e) => e.type === 'updateIsolatedMargin').pop();
  check('add margin: exactly 50 USDC (ntli 50,000,000) to the long, signed by the agent', m1.ok && mg && mg.action.ntli === 50_000_000 && mg.action.isBuy === true && mg.signer === hl.agents[0].address, JSON.stringify(mg?.action));
  await page.waitForTimeout(6500);
  const liq1 = Number(await row.locator('td').nth(3).innerText().then((t) => t.replace(/,/g, '')));
  check('the liquidation price moved away (estimate shown before, exchange value after)', liq1 < liq0 && /Liquidation after \(est\.\) \| [\d,.]+/.test(mgText), `${liq0} -> ${liq1} | ${mgText}`);

  // ---------- 5. Close half ----------
  await row.locator('button', { hasText: 'Close' }).click();
  await dlg.locator('button', { hasText: '50%' }).click();
  await page.waitForTimeout(200);
  await dlg.locator('button.btn-block', { hasText: 'Close 50%' }).click();
  const c1 = await confirm(page, 'Close 50%');
  const half = lastOrder(hl).action.orders[0];
  check('close 50%: a reduce-only IOC sell of 1.302 TSLA; the position halves', c1.ok && half.r === true && half.b === false && half.s === '1.302' && half.t.limit.tif === 'Ioc' && Math.abs(hl.pos.size - 1.302) < 1e-9, JSON.stringify(half));

  // ---------- 6. A resting limit order, then cancel it ----------
  await page.locator('[aria-label="Order type"] button', { hasText: 'Limit' }).click();
  await page.locator('#t-limit').waitFor();
  check('limit: the price starts at the mid, slippage hidden', (await page.locator('#t-limit').inputValue()) === '384.00' && (await page.locator('[aria-label="Slippage"]').count()) === 0, await page.locator('#t-limit').inputValue());
  await page.locator('.tpsl-toggle input').uncheck();
  await page.locator('#t-limit').fill('350');
  await page.locator('#t-size').fill('500');
  const limBtn = page.locator('.ticket button.btn-block', { hasText: 'Place limit long' });
  await limBtn.waitFor({ timeout: 20_000 });
  await limBtn.click();
  const l1 = await confirm(page, 'Place order');
  const lim = lastOrder(hl).action.orders[0];
  check('limit order: review says good until cancelled; one Gtc buy at 350, resting', l1.ok && /Order \| Limit at 350, good until cancelled/.test(l1.review) && lim.t.limit.tif === 'Gtc' && lim.p === '350' && lim.b === true && /resting/.test(l1.text), `${JSON.stringify(lim)} ${l1.text.slice(-200)}`);
  await page.locator('.posbox .ptabs button', { hasText: 'Orders' }).click();
  const limRow = page.locator('.orders-tbl tbody tr', { hasText: 'Limit' });
  await limRow.waitFor({ timeout: 20_000 });
  await limRow.locator('button', { hasText: 'Cancel' }).click();
  const x1 = await confirm(page, 'Cancel order');
  const cx = hl.exchange.filter((e) => e.type === 'cancel').pop();
  check('cancel: exactly that order, gone from Orders', x1.ok && cx.action.cancels.length === 1 && cx.action.cancels[0].a === 110001 && hl.orders.every((o) => o.kind !== 'limit'), JSON.stringify(cx.action));

  // ---------- 7. Cancel all ----------
  await page.waitForTimeout(500);
  await page.locator('.orders-tbl button', { hasText: 'Cancel all' }).click();
  const x2 = await confirm(page, 'Cancel all');
  check('cancel all: both triggers cancelled in one action', x2.ok && hl.exchange.filter((e) => e.type === 'cancel').pop().action.cancels.length === 2 && hl.orders.length === 0, JSON.stringify(hl.orders));

  const main = await page.locator('main').innerText();
  check('the venue is not named on the page', !/Hyperliquid/.test(main));
  check('no unknown reads', hl.unknown.length === 0, hl.unknown.join(','));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('one wallet signature in all (enabling trading)', wallet.typed.length === 1, String(wallet.typed.length));

  // ---------- 8. 360 px ----------
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const hl2 = hyperliquid(me);
  hl2.pos = { long: true, size: 2.604, entry: 380, lev: 3, margin: 330 };
  hl2.orders = [{ oid: 1, kind: 'tp', isBuy: false, sz: 0, px: 378, limitPx: '378', trigger: true, triggerPx: '420', reduceOnly: true, position: true, time: 2 }];
  const w2 = await installWallet(ctx2, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await routes(ctx2, hl2, w2);
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await connect(p2);
  await p2.locator('.tpsl-toggle input').check();
  await p2.locator('.posbox tbody tr', { hasText: 'TSLA' }).waitFor({ timeout: 20_000 });
  const over = await p2.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await p2.locator('aside.ticket').screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-ticket-360.png`) });
  await p2.locator('.posbox').screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-positions-360.png`) });
  check('360 px: the page does not overflow', over <= 0, String(over));
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
