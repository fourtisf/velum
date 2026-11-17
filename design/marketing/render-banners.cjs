// Renders the banners to PNG at 2x (design/marketing/*.png): banners.html (casual copy), banners-pro.html
// (professional copy), article-cover.html (article covers), banners-premium.html (premium how-it-works) and
// banners-today.html ("Velum today": buy with ETH or USDG, perps funded from Robinhood Chain, live Portfolio).
// Run: node design/marketing/render-banners.cjs
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const OUT = __dirname;
const { existsSync } = require('node:fs');
const SETS = [
  ['banners.html', [['post', 'velum-how-it-works-1600x900.png'], ['header', 'velum-x-header-1500x500.png'], ['portrait', 'velum-how-it-works-1080x1350.png']]],
  ['banners-pro.html', [['post', 'velum-how-it-works-pro-1600x900.png'], ['header', 'velum-x-header-pro-1500x500.png'], ['portrait', 'velum-how-it-works-pro-1080x1350.png']]],
  ['article-cover.html', [['cover', 'velum-article-cover-1500x600.png'], ['wide', 'velum-article-cover-1600x900.png']]],
  ['banners-premium.html', [['hiw', 'velum-how-it-works-premium-1600x900.png'], ['hiw-portrait', 'velum-how-it-works-premium-1080x1350.png']]],
  ['banners-today.html', [['today', 'velum-today-1600x900.png'], ['today-portrait', 'velum-today-1080x1350.png'], ['today-header', 'velum-x-header-today-1500x500.png']]],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 2 });
  for (const [html, arts] of SETS) {
    if (!existsSync(path.join(__dirname, html))) continue;
    await page.goto(pathToFileURL(path.join(__dirname, html)).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
    if (!fonts.includes('Inter') || !fonts.includes('Inter Tight')) throw new Error(`${html}: fonts not loaded: ${fonts.join(', ')}`);
    for (const [id, file] of arts) {
      await page.locator(`#${id}`).screenshot({ path: path.join(OUT, file), animations: 'disabled' });
      console.log('wrote', file);
    }
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
