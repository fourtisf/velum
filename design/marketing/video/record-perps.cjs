// Records the product footage of the "Perps are open" ad: the real mainnet web build and a throwaway wallet on a local
// fork of Robinhood Chain, trading perps against a model of the user's own perps account (nothing is sent to the
// exchange). Market data is live: the order book and mids come from the public info API, read at record time. Flow:
// the TSLA perps terminal with its live order book, the Deposit dialog (Robinhood Chain, Ethereum, Arbitrum and a live
// Relay quote), Long/Short, size and 5x leverage, Open long (agent approval and order), the position with an
// ILLUSTRATIVE price rise (the model shifts mids and book by the same offset), Close, and the Activity tab.
//
// Output in OUT_DIR: frames/ (Chrome screencast JPEGs at 2880x1620), frames.json (each frame's time), marks.json (named
// marks, element rectangles in CSS px of the 1440x810 viewport, and the stretches where the order review is on screen,
// which the edit never shows). edit-ad.cjs cuts the ad from these.
//
// Needs: the web (mainnet build, NEXT_PUBLIC_RPC_URL on the fork, NEXT_PUBLIC_API_URL on a local API) on WEB_URL,
// anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 on FORK_RPC, and the API with live prices.
// Run: NODE_USE_ENV_PROXY=1 OUT_DIR=<out> node design/marketing/video/record-perps.cjs
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../../..');
const WEB = path.join(ROOT, 'apps/web');
const req = createRequire(path.join(WEB, 'package.json'));
const { chromium } = require('playwright');
const { createTestClient, http } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require(path.join(WEB, 'e2e/wallet.cjs'));

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const INFO = 'https://api.hyperliquid.xyz/info';
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out-perps');
const FRAMES = path.join(OUT, 'frames');
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const live = async (body) => {
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`info ${body.type} ${r.status}`);
  return r.json();
};

// ---------- The user's perps account, as a model (xyz dex funded with 2,500 USDC); market data stays live ----------
function account() {
  const a = { agents: [], usdc: 2500, leverage: { type: 'cross', value: 20 }, pos: null, fills: [], offset: 1, oid: 51870, mids: {} };
  const mid = (coin = 'xyz:TSLA') => Number(a.mids[coin]) * (coin === 'xyz:TSLA' ? a.offset : 1);
  const position = () => {
    if (!a.pos) return null;
    const p = a.pos;
    const m = mid();
    const pnl = (m - p.entry) * p.size;
    const liq = (p.entry * (1 - 1 / p.lev)) / (1 - 1 / 40);
    return {
      coin: 'xyz:TSLA', szi: p.size.toFixed(3), leverage: { type: 'isolated', value: p.lev, rawUsd: (-(p.size * p.entry) + p.margin).toFixed(6) },
      entryPx: p.entry.toFixed(2), positionValue: (p.size * m).toFixed(4), unrealizedPnl: pnl.toFixed(6), returnOnEquity: (pnl / p.margin).toFixed(10),
      liquidationPx: liq.toFixed(4), marginUsed: (p.margin + pnl).toFixed(6), maxLeverage: 10, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
    };
  };
  const free = () => a.usdc - (a.pos ? a.pos.margin : 0);
  a.info = async (b) => {
    switch (b.type) {
      case 'allMids': {
        if (b.dex !== 'xyz') return {};
        Object.assign(a.mids, await live(b));
        const out = { ...a.mids };
        out['xyz:TSLA'] = mid().toFixed(2);
        return out;
      }
      case 'l2Book': {
        const book = await live(b);
        if (b.coin === 'xyz:TSLA' && a.offset !== 1) {
          for (const side of book.levels) for (const l of side) l.px = (Number(l.px) * a.offset).toFixed(2);
        }
        return book;
      }
      case 'userAbstraction': return 'disabled';
      case 'extraAgents': return a.agents;
      case 'clearinghouseState': {
        const p = b.dex === 'xyz' ? position() : null;
        const w = b.dex === 'xyz' ? free() : 0;
        const val = b.dex === 'xyz' ? a.usdc + (p ? Number(p.unrealizedPnl) : 0) : 0;
        const s = { accountValue: val.toFixed(6), totalNtlPos: '0', totalRawUsd: val.toFixed(6), totalMarginUsed: '0' };
        return { marginSummary: s, crossMarginSummary: s, crossMaintenanceMarginUsed: '0', withdrawable: w.toFixed(6), assetPositions: p ? [{ type: 'oneWay', position: p }] : [], time: Date.now() };
      }
      case 'spotClearinghouseState': return { balances: [] };
      case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: a.leverage, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: mid(b.coin).toFixed(2) };
      case 'userFills': return a.fills;
      case 'maxBuilderFee': return 0;
      default:
        // Anything about an account stays in the model; public market data is read live.
        return b.user ? null : live(b);
    }
  };
  a.exchange = (x) => {
    const ok = { status: 'ok', response: { type: 'default' } };
    if (x.type === 'approveAgent') { a.agents = [{ address: x.agentAddress.toLowerCase(), name: 'velum', validUntil: Number(x.agentName.split(' ').pop()) }]; return ok; }
    if (x.type === 'updateLeverage') { a.leverage = { type: x.isCross ? 'cross' : 'isolated', value: x.leverage }; return ok; }
    if (x.type === 'order') {
      const o = x.orders[0];
      const m = mid();
      const px = Math.round((o.b ? m * 1.0002 : m * 0.9998) * 100) / 100;
      const sz = Number(o.s);
      const oid = ++a.oid;
      const fee = px * sz * 0.00045;
      let dir = o.b ? 'Open Long' : 'Open Short';
      let closedPnl = '0.0';
      if (o.r && a.pos) {
        const pnl = (px - a.pos.entry) * a.pos.size;
        a.usdc += pnl - fee;
        closedPnl = pnl.toFixed(6);
        dir = 'Close Long';
        a.pos = null;
      } else {
        const lev = a.leverage.value;
        a.pos = { size: sz, entry: px, lev, margin: (sz * px) / lev };
        a.usdc -= fee;
      }
      a.fills.unshift({ coin: 'xyz:TSLA', px: px.toFixed(2), sz: o.s, side: o.b ? 'B' : 'A', time: Date.now(), startPosition: '0', dir, closedPnl, hash: '0x' + '0'.repeat(64), oid, crossed: true, fee: fee.toFixed(6), tid: oid, feeToken: 'USDC' });
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: o.s, avgPx: px.toFixed(2), oid } }] } } };
    }
    return { status: 'err', response: `unexpected action ${x.type}` };
  };
  a.mid = mid;
  return a;
}

// ---------- Cursor and click ripple drawn into the page ----------
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
  const acct = account();
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 5n * 10n ** 17n }); // 0.5 ETH: the Deposit dialog quotes from it

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
  await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await context.addInitScript(OVERLAY);
  await context.route(`${API}/**`, async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(rq.postData() || '{}');
    try {
      const res = rq.url().endsWith('/info') ? await acct.info(body) : acct.exchange(body.action);
      return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res) });
    } catch (e) {
      return r.fulfill({ status: 502, headers: cors, body: String(e) });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const i = frames.length;
    fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
    frames.push(metadata.timestamp);
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* closing */ }
  });
  const marks = [];
  const rects = [];
  const review = [];
  const now = () => Date.now() / 1000;
  const mark = (name) => { marks.push({ name, t: now() }); console.log('mark', name); };
  const rect = async (name, loc) => {
    const b = await loc.boundingBox();
    if (b) rects.push({ name, t: now(), x: b.x, y: b.y, w: b.width, h: b.height });
  };
  const cursorTo = async (loc, ms = 700) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.evaluate(([x, y, ms]) => window.__vd.move(x, y, ms), [b.x + b.width / 2 - 4, b.y + b.height / 2 - 3, ms]);
    await sleep(ms + 100);
  };
  /** `opens` is called right before a click that opens the order review, so the edit knows where it starts. */
  const click = async (loc, ms, opens) => {
    await cursorTo(loc, ms);
    await page.evaluate(() => window.__vd.click());
    await sleep(140);
    if (opens) opens(now());
    await loc.click();
  };
  const type = async (loc, text) => {
    await click(loc, 600);
    await loc.fill('');
    await loc.pressSequentially(text, { delay: 110 });
  };
  const enabled = (sel, text) => page.waitForFunction(([sel, text]) => [...document.querySelectorAll(sel)].some((b) => b.textContent.includes(text) && !b.disabled), [sel, text], { timeout: 90_000 });

  // Connected before the camera rolls.
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await page.locator('.obook .ob-row.bid').first().waitFor({ timeout: 30_000 });
  await page.locator('.ticket .fl', { hasText: /Perps balance\s*2,?500/ }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__vd.move(1000, 560, 0));
  await sleep(2000);
  console.log('TSLA mid', acct.mid().toFixed(2));

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 2880, maxHeight: 1620, everyNthFrame: 1 });
  await sleep(500);

  // ---------- 1. The terminal and its live order book ----------
  mark('terminal');
  await rect('chart', page.locator('.chart-row .card').first());
  await rect('obook', page.locator('.obook'));
  await rect('ticket', page.locator('aside.ticket'));
  await rect('strip', page.locator('nav.strip'));
  await sleep(3000);
  mark('book');
  await cursorTo(page.locator('.obook .ob-mid'), 900);
  await sleep(3500);

  // ---------- 2. Deposit: Robinhood Chain, Ethereum, Arbitrum ----------
  mark('deposit');
  await click(page.locator('.ticket .linkbtn', { hasText: 'Deposit' }), 800);
  const dm = page.locator('.modal');
  await dm.locator('.seg-src').waitFor();
  await sleep(500);
  await rect('depmodal', dm);
  await sleep(700);
  await click(dm.locator('.seg-src button', { hasText: 'Ethereum' }), 600);
  await sleep(900);
  await click(dm.locator('.seg-src button', { hasText: 'Arbitrum' }), 500);
  await sleep(700);
  await click(dm.locator('.seg-src button', { hasText: 'Robinhood Chain' }), 500);
  await sleep(600);
  await type(dm.locator('#dep-amt'), '0.25');
  mark('quote');
  await dm.locator('.receipt, .sumbox, div', { hasText: /You receive in your perps account/ }).first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => /You receive in your perps account\s*≈?\s*[\d,.]+\s*USDC/.test(document.querySelector('.modal')?.innerText ?? ''), null, { timeout: 30_000 }).catch(() => console.warn('no Relay quote shown'));
  await rect('depmodal', dm);
  await cursorTo(dm.getByText('You receive in your perps account'), 700);
  await sleep(2200);
  await click(dm.locator('.xbtn'), 600);
  await dm.waitFor({ state: 'detached' });
  mark('deposit-end');
  await sleep(500);

  // ---------- 3. Long or short, size, 5x ----------
  mark('ticket');
  await rect('ticket', page.locator('aside.ticket'));
  await click(page.locator('.ticket .sides button.short'), 700);
  await sleep(900);
  await click(page.locator('.ticket .sides button.long'), 500);
  await sleep(500);
  mark('size');
  await type(page.locator('#t-size'), '2500');
  await sleep(300);
  mark('lev');
  const lev = page.locator('#t-lev');
  await cursorTo(lev, 600);
  await lev.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 4; i++) { await sleep(330); await page.keyboard.press('ArrowRight'); }
  await enabled('.ticket button.btn-block', 'Open long');
  await sleep(500);
  mark('summary');
  await rect('sumbox', page.locator('.ticket .sumbox'));
  await cursorTo(page.locator('.ticket .sumbox'), 600);
  await sleep(1600);

  // ---------- 4. Open long ----------
  mark('open');
  let r0 = 0;
  await click(page.locator('.ticket button.btn-block', { hasText: 'Open long' }), 600, (t) => { r0 = t; });
  const m = page.locator('.modal');
  await m.locator('button', { hasText: /Open long|Confirm|Start/ }).last().waitFor({ timeout: 30_000 });
  await sleep(600);
  const ack = m.locator('input[type="checkbox"]');
  if (await ack.count()) await ack.check();
  await sleep(200);
  await m.locator('.btn-white.btn-block').first().click();
  review.push([r0, now()]);
  mark('steps');
  await rect('modal', m);
  await m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 60_000 });
  mark('receipt');
  await rect('modal', m);
  await sleep(1800);
  await click(m.locator('button', { hasText: 'Done' }), 500);
  await m.waitFor({ state: 'detached' });

  // ---------- 5. The position, with an illustrative rise ----------
  const row = page.locator('.posbox tbody tr', { hasText: 'TSLA' });
  await row.waitFor({ timeout: 30_000 });
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
  mark('pnl');
  await rect('posbox', page.locator('.posbox'));
  await rect('posrow', row);
  await cursorTo(row.locator('td').nth(4), 800);
  // The positions refresh every 5 s, so the rise runs over a minute and the edit plays it fast.
  const steps = 120;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const eased = 1 - Math.pow(1 - k, 1.8);
    const noise = (Math.sin(i * 0.61) * 0.0012 + Math.cos(i * 0.37) * 0.0008) * (1 - k);
    acct.offset = 1 + 0.031 * eased + noise;
    await sleep(500);
  }
  await sleep(6000);
  mark('pnl-end');

  // ---------- 6. Close ----------
  mark('close');
  let r1 = 0;
  await click(row.locator('button', { hasText: 'Close' }), 700, (t) => { r1 = t; });
  const cm = page.locator('.modal');
  await cm.locator('.btn-white.btn-block').first().waitFor({ timeout: 30_000 });
  await sleep(500);
  const ack2 = cm.locator('input[type="checkbox"]');
  if (await ack2.count()) await ack2.check();
  await cm.locator('.btn-white.btn-block').first().click();
  review.push([r1, now()]);
  mark('close-steps');
  await cm.locator('button', { hasText: 'Done' }).waitFor({ timeout: 60_000 });
  mark('close-receipt');
  await rect('modal', cm);
  await sleep(1800);
  await click(cm.locator('button', { hasText: 'Done' }), 500);
  await cm.waitFor({ state: 'detached' });
  await sleep(300);
  mark('activity');
  await click(page.locator('.posbox .ptabs button', { hasText: 'Activity' }), 700);
  await page.locator('.posbox .act', { hasText: 'Close Long' }).waitFor({ timeout: 30_000 });
  await rect('posbox', page.locator('.posbox'));
  await rect('act', page.locator('.posbox .act').first());
  await cursorTo(page.locator('.posbox .act').first(), 700);
  await sleep(3000);
  mark('end');

  await cdp.send('Page.stopScreencast');
  await sleep(500);
  const text = await page.locator('main').innerText();
  await browser.close();

  const t0 = frames[0];
  const r = (t) => Math.max(0, t - t0);
  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames.map((t) => +(t - t0).toFixed(4))));
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify({
    marks: Object.fromEntries(marks.map((m) => [m.name, +r(m.t).toFixed(3)])),
    rects: rects.map((x) => ({ ...x, t: +r(x.t).toFixed(3) })),
    review: review.map(([a, b]) => [+r(a).toFixed(3), +r(b).toFixed(3)]),
    duration: frames[frames.length - 1] - t0, fills: acct.fills,
  }, null, 1));
  console.log('frames', frames.length, 'duration', (frames[frames.length - 1] - t0).toFixed(1), 's');
  console.log('fills', JSON.stringify(acct.fills.map((f) => [f.dir, f.sz, f.px, Number(f.closedPnl).toFixed(2)])));
  console.log('venue name on the page at the end:', /Hyperliquid/.test(text), '| page errors', errors.length, errors.slice(0, 3).join(' | '));

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
