// Renders the "Perps are open" ad: loads ad-perps.html, hands it record-perps.cjs's footage (frames/, frames.json,
// marks.json in VIDEO_DIR) and screenshots it frame by frame at 30 fps into one 1080p H.264 file; MUSIC=<wav> (from
// music-perps.py) adds the soundtrack, high-passed at 35 Hz and normalised to -16 LUFS (true peak -1.5 dB).
// STILLS=8.5,12,20 writes those moments as PNGs instead (for checking a layout); FROM/TO render a part.
// Run: VIDEO_DIR=<dir> OUT_FILE=<mp4> MUSIC=<wav> node design/marketing/video/edit-ad.cjs
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const DIR = process.env.VIDEO_DIR || path.join(__dirname, 'out-perps');
const OUT = process.env.OUT_FILE || path.join(DIR, 'velum-perps-are-open-1080p.mp4');
const FPS = 30;
const run = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

(async () => {
  const marks = JSON.parse(fs.readFileSync(path.join(DIR, 'marks.json'), 'utf8'));
  const times = JSON.parse(fs.readFileSync(path.join(DIR, 'frames.json'), 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(__dirname, 'ad-perps.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all(['600 40px "Inter Tight"', '500 40px "Inter Tight"', '400 20px Inter', '500 20px Inter', '600 20px Inter'].map((f) => document.fonts.load(f))));
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  if (!fonts.includes('Inter') || !fonts.includes('Inter Tight')) throw new Error(`fonts not loaded: ${fonts.join(', ')}`);
  const plan = await page.evaluate((f) => window.AD.init(f), { dir: pathToFileURL(path.join(DIR, 'frames')).href, times, marks: marks.marks, rects: marks.rects, review: marks.review });
  for (const s of plan) console.log(`shot ${s.a}-${s.b}s`, JSON.stringify(s.segs));
  const total = await page.evaluate(() => window.AD.duration);

  if (process.env.STILLS) {
    for (const t of process.env.STILLS.split(',').map(Number)) {
      await page.evaluate((t) => window.AD.render(t), t);
      await page.waitForTimeout(30);
      const file = path.join(DIR, `still-${t.toFixed(2)}.png`);
      await page.screenshot({ path: file });
      console.log('still', file);
    }
    await browser.close();
    if (errors.length) throw new Error(errors.join(' | '));
    return;
  }

  const from = Number(process.env.FROM || 0);
  const to = Math.min(total, Number(process.env.TO || total));
  const silent = process.env.MUSIC ? path.join(DIR, 'ad-silent.mp4') : OUT;
  const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
  const n = Math.round((to - from) * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const t = from + i / FPS;
    await page.evaluate((t) => window.AD.render(t), t);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  await done;
  await browser.close();
  if (errors.length) throw new Error(errors.join(' | '));
  const len = to - from;
  if (process.env.MUSIC) {
    const a = `atrim=start=${from},asetpts=PTS-STARTPTS,highpass=f=35,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${(len - 1.2).toFixed(3)}:d=1.2`;
    run(['-i', silent, '-i', process.env.MUSIC, '-filter_complex', `[1:a]${a}[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', len.toFixed(3), '-movflags', '+faststart', OUT]);
  }
  console.log('final', len.toFixed(1), 's ->', OUT, process.env.MUSIC ? '(with music)' : '');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
