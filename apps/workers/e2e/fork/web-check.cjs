/**
 * The web part of the mainnet-fork end-to-end run (fork-e2e.sh): the production web build compiled with the fork's
 * deployment file shows, for each market, the oracle price the contracts use. For the uiMultiplier tokens (NVDA,
 * AAPL, META, MSFT) that must be the price per TOKEN (share price x multiplier), exactly what the signer pushed.
 * No wallet is needed: the trade ticket reads the oracle through the app's own RPC client.
 *
 * Env: WEB (http://127.0.0.1:<port>), RPC (the fork), ORACLE (address), TOKENS (JSON symbol -> address), OUT (dir).
 * Playwright comes from the global install (NODE_PATH).
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const WEB = process.env.WEB;
const RPC = process.env.RPC;
const ORACLE = process.env.ORACLE;
const TOKENS = JSON.parse(process.env.TOKENS);
const OUT = process.env.OUT;
const SYMS = ['NVDA', 'AAPL', 'META', 'MSFT', 'TSLA'];

async function oracleLatest(token) {
  // latest(address) -> (uint256 p, uint256 updatedAt); selector of latest(address)
  const data = '0x' + '4a4aac1a' + token.slice(2).toLowerCase().padStart(64, '0');
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ORACLE, data }, 'latest'] }) });
  const body = await res.json();
  if (!body.result) throw new Error(`eth_call: ${JSON.stringify(body.error)}`);
  return BigInt('0x' + body.result.slice(2, 66));
}

/** wad -> "1,234.56": 2 decimals rounded half up, like the app's fmt (toDecimalString(w, 2) rounds 'half'). */
function fmt2(w) {
  const cents = (w + 5n * 10n ** 15n) / 10n ** 16n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const rows = [];
  let ok = true;
  for (const sym of SYMS) {
    await page.goto(`${WEB}/app/trade/${sym}?mode=spot`, { waitUntil: 'networkidle' });
    const cell = page.locator('.sumbox div', { hasText: 'Oracle price' }).locator('b');
    await cell.waitFor({ timeout: 60_000 });
    let shown = '';
    for (let i = 0; i < 60; i++) {
      shown = (await cell.innerText()).trim();
      if (/^\$?[\d,]+\.\d{2}$/.test(shown)) break;
      await page.waitForTimeout(1000);
    }
    const p = await oracleLatest(TOKENS[sym]);
    const want = fmt2(p);
    const match = shown.replace('$', '') === want;
    ok = ok && match;
    rows.push({ symbol: sym, ui: shown, oracle: want, oracleWad: p.toString(), match });
    await page.screenshot({ path: path.join(OUT, `web-${sym}.png`) });
    console.log(`${sym}: UI oracle price ${shown}, oracle ${want} ${match ? 'OK' : 'MISMATCH'}`);
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'web-check.json'), JSON.stringify({ ok, rows, consoleErrors: errors.slice(0, 20) }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
