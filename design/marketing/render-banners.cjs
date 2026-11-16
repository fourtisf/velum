// Renders the banners in banners.html to PNG at 2x (design/marketing/*.png).
// Run: node design/marketing/render-banners.cjs
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const OUT = __dirname;
const ARTS = [
  ['post', 'velum-how-it-works-1600x900.png'],
  ['header', 'velum-x-header-1500x500.png'],
  ['portrait', 'velum-how-it-works-1080x1350.png'],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(__dirname, 'banners.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  if (!fonts.includes('Inter') || !fonts.includes('Inter Tight')) throw new Error(`fonts not loaded: ${fonts.join(', ')}`);
  for (const [id, file] of ARTS) {
    await page.locator(`#${id}`).screenshot({ path: path.join(OUT, file), animations: 'disabled' });
    console.log('wrote', file);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
