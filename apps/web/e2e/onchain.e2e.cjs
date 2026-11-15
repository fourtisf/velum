// Browser scenarios of the web's real (Phase 3) mode, run by onchain-e2e.sh against the local stack.
// Usage: node onchain.e2e.cjs unguarded|guarded   (E2E_BASE, E2E_RPC, E2E_CTL, E2E_OUT set by the script)
// Each scenario drives the real UI with a mock wallet that signs with a throwaway key, then checks the
// result on chain (and in the API's index). Every page is watched for CSP violations, console errors,
// page errors and requests leaving the machine; any of them fails the run.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const { installWallet } = require('./wallet.cjs');

const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { createPublicClient, http, parseAbi } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');

const PHASE = process.argv[2] || 'unguarded';
const BASE = process.env.E2E_BASE;
const RPC = process.env.E2E_RPC;
const CTL = process.env.E2E_CTL;
const OUT = path.join(process.env.E2E_OUT || path.join(__dirname, 'out'), PHASE);
fs.mkdirSync(OUT, { recursive: true });

const pub = createPublicClient({ transport: http(RPC) });
const VAULT = parseAbi(['function balanceOf(address account, address token) view returns (uint256)', 'function approved(address account, address module) view returns (bool)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)']);
const PERPS = parseAbi([
  'function getPosition(uint256 id) view returns ((address taker, address maker, address market, bool isLong, bool open, uint8 leverageHalf, uint16 closeSpreadBps, uint64 openedAt, uint64 exitRequestedAt, address exitRequester, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, int256 fundingIndexAtOpen))',
  'function bondRefunds(address) view returns (uint256)',
]);
const BOOK = parseAbi(['function offers(uint256 id) view returns (address maker, address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry, bool active)']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = async (p) => {
  const r = await fetch(CTL + p);
  const b = await r.json();
  if (!r.ok) throw new Error(`${p}: ${b.error}`);
  return b;
};
let failures = 0;
const results = [];
function check(name, cond, detail = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  console.log(`${cond ? '  ok ' : '  !! '} ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures++;
}
async function waitFor(what, fn, ms = 60_000, every = 500) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last})` : ''}`);
}

let D; // deployment
let shot = 0;

async function session(name, { fund = { usdg: 10000, tsla: 5 }, chainId = 31337, viewport = { width: 1366, height: 900 } } = {}) {
  const pk = generatePrivateKey();
  const addr = privateKeyToAccount(pk).address;
  const q = new URLSearchParams({ addr, ...Object.fromEntries(Object.entries(fund).map(([k, v]) => [k, String(v)])) });
  await ctl(`/fund?${q}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport });
  const rec = { console: [], pageErrors: [], external: [], csp: [] };
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    rec.external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const wallet = await installWallet(context, { privateKey: pk, rpc: RPC, chainId });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') rec.console.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  const collectCsp = async () => {
    try {
      rec.csp.push(...(await page.evaluate(() => window.__csp.splice(0))));
    } catch {
      /* navigating */
    }
  };
  page.on('framenavigated', () => void collectCsp());
  return { name, browser, context, page, wallet, rec, addr, collectCsp };
}

async function snap(s, label) {
  const file = path.join(OUT, `${String(++shot).padStart(2, '0')}-${label}.png`);
  await s.page.screenshot({ path: file, animations: 'disabled' });
  return file;
}

async function goto(s, p) {
  await s.collectCsp();
  await s.page.goto(BASE + p, { waitUntil: 'networkidle' });
  // Real mode is on once the deployment check passed (the banner says so).
  await s.page.locator('.demo-bar', { hasText: 'real' }).waitFor({ timeout: 20_000 });
  await sleep(800);
}

async function connect(s) {
  await s.page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await s.page.locator('.modal .wopt', { hasText: 'Test Wallet' }).click();
  await s.page.locator('.modal button', { hasText: 'Sign message' }).click();
  await s.page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await sleep(1200);
}

/** A TxFlow dialog is open in review: screenshot, confirm, wait for the receipt or a failure. */
async function flow(s, label, { expectFail = false, beforeConfirm } = {}) {
  const m = s.page.locator('.modal');
  await m.locator('button', { hasText: 'Confirm in wallet' }).waitFor({ timeout: 20_000 });
  await snap(s, `${label}-review`);
  const review = await m.innerText();
  if (beforeConfirm) await beforeConfirm();
  await m.locator('button', { hasText: 'Confirm in wallet' }).click();
  const done = m.locator('button', { hasText: 'Done' });
  const failed = m.locator('.boxnote.warn[role="alert"]');
  await Promise.race([done.waitFor({ timeout: 120_000 }), failed.waitFor({ timeout: 120_000 })]);
  await sleep(300);
  const text = await m.innerText();
  await snap(s, `${label}-${(await done.isVisible()) ? 'receipt' : 'failed'}`);
  const ok = await done.isVisible();
  check(`${label}: ${expectFail ? 'refused as expected' : 'confirmed'}`, ok === !expectFail, ok ? '' : text.split('\n').slice(-4).join(' | ').slice(0, 300));
  return { ok, text, review, close: async () => (ok ? done.click() : m.locator('button', { hasText: 'Close' }).last().click()) };
}

const vaultBal = (addr, sym) => pub.readContract({ address: D.contracts.vault, abi: VAULT, functionName: 'balanceOf', args: [addr, D.tokens[sym]] });
const walletBal = (addr, sym) => pub.readContract({ address: D.tokens[sym], abi: ERC20, functionName: 'balanceOf', args: [addr] });
const position = (id) => pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'getPosition', args: [BigInt(id)] });
const idFrom = (text, what) => {
  const m = new RegExp(`${what}\\s*#(\\d+)`).exec(text);
  return m ? m[1] : null;
};

async function waitOracleCalm(sym) {
  await waitFor(`${sym} oracle not lagging`, async () => {
    const o = await ctl(`/oracle?sym=${sym}`);
    return !o.lagging && BigInt(o.now) - BigInt(o.updatedAt) <= 6n;
  }, 120_000, 1000);
}

async function finish(s) {
  await s.collectCsp();
  const consoleBad = s.rec.console.filter((x) => !/Download the React DevTools/.test(x));
  check(`${s.name}: no CSP violations`, s.rec.csp.length === 0, s.rec.csp.slice(0, 3).join('; '));
  check(`${s.name}: no console errors or warnings`, consoleBad.length === 0, consoleBad.slice(0, 3).join('; '));
  check(`${s.name}: no page errors`, s.rec.pageErrors.length === 0, s.rec.pageErrors.slice(0, 2).join('; '));
  check(`${s.name}: no request left the machine`, s.rec.external.length === 0, [...new Set(s.rec.external.map((u) => new URL(u).host))].join(', '));
  check(`${s.name}: nothing sent while the wallet was on another network`, s.wallet.wrongChainSends === 0);
  await s.browser.close();
}

async function unguarded() {
  const s = await session('trader');
  const { page } = s;
  const a = s.addr;

  // Deposit (shield): exact approval, then deposit.
  await goto(s, '/app/portfolio');
  await connect(s);
  await page.locator('.pf-hero', { hasText: 'Vault balance' }).waitFor();
  await snap(s, 'portfolio-onchain');
  await page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await page.locator('#mv-amt').fill('2000');
  await page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  let f = await flow(s, 'deposit');
  check('deposit review shows the exact amount and the exact approval', /Deposit\s*2,000 USDG/.test(f.review) && /Exactly 2,000 USDG/.test(f.review));
  await f.close();
  check('vault holds 2,000 USDG', (await vaultBal(a, 'USDG')) === 2000_000000n);
  check('no allowance left over (exact approval)', (await pub.readContract({ address: D.tokens.USDG, abi: ERC20, functionName: 'allowance', args: [a, D.contracts.vault] })) === 0n);
  check('two transactions sent (approve, deposit)', s.wallet.sent.length === 2, String(s.wallet.sent.length));

  // Open perps: module approval, then open with a non-zero price limit.
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await page.locator('#t-size').fill('500');
  await page.locator('.ticket .btn-block', { hasText: 'Open long' }).waitFor({ timeout: 20_000 });
  await snap(s, 'ticket-perps');
  await page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  f = await flow(s, 'open-perps');
  check('open review shows fee, liquidation price and price limit', /Fee \(0\.06%\)\s*0\.3 USDG/.test(f.review) && /Liquidation \(est\.\)\s*[\d,]+\.\d\d/.test(f.review) && /Price limit\s*At most [\d,.]+ \(0\.5% slippage\)/.test(f.review), f.review.replace(/\n/g, ' | ').slice(0, 400));
  const posId = idFrom(f.text, 'Position ID');
  await f.close();
  const p1 = await position(posId);
  check('position open on chain for this wallet', p1.open && p1.taker.toLowerCase() === a.toLowerCase() && p1.leverageHalf === 4, `#${posId}`);
  check('margin 250 USDG at 2x on 500 USDG', p1.takerMargin === 250_000000n);
  await waitFor('the API index lists the position', async () => {
    const r = await (await fetch(`${BASE}/api/v1/accounts/${a}/positions?status=open`)).json();
    return Array.isArray(r) && r.some((x) => x.id === posId);
  });
  check('API lists the open position', true);
  await page.locator('.posbox tbody tr').first().waitFor({ timeout: 20_000 });
  await snap(s, 'positions');

  // 360 px with a position open: no sideways scroll, Manage and Close reachable.
  await page.setViewportSize({ width: 360, height: 780 });
  for (const route of ['/app/portfolio', '/app/trade/TSLA?mode=perps']) {
    await goto(s, route);
    await page.locator('.tbl tbody tr .btn', { hasText: 'Manage' }).first().waitFor({ timeout: 20_000 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`360 px ${route}: no horizontal overflow`, over <= 1, String(over));
    await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-mobile-${route.split('/')[2]}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await goto(s, '/app/trade/TSLA?mode=perps');
  await page.locator('.posbox tbody tr').first().waitFor({ timeout: 20_000 });

  // Close.
  await page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
  f = await flow(s, 'close-perps');
  await f.close();
  check('position closed on chain', !(await position(posId)).open);

  // A revert shown properly: the price moves past a 0.1% slippage limit between review and confirm.
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await page.locator('.ticket .seg button', { hasText: '0.1%' }).click();
  await page.locator('#t-size').fill('300');
  await page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  const sentBefore = s.wallet.sent.length;
  f = await flow(s, 'slippage-revert', {
    expectFail: true,
    beforeConfirm: async () => {
      await ctl(`/price?sym=TSLA&wei=${393n * 10n ** 18n}`);
      await waitFor('the onchain price caught up', async () => {
        const o = await ctl('/oracle?sym=TSLA');
        return !o.lagging && BigInt(o.price) >= 3929n * 10n ** 17n;
      }, 120_000, 1000);
    },
  });
  check('the revert is decoded (price limit, slippage)', /slippage limit/i.test(f.text), f.text.split('\n').slice(-3).join(' | '));
  check('nothing was sent for the refused open', s.wallet.sent.length === sentBefore);
  await f.close();
  await page.locator('.ticket .seg button', { hasText: '0.5%' }).click();
  await ctl(`/price?sym=TSLA&wei=${39165n * 10n ** 16n}`);

  // Spot swap (USDG -> TSLA), minimum from the slippage setting.
  await goto(s, '/app/swap');
  await page.locator('#sw-in').fill('100');
  await page.locator('.swapcard .btn-block', { hasText: /^Swap$/ }).waitFor({ timeout: 20_000 });
  await snap(s, 'swap');
  await page.locator('.swapcard .btn-block', { hasText: /^Swap$/ }).click();
  f = await flow(s, 'swap');
  check('swap review shows a non-zero minimum and the pool fee', /Minimum you get\s*0\.\d+ TSLA/.test(f.review) && /Pool fee \(0\.30%\)\s*0\.30? USDG/.test(f.review), f.review.replace(/\n/g, ' | ').slice(0, 300));
  await f.close();
  check('vault now holds TSLA from the swap', (await vaultBal(a, 'TSLA')) > 0n);

  // Maker offer: post, then withdraw.
  await goto(s, '/app/makers');
  await page.locator('#of-back').fill('1000');
  await page.locator('#of-max').fill('500');
  await page.locator('.mk-grid .btn-block', { hasText: 'Post offer' }).click();
  f = await flow(s, 'offer-post');
  const offerId = idFrom(f.text, 'Offer ID');
  await f.close();
  const o = await pub.readContract({ address: D.contracts.makerBook, abi: BOOK, functionName: 'offers', args: [BigInt(offerId)] });
  check('offer on chain: 1,000 USDG backing, 8/5 bps', o[7] && o[2] === 1000_000000n && o[4] === 8 && o[5] === 5, `#${offerId}`);
  await page.locator('.stack2 tbody tr', { hasText: `#${offerId}` }).waitFor({ timeout: 20_000 });
  await snap(s, 'offers');
  await page.locator('.stack2 tbody tr', { hasText: `#${offerId}` }).locator('button', { hasText: 'Withdraw' }).click();
  f = await flow(s, 'offer-withdraw');
  await f.close();
  check('offer withdrawn on chain', !(await pub.readContract({ address: D.contracts.makerBook, abi: BOOK, functionName: 'offers', args: [BigInt(offerId)] }))[7]);

  // Forced exit: request (0.001 ETH bond), 7 days later settle, claim the bond.
  await waitOracleCalm('TSLA');
  await goto(s, '/app/trade/TSLA?mode=perps');
  await page.locator('#t-size').fill('200');
  await page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  f = await flow(s, 'open-for-exit');
  const exitId = idFrom(f.text, 'Position ID');
  await f.close();
  await goto(s, '/app/portfolio');
  await page.locator('.tbl tbody tr .btn', { hasText: 'Manage' }).first().click();
  await page.locator('.modal button', { hasText: 'Request forced exit' }).click();
  f = await flow(s, 'forced-exit-request');
  check('forced exit review shows the 0.001 ETH bond', /0\.001 ETH/.test(f.review));
  await f.close();
  const pe = await position(exitId);
  check('forced exit requested on chain', pe.exitRequestedAt > 0n && pe.exitRequester.toLowerCase() === a.toLowerCase(), `#${exitId}`);
  await ctl('/warp?s=605000');
  await waitOracleCalm('TSLA');
  await goto(s, '/app/portfolio');
  await page.locator('.tbl tbody tr .btn', { hasText: 'Manage' }).first().click();
  await page.locator('.modal button:not([disabled])', { hasText: 'Settle forced exit' }).waitFor({ timeout: 30_000 });
  await page.locator('.modal button', { hasText: 'Settle forced exit' }).click();
  f = await flow(s, 'forced-exit-settle');
  await f.close();
  check('forced exit settled on chain', !(await position(exitId)).open);
  const bond = await pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'bondRefunds', args: [a] });
  if (bond > 0n) {
    await goto(s, '/app/portfolio');
    await page.locator('.boxnote button', { hasText: 'Claim bond refund' }).click();
    f = await flow(s, 'claim-bond');
    await f.close();
    check('bond refund claimed', (await pub.readContract({ address: D.contracts.perpsMarkets, abi: PERPS, functionName: 'bondRefunds', args: [a] })) === 0n);
  } else check('bond refunded at settlement', true);

  // Wrong network: refused before anything is sent, then switched from the dialog.
  await goto(s, '/app/portfolio');
  await s.wallet.setChain(page, 1);
  await page.locator('.modal h3', { hasText: 'Switch network' }).waitFor({ timeout: 10_000 });
  await snap(s, 'wrong-network-prompt');
  await page.locator('.modal .xbtn').click();
  await page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await page.locator('#mv-amt').fill('100');
  await page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  f = await flow(s, 'wrong-chain', { expectFail: true });
  check('wrong network refused with a switch offer', /another network/.test(f.text) && (await page.locator('.modal button', { hasText: 'Switch to' }).isVisible()));
  await page.locator('.modal button', { hasText: 'Switch to' }).click();
  await page.locator('.modal button', { hasText: 'Done' }).waitFor({ timeout: 60_000 });
  await snap(s, 'wrong-chain-switched-receipt');
  check('after switching, the deposit went through', (await vaultBal(a, 'USDG')) > 0n && s.wallet.chainId === 31337);
  await page.locator('.modal button', { hasText: 'Done' }).click();

  // Withdraw (unshield) to the wallet.
  const before = await walletBal(a, 'USDG');
  await page.locator('.pf-actions .btn', { hasText: 'Unshield' }).click();
  await page.locator('#mv-amt').fill('300');
  await page.locator('.modal .btn-block', { hasText: 'Unshield USDG' }).click();
  f = await flow(s, 'withdraw');
  await f.close();
  check('300 USDG back in the wallet', (await walletBal(a, 'USDG')) - before === 300_000000n);

  // Liquidity: add (swap half, add both), then remove.
  await goto(s, '/app/liquidity');
  await page.locator('.pool', { hasText: 'TSLA / USDG' }).locator('button', { hasText: 'Add liquidity' }).click();
  await page.locator('#lp-amt').fill('400');
  await page.locator('.modal .btn-block', { hasText: 'Add liquidity' }).click();
  f = await flow(s, 'lp-add');
  await f.close();
  await page.locator('.pool', { hasText: 'TSLA / USDG' }).locator('button', { hasText: 'Remove' }).waitFor({ timeout: 20_000 });
  await page.locator('.pool', { hasText: 'TSLA / USDG' }).locator('button', { hasText: 'Remove' }).click();
  f = await flow(s, 'lp-remove');
  await f.close();

  // Activity from the API's index.
  await goto(s, '/app/portfolio');
  await waitFor('activity from the API', async () => (await page.locator('.act').count()) >= 8, 60_000, 1000);
  const acts = await page.locator('.act').allInnerTexts();
  check('activity lists the deposit, the open and the swap', acts.some((x) => /Shielded [\d,.]+ USDG/.test(x)) && acts.some((x) => /Opened long TSLA/.test(x)) && acts.some((x) => /Swapped/.test(x)), String(acts.length));
  await page.locator('.pf').screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-portfolio-activity.png`) });
  await finish(s);
}

async function guarded() {
  // Not allowlisted: deposits and new trades blocked with a clear message; withdrawals stay available.
  const out = await session('outsider');
  await goto(out, '/app/portfolio');
  await connect(out);
  await out.page.locator('.demo-bar .badge', { hasText: 'Guarded beta' }).waitFor({ timeout: 20_000 });
  await out.page.locator('.boxnote', { hasText: 'not on the guarded beta allowlist' }).waitFor();
  await snap(out, 'guarded-not-allowlisted');
  await out.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await out.page.locator('#mv-amt').fill('100');
  const shieldBtn = out.page.locator('.modal .btn-block', { hasText: 'Shield USDG' });
  check('shield refused for a wallet off the allowlist', await shieldBtn.isDisabled());
  check('shield dialog says why', await out.page.locator('.modal .boxnote.warn', { hasText: 'not on the guarded beta allowlist' }).isVisible());
  await snap(out, 'guarded-shield-refused');
  await out.page.locator('.modal .xbtn').click();
  await out.page.locator('.pf-actions .btn', { hasText: 'Unshield' }).click();
  check('unshield stays available', await out.page.locator('.modal h3', { hasText: 'Unshield tokens' }).isVisible());
  await out.page.locator('.modal .xbtn').click();
  await goto(out, '/app/trade/TSLA?mode=perps');
  check('trading refused for a wallet off the allowlist', await out.page.locator('.ticket .btn-block', { hasText: 'Not on the beta allowlist' }).isDisabled());
  await snap(out, 'guarded-trade-refused');
  check('the outsider sent nothing', out.wallet.sent.length === 0);
  await finish(out);

  // Allowlisted: status and remaining limit shown; a deposit within the cap and a trade work.
  const ins = await session('allowlisted');
  await ctl(`/allowlist?addr=${ins.addr}`);
  await goto(ins, '/app/trade/TSLA?mode=perps');
  await connect(ins);
  await ins.page.locator('.acct', { hasText: 'Allowlisted' }).waitFor({ timeout: 20_000 });
  check('account card shows the allowlist status and the limit left', /Deposit limit left\s*100,000(\.00)? USDG/.test(await ins.page.locator('.acct').innerText()));
  await snap(ins, 'guarded-allowlisted-card');
  await goto(ins, '/app/portfolio');
  await ins.page.locator('.pf-actions .btn', { hasText: /^Shield$/ }).click();
  await ins.page.locator('#mv-amt').fill('1000');
  check('the shield dialog shows the limit left', await ins.page.locator('.modal', { hasText: 'deposit limit left: 100,000 USDG' }).isVisible());
  await ins.page.locator('.modal .btn-block', { hasText: 'Shield USDG' }).click();
  let f = await flow(ins, 'guarded-deposit');
  await f.close();
  check('deposit within the cap went through', (await vaultBal(ins.addr, 'USDG')) === 1000_000000n);
  await ins.page.locator('.boxnote', { hasText: 'Deposit limit left: 99,000 USDG' }).waitFor({ timeout: 20_000 });
  check('the limit left went down by the deposit', true);
  await snap(ins, 'guarded-limit-after');
  await waitOracleCalm('TSLA');
  await goto(ins, '/app/trade/TSLA?mode=perps');
  await ins.page.locator('#t-size').fill('300');
  await ins.page.locator('.ticket .btn-block', { hasText: 'Open long' }).click();
  f = await flow(ins, 'guarded-open');
  const id = idFrom(f.text, 'Position ID');
  await f.close();
  check('allowlisted wallet opened a position', (await position(id)).open);
  await ins.page.locator('.posbox .btn', { hasText: 'Close' }).first().waitFor({ timeout: 20_000 });
  await ins.page.locator('.posbox .btn', { hasText: 'Close' }).first().click();
  f = await flow(ins, 'guarded-close');
  await f.close();
  check('and closed it', !(await position(id)).open);
  await finish(ins);
}

(async () => {
  D = (await ctl('/info')).deployment;
  console.log(`phase ${PHASE}: vault ${D.contracts.vault}`);
  if (PHASE === 'guarded') await guarded();
  else await unguarded();
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + '\n');
  console.log(failures ? `FAILED: ${failures} check(s)` : `ALL ${results.length} CHECKS PASSED`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + `\nERROR ${e}\n`);
  process.exit(1);
});

