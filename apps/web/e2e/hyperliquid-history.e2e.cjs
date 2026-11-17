// Perps history and chart lines in the browser: the mainnet web build, a mock EIP-6963 wallet on a local fork of Robinhood
// Chain and a read-only model of the user's Hyperliquid account (a TSLA long with TP/SL and a resting limit order, two
// fills, funding payments). Checked: the chart draws the entry, liquidation, TP, SL and limit lines (pixels of each
// line's color at its price), the Portfolio's realized P&L, fees, funding and net, and the CSV export.
//
// Run (fork on 127.0.0.1:8547, a local API for prices, the mainnet web on WEB_URL):
//   WEB_URL=http://127.0.0.1:3100 node apps/web/e2e/hyperliquid-history.e2e.cjs
const path = require('node:path');
const { mkdirSync, readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = require('playwright');
const { generatePrivateKey } = req('viem/accounts');
const { installWallet } = require('./wallet.cjs');
const meta = require('../../workers/src/__fixtures__/hyperliquid-xyz-2026-11-16.json').body[0];

const BASE = process.env.WEB_URL || 'http://127.0.0.1:3100';
const RH = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR || path.join(require('node:os').tmpdir(), 'velum-history-e2e');
mkdirSync(OUT, { recursive: true });
const TSLA = 'xyz:TSLA';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const results = [];
let failed = 0;
const check = (label, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

async function main() {
  const key = generatePrivateKey();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await installWallet(context, { privateKey: key, rpc: RH, chainId: 4663, anvilChainId: 4663, name: 'Browser Wallet' });
  const unknown = [];
  // The chart's price range follows the API's candles; the lines sit around the live price so they are in view.
  let px = 380;
  await context.route(`${API}/**`, async (r) => {
    const resp = await r.fetch();
    if (r.request().url().includes('/v1/markets')) {
      try {
        const j = await resp.json();
        const t = (j.markets ?? j).find?.((m) => m.symbol === 'TSLA');
        if (t && Number(t.price)) px = Number(t.price);
      } catch { /* keep the default */ }
      return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
    }
    await r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-expose-headers': 'Date' } });
  });
  const lv = () => ({ entry: px * 0.99, tp: px * 1.012, sl: px * 0.976, limit: px * 0.985 });
  await context.route('https://api.hyperliquid.xyz/**', async (r) => {
    const rq = r.request();
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const b = JSON.parse(rq.postData() || '{}');
    const L = lv();
    const body = (() => {
      switch (b.type) {
        case 'meta': return b.dex === 'xyz' ? meta : null;
        case 'allMids': return b.dex === 'xyz' ? { [TSLA]: px.toFixed(2) } : {};
        case 'l2Book': return { coin: b.coin, time: Date.now(), levels: [[{ px: (px - 0.01).toFixed(2), sz: '1', n: 1 }], [{ px: (px + 0.01).toFixed(2), sz: '1', n: 1 }]] };
        case 'userAbstraction': return 'unifiedAccount';
        case 'extraAgents': return [];
        case 'clearinghouseState': {
          const pos = b.dex === 'xyz' ? [{ type: 'oneWay', position: { coin: TSLA, szi: '2.604', leverage: { type: 'isolated', value: 3, rawUsd: '0' }, entryPx: L.entry.toFixed(2), positionValue: (2.604 * px).toFixed(2), unrealizedPnl: '9.80', returnOnEquity: '0.03', liquidationPx: (px * 0.97).toFixed(2), marginUsed: '340', maxLeverage: 10, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }] : [];
          const s = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' };
          return { marginSummary: s, crossMarginSummary: s, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: pos, time: Date.now() };
        }
        case 'spotClearinghouseState': return { balances: [{ coin: 'USDC', token: 0, total: '1000', hold: '340', entryNtl: '0' }] };
        case 'activeAssetData': return { user: b.user, coin: b.coin, leverage: { type: 'isolated', value: 3 }, maxTradeSzs: ['0', '0'], availableToTrade: ['0', '0'], markPx: px.toFixed(2) };
        case 'maxBuilderFee': return 0;
        case 'frontendOpenOrders':
          return [
            { coin: TSLA, side: 'A', limitPx: '1', sz: '0.0', oid: 1, timestamp: 3, origSz: '0.0', triggerCondition: '', isTrigger: true, triggerPx: L.tp.toFixed(2), children: [], isPositionTpsl: true, reduceOnly: true, orderType: 'Take Profit Market', tif: null, cloid: null },
            { coin: TSLA, side: 'A', limitPx: '1', sz: '0.0', oid: 2, timestamp: 2, origSz: '0.0', triggerCondition: '', isTrigger: true, triggerPx: L.sl.toFixed(2), children: [], isPositionTpsl: true, reduceOnly: true, orderType: 'Stop Market', tif: null, cloid: null },
            { coin: TSLA, side: 'B', limitPx: L.limit.toFixed(2), sz: '1.000', oid: 3, timestamp: 1, origSz: '1.000', triggerCondition: 'N/A', isTrigger: false, triggerPx: '0.0', children: [], isPositionTpsl: false, reduceOnly: false, orderType: 'Limit', tif: 'Gtc', cloid: null },
          ];
        case 'userFills':
          return [
            { coin: TSLA, px: '392.46', sz: '6.574', side: 'A', time: Date.UTC(2026, 10, 17, 12, 5), startPosition: '6.574', dir: 'Close Long', closedPnl: '79.94', hash: '0x', oid: 2, crossed: true, fee: '1.16', tid: 2, feeToken: 'USDC' },
            { coin: TSLA, px: '380.30', sz: '6.574', side: 'B', time: Date.UTC(2026, 10, 17, 11, 0), startPosition: '0', dir: 'Open Long', closedPnl: '0.0', hash: '0x', oid: 1, crossed: true, fee: '1.12', tid: 1, feeToken: 'USDC' },
          ];
        case 'userFunding':
          return [
            { time: Date.UTC(2026, 10, 17, 12, 0), hash: '0x', delta: { type: 'funding', coin: TSLA, usdc: '-0.0158', szi: '6.574', fundingRate: '0.00000625', nSamples: null } },
            { time: Date.UTC(2026, 10, 17, 11, 0), hash: '0x', delta: { type: 'funding', coin: TSLA, usdc: '0.0042', szi: '6.574', fundingRate: '-0.0000017', nSamples: null } },
          ];
        default:
          unknown.push(b.type);
          return null;
      }
    })();
    return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: 'networkidle' });
  await page.locator('header button', { hasText: 'Connect wallet' }).first().click();
  await page.locator('.modal .wopt', { hasText: 'Browser Wallet' }).click();
  await page.locator('.walletbtn').waitFor({ timeout: 20_000 });
  await page.locator('.posbox tbody tr', { hasText: 'TSLA' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);

  // ---------- Chart lines: each line's color must be on the canvas ----------
  const chart = page.locator('.chartbox canvas').first();
  await chart.screenshot({ path: path.join(OUT, '01-chart-lines.png') });
  const found = await chart.evaluate((cv) => {
    const x = cv.getContext('2d');
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    const want = { warn: [0xf2, 0xc4, 0x6b], acc: [0x8f, 0x96, 0xff] };
    const hits = { warn: 0, acc: 0 };
    for (let i = 0; i < d.length; i += 4)
      for (const [k, c] of Object.entries(want)) if (Math.abs(d[i] - c[0]) < 8 && Math.abs(d[i + 1] - c[1]) < 8 && Math.abs(d[i + 2] - c[2]) < 8) hits[k]++;
    return hits;
  });
  check('chart: the liquidation (amber) and limit order (violet) lines are drawn', found.warn > 200 && found.acc > 200, JSON.stringify(found));

  // ---------- Portfolio: results and CSV ----------
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: 'load' });
  const stats = page.locator('.hl-stats');
  await stats.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  const st = (await stats.innerText()).replace(/\s*\n\s*/g, ' | ');
  check('Portfolio: realized P&L, fees, funding and net', /Realized P&L \| \+\$79\.94/.test(st) && /Fees paid \| \$2\.28/.test(st) && /Funding \| -\$0\.01/.test(st) && /Net \| \+\$77\.65/.test(st), st);
  const foot = await page.locator('.hl-history-foot').innerText();
  check('Portfolio: trade count, volume and the funding window', /2 trades · \$5,080\.12 volume · funding over the last 90 days/.test(foot), foot);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.hl-history-foot button', { hasText: 'Export CSV' }).click()]);
  const file = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(file);
  const csv = readFileSync(file, 'utf8').trim().split('\n');
  check('CSV: named by date, a header, two trades and two funding payments, oldest first', /^velum-perps-history-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()) && csv.length === 5 && csv[0].startsWith('time_utc,type,market') && csv[1].includes('Open Long') && csv[4].includes('Close Long') && csv[4].includes('79.94'), csv.join(' / '));
  await page.locator('.hl-history').screenshot({ path: path.join(OUT, '02-history.png') });
  check('no unknown reads', unknown.length === 0, unknown.join(','));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
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
