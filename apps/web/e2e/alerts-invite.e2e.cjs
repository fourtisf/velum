// Telegram alerts and invite links in the browser (mainnet build, a mock EIP-6963 wallet on a local fork of Robinhood
// Chain; the API's alerts and referral answers are modelled, and the signed message is checked like the API does).
// Checked: a visitor arriving with ?ref= is recorded once when the wallet connects; the Portfolio shows the wallet's
// invite link and count; "Get alerts on Telegram" asks for one signature (no transaction) of the alerts message and
// opens the bot link it returns.
//
// Run (fork on 127.0.0.1:8547, a local API, the mainnet web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/alerts-invite.e2e.cjs
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { recoverMessageAddress } = req('viem');
const { generatePrivateKey, privateKeyToAccount } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

async function main() {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wallet = await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  const posted = { refs: [], codes: [] };
  await context.route(`${API}/**`, async (r) => {
    const rq = r.request();
    const url = rq.url();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const json = (o, status = 200) => r.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (url.endsWith('/v1/alerts')) return json({ enabled: true, bot: 'velum_alerts_bot' });
    if (url.endsWith('/v1/alerts/code')) {
      const b = JSON.parse(rq.postData() || '{}');
      // The text of alertsMessage (packages/config/src/alerts.ts; apps/api/src/alerts.test.ts checks the API with it).
      const msg = `Velum: send perps alerts for this wallet to Telegram.\nWallet: ${b.address.toLowerCase()}\nIssued: ${b.issuedAt}\n\nThis signature costs nothing and moves no funds.`;
      const signer = await recoverMessageAddress({ message: msg, signature: b.signature }).catch(() => null);
      posted.codes.push({ ...b, signer });
      return signer && signer.toLowerCase() === b.address.toLowerCase() ? json({ code: 'Abc123Abc123Abc123Abc1', url: 'https://t.me/velum_alerts_bot?start=Abc123Abc123Abc123Abc1', expiresIn: 900 }) : json({ error: { message: 'bad' } }, 400);
    }
    if (url.endsWith('/v1/referrals')) {
      posted.refs.push(JSON.parse(rq.postData() || '{}'));
      return json({ attributed: true });
    }
    if (/\/v1\/referrals\/[0-9a-f]{10}$/.test(url)) return json({ code: url.slice(-10), friends: 3 });
    const resp = await r.fetch();
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  await context.route('https://api.hyperliquid.xyz/**', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: 'null' })));
  await context.route('https://t.me/**', (r) => r.fulfill({ status: 200, body: 'telegram' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ---------- Arrive through a friend's link, connect ----------
  await page.goto(`${BASE}/?ref=ABCDEF0123`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!localStorage.getItem('velum.ref'), null, { timeout: 15_000 });
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: 'load' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  check('the friend’s code is recorded once for this wallet', posted.refs.length === 1 && posted.refs[0].code === 'abcdef0123' && posted.refs[0].address.toLowerCase() === me.toLowerCase(), JSON.stringify(posted.refs));

  // ---------- Invite card ----------
  const invite = page.locator('section.card', { hasText: 'Invite friends' });
  await invite.waitFor({ timeout: 20_000 });
  await invite.locator('b.num', { hasText: '3' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  const inv = await invite.innerText();
  check('Portfolio: the wallet’s invite link (its first 10 hex digits) and friends joined', inv.includes(`/?ref=${me.slice(2, 12).toLowerCase()}`) && /Friends joined: 3/.test(inv.replace(/\s+/g, ' ')), inv.replace(/\n/g, ' | '));

  // ---------- Telegram alerts ----------
  const alerts = page.locator('section.card', { hasText: 'Telegram alerts' });
  await alerts.waitFor({ timeout: 20_000 });
  const sentBefore = wallet.sent.length;
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 20_000 }).catch(() => null), alerts.locator('button', { hasText: 'Get alerts on Telegram' }).click()]);
  await page.waitForTimeout(500);
  const c = posted.codes[0];
  check('alerts: one signature of the alerts message by this wallet (no transaction), checked like the API does', !!c && c.signer?.toLowerCase() === me.toLowerCase() && wallet.sent.length === sentBefore && wallet.log.some((l) => l.method === 'personal_sign'), JSON.stringify(c));
  check('alerts: the bot link opens in a new tab, with what to do next', !!popup && popup.url().startsWith('https://t.me/velum_alerts_bot?start=') && /press Start in the bot/.test(await alerts.innerText()), popup?.url() ?? 'no popup');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(results.join('\n'));
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
