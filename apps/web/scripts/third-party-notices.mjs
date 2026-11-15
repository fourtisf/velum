#!/usr/bin/env node
/**
 * Writes public/third-party-notices.txt (served at /third-party-notices.txt): name, version, licence and
 * the licence/notice files of every package installed in the web app's production dependency tree
 * (`pnpm list --prod --depth Infinity`). That tree is a superset of what ships in the browser bundle (it
 * also holds server-only packages such as Next's runtime and image binaries), so nothing that ships is
 * left out (audit SC-F13). `pnpm licenses list` is not used: in pnpm 9 it covers the whole workspace and
 * its output varies from run to run.
 *
 *   pnpm --filter @velum/web notices          regenerate the file
 *   pnpm --filter @velum/web notices:check    exit 1 when the file is out of date (CI)
 *
 * Run it after any dependency change. Output is sorted and has no machine paths or dates, so it only
 * changes when the dependencies do. Optional packages for other platforms (not installed) are skipped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'public', 'third-party-notices.txt');
const check = process.argv.includes('--check');

const raw = execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], { cwd: WEB, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
/** @typedef {{ version?: string; path?: string; dependencies?: Record<string, Dep>; optionalDependencies?: Record<string, Dep> }} Dep */
/** @type {Array<{ dependencies?: Record<string, Dep>; optionalDependencies?: Record<string, Dep> }>} */
const roots = JSON.parse(raw);

/** name@version -> package directory */
const pkgs = new Map();
const walk = (deps) => {
  for (const [name, d] of Object.entries(deps ?? {})) {
    if (!d.version || d.version.startsWith('link:') || name.startsWith('@velum/')) continue;
    const key = `${name}@${d.version}`;
    if (pkgs.has(key)) continue;
    if (!d.path || !existsSync(join(d.path, 'package.json'))) continue; // optional, not installed here
    pkgs.set(key, { name, version: d.version, dir: d.path });
    walk(d.dependencies);
    walk(d.optionalDependencies);
  }
};
for (const r of roots) {
  walk(r.dependencies);
  walk(r.optionalDependencies);
}

const str = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.name === 'string' ? v.name : undefined);
const licenseOf = (pj) => {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && typeof pj.license.type === 'string') return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ') || 'Unknown';
  return 'Unknown';
};
const NOTICE_FILE = /^(licen[cs]e|copying|notice|copyright)(\.(md|txt|markdown|rst))?$|^licen[cs]e[-_.]/i;

const entries = [...pkgs.values()].map(({ name, version, dir }) => {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = readdirSync(dir).filter((f) => NOTICE_FILE.test(f)).sort();
  const texts = files.map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim() }));
  return { name, version, license: licenseOf(pj), author: str(pj.author), homepage: str(pj.homepage), texts };
});
entries.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version, 'en') : a.name.localeCompare(b.name, 'en')));

const RULE = '='.repeat(78);
const lines = [
  'Velum web app: third-party software notices',
  '',
  'The Velum web app includes the open-source packages listed below, under their own licences. Velum',
  "itself is proprietary (see the repository's LICENSE). This list covers the web app's whole",
  'production dependency tree, a superset of what is sent to your browser.',
  '',
  `Packages: ${entries.length}`,
  '',
];
for (const e of entries) {
  lines.push(RULE, `${e.name} ${e.version}`, `License: ${e.license}`);
  if (e.author) lines.push(`Author: ${e.author}`);
  if (e.homepage) lines.push(`Homepage: ${e.homepage}`);
  for (const t of e.texts) lines.push('', `--- ${t.f} ---`, t.text);
  if (!e.texts.length) lines.push('', '(The package ships no licence file; its declared licence is above.)');
  lines.push('');
}
const out = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== out) {
    console.error('apps/web/public/third-party-notices.txt is out of date: run `pnpm --filter @velum/web notices` and commit it.');
    process.exit(1);
  }
  console.log(`third-party-notices.txt is up to date (${entries.length} packages).`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`Wrote ${OUT} (${entries.length} packages, ${(out.length / 1024).toFixed(0)} KB).`);
}
