/**
 * deploy/ecosystem.config.cjs: the hot keys reach velum-workers only with ONCHAIN_WORKERS=true, and never the
 * API or the web. Runs the PM2 file in a child process with a temporary env file (it reads its env at load).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ECOSYSTEM = path.resolve(__dirname, '../../../../deploy/ecosystem.config.cjs');
// Throwaway values (never real keys).
const KEYS = `PRICE_RELAY_PRIVATE_KEY=0x${'0'.repeat(63)}1\nKEEPER_PRIVATE_KEY=0x${'0'.repeat(63)}2\n`;

/** App name -> the variable names it gets (values never leave the child). */
function keysFor(envFile: string): Record<string, string[]> {
  const out = execFileSync(process.execPath, ['-e', `const { apps } = require(${JSON.stringify(ECOSYSTEM)}); console.log(JSON.stringify(Object.fromEntries(apps.map((a) => [a.name, Object.keys(a.env)]))));`], {
    env: { PATH: process.env.PATH, VELUM_ENV_FILE: envFile, VELUM_PM2_SCOPE: 'all' },
    encoding: 'utf8',
  });
  return JSON.parse(out) as Record<string, string[]>;
}

function envFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'velum-eco-'));
  const f = path.join(dir, '.env');
  writeFileSync(f, text);
  return f;
}

describe('PM2 env allowlist for the on-chain workers', () => {
  it('passes the hot keys to velum-workers only with ONCHAIN_WORKERS=true', () => {
    const on = keysFor(envFile(`ONCHAIN_WORKERS=true\nDEPLOYMENTS_DIR=/srv/velum/current/contracts/deployments\nRELAYER_MAX_GWEI=0.5\n${KEYS}DATABASE_URL=postgresql://x\n`));
    expect(on['velum-workers']).toEqual(expect.arrayContaining(['PRICE_RELAY_PRIVATE_KEY', 'KEEPER_PRIVATE_KEY', 'ONCHAIN_WORKERS', 'RELAYER_MAX_GWEI', 'DEPLOYMENTS_DIR']));
    for (const app of ['velum-api', 'velum-web']) expect(on[app]!.filter((k) => /PRIVATE_KEY/.test(k)), app).toEqual([]);
    expect(on['velum-api']).toContain('DEPLOYMENTS_DIR');
    expect(on['velum-web']).not.toContain('DATABASE_URL');

    for (const flag of ['', 'ONCHAIN_WORKERS=false\n', 'ONCHAIN_WORKERS=1\n', 'ONCHAIN_WORKERS=yes\n']) {
      const off = keysFor(envFile(`${flag}${KEYS}`));
      expect(off['velum-workers']!.filter((k) => /PRIVATE_KEY/.test(k)), flag || 'unset').toEqual([]);
      expect(off['velum-api']!.filter((k) => /PRIVATE_KEY/.test(k))).toEqual([]);
    }
    // Other hot keys of later phases never reach anyone.
    const other = keysFor(envFile(`ONCHAIN_WORKERS=true\nRELAYER_PRIVATE_KEY=0x${'0'.repeat(63)}3\nCOORDINATOR_PRIVATE_KEY=0x${'0'.repeat(63)}4\n`));
    expect(Object.values(other).flat().filter((k) => /PRIVATE_KEY/.test(k))).toEqual([]);
  });
});
