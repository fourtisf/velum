// Records the product footage of the Velum introduction video: the real mainnet web build, a throwaway wallet, real
// Uniswap swaps on a local fork of Robinhood Chain (buy and sell TSLA), and real perps flows against a model of the
// user's Hyperliquid account (open a 3x long, an ILLUSTRATIVE price rise, close in profit; nothing reaches
// Hyperliquid). An animated cursor is drawn into the page; frames come from Chrome's screencast at 2880x1620 (so the
// edit can zoom to 1.5x and stay sharp at 1080p) and are assembled into footage.mp4. marks.json holds, on the footage
// clock: scene marks, focus rectangles (CSS px of the 1440x810 viewport) for the edit's zooms, captions (drawn by the
// edit, so zooms never crop them) and idle stretches the edit shortens.
//
// Needs: the web (mainnet build, NEXT_PUBLIC_RPC_URL on the fork, NEXT_PUBLIC_API_URL on a local API) on WEB_URL,
// anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 on FORK_RPC, and the API with live
// mainnet prices. Run: NODE_USE_ENV_PROXY=1 node design/marketing/video/record-demo.cjs
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../../..');
const WEB = path.join(ROOT, 'apps/web');
const req = createRequire(path.join(WEB, 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, createWalletClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require(path.join(WEB, 'e2e/wallet.cjs'));
const meta = require(path.join(ROOT, 'apps/workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json')).body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
const FRAMES = path.join(OUT, 'frames');
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const HOLDER = '0xb349fb08c2712f3a70bad40a4d006b68d67e888b';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

// ---------- Hyperliquid account model (unified account: one USDC balance) ----------
function hyperliquid(mids) {
  const hl = { agents: [], usdc: 2500, leverage: { type: 'cross', value: 10 }, pos: null, fills: [], mids: { ...mids }, oid: 48213 };
  const mid = () => Number(hl.mids['xyz:TSLA']);
  const position = () => {
    if (!hl.pos) return null;
    const p = hl.pos;
    const m = mid();
    const pnl = (m - p.entry) * p.size;
    const lev = p.lev;
    const mm = 1 / 40;
    const liq = (p.entry * (1 - 1 / lev)) / (1 - mm);
    return {
      coin: 'xyz:TSLA', szi: p.size.toFixed(3), leverage: { type: 'isolated', value: lev, rawUsd: (-(p.size * p.entry) + p.margin).toFixed(6) },
      entryPx: p.entry.toFixed(2), positionValue: (p.size * m).toFixed(4), unrealizedPnl: pnl.toFixed(6), returnOnEquity: (pnl / p.margin).toFixed(10),
      liquidationPx: liq.toFixed(4), marginUsed: (p.margin + pnl).toFixed(6), maxLeverage: 20, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
    };
  };
  hl.info = (b) => {
    switch (b.type) {
      case 'meta': return b.dex === 'xyz' ? meta : null;
      case 'allMids': return b.dex === 'xyz' ? hl.mids : {};
      case 'userAbstraction': return 'unifiedAccount';
      case 'extraAgents': return hl.agents;
      case 'clearinghouseState': {
        const p = b.dex === 'xyz' ? position() : null;
        return { marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' }, crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' }, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions: p ? [{ type: 'oneWay', position: p }] : [], time: Date.now() };
      }
      case 'spotClearinghouseState': return { balances: [{ coin: 'USDC', token: 0, total: hl.usdc.toFixed(8), hold: (hl.pos ? hl.pos.margin : 0).toFixed(8), entryNtl: '0.0' }] };
      case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: hl.leverage, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: hl.mids[b.coin] };
      case 'userFills': return hl.fills;
      case 'maxBuilderFee': return 0;
      default: return null;
    }
  };
  hl.exchange = (a) => {
    const ok = { status: 'ok', response: { type: 'default' } };
    if (a.type === 'approveAgent') { hl.agents = [{ address: a.agentAddress.toLowerCase(), name: 'velum', validUntil: Number(a.agentName.split(' ').pop()) }]; return ok; }
    if (a.type === 'updateLeverage') { hl.leverage = { type: a.isCross ? 'cross' : 'isolated', value: a.leverage }; return ok; }
    if (a.type === 'order') {
      const o = a.orders[0];
      const m = mid();
      const px = Math.round((o.b ? m * 1.0002 : m * 0.9998) * 100) / 100;
      const sz = Number(o.s);
      const oid = ++hl.oid;
      let dir = o.b ? 'Open Long' : 'Open Short';
      let closedPnl = '0.0';
      if (o.r && hl.pos) {
        const pnl = (px - hl.pos.entry) * hl.pos.size;
        hl.usdc += pnl - px * sz * 0.00045;
        closedPnl = pnl.toFixed(6);
        dir = 'Close Long';
        hl.pos = null;
      } else {
        const lev = hl.leverage.value;
        hl.pos = { size: sz, entry: px, lev, margin: (sz * px) / lev };
        hl.usdc -= px * sz * 0.00045;
      }
      hl.fills.unshift({ coin: 'xyz:TSLA', px: px.toFixed(2), sz: o.s, side: o.b ? 'B' : 'A', time: Date.now(), startPosition: '0', dir, closedPnl, hash: '0x' + '0'.repeat(64), oid, crossed: true, fee: (px * sz * 0.00045).toFixed(6), tid: oid, feeToken: 'USDC' });
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: o.s, avgPx: px.toFixed(2), oid } }] } } };
    }
    return { status: 'err', response: `unexpected action ${a.type}` };
  };
  hl.mid = mid;
  return hl;
}

// ---------- Overlay drawn into the page: cursor, click ripple, lower-third caption, demo tag ----------
const OVERLAY = `(() => {
  const css = \`
  #vd-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform var(--vd-ms,700ms) cubic-bezier(.22,.8,.2,1);filter:drop-shadow(0 4px 10px rgba(0,0,0,.55))}
  #vd-ripple{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid #8F96FF;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.3)}
  #vd-ripple.go{animation:vdr .55s ease-out}
  @keyframes vdr{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.4)}}
  \`;
  function boot(){
    if (document.getElementById('vd-cursor')) return;
    const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);
    const c=document.createElement('div'); c.id='vd-cursor';
    c.innerHTML='<svg viewBox="0 0 26 26" width="26" height="26"><path d="M5 3l15 9.2-6.6 1.4L10 20z" fill="#fff" stroke="#0B0C10" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const r=document.createElement('div'); r.id='vd-ripple';
    document.body.append(c,r);
    const p=window.__vdPos||{x:1100,y:620}; c.style.setProperty('--vd-ms','0ms'); c.style.transform='translate('+p.x+'px,'+p.y+'px)';
  }
  window.__vd={
    move(x,y,ms){ boot(); const c=document.getElementById('vd-cursor'); c.style.setProperty('--vd-ms',ms+'ms'); c.style.transform='translate('+x+'px,'+y+'px)'; window.__vdPos={x,y}; },
    click(){ const p=window.__vdPos||{x:0,y:0}; const r=document.getElementById('vd-ripple'); r.style.left=(p.x+4)+'px'; r.style.top=(p.y+4)+'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); },
  };
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();`;

async function main() {
  // Live Hyperliquid mids, so the perps ticket starts at the real price (the model moves it later).
  let mids = Object.fromEntries(['TSLA', 'NVDA', 'PLTR', 'COIN', 'META', 'AAPL', 'MSFT', 'AMZN', 'AMD', 'NFLX'].map((s) => [`xyz:${s}`, '100']));
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids', dex: 'xyz' }) });
    const live = await r.json();
    for (const k of Object.keys(mids)) if (typeof live[k] === 'string') mids[k] = live[k];
  } catch (e) {
    console.warn('live mids unavailable, using the API price', e.message);
  }
  const hl = hyperliquid(mids);
  const startMid = hl.mid();
  console.log('TSLA mid', startMid);

  // Throwaway wallet on the fork: ETH for gas and USDG from a pool the trades do not route through.
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 10n ** 17n });
  const have = await pub.readContract({ address: USDG, abi: ERC20, functionName: 'balanceOf', args: [HOLDER] });
  const fund = have >= 2_000_000000n ? 1_000_000000n : 300_000000n;
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: 10n ** 18n });
  const w = createWalletClient({ account: HOLDER, chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: ERC20, functionName: 'transfer', args: [me, fund], chain }) });
  await test.stopImpersonatingAccount({ address: HOLDER });
  const buyAmt = fund >= 1_000_000000n ? '500' : '200';
  console.log('funded', Number(fund) / 1e6, 'USDG; buying', buyAmt);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
  await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await context.addInitScript(OVERLAY);
  // The local API runs on another port than the web, and browsers hide the Date header of cross-origin answers, which
  // the web needs to trust a price (lib/markets.ts readApiMarket). In production the API is same-origin behind Nginx.
  await context.route(`${API}/**`, async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(rq.postData() || '{}');
    const res = rq.url().endsWith('/info') ? hl.info(body) : hl.exchange(body.action);
    return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Screencast.
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const i = frames.length;
    fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
    frames.push(metadata.timestamp);
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* closing */ }
  });
  const marks = [];
  const focuses = [];
  const captions = [];
  const idles = [];
  const now = () => Date.now() / 1000;
  const mark = (name) => { marks.push({ name, t: now() }); console.log('mark', name); };
  /** Zoom target for the edit: a locator (optionally only its top `maxH` px), a rect, or null for the full view. */
  const focus = async (target, opts = {}) => {
    if (!target) { focuses.push({ t: now(), rect: null }); return; }
    let b = target.x !== undefined ? target : await target.boundingBox();
    if (!b) return;
    if (opts.maxH && b.height > opts.maxH) b = { ...b, height: opts.maxH };
    const pad = opts.pad ?? 28;
    focuses.push({ t: now(), rect: { x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad } });
  };
  let capOpen = null;
  const cap = async (e, t, sub) => { if (capOpen) capOpen.end = now(); capOpen = { e, t, s: sub, start: now(), end: null }; captions.push(capOpen); };
  const hide = async () => { if (capOpen) { capOpen.end = now(); capOpen = null; } };
  /** Marks a stretch the edit may shorten (waiting for the chain, a balance, a dialog). */
  const idle = async (p) => { const a = now(); const r = await p; idles.push([a, now()]); return r; };

  const cursorTo = async (loc, ms = 750) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    const x = b.x + b.width / 2 - 4;
    const y = b.y + b.height / 2 - 3;
    await page.evaluate(([x, y, ms]) => window.__vd.move(x, y, ms), [x, y, ms]);
    await sleep(ms + 120);
  };
  const click = async (loc, ms) => {
    await cursorTo(loc, ms);
    await page.evaluate(() => window.__vd.click());
    await sleep(160);
    await loc.click();
  };
  const type = async (loc, text) => {
    await click(loc, 650);
    await loc.fill('');
    await loc.pressSequentially(text, { delay: 140 });
  };
  const enabled = (sel, text) => page.waitForFunction(([sel, text]) => [...document.querySelectorAll(sel)].some((b) => b.textContent.includes(text) && !b.disabled), [sel, text], { timeout: 60_000 });
  const pump = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(400); } };

  // ---------- 1. Trade page, connect ----------
  await page.goto(`${BASE}/app/trade/TSLA?mode=spot`, { waitUntil: 'networkidle' });
  await page.locator('.chartbox canvas').first().waitFor({ timeout: 30_000 });
  await sleep(2500);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2880, maxHeight: 1620, everyNthFrame: 1 });
  await sleep(600);
  mark('connect');
  await focus(null);
  await cap('01 · Connect', 'Connect your own wallet', 'No account to open. Velum never holds your keys or funds.');
  await sleep(2200);
  await click(page.locator('header button', { hasText: 'Connect wallet' }).first(), 900);
  await page.locator('.modal').waitFor();
  await sleep(800);
  await focus(page.locator('.modal'));
  await sleep(900);
  await click(page.locator('.modal .wopt', { hasText: 'Browser Wallet' }), 700);
  await sleep(700);
  await focus(page.locator('.modal'));
  await click(page.locator('.modal button', { hasText: 'Sign message' }), 700);
  await idle(page.locator('.walletbtn').waitFor({ timeout: 20_000 }));
  await focus(null);
  await idle(page.locator('.ticket .fl', { hasText: 'USDG' }).waitFor({ timeout: 30_000 }));
  await sleep(1200);
  await hide();

  // ---------- 2. Spot buy ----------
  mark('buy');
  await cap('02 · Spot', 'Buy TSLA with USDG', 'Real Uniswap liquidity on Robinhood Chain, 24/7. Tokens settle to your wallet.');
  await focus(page.locator('aside.ticket'), { maxH: 470 });
  await sleep(1300);
  await type(page.locator('#t-spot'), buyAmt);
  await idle(enabled('.ticket button.btn-block', 'Buy TSLA'));
  await sleep(1000);
  await focus(page.locator('.ticket .sumbox'), { pad: 60 });
  await cursorTo(page.locator('.ticket .sumbox'), 700);
  await sleep(1500);
  await click(page.locator('.ticket button.btn-block', { hasText: 'Buy TSLA' }), 700);
  const m1 = page.locator('.modal');
  await m1.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  await sleep(800);
  await focus(m1);
  await sleep(2000);
  await click(m1.locator('input[type="checkbox"]'), 700);
  await sleep(500);
  await click(m1.locator('button', { hasText: 'Start trade' }), 600);
  await sleep(400);
  await focus(m1);
  await idle(m1.locator('button', { hasText: 'Done' }).waitFor({ timeout: 180_000 }));
  await focus(m1);
  await sleep(2600);
  await click(m1.locator('button', { hasText: 'Done' }), 600);
  await focus(null);
  await sleep(1000);
  await hide();

  // ---------- 3. Spot sell ----------
  mark('sell');
  await cap('03 · Spot', 'Sell anytime, even on weekends', 'Every swap carries a minimum output from your slippage limit.');
  await focus(page.locator('aside.ticket'), { maxH: 470 });
  await sleep(900);
  await click(page.locator('.ticket .sides button', { hasText: 'Sell' }), 700);
  await sleep(900);
  await click(page.locator('.ticket .pcts button', { hasText: 'Max' }), 700);
  await idle(enabled('.ticket button.btn-block', 'Sell TSLA'));
  await sleep(1300);
  await focus(page.locator('aside.ticket'), { pad: 20 });
  await click(page.locator('.ticket button.btn-block', { hasText: 'Sell TSLA' }), 700);
  const m2 = page.locator('.modal');
  await m2.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  await sleep(800);
  await focus(m2);
  await sleep(1500);
  await click(m2.locator('input[type="checkbox"]'), 600);
  await sleep(400);
  await click(m2.locator('button', { hasText: 'Start trade' }), 600);
  await sleep(400);
  await focus(m2);
  await idle(m2.locator('button', { hasText: 'Done' }).waitFor({ timeout: 180_000 }));
  await focus(m2);
  await sleep(2400);
  await click(m2.locator('button', { hasText: 'Done' }), 600);
  await focus(null);
  await sleep(900);
  await hide();

  // ---------- 4. Perps open ----------
  mark('perps');
  await cap('04 · Perps', 'Go long up to 5x', 'Placed from your own Hyperliquid account, with isolated margin.');
  await click(page.locator('.chartbox .seg button', { hasText: 'Perps' }), 800);
  await idle(page.locator('.ticket .fl', { hasText: 'USDC' }).waitFor({ timeout: 30_000 }));
  await sleep(600);
  await focus(page.locator('aside.ticket'), { maxH: 520 });
  await sleep(1000);
  await type(page.locator('#t-size'), '1000');
  await sleep(500);
  const lev = page.locator('#t-lev');
  await cursorTo(lev, 700);
  await lev.focus();
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowLeft'); await sleep(40); }
  for (let i = 0; i < 2; i++) { await sleep(420); await page.keyboard.press('ArrowRight'); }
  await idle(enabled('.ticket button.btn-block', 'Open long on Hyperliquid'));
  await sleep(900);
  await focus(page.locator('.ticket .sumbox'), { pad: 60 });
  await cursorTo(page.locator('.ticket .sumbox'), 700);
  await sleep(1600);
  await focus(page.locator('aside.ticket'), { pad: 20 });
  await click(page.locator('.ticket button.btn-block', { hasText: 'Open long on Hyperliquid' }), 700);
  const m3 = page.locator('.modal');
  await m3.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  await sleep(800);
  await focus(m3);
  await sleep(2300);
  await click(m3.locator('input[type="checkbox"]'), 700);
  await sleep(400);
  await click(m3.locator('button', { hasText: 'Start trade' }), 600);
  await sleep(400);
  await focus(m3);
  await idle(m3.locator('button', { hasText: 'Done' }).waitFor({ timeout: 60_000 }));
  await focus(m3);
  await sleep(2600);
  await click(m3.locator('button', { hasText: 'Done' }), 600);
  await hide();

  // ---------- 5. P&L (illustrative rise) ----------
  mark('pnl');
  const row = page.locator('.posbox tbody tr', { hasText: 'TSLA' });
  await idle(row.waitFor({ timeout: 30_000 }));
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
  await focus(page.locator('.posbox .tbl-wrap'), { pad: 30 });
  await cap('04 · Perps', 'Watch your P&L in real time', 'Illustrative price move in a test environment.');
  await cursorTo(row.locator('td').nth(4), 900);
  const target = startMid * 1.026;
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const eased = 1 - Math.pow(1 - k, 2.2);
    const noise = (Math.sin(i * 1.7) * 0.0009 + Math.cos(i * 0.9) * 0.0006) * (1 - k);
    hl.mids['xyz:TSLA'] = (startMid + (target - startMid) * eased + startMid * noise).toFixed(2);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(420);
  }
  await pump(3200);
  await hide();

  // ---------- 6. Close in profit ----------
  mark('close');
  await cap('05 · Close', 'Close in profit', 'One reduce-only order closes the whole position.');
  await click(row.locator('button', { hasText: 'Close' }), 800);
  const m4 = page.locator('.modal');
  await m4.locator('button', { hasText: 'Close position' }).waitFor({ timeout: 30_000 });
  await sleep(800);
  await focus(m4);
  await sleep(2400);
  await click(m4.locator('button', { hasText: 'Close position' }), 700);
  await sleep(800);
  await focus(m4);
  await idle(m4.locator('button', { hasText: 'Done' }).waitFor({ timeout: 60_000 }));
  await focus(m4);
  await sleep(2400);
  await click(m4.locator('button', { hasText: 'Done' }), 600);
  await sleep(500);
  await focus(page.locator('.posbox'), { pad: 24 });
  await click(page.locator('.posbox .ptabs button', { hasText: 'Activity' }), 800);
  await idle(page.locator('.posbox .act', { hasText: 'Close Long' }).waitFor({ timeout: 30_000 }));
  await cursorTo(page.locator('.posbox .act').first(), 800);
  await sleep(3200);
  await hide();
  await focus(null);
  await sleep(1500);
  mark('end');

  await cdp.send('Page.stopScreencast');
  await sleep(500);
  await browser.close();

  // Footage: each frame lasts until the next one.
  const t0 = frames[0];
  const list = frames.map((t, i) => {
    const d = i + 1 < frames.length ? Math.max(1 / 120, frames[i + 1] - t) : 0.5;
    return `file '${path.join(FRAMES, `f${String(i).padStart(6, '0')}.jpg`)}'\nduration ${d.toFixed(4)}`;
  });
  fs.writeFileSync(path.join(OUT, 'frames.txt'), list.join('\n') + `\nfile '${path.join(FRAMES, `f${String(frames.length - 1).padStart(6, '0')}.jpg`)}'\n`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'), '-vf', 'fps=30,scale=2880:1620:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', path.join(OUT, 'footage.mp4')]);
  const r = (t) => Math.max(0, t - t0);
  if (capOpen) capOpen.end = now();
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify({
    marks: marks.map((m) => ({ name: m.name, t: r(m.t) })),
    focuses: focuses.map((f) => ({ t: r(f.t), rect: f.rect })),
    captions: captions.map((c) => ({ e: c.e, t: c.t, s: c.s, start: r(c.start), end: r(c.end) })),
    idles: idles.map(([a, b]) => [r(a), r(b)]),
    frames: frames.length, duration: frames[frames.length - 1] - t0, startMid, endMid: hl.mid(), fills: hl.fills,
  }, null, 1));
  console.log('frames', frames.length, 'duration', (frames[frames.length - 1] - t0).toFixed(1), 's');
  console.log('fills', JSON.stringify(hl.fills.map((f) => [f.dir, f.sz, f.px, f.closedPnl])));
  console.log('page errors', errors.length, errors.slice(0, 3).join(' | '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
