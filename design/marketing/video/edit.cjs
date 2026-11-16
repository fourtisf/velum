// Edits the Velum introduction video from record-demo.cjs's footage (footage.mp4 + marks.json in VIDEO_DIR):
//  1. renders the title scenes of scenes.html frame by frame (intro, headline, privacy, outro);
//  2. renders the captions (each card also says "product demo, test environment") as transparent overlays;
//  3. zooms the footage smoothly onto each recorded focus rectangle (2880x1620 source, at most 1.5x, so 1080p stays
//     sharp), overlays the captions with fades;
//  4. joins everything with crossfades into one 1080p H.264 file (no audio track).
// Run: VIDEO_DIR=<dir> node design/marketing/video/edit.cjs
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const DIR = process.env.VIDEO_DIR || path.join(__dirname, 'out');
const OUT = process.env.OUT_FILE || path.join(DIR, 'velum-introduction-1080p.mp4');
const FPS = 30;
const M = JSON.parse(fs.readFileSync(path.join(DIR, 'marks.json'), 'utf8'));
const run = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const probeDur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

async function renderScenes(page) {
  const out = {};
  for (const id of ['intro', 'headline', 'privacy', 'outro']) {
    await page.evaluate((id) => document.querySelectorAll('.scene').forEach((s) => s.classList.toggle('on', s.id === id)), id);
    await page.waitForTimeout(120);
    const dur = await page.evaluate((id) => Number(document.getElementById(id).dataset.dur), id);
    const file = path.join(DIR, `scene-${id}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${id} ${c}`)))));
    const n = Math.round(dur * FPS);
    for (let i = 0; i < n; i++) {
      await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), (i * 1000) / FPS);
      const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 }, type: 'png' });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await done;
    out[id] = { file, dur };
    console.log('scene', id, dur, 's');
  }
  return out;
}

async function renderOverlays(page) {
  await page.evaluate(() => { document.querySelectorAll('.scene').forEach((s) => s.classList.remove('on')); document.body.style.background = 'transparent'; });
  const caps = [];
  for (const [i, c] of M.captions.entries()) {
    await page.evaluate((c) => {
      document.getElementById('tagtpl').style.display = 'none';
      document.getElementById('captpl').style.display = 'block';
      document.getElementById('cap-e').textContent = c.e;
      document.getElementById('cap-t').textContent = c.t;
      document.getElementById('cap-s').textContent = c.s;
    }, c);
    const file = path.join(DIR, `cap-${i}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 }, omitBackground: true });
    caps.push({ ...c, file });
  }
  await page.evaluate(() => { document.getElementById('captpl').style.display = 'none'; document.getElementById('tagtpl').style.display = 'block'; });
  const tag = path.join(DIR, 'tag.png');
  await page.screenshot({ path: tag, clip: { x: 0, y: 0, width: 1920, height: 1080 }, omitBackground: true });
  return { caps, tag };
}

/** Zoom state of a focus rectangle (CSS px of the 1440x810 viewport), or the full view. */
function target(rect) {
  if (!rect) return { z: 1, cx: 720, cy: 405 };
  const z = Math.max(1, Math.min(1.5, (0.92 * 1440) / rect.w, (0.92 * 810) / rect.h));
  const hx = 720 / z;
  const hy = 405 / z;
  const cx = Math.min(1440 - hx, Math.max(hx, rect.x + rect.w / 2));
  const cy = Math.min(810 - hy, Math.max(hy, rect.y + rect.h / 2));
  return { z, cx, cy };
}

/** ffmpeg expressions for zoom and centre over time (`tv`: the time variable): the full view plus one eased step per focus change. */
function zoomExpr(tv) {
  const D = 0.85;
  let prev = target(null);
  const terms = { z: [String(prev.z)], cx: [String(prev.cx)], cy: [String(prev.cy)] };
  for (const f of M.focuses) {
    const s = target(f.rect);
    for (const k of ['z', 'cx', 'cy']) {
      const d = s[k] - prev[k];
      if (Math.abs(d) > 1e-4) terms[k].push(`${d.toFixed(4)}*(1-cos(PI*clip((${tv}-${f.t.toFixed(3)})/${D},0,1)))/2`);
    }
    prev = s;
  }
  return { Z: terms.z.join('+'), CX: terms.cx.join('+'), CY: terms.cy.join('+') };
}

function renderUi(ov) {
  const src = path.join(DIR, 'footage.mp4');
  const dur = probeDur(src);
  // zoompan: z=1 shows the whole 2880x1620 frame; x,y are the visible area's top left in source pixels (2 per CSS px).
  const { Z, CX, CY } = zoomExpr('it');
  const inputs = ['-i', src];
  const chain = [`[0:v]fps=${FPS},zoompan=z='${Z}':x='clip((${CX})*2-iw/zoom/2,0,iw-iw/zoom)':y='clip((${CY})*2-ih/zoom/2,0,ih-ih/zoom)':d=1:s=1920x1080:fps=${FPS},format=yuva420p[v0]`];
  let last = 'v0';
  let idx = 1;
  // Every caption card carries the "product demo, test environment" line; the outro carries the full disclaimer.
  for (const c of ov.caps) {
    const start = Math.max(0, c.start + 0.15);
    const d = Math.max(1.2, Math.min(dur, c.end) - start);
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3), '-i', c.file);
    chain.push(`[${idx}:v]format=rgba,fade=t=in:st=0:d=0.4:alpha=1,fade=t=out:st=${(d - 0.4).toFixed(3)}:d=0.4:alpha=1,setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[c${idx}]`, `[${last}][c${idx}]overlay=0:0:eof_action=pass[v${idx}]`);
    last = `v${idx}`;
    idx++;
  }
  chain.push(`[${last}]format=yuv420p[out]`);
  const script = path.join(DIR, 'ui-filter.txt');
  fs.writeFileSync(script, chain.join(';\n'));
  const file = path.join(DIR, 'ui.mp4');
  run([...inputs, '-filter_complex_script', script, '-map', '[out]', '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', file]);
  console.log('ui', dur.toFixed(1), 's');
  return { file, dur };
}

function assemble(parts) {
  const order = [parts.intro, parts.headline, parts.ui, parts.privacy, parts.outro];
  const fades = [0.6, 0.7, 0.7, 0.7];
  const inputs = order.flatMap((p) => ['-i', p.file]);
  const chain = order.map((p, i) => `[${i}:v]fps=${FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[s${i}]`);
  let last = 's0';
  let len = order[0].dur;
  for (let i = 1; i < order.length; i++) {
    const off = len - fades[i - 1];
    chain.push(`[${last}][s${i}]xfade=transition=fade:duration=${fades[i - 1]}:offset=${off.toFixed(3)}[x${i}]`);
    last = `x${i}`;
    len = off + order[i].dur;
  }
  chain.push(`[${last}]fade=t=out:st=${(len - 0.6).toFixed(3)}:d=0.6[out]`);
  const script = path.join(DIR, 'final-filter.txt');
  fs.writeFileSync(script, chain.join(';\n'));
  run([...inputs, '-filter_complex_script', script, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT]);
  console.log('final', len.toFixed(1), 's ->', OUT);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(__dirname, 'scenes.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all(['600 40px "Inter Tight"', '500 40px "Inter Tight"', '400 20px Inter', '500 20px Inter', '600 20px Inter'].map((f) => document.fonts.load(f))));
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  if (!fonts.includes('Inter') || !fonts.includes('Inter Tight')) throw new Error(`fonts not loaded: ${fonts.join(', ')}`);
  const ov = await renderOverlays(page);
  await page.evaluate(() => { document.body.style.background = '#000'; document.getElementById('tagtpl').style.display = 'none'; });
  const scenes = await renderScenes(page);
  await browser.close();
  const ui = renderUi(ov);
  assemble({ ...scenes, ui });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
