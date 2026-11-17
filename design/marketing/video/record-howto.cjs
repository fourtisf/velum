// Records the product footage of the "How to buy stocks on Velum" video: the real mainnet web build, a throwaway wallet
// with ETH, real Uniswap swaps on a local fork of Robinhood Chain. Flow: the landing page, Launch app, connect (no
// signature), pick NVDA, buy it with the wallet's ETH (one swap ETH -> USDG -> NVDA), the receipt, then the Portfolio
// (the holding, its value and P&L, the account card, the wallet activity read from the chain) and Sell from the
// Portfolio (the ticket opens on Sell with the whole balance), then the activity with the sale. The cursor, frames and
// marks.json work as in record-demo.cjs; edit with:
//   VIDEO_DIR=<out> SCENES=scenes-howto.html ORDER=intro,steps,ui,outro OUT_FILE=<file> node design/marketing/video/edit.cjs
//
// Needs: the web (mainnet build, NEXT_PUBLIC_RPC_URL on the fork, NEXT_PUBLIC_API_URL on a local API) on WEB_URL,
// anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 on FORK_RPC, a chain-ID-1 anvil on L1_RPC
// (answers for the Ethereum balance instead of the public RPC), and the API with live mainnet prices.
// Run: NODE_USE_ENV_PROXY=1 OUT_DIR=<out> node design/marketing/video/record-howto.cjs
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../../..');
const WEB = path.join(ROOT, 'apps/web');
const req = createRequire(path.join(WEB, 'package.json'));
const { chromium } = require('playwright');
const { createPublicClient, createTestClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require(path.join(WEB, 'e2e/wallet.cjs'));

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const L1 = process.env.L1_RPC || 'http://127.0.0.1:8549';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out-howto');
const FRAMES = path.join(OUT, 'frames');
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const BUY_ETH = process.env.BUY_ETH || '0.03';
const chain = { id: 4663, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

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
  // Throwaway wallet on the fork: 0.12 ETH (pays for the stock and the gas).
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  await test.setBalance({ address: me, value: 12n * 10n ** 16n });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
  await installWallet(context, { privateKey: key, rpc: RPC, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  await context.addInitScript(OVERLAY);
  // Same-origin in production; locally the API is on another port and its Date header must be exposed.
  await context.route(`${API}/**`, async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  // The Portfolio's Ethereum balance: answered by the local chain-ID-1 anvil, nothing leaves the machine.
  await context.route('https://ethereum-rpc.publicnode.com/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const res = await fetch(L1, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rq.postData() });
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
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
  const idle = async (p) => { const a = now(); const r = await p; idles.push([a, now()]); return r; };
  const cursorTo = async (loc, ms = 750) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.evaluate(([x, y, ms]) => window.__vd.move(x, y, ms), [b.x + b.width / 2 - 4, b.y + b.height / 2 - 3, ms]);
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
    await loc.pressSequentially(text, { delay: 150 });
  };
  const enabled = (sel, text) => page.waitForFunction(([sel, text]) => [...document.querySelectorAll(sel)].some((b) => b.textContent.includes(text) && !b.disabled), [sel, text], { timeout: 90_000 });
  /** A smooth scroll the screencast can see (the page scrolls in small steps). */
  const scrollTo = async (loc, offset = 90) => {
    const y = await loc.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
    await page.evaluate(async (y) => { const s = window.scrollY; const n = 28; for (let i = 1; i <= n; i++) { const k = i / n; window.scrollTo(0, s + (y - s) * (1 - Math.pow(1 - k, 3))); await new Promise((r) => setTimeout(r, 22)); } }, y);
    await sleep(350);
  };

  // ---------- 1. Landing ----------
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(2500);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2880, maxHeight: 1620, everyNthFrame: 1 });
  await sleep(600);
  mark('landing');
  await focus(null);
  await cap('Step 1 · Open Velum', 'Go to velumtrade.com', 'Launch the app. No sign-up and no account to open.');
  await sleep(2600);
  await click(page.locator('header a', { hasText: 'Launch app' }).first(), 1000);
  await page.waitForURL(/\/app\/trade\//, { timeout: 30_000 });
  await idle(page.locator('.chartbox canvas').first().waitFor({ timeout: 30_000 }));
  await sleep(1800);

  // ---------- 2. Connect ----------
  mark('connect');
  await cap('Step 1 · Connect', 'Connect your wallet', 'One click, no signature. Your tokens stay in your wallet: Velum never holds them.');
  await sleep(1400);
  await click(page.locator('header button', { hasText: 'Connect wallet' }).first(), 900);
  await page.locator('.modal').waitFor();
  await sleep(700);
  await focus(page.locator('.modal'));
  await sleep(1100);
  await click(page.locator('.modal .wopt', { hasText: 'Browser Wallet' }), 700);
  await idle(page.locator('.walletbtn').waitFor({ timeout: 20_000 }));
  await focus(null);
  await sleep(700);
  await focus(page.locator('.walletbtn'), { pad: 60 });
  await cursorTo(page.locator('.walletbtn'), 700);
  await sleep(1800);
  await focus(null);
  await hide();

  // ---------- 3. Pick a stock ----------
  mark('pick');
  await cap('Step 2 · Pick a stock', 'Choose a Stock Token', 'Live prices for TSLA, NVDA, AAPL and more, 24/7.');
  await focus(page.locator('nav.strip'), { pad: 18 });
  await sleep(1200);
  await click(page.locator('nav.strip .mchip', { hasText: 'NVDA' }), 900);
  await page.waitForURL(/\/app\/trade\/NVDA/, { timeout: 20_000 });
  await idle(page.locator('.chartbox canvas').first().waitFor({ timeout: 30_000 }));
  await sleep(600);
  await focus(null);
  await sleep(1600);
  await hide();

  // ---------- 4. Buy with ETH ----------
  mark('buy');
  await cap('Step 3 · Buy', 'Pay with ETH or USDG', 'Pay with the ETH in your wallet: it becomes USDG, then NVDA, in one Uniswap swap.');
  // Spot: you buy the token itself (Perps is the leveraged ticket).
  const spotTab = page.locator('[aria-label="Market type"] button', { hasText: 'Spot' });
  if ((await spotTab.getAttribute('aria-pressed')) !== 'true') {
    await focus(page.locator('[aria-label="Market type"]'), { pad: 80 });
    await click(spotTab, 800);
    await sleep(700);
  }
  await focus(page.locator('aside.ticket'), { maxH: 470 });
  await sleep(1100);
  await click(page.locator('.ticket button', { hasText: 'Pay with ETH' }), 800);
  await idle(page.locator('.ticket .fl', { hasText: /ETH · \$/ }).waitFor({ timeout: 40_000 }));
  await sleep(700);
  await type(page.locator('#t-spot'), BUY_ETH);
  await idle(enabled('.ticket button.btn-block', 'Buy NVDA with ETH'));
  await sleep(900);
  await focus(page.locator('.ticket .sumbox'), { pad: 60 });
  await cursorTo(page.locator('.ticket .sumbox div', { hasText: 'Order value' }), 700);
  await sleep(1700);
  await focus(page.locator('aside.ticket'), { pad: 20 });
  await click(page.locator('.ticket button.btn-block', { hasText: 'Buy NVDA with ETH' }), 700);
  const m1 = page.locator('.modal');
  await m1.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  await cap('Step 3 · Confirm', 'Review, then confirm', 'Every amount before you sign, and a minimum that protects you from price moves.');
  await sleep(700);
  await focus(m1);
  await sleep(2300);
  await click(m1.locator('input[type="checkbox"]'), 700);
  await sleep(400);
  await click(m1.locator('button', { hasText: 'Start trade' }), 600);
  await sleep(400);
  await focus(m1);
  await idle(m1.locator('button', { hasText: 'Done' }).waitFor({ timeout: 180_000 }));
  await focus(m1);
  await sleep(2600);
  await click(m1.locator('button', { hasText: 'Done' }), 600);
  await focus(null);
  await sleep(700);
  await hide();

  // ---------- 5. Portfolio: holding, P&L, activity ----------
  mark('portfolio');
  await cap('Step 4 · Portfolio', 'Your stock, live', 'Value and P&L of every Stock Token you hold, at live prices.');
  await click(page.locator('nav.tabs a', { hasText: 'Portfolio' }), 900);
  await page.locator('.pf-hero').waitFor({ timeout: 30_000 });
  const row = page.locator('.tbl tr', { hasText: 'Nvidia' });
  await idle(row.waitFor({ timeout: 40_000 }));
  await idle(page.waitForFunction(() => /^[+-]\$/.test([...document.querySelectorAll('.tbl tr small.pnl')].map((e) => e.textContent.trim()).join(' ')), null, { timeout: 120_000 }).catch(() => undefined));
  await sleep(900);
  await scrollTo(page.locator('.pf-grid'), 80);
  await focus(page.locator('.pf-grid section').first(), { pad: 20 });
  await sleep(900);
  await cursorTo(row.locator('small.pnl'), 900);
  await sleep(2400);
  await focus(page.locator('.pf-grid .card.acct'), { pad: 20 });
  await cursorTo(page.locator('.pf-grid .card.acct .r', { hasText: 'Stock P&L' }), 800);
  await sleep(2200);
  await hide();
  await cap('Step 4 · Activity', 'Every trade, from the chain', 'Your buys and sells, read straight from Robinhood Chain, each linked to the explorer.');
  const act = page.locator('.act', { hasText: /Bought [\d.]+ NVDA/ });
  await idle(act.waitFor({ timeout: 90_000 }));
  await scrollTo(act, 260);
  await focus(act, { pad: 40 });
  await cursorTo(act, 900);
  await sleep(2600);
  await hide();

  // ---------- 6. Sell from the Portfolio ----------
  mark('sell');
  await scrollTo(page.locator('.pf-grid'), 80);
  await focus(page.locator('.pf-grid section').first(), { pad: 20 });
  await cap('Sell anytime', 'Sell with one tap', 'Sell opens the ticket with your whole balance filled in.');
  await sleep(900);
  await click(row.locator('button', { hasText: 'Sell' }), 900);
  await page.waitForURL(/\/app\/trade\/NVDA\?mode=spot/, { timeout: 20_000 });
  const sellBtn = page.locator('.ticket button.btn-block', { hasText: 'Sell NVDA' });
  await idle(sellBtn.waitFor({ timeout: 30_000 }));
  await idle(enabled('.ticket button.btn-block', 'Sell NVDA'));
  await focus(page.locator('aside.ticket'), { maxH: 470 });
  await cursorTo(page.locator('#t-spot'), 800);
  await sleep(1900);
  await focus(page.locator('aside.ticket'), { pad: 20 });
  await click(sellBtn, 700);
  const m2 = page.locator('.modal');
  await m2.locator('button', { hasText: 'Start trade' }).waitFor({ timeout: 30_000 });
  await sleep(700);
  await focus(m2);
  await sleep(1800);
  await click(m2.locator('input[type="checkbox"]'), 700);
  await sleep(300);
  await click(m2.locator('button', { hasText: 'Start trade' }), 600);
  await sleep(300);
  await focus(m2);
  await idle(m2.locator('button', { hasText: 'Done' }).waitFor({ timeout: 180_000 }));
  await focus(m2);
  await sleep(2400);
  await click(m2.locator('button', { hasText: 'Done' }), 600);
  await focus(null);
  await hide();

  // ---------- 7. Back to the Portfolio: the sale in the activity ----------
  mark('after');
  await click(page.locator('nav.tabs a', { hasText: 'Portfolio' }), 900);
  await page.locator('.pf-hero').waitFor({ timeout: 30_000 });
  const sold = page.locator('.act', { hasText: /Sold [\d.]+ NVDA/ });
  await idle(sold.waitFor({ timeout: 90_000 }));
  await cap('Done', 'Sold, back to USDG', 'The sale shows in your activity. Your USDG stays in your wallet.');
  await scrollTo(sold, 300);
  await focus(page.locator('.act').first().locator('xpath=..'), { pad: 20, maxH: 260 });
  await cursorTo(sold, 900);
  await sleep(3000);
  await hide();
  await focus(null);
  await sleep(1200);
  mark('end');

  await cdp.send('Page.stopScreencast');
  await sleep(500);
  await browser.close();
  const left = await pub.readContract({ address: NVDA, abi: ERC20, functionName: 'balanceOf', args: [me] });
  console.log('NVDA left after the sale:', String(left), 'page errors:', errors.length, errors.slice(0, 2).join(' | '));

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
    frames: frames.length, duration: frames[frames.length - 1] - t0,
  }, null, 1));
  console.log('frames', frames.length, 'duration', (frames[frames.length - 1] - t0).toFixed(1), 's');
  console.log('page errors', errors.length, errors.slice(0, 3).join(' | '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
