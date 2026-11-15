// Adversarial browser cases of the web audit of the real-transaction wiring (A1-A16), run against the local stack
// of apps/web/e2e/onchain-e2e.sh (E2E_ADV=1 runs them after the unguarded phase; E2E_HOLD=1 keeps a stack up to
// run them by hand). Each case drives the real UI with a mock wallet (adv-wallet.cjs) and checks the outcome on
// chain. Verdicts follow the fixes (W3-01 to W3-12): PASS, or FAIL / ERROR, which fail the run.
// Env: E2E_BASE, E2E_RPC, E2E_CTL, E2E_OUT, NODE_PATH (playwright). Usage: node adv.e2e.cjs [case ...]
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const { installWallet } = require('./adv-wallet.cjs');
const req = createRequire(path.join(__dirname, '..', '..', 'package.json'));
const { createPublicClient, createWalletClient, http, parseAbi, decodeFunctionData, toFunctionSelector } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');

const BASE = process.env.E2E_BASE, RPC = process.env.E2E_RPC, CTL = process.env.E2E_CTL;
const OUT = path.join(process.env.E2E_OUT || path.join(__dirname, 'out'), 'adv');
fs.mkdirSync(OUT, { recursive: true });
const pub = createPublicClient({ transport: http(RPC) });
const chain = { id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const VAULT = parseAbi(['function balanceOf(address account, address token) view returns (uint256)', 'function deposit(address token, uint256 amount, address to) returns (uint256)', 'function setApproval(address module, bool ok)', 'function withdraw(address token, uint256 amount, address to)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)']);
const PERPS = parseAbi(['function getPosition(uint256 id) view returns ((address taker, address maker, address market, bool isLong, bool open, uint8 leverageHalf, uint16 closeSpreadBps, uint64 openedAt, uint64 exitRequestedAt, address exitRequester, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, int256 fundingIndexAtOpen))', 'function nextPositionId() view returns (uint256)', 'function isLiquidatable(uint256) view returns (bool)']);
const BOOK = parseAbi(['function postOffer(address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry) returns (uint256)', 'function nextOfferId() view returns (uint256)']);
const ALLABI = [...VAULT, ...ERC20, ...parseAbi(['function open(uint256 offerId, address market, bool isLong, uint256 size, uint8 leverageHalf, uint256 priceLimit) returns (uint256 id)', 'function close(uint256 id, uint256 priceLimit) returns (uint256)', 'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline) returns (uint256)'])];
const GET_POSITION = toFunctionSelector('getPosition(uint256)');
const DEMO = /Demo mode|Simulated|Open long privately|Private account|Practice balance/;
const TSLA_PRICE = 39165n * 10n ** 16n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = async (p) => { const r = await fetch(CTL + p); const b = await r.json(); if (!r.ok) throw new Error(`${p}: ${b.error}`); return b; };
const rpc = async (method, params = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const results = [];
const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
const note = (id, pass, detail) => { const line = `[${id}] ${pass === null ? 'OBSERVED' : pass ? 'PASS' : 'FAIL'}: ${detail}`; results.push(line); console.log(line); };
async function waitFor(what, fn, ms = 60_000, every = 500) { const until = Date.now() + ms; let last; while (Date.now() < until) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(every); } throw new Error(`timed out: ${what}${last ? ` (${last})` : ''}`); }
let D; let shot = 0;
const snap = async (s, label) => s.page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`), animations: 'disabled' }).catch(() => undefined);

// A small disk cache: these cases start many browsers, and a full disk crashes Chromium pages.
const LAUNCH = { args: ['--disk-cache-size=1048576', '--media-cache-size=1048576'] };
async function newContext(rec, routes) {
  const browser = await chromium.launch(LAUNCH);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') { rec.external.push(u.href); return route.abort(); }
    if (u.pathname.startsWith('/api/')) rec.api.push(u.pathname + u.search);
    if (u.port === new URL(RPC).port) { rec.rpc++; rec.rpcBodies.push(route.request().postData() || ''); }
    for (const r of routes) { const h = await r(route, u); if (h) return; }
    return route.continue();
  });
  return { browser, context };
}
async function session(name, { fund = { usdg: 10000, tsla: 5 }, chainId = 31337, routes = [], pk = generatePrivateKey() } = {}) {
  const addr = privateKeyToAccount(pk).address;
  if (fund) await ctl(`/fund?${new URLSearchParams({ addr, ...Object.fromEntries(Object.entries(fund).map(([k, v]) => [k, String(v)])) })}`);
  const rec = { api: [], rpc: 0, rpcBodies: [], external: [], dialogs: [], console: [] };
  const { browser, context } = await newContext(rec, routes);
  const wallet = await installWallet(context, { privateKey: pk, rpc: RPC, chainId });
  const page = await context.newPage();
  page.on('dialog', (d) => { rec.dialogs.push(d.message()); d.dismiss().catch(() => undefined); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') rec.console.push(m.text().slice(0, 200)); });
  return { name, browser, context, page, wallet, rec, addr, pk };
}
async function goto(s, p, { real = true } = {}) {
  await s.page.goto(BASE + p, { waitUntil: 'networkidle' });
  if (real) await s.page.locator('.demo-bar', { hasText: 'real' }).waitFor({ timeout: 20_000 });
  await sleep(800);
}
async function connect(s) {
  await s.page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await s.page.locator('.modal .wopt', { hasText: 'Test Wallet' }).click();
  await s.page.locator('.modal button', { hasText: 'Sign message' }).click();
  await s.page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await sleep(1200);
}
async function waitOracleCalm(sym) { await waitFor(`${sym} calm`, async () => { const o = await ctl(`/oracle?sym=${sym}`); return !o.lagging && BigInt(o.now) - BigInt(o.updatedAt) <= 6n; }, 180_000, 1000); }
async function shield(s, amount) {
  await goto(s, '/app/portfolio');
  await s.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await s.page.locator('#mv-amt').fill(String(amount));
  await s.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  await confirmAndWait(s);
}
async function confirmAndWait(s) {
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  await Promise.race([m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 120_000 }), m.locator('.boxnote.warn[role="alert"]').waitFor({ timeout: 120_000 })]);
  const text = await m.innerText();
  if (await m.locator('button', { hasText: 'Done' }).isVisible()) await m.locator('button', { hasText: 'Done' }).click();
  else await m.locator('button', { hasText: 'Close' }).last().click();
  return text;
}
async function openLong(s, size, lev) {
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  if (lev) await s.page.locator('#t-lev').fill(String(lev));
  await s.page.locator('#t-size').fill(String(size));
  await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  const t = await confirmAndWait(s);
  return /Position ID\s*#(\d+)/.exec(t)?.[1];
}
const vaultBal = (a, sym) => pub.readContract({ address: D.contracts.vault, abi: VAULT, functionName: 'balanceOf', args: [a, D.tokens[sym]] });
const nextPos = () => pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'nextPositionId' });
const position = (id) => pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'getPosition', args: [BigInt(id)] });
const decode = (data) => { try { const d = decodeFunctionData({ abi: ALLABI, data }); return `${d.functionName}(${d.args.map(String).join(',')})`; } catch { return data.slice(0, 10); } };
async function minePositions(s, from, to) { const mine = []; for (let i = from; i < to; i++) { const p = await position(i); if (p.taker.toLowerCase() === s.addr.toLowerCase()) mine.push(i); } return mine; }
const blockDeployment = (state) => async (route, u) => {
  if (u.pathname !== '/api/v1/deployment' || !state.mode) return false;
  if (state.mode === 'abort') await route.abort();
  else await route.fulfill({ status: Number(state.mode), contentType: 'application/json', body: '{"error":{"code":"UNAVAILABLE","message":"down"}}' });
  return true;
};
async function makerWallet(usdg) {
  const mk = generatePrivateKey(); const ma = privateKeyToAccount(mk);
  await ctl(`/fund?addr=${ma.address}&usdg=${usdg}`);
  const w = createWalletClient({ account: ma, chain, transport: http(RPC) });
  const send = async (address, abi, functionName, args, wait = true) => { const h = await w.writeContract({ address, abi, functionName, args, chain }); if (wait) { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error(functionName); } return h; };
  return { ma, send };
}

// ---------------------------------------------------------------- cases
const CASES = {};

// A1 (W3-02): a spoofed /v1/deployment: never the demo, new trades paused, the reason on screen.
CASES.spoofDeployment = async () => {
  const variants = {
    otherVault: [(b) => ({ ...b, contracts: { ...b.contracts, vault: '0x000000000000000000000000000000000000dEaD' } }), 'a different vault address'],
    extraToken: [(b) => ({ ...b, tokens: { ...b.tokens, NVDA: '0x000000000000000000000000000000000000bEEF' } }), 'a different token list'],
    otherChain: [(b) => ({ ...b, chainId: 4663 }), 'chain ID 4663 instead of 31337'],
    swappedTokens: [(b) => ({ ...b, tokens: { ...b.tokens, TSLA: b.tokens.AMZN, AMZN: b.tokens.TSLA } }), 'a different AMZN token address'],
  };
  for (const [k, [fn, reason]] of Object.entries(variants)) {
    const s = await session(`spoof-${k}`, { routes: [async (route, u) => { if (u.pathname === '/api/v1/deployment') { const r = await route.fetch(); const b = await r.json(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fn(b)) }); return true; } }] });
    await goto(s, '/app/trade/TSLA?mode=perps', { real: false });
    await sleep(3000);
    const banner = flat(await s.page.locator('.demo-bar').innerText());
    const body = await s.page.locator('body').innerText();
    const realTicket = await s.page.locator('.ticket', { hasText: 'Price limit' }).count();
    const paused = await s.page.locator('.ticket button:disabled', { hasText: 'New trades paused' }).count();
    note(`A1-${k}`, !/real/.test(banner) && !DEMO.test(body) && realTicket === 0 && paused === 1 && banner.includes(reason), `banner="${banner.slice(0, 170)}", demo content=${DEMO.test(body)}, quoting ticket=${realTicket}, paused ticket=${paused}`);
    await snap(s, `spoof-${k}`);
    await s.browser.close();
  }
};

// A2 (W3-02): the API down on a real build: no demo, a visible state, and exits (withdraw, close) still work.
CASES.apiDown = async () => {
  const st = { mode: null };
  const s = await session('apidown-503', { routes: [blockDeployment(st)] });
  await goto(s, '/app/portfolio');
  await connect(s);
  await shield(s, 300);
  const id = await openLong(s, 100);
  st.mode = '503';
  await goto(s, '/app/portfolio', { real: false });
  await s.page.locator('.demo-bar', { hasText: 'unavailable' }).waitFor({ timeout: 20_000 });
  const banner = flat(await s.page.locator('.demo-bar').innerText());
  const body = await s.page.locator('main').innerText();
  await s.page.locator('.tbl tbody tr', { hasText: 'TSLA' }).first().waitFor({ timeout: 20_000 });
  await snap(s, 'apidown-503-portfolio');
  const before = await vaultBal(s.addr, 'USDG');
  await s.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await s.page.locator('#mv-amt').fill('10');
  const shieldPaused = await s.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).isDisabled();
  await s.page.locator('.modal .xbtn').click();
  await s.page.locator('.pf-actions .btn', { hasText: 'Unshield' }).click();
  await s.page.locator('#mv-amt').fill('50');
  await s.page.locator('.modal .btn-block', { hasText: 'Unshield USDG' }).click();
  const wt = await confirmAndWait(s);
  const after = await vaultBal(s.addr, 'USDG');
  await goto(s, '/app/trade/TSLA?mode=perps', { real: false });
  await s.page.locator('.ticket button:disabled', { hasText: 'New trades paused' }).waitFor({ timeout: 20_000 });
  const ticket = flat(await s.page.locator('.ticket').innerText());
  await snap(s, 'apidown-503-ticket');
  await waitOracleCalm('TSLA');
  await s.page.locator('.posbox .btn:not([disabled])', { hasText: 'Close' }).first().click();
  const ct = await confirmAndWait(s);
  const closed = id ? !(await position(id)).open : false;
  note('A2-503', !/real/.test(banner) && !DEMO.test(body) && shieldPaused && before - after === 50_000000n && /Withdrawn/.test(wt) && !/Price limit/.test(ticket) && closed,
    `banner="${banner.slice(0, 150)}"; demo content=${DEMO.test(body)}; deposit paused=${shieldPaused}; unshield 50 -> vault ${before} -> ${after}; ticket="${ticket.slice(0, 110)}"; close of #${id} while the API is down: ${closed ? 'closed on chain' : flat(ct).slice(-120)}`);
  await s.browser.close();

  const s2 = await session('apidown-abort', { routes: [blockDeployment({ mode: 'abort' })] });
  await goto(s2, '/app/portfolio', { real: false });
  await connect(s2).catch(() => undefined);
  await s2.page.locator('.demo-bar', { hasText: 'unavailable' }).waitFor({ timeout: 20_000 });
  const b2 = flat(await s2.page.locator('.demo-bar').innerText());
  const body2 = await s2.page.locator('main').innerText();
  const vault2 = await s2.page.locator('.pf-hero', { hasText: 'Vault balance' }).count();
  await snap(s2, 'apidown-abort-portfolio');
  await goto(s2, '/app/trade/TSLA?mode=perps', { real: false });
  await sleep(1500);
  const t2 = flat(await s2.page.locator('.ticket').innerText());
  await snap(s2, 'apidown-abort-ticket');
  note('A2-abort', !/real/.test(b2) && !DEMO.test(body2) && vault2 === 1 && /New trades paused/.test(t2) && !/Price limit/.test(t2), `banner="${b2.slice(0, 120)}"; demo content=${DEMO.test(body2)}; vault account shown=${vault2}; ticket="${t2.slice(0, 120)}"`);
  await s2.browser.close();

  // First paint: the server-rendered HTML of a real build carries no demo content.
  const bad = [];
  for (const p of ['/app/trade/TSLA', '/app/portfolio', '/app/swap', '/app/liquidity', '/app/makers', '/app/markets']) {
    const html = await (await fetch(BASE + p)).text();
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    if (DEMO.test(visible) || !/Checking this build/.test(visible)) bad.push(`${p}: ${(visible.match(DEMO) || ['no checking banner'])[0]}`);
  }
  note('A2-first-paint', bad.length === 0, bad.length ? bad.join('; ') : 'server HTML of 6 routes: no demo content, the banner says the contracts are being checked');
};

// A3-A4 (W3-05, W3-12): positions and activity from a failing or hostile API.
CASES.hostileIndex = async () => {
  const s = await session('index');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 2000);
  const id = await openLong(s, 300);
  await s.browser.close();
  // A new browser (no stored ids), same key, with the positions endpoint failing.
  const s2 = await session('index-500', { fund: null, pk: s.pk, routes: [async (route, u) => { if (/\/api\/v1\/accounts\/.*\/positions/.test(u.pathname)) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL"}}' }); return true; } }] });
  await goto(s2, '/app/trade/TSLA?mode=perps');
  await connect(s2);
  await s2.page.locator('.posbox tbody tr', { hasText: 'TSLA' }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const posbox = flat(await s2.page.locator('.posbox').innerText());
  await snap(s2, 'positions-api-500');
  await waitOracleCalm('TSLA');
  let closed = false;
  if (await s2.page.locator('.posbox .btn:not([disabled])', { hasText: 'Close' }).count()) {
    await s2.page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
    await confirmAndWait(s2);
    closed = !(await position(id)).open;
  }
  note('A3-positions-500', !!id && !/No open positions/.test(posbox) && /index is unavailable/.test(posbox) && closed, `position #${id} open on chain, positions API 500 in a fresh browser: "${posbox.slice(0, 200)}"; closed from there: ${closed}`);
  await s2.browser.close();

  const evil = { items: [
    { kind: '<img src=x onerror=alert(1)>', tx: '0x' + 'ab'.repeat(32), block: 1, logIndex: 0, at: Date.now(), contract: '0x0', market: 'TSLA', token: null, positionId: '1', data: {} },
    { kind: 'URGENT_your_vault_is_compromised_withdraw_now_to_0x000000000000000000000000000000000000dEaD_or_visit_velum-support.example', tx: '0x' + 'cd'.repeat(32), block: 1, logIndex: 1, at: Date.now(), contract: '0x0', market: '<b>x</b>', token: null, positionId: '1', data: { amount: '1e99', token: '<script>' } },
    { kind: 'position_open', tx: '0x' + 'ef'.repeat(32), block: 1, logIndex: 2, at: Date.now(), contract: '0x0', market: 'Visit velum-support now', token: null, positionId: '1', data: { role: 'taker', side: 'long', qty: '1', entry: '1', takerMargin: '1' } },
    { kind: 'deposit', tx: 'javascript:alert(1)', block: 1, logIndex: 3, at: Date.now(), contract: '0x0', market: null, token: null, positionId: null, data: { amount: '5', token: 'USDG' } },
  ], next: null };
  const many = Array.from({ length: 3000 }, (_, i) => ({ id: String(100000 + i), status: 'open', openTx: null }));
  const s3 = await session('index-hostile', { fund: null, pk: s.pk, routes: [async (route, u) => {
    if (/\/api\/v1\/accounts\/.*\/activity/.test(u.pathname)) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evil) }); return true; }
    if (/\/api\/v1\/accounts\/.*\/positions/.test(u.pathname)) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(many) }); return true; }
  }] });
  await goto(s3, '/app/portfolio');
  await connect(s3);
  const b0 = s3.rec.rpcBodies.length;
  await sleep(13_000);
  const acts = (await s3.page.locator('.act').allInnerTexts()).map(flat);
  const hrefs = await s3.page.locator('.act a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  const imgs = await s3.page.locator('.act img').count();
  const fake = new Set();
  for (const b of s3.rec.rpcBodies.slice(b0)) for (const m of b.matchAll(new RegExp(`${GET_POSITION}([0-9a-f]{64})`, 'g'))) { const n = BigInt('0x' + m[1]); if (n >= 100000n) fake.add(n); }
  note('A4-activity-markup', s3.rec.dialogs.length === 0 && imgs === 0 && !hrefs.some((h) => /javascript/i.test(h || '')), `dialogs=${s3.rec.dialogs.length}, injected <img>=${imgs}, rows=${acts.length}, hrefs=${JSON.stringify(hrefs)}`);
  note('A4-activity-text', !acts.some((x) => /compromised|velum-support|URGENT|<b>/i.test(x)), `rows: ${JSON.stringify(acts).slice(0, 300)}`);
  note('A4-position-ids', fake.size <= 100, `3,000 fake open-position ids from the API -> ${fake.size} distinct ones read on chain in 13 s (cap 100)`);
  await snap(s3, 'hostile-activity');
  await s3.browser.close();
};

// A5: wallet switched to another chain while the transaction is being simulated.
CASES.chainSwitchRace = async () => {
  const s = await session('race');
  await goto(s, '/app/portfolio');
  await connect(s);
  await s.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await s.page.locator('#mv-amt').fill('50');
  await s.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  let switched = false;
  const onRpc = async (route) => {
    if (!switched && (route.request().postData() || '').includes('0x095ea7b3')) { switched = true; await s.wallet.setChain(s.page, 4663); }
    return route.fallback();
  };
  await s.context.route(RPC + '/**', onRpc);
  await s.context.route(RPC, onRpc);
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  await m.locator('.boxnote.warn[role="alert"], button:has-text("Done")').first().waitFor({ timeout: 60_000 });
  const text = flat(await m.innerText());
  note('A5-chain-switch-during-simulation', switched && s.wallet.wrongChainSends === 0 && s.wallet.txs.length === 0, `switched=${switched}, wallet tx requests=${s.wallet.txs.length}, wrong-chain sends=${s.wallet.wrongChainSends}; dialog: ${text.slice(-170)}`);
  await snap(s, 'chain-switch-race');
  await s.browser.close();
};

// A6: the price moves past the limit while the wallet prompt is open.
CASES.priceDuringSignature = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  await waitOracleCalm('TSLA');
  const s = await session('sigprice');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 1000);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('.ticket .seg button', { hasText: '0.1%' }).click();
  await s.page.locator('#t-size').fill('200');
  await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  const m = s.page.locator('.modal');
  s.wallet.hold = true;
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  await waitFor('open request held', async () => { if (s.wallet.pending.length && s.wallet.txs.at(-1) && !decode(s.wallet.txs.at(-1).data).startsWith('open')) s.wallet.releaseAll(); return s.wallet.pending.length && decode(s.wallet.txs.at(-1).data).startsWith('open'); }, 60_000, 200);
  const sent = decode(s.wallet.txs.at(-1).data);
  await ctl(`/price?sym=TSLA&wei=${394n * 10n ** 18n}`);
  await waitFor('price moved on chain', async () => { const o = await ctl('/oracle?sym=TSLA'); return !o.lagging && BigInt(o.price) >= 3935n * 10n ** 17n; }, 120_000, 1000);
  const before = await nextPos();
  s.wallet.hold = false; s.wallet.releaseAll();
  await Promise.race([m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 90_000 }), m.locator('.boxnote.warn[role="alert"]').waitFor({ timeout: 90_000 })]);
  const text = flat(await m.innerText());
  const after = await nextPos();
  note('A6-price-moved-during-signature', after === before && /reverted/.test(text), `sent ${sent}; positions opened=${after - before}; dialog: ${text.slice(-220)}`);
  await snap(s, 'price-during-signature');
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  await s.browser.close();
};

/** Opens the open dialog with the wallet holding requests; resolves once the open request itself is held. */
async function heldOpen(s, size) {
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('#t-size').fill(String(size));
  await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  const m = s.page.locator('.modal');
  s.wallet.hold = true;
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  await waitFor('open request held', async () => { if (s.wallet.pending.length && !decode(s.wallet.txs.at(-1).data).startsWith('open')) s.wallet.releaseAll(); return s.wallet.pending.length && decode(s.wallet.txs.at(-1).data).startsWith('open'); }, 60_000, 200);
  return m;
}

// A7 (W3-01): "Cancel" while the wallet prompt is open, then the wallet sends it anyway: followed, never sent twice.
CASES.cancelThenRetry = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const s = await session('cancel');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 2000);
  await waitOracleCalm('TSLA');
  const before = await nextPos();
  const m = await heldOpen(s, 200);
  await m.locator('button', { hasText: 'Cancel' }).waitFor({ timeout: 15_000 });
  await m.locator('button', { hasText: 'Cancel' }).click();
  const cancelled = flat(await m.innerText());
  const retryWhileOpen = await m.locator('button', { hasText: 'Try again' }).count();
  await snap(s, 'cancel-open');
  s.wallet.hold = false;
  s.wallet.releaseAll(); // the user approves the old prompt in the wallet after all
  await m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 90_000 }).catch(() => undefined);
  const late = flat(await m.innerText());
  await snap(s, 'cancel-then-late-confirm');
  const retryAfter = await m.locator('button', { hasText: 'Try again' }).count();
  await sleep(1500);
  const mine = await minePositions(s, before, await nextPos());
  note('A7-cancel-then-wallet-sends', mine.length === 1 && /may already be pending/.test(cancelled) && retryWhileOpen === 0 && retryAfter === 0 && /Position ID/.test(late),
    `after Cancel: "${cancelled.slice(-150)}", "Try again" offered: ${retryWhileOpen}; the late transaction was followed: "${late.slice(-150)}"; positions opened by this wallet: ${mine.length} (#${mine.join(', #')}); wallet sends=${s.wallet.sent.length}`);
  await s.browser.close();
};

// A7b (W3-01): Cancel, then the wallet declines the open prompt: a retry is safe and sends exactly once.
CASES.cancelThenReject = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const s = await session('cancel-reject');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 2000);
  await waitOracleCalm('TSLA');
  const before = await nextPos();
  const m = await heldOpen(s, 200);
  await m.locator('button', { hasText: 'Cancel' }).waitFor({ timeout: 15_000 });
  await m.locator('button', { hasText: 'Cancel' }).click();
  s.wallet.hold = false;
  s.wallet.rejectNext = true;
  s.wallet.releaseAll();
  await m.locator('button', { hasText: 'Try again' }).waitFor({ timeout: 20_000 });
  const declined = flat(await m.innerText());
  await waitOracleCalm('TSLA');
  await m.locator('button', { hasText: 'Try again' }).click();
  await Promise.race([m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 90_000 }), m.locator('.boxnote.warn[role="alert"]').waitFor({ timeout: 90_000 })]);
  const done = flat(await m.innerText());
  const mine = await minePositions(s, before, await nextPos());
  note('A7b-cancel-then-wallet-declines', mine.length === 1 && /declined/.test(declined) && /Position ID/.test(done), `after the late decline: "${declined.slice(-110)}"; after Try again: "${done.slice(-90)}"; positions opened: ${mine.length}`);
  await s.browser.close();
};

// A7c (W3-01): the wallet broadcasts the open but reports an error: the pending nonce moved, so no blind retry.
CASES.sentButErrored = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const s = await session('sent-errored');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 2000);
  await waitOracleCalm('TSLA');
  const before = await nextPos();
  // The module approval goes through; the open is broadcast but the wallet answers with an error.
  const m = await heldOpen(s, 200);
  s.wallet.failAfterSend = true;
  s.wallet.hold = false;
  s.wallet.releaseAll();
  await m.locator('.boxnote.warn[role="alert"], button:has-text("Done")').first().waitFor({ timeout: 90_000 });
  const text = flat(await m.innerText());
  const retry = await m.locator('button', { hasText: 'Try again' }).count();
  await snap(s, 'sent-but-errored');
  await sleep(1500);
  const mine = await minePositions(s, before, await nextPos());
  note('A7c-broadcast-but-wallet-error', retry === 0 && /may already be pending/.test(text) && mine.length === 1, `dialog: "${text.slice(-200)}"; "Try again" offered: ${retry}; positions opened: ${mine.length}`);
  await s.browser.close();
};

// A8 (W3-04): the pending withdrawal is replaced by a cancel (same nonce, 0 ETH to self): never "Confirmed".
CASES.replacedTx = async () => {
  const s = await session('replaced');
  await goto(s, '/app/portfolio');
  await connect(s);
  await shield(s, 500);
  const before = await vaultBal(s.addr, 'USDG');
  await s.page.locator('.pf-actions .btn', { hasText: 'Unshield' }).click();
  await s.page.locator('#mv-amt').fill('100');
  await s.page.locator('.modal .btn-block', { hasText: 'Unshield USDG' }).click();
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  await ctl('/pusher?on=0');
  await sleep(2500);
  await rpc('evm_setAutomine', [false]);
  try {
    s.wallet.gasPrice = 2_000_000_000n;
    await m.locator('button', { hasText: 'Confirm in wallet' }).click();
    await waitFor('withdraw sent (pending)', async () => s.wallet.sent.length > 0 && s.wallet.txs.some((x) => decode(x.data).startsWith('withdraw')), 30_000, 200);
    const orig = s.wallet.sent.at(-1);
    await sleep(5000); // let the app's receipt watcher see the pending transaction
    const tx = await pub.getTransaction({ hash: orig });
    const w = createWalletClient({ account: privateKeyToAccount(s.pk), chain, transport: http(RPC) });
    await w.sendTransaction({ to: s.addr, value: 0n, nonce: tx.nonce, gasPrice: 20_000_000_000n, gas: 21000n, chain });
    await rpc('evm_mine');
  } finally {
    await rpc('evm_setAutomine', [true]);
    await ctl('/pusher?on=1');
  }
  s.wallet.gasPrice = undefined;
  await Promise.race([m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 90_000 }), m.locator('.boxnote.warn[role="alert"]').waitFor({ timeout: 90_000 })]);
  const text = flat(await m.innerText());
  const after = await vaultBal(s.addr, 'USDG');
  note('A8-replaced-by-cancel', !/Withdrawn|Done/.test(text) && /cancelled it before it confirmed/.test(text) && after === before, `vault USDG before=${before} after=${after}; dialog: ${text.slice(0, 260)}`);
  await snap(s, 'replaced-by-cancel');
  await s.browser.close();
};

// A9 (W3-03): a 2 bps open / 500 bps close offer: ranked by the whole round trip, its cost shown, chosen only knowingly.
CASES.offerSteering = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const { ma, send } = await makerWallet(20000);
  await send(D.tokens.USDG, ERC20, 'approve', [D.contracts.vault, 20000n * 10n ** 6n]);
  await send(D.contracts.vault, VAULT, 'deposit', [D.tokens.USDG, 20000n * 10n ** 6n, ma.address]);
  await send(D.contracts.vault, VAULT, 'setApproval', [D.contracts.makerBook, true]);
  const now = (await pub.getBlock()).timestamp;
  await send(D.contracts.makerBook, BOOK, 'postOffer', [D.tokens.TSLA, 10000n * 10n ** 6n, 5000n * 10n ** 6n, 2, 500, now + 86400n]);
  const offerId = (await pub.readContract({ address: D.contracts.makerBook, abi: BOOK, functionName: 'nextOfferId' })) - 1n;
  const s = await session('steer');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 2000);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('#t-size').fill('1000');
  await s.page.locator('.ticket .seg button', { hasText: '2 / 500 bps' }).waitFor({ timeout: 30_000 });
  const ticket = flat(await s.page.locator('.ticket').innerText());
  const chosen = flat(await s.page.locator('.ticket .seg button[aria-pressed="true"]', { hasText: 'bps' }).innerText());
  await snap(s, 'offer-choice-ticket');
  await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  const review = flat(await m.innerText());
  await snap(s, 'offer-review');
  const t = await confirmAndWait(s);
  const id = /Position ID\s*#(\d+)/.exec(t)?.[1];
  const p = await position(id);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  const ct = flat(await confirmAndWait(s));
  // Now pick the 500 bps close offer on purpose: the review asks for an explicit acknowledgement.
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('#t-size').fill('1000');
  await s.page.locator('.ticket .seg button', { hasText: '2 / 500 bps' }).click();
  await sleep(500);
  const hint = flat(await s.page.locator('.ticket .hint').innerText());
  await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  const steerReview = flat(await m.innerText());
  const ack = m.locator('input[type="checkbox"]');
  const hasAck = (await ack.count()) === 1;
  const disabledBefore = await m.locator('button', { hasText: 'Confirm in wallet' }).isDisabled();
  await snap(s, 'offer-high-spread-ack');
  if (hasAck) await ack.check();
  const enabledAfter = await m.locator('button', { hasText: 'Confirm in wallet' }).isEnabled();
  await m.locator('.xbtn').click();
  note('A9-offer-steering', p.closeSpreadBps !== 500 && /5 \/ 5 bps/.test(chosen) && /Close spread/.test(ticket) && /Round trip \(est\.\)/.test(ticket) && /Round trip \(est\.\)/.test(review) && /Profit cap/.test(review) && hasAck && disabledBefore && enabledAfter,
    `offer #${offerId} (2/500) posted; ticket default "${chosen}"; position #${id} closeSpreadBps=${p.closeSpreadBps}; ticket: "${ticket.slice(ticket.indexOf('Entry price'), ticket.indexOf('Entry price') + 260)}"; review: "${review.slice(review.indexOf('Maker offer'), review.indexOf('Maker offer') + 160)}"`);
  note('A9-round-trip-5-5', null, `open + close at an unchanged price: ${ct.slice(ct.indexOf('Exit price'), ct.indexOf('Exit price') + 120)}`);
  note('A9-high-spread-ack', hasAck && disabledBefore && enabledAfter && /500 bps close spread/.test(steerReview), `ticket hint: "${hint.slice(0, 150)}"; review asks: "${(steerReview.match(/I accept[^.]*\./) || [''])[0].slice(0, 220)}"; confirm disabled until ticked: ${disabledBefore} -> ${!enabledAfter}`);
  await s.browser.close();
};

/** Posts `n` dust offers (1 base unit of USDG each) from a fresh maker. */
async function dust(n) {
  const { ma, send } = await makerWallet(1);
  await send(D.tokens.USDG, ERC20, 'approve', [D.contracts.vault, 10n ** 6n]);
  await send(D.contracts.vault, VAULT, 'deposit', [D.tokens.USDG, 10n ** 6n, ma.address]);
  await send(D.contracts.vault, VAULT, 'setApproval', [D.contracts.makerBook, true]);
  const now = (await pub.getBlock()).timestamp;
  let last;
  for (let i = 0; i < n; i++) last = await send(D.contracts.makerBook, BOOK, 'postOffer', [D.tokens.TSLA, 1n, 1n, 2, 0, now + 86400n], false);
  await pub.waitForTransactionReceipt({ hash: last });
}

// A10 (W3-09): dust offers on top of the book do not hide the real ones.
async function spamCase(id, n) {
  await dust(n);
  const s = await session(`spam-${n}`);
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 1000);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('#t-size').fill('100');
  const t0 = Date.now();
  const ok = await s.page.locator('.ticket .btn-block', { hasText: 'Open long' }).waitFor({ timeout: 45_000 }).then(() => true, () => false);
  const btn = flat(await s.page.locator('.ticket .btn-block').innerText());
  note(id, ok, `after ${n} offers of 0.000001 USDG on top of the book the ticket button reads "${btn}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  await snap(s, `offer-spam-${n}`);
  await s.browser.close();
}
CASES.offerSpam = () => spamCase('A10-offer-scan-spam-120', 120);
CASES.offerSpamDeep = () => spamCase('A10b-offer-scan-spam-1600', 1600);

// A11: double-click on "Confirm in wallet".
CASES.doubleClick = async () => {
  const s = await session('dbl');
  await goto(s, '/app/portfolio');
  await connect(s);
  await s.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await s.page.locator('#mv-amt').fill('10');
  await s.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).dblclick();
  await m.locator('button', { hasText: 'Done' }).waitFor({ timeout: 60_000 });
  note('A11-double-click', s.wallet.sent.length === 2, `wallet sends=${s.wallet.sent.length} (approve + deposit expected), vault=${await vaultBal(s.addr, 'USDG')}`);
  await s.browser.close();
};

// A12: the wallet switches account between the approval and the deposit.
CASES.accountSwitch = async () => {
  const s = await session('acct');
  await goto(s, '/app/portfolio');
  await connect(s);
  await s.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await s.page.locator('#mv-amt').fill('25');
  await s.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  const m = s.page.locator('.modal');
  s.wallet.hold = true;
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  await waitFor('approve held', async () => s.wallet.pending.length > 0, 30_000, 200);
  const other = privateKeyToAccount(generatePrivateKey()).address;
  await s.page.evaluate((a) => window.__walletEmit('accountsChanged', [a]), other);
  await sleep(500);
  s.wallet.hold = false; s.wallet.releaseAll();
  await m.locator('.boxnote.warn[role="alert"], button:has-text("Done")').first().waitFor({ timeout: 60_000 });
  const text = flat(await m.innerText());
  const reqs = s.wallet.txs.map((x) => decode(x.data).split('(')[0]);
  note('A12-account-switch-between-steps', !reqs.includes('deposit'), `wallet requests: ${reqs.join(', ')}; dialog: ${text.slice(-150)}`);
  await s.browser.close();
};

// A13: short open and close on chain: argument order, price-limit direction.
CASES.shortRoundTrip = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const s = await session('short');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 1000);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('.sides button', { hasText: 'Short' }).click();
  await s.page.locator('#t-lev').fill('5');
  await s.page.locator('#t-size').fill('250');
  await s.page.locator('.ticket .btn-block', { hasText: 'Open short' }).click();
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  const t = await confirmAndWait(s);
  const openTx = s.wallet.txs.map((x) => decode(x.data)).find((x) => x.startsWith('open'));
  const id = /Position ID\s*#(\d+)/.exec(t)?.[1];
  const p = await position(id);
  const lim = openTx.slice(5, -1).split(',')[5];
  note('A13-short-open', !p.isLong && p.leverageHalf === 10 && BigInt(lim) <= p.entry, `sent ${openTx}; on chain entry=${p.entry} (limit ${lim} must be <= entry for a short), takerMargin=${p.takerMargin}`);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  await confirmAndWait(s);
  const closeTx = s.wallet.txs.map((x) => decode(x.data)).find((x) => x.startsWith('close'));
  note('A13-short-close', !(await position(id)).open, `sent ${closeTx}`);
  await s.browser.close();
};

// A14: "Max" size at 3.5x opens.
CASES.maxPreset = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const s = await session('max', { fund: { usdg: 1000 } });
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 333.333333);
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('#t-lev').fill('3.5');
  await s.page.locator('.ticket .pcts button', { hasText: 'Max' }).click();
  await sleep(1500);
  const size = await s.page.locator('#t-size').inputValue();
  const btn = await s.page.locator('.ticket .btn-block').innerText();
  let res = 'not attempted';
  if (/Open/.test(btn)) { await s.page.locator('.ticket .btn-block').click(); const t = await confirmAndWait(s); res = /Position ID/.test(t) ? 'opened' : flat(t).slice(-120); }
  note('A14-max-preset', /opened/.test(res), `size=${size}, button="${btn}", result=${res}, vault left=${await vaultBal(s.addr, 'USDG')}`);
  await s.browser.close();
};

// A15 (W3-10): close a liquidatable position: the review quotes the liquidation route the chain takes.
CASES.closeLiquidatable = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  await waitOracleCalm('TSLA');
  const s = await session('liqclose');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await connect(s);
  await shield(s, 1000);
  const id = await openLong(s, 500, 5);
  await ctl('/pusher?on=0');
  await ctl(`/price?sym=TSLA&wei=${(TSLA_PRICE * 87n) / 100n}`);
  for (let i = 0; i < 3; i++) await ctl('/warp?s=300');
  await ctl('/pusher?on=1');
  await waitOracleCalm('TSLA');
  const liqNow = await pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'isLiquidatable', args: [BigInt(id)] });
  await goto(s, '/app/trade/TSLA?mode=perps');
  await s.page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor();
  const cr = flat(await m.innerText());
  await snap(s, 'close-liquidatable-review');
  const ct = flat(await confirmAndWait(s));
  const num = (re, t) => { const x = re.exec(t); return x ? Number(x[1].replace(/,/g, '')) : NaN; };
  const est = num(/Total back to your vault \(est\.\)\s*([\d,.]+) USDG/, cr);
  const got = num(/Total back to your vault\s*([\d,.]+) USDG/, ct);
  note('A15-close-when-liquidatable', liqNow && /Settles as/.test(cr) && /liquidation/i.test(cr) && Math.abs(est - got) <= Math.max(0.1, got * 0.005),
    `isLiquidatable=${liqNow}; review: total (est.) ${est} USDG ("${cr.slice(cr.indexOf('Settles as'), cr.indexOf('Settles as') + 200)}"); receipt: total ${got} USDG ("${ct.slice(ct.indexOf('Exit price'), ct.indexOf('Exit price') + 220)}")`);
  await ctl('/pusher?on=0');
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  for (let i = 0; i < 3; i++) await ctl('/warp?s=300');
  await ctl('/pusher?on=1');
  await s.browser.close();
};

// A16 (W3-06): no demo in an API-down session, and a demo ledger left in the browser never "liquidates" in real mode.
CASES.demoToastInRealMode = async () => {
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  const st = { mode: '503' };
  const s = await session('demotoast', { routes: [blockDeployment(st)] });
  await goto(s, '/app/trade/TSLA?mode=perps', { real: false });
  await connect(s);
  await sleep(1500);
  const downBody = await s.page.locator('body').innerText();
  const demoTicket = await s.page.locator('.ticket .btn-block', { hasText: 'privately' }).count();
  // A ledger an earlier simulated build left in this browser: a 5x TSLA long, liquidatable after a 30% drop.
  const ledger = { priv: { USDG: '1000000000000000000000n' }, positions: [{ id: 'demo1', sym: 'TSLA', side: 'long', lev: 5, margin: '200000000000000000000n', qty: '2553000000000000000n', entry: '391650000000000000000n', liq: '352000000000000000000n', cs: '500000000000000n', commit: '0x' + 'ab'.repeat(32), block: 1, openedAt: Date.now() }], history: [], offers: [], lp: {}, lastChain: null, shielded: {} };
  await s.page.evaluate(([k, v]) => localStorage.setItem(k, v), [`velum:demo:v2:46630:${s.addr.toLowerCase()}`, JSON.stringify(ledger)]);
  st.mode = null; // the API is back
  await goto(s, '/app/trade/TSLA?mode=perps');
  const toasts = [];
  await s.page.exposeFunction('__toast', (t) => toasts.push(t));
  await s.page.evaluate(() => new MutationObserver(() => document.querySelectorAll('.toast').forEach((e) => window.__toast(e.textContent))).observe(document.body, { subtree: true, childList: true }));
  await ctl(`/price?sym=TSLA&wei=${(TSLA_PRICE * 70n) / 100n}`); // the market snapshot (API) drops 30%
  await sleep(9000);
  const banner = flat(await s.page.locator('.demo-bar').innerText());
  const body = await s.page.locator('body').innerText();
  const uniq = [...new Set(toasts.map((t) => t.trim()).filter(Boolean))];
  note('A16-no-demo-engine-on-a-real-build', !DEMO.test(downBody) && demoTicket === 0 && !uniq.some((t) => /liquidated/i.test(t)) && !/1,000\.00 USDG|Private balance/.test(body) && /real/.test(banner),
    `API-down session: demo content=${DEMO.test(downBody)}, demo ticket=${demoTicket}; real mode with a planted demo ledger and a 30% drop: toasts=${JSON.stringify(uniq).slice(0, 160)}; banner="${banner.slice(0, 80)}"`);
  await snap(s, 'demo-toast-real-mode');
  await ctl(`/price?sym=TSLA&wei=${TSLA_PRICE}`);
  await s.browser.close();
};

(async () => {
  D = (await ctl('/info')).deployment;
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
  for (const k of want) {
    try { await CASES[k](); } catch (e) { const line = `[${k}] ERROR: ${String(e).split('\n')[0].slice(0, 300)}`; results.push(line); console.log(line); }
  }
  fs.writeFileSync(path.join(OUT, 'adv-results.txt'), results.join('\n') + '\n');
  const bad = results.filter((l) => /\] (FAIL|ERROR):/.test(l));
  console.log(bad.length ? `ADVERSARIAL: ${bad.length} case(s) failed` : `ADVERSARIAL: all ${results.filter((l) => /\] PASS:/.test(l)).length} checks passed`);
  process.exit(bad.length ? 1 : 0);
})();
