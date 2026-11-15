/**
 * deploy/ecosystem.config.cjs (on-chain audit M-2): no hot key ever reaches a PM2 app (the signer reads its keys from
 * SIGNER_KEYS_FILE itself), the signer gets neither Postgres, Redis nor the proxy secret, and it runs only with
 * ONCHAIN_WORKERS=true. Runs the PM2 file in a child process with a temporary env file (it reads its env at load).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ECOSYSTEM = path.resolve(__dirname, '../../../../deploy/ecosystem.config.cjs');
// Throwaway values (never real keys).
const KEYS = `PRICE_RELAY_PRIVATE_KEY=0x${'0'.repeat(63)}1\nKEEPER_PRIVATE_KEY=0x${'0'.repeat(63)}2\n`;

/** App name -> the variable names it gets (values never leave the child). */
function keysFor(envFile: string, scope = 'all'): Record<string, string[]> {
  const out = execFileSync(process.execPath, ['-e', `const { apps } = require(${JSON.stringify(ECOSYSTEM)}); console.log(JSON.stringify(Object.fromEntries(apps.map((a) => [a.name, Object.keys(a.env)]))));`], {
    env: { PATH: process.env.PATH, VELUM_ENV_FILE: envFile, VELUM_PM2_SCOPE: scope },
    encoding: 'utf8',
  });
  return JSON.parse(out) as Record<string, string[]>;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function envFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'velum-eco-'));
  dirs.push(dir);
  const f = path.join(dir, '.env');
  writeFileSync(f, text);
  return f;
}

describe('PM2 env allowlist (on-chain audit M-2)', () => {
  it('never passes a hot key to any app, whatever the env file holds', () => {
    const on = keysFor(envFile(`ONCHAIN_WORKERS=true\nDEPLOYMENTS_DIR=/srv/velum/current/contracts/deployments\nRELAYER_MAX_GWEI=0.5\nRPC_URL_SEND=https://send.example/key\n${KEYS}DATABASE_URL=postgresql://x\nREDIS_URL=unix://x\nPROXY_SECRET=${'a'.repeat(64)}\nSIGNER_STATUS_FILE=/run/velum-signer/status.json\nSIGNER_KEYS_FILE=/etc/velum/signer-keys.env\n`));
    expect(Object.keys(on)).toEqual(['velum-web', 'velum-api', 'velum-workers', 'velum-signer']);
    for (const [app, keys] of Object.entries(on)) expect(keys.filter((k) => /PRIVATE_KEY/.test(k)), app).toEqual([]);
    // The signer: its own settings, no Postgres, no Redis, no proxy secret; it alone gets the send endpoint.
    expect(on['velum-signer']).toEqual(expect.arrayContaining(['ONCHAIN_WORKERS', 'RELAYER_MAX_GWEI', 'RPC_URL_SEND', 'SIGNER_KEYS_FILE', 'SIGNER_STATUS_FILE']));
    for (const k of ['DATABASE_URL', 'REDIS_URL', 'PROXY_SECRET', 'DEPLOYMENTS_DIR']) expect(on['velum-signer']).not.toContain(k);
    expect(on['velum-workers']).not.toContain('RPC_URL_SEND');
    expect(on['velum-workers']).toEqual(expect.arrayContaining(['ONCHAIN_WORKERS', 'DEPLOYMENTS_DIR', 'DATABASE_URL']));
    expect(on['velum-api']).toEqual(expect.arrayContaining(['DEPLOYMENTS_DIR', 'SIGNER_STATUS_FILE']));
    expect(on['velum-web']).not.toContain('DATABASE_URL');
    // Other hot keys of later phases never reach anyone either.
    const other = keysFor(envFile(`ONCHAIN_WORKERS=true\nRELAYER_PRIVATE_KEY=0x${'0'.repeat(63)}3\nCOORDINATOR_PRIVATE_KEY=0x${'0'.repeat(63)}4\n`));
    expect(Object.values(other).flat().filter((k) => /PRIVATE_KEY/.test(k))).toEqual([]);
  });

  it('runs the signer only with the literal ONCHAIN_WORKERS=true; scopes split the apps by user', () => {
    for (const flag of ['', 'ONCHAIN_WORKERS=false\n', 'ONCHAIN_WORKERS=1\n', 'ONCHAIN_WORKERS=yes\n']) {
      expect(Object.keys(keysFor(envFile(`${flag}${KEYS}`))), flag || 'unset').toEqual(['velum-web', 'velum-api', 'velum-workers']);
      expect(keysFor(envFile(`${flag}${KEYS}`), 'signer'), flag || 'unset').toEqual({});
    }
    const f = envFile('ONCHAIN_WORKERS=true\n');
    expect(Object.keys(keysFor(f, 'signer'))).toEqual(['velum-signer']);
    expect(Object.keys(keysFor(f, 'backend'))).toEqual(['velum-api', 'velum-workers']);
    expect(Object.keys(keysFor(f, 'web'))).toEqual(['velum-web']);
  });
});
