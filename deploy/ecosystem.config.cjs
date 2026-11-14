// PM2 process file. deploy/release.sh starts and reloads it; do not run `pm2 reload` on it by hand
// from a shell with secrets in its environment (PM2 merges the caller's environment into every app on
// reload, and cluster workers inherit the PM2 daemon's environment).
//
// Each app gets only the variables it reads (audit M5). Values come from .env, parsed here as data
// (same rules as deploy/lib/common.sh: KEY=VALUE, no shell evaluation). filter_env stops PM2 from
// copying the CLI environment into the apps on start.
//
// Layout: in a release directory (<base>/releases/<id>/deploy/…) the apps run from <base>/current,
// the symlink deploy.sh switches atomically, and .env is <base>/.env. Run from a plain checkout
// (local or manual setups), the apps run from the checkout and .env sits at its root.
//
//   node deploy/ecosystem.config.cjs --keys         app names and the variable NAMES each one gets
//   node deploy/ecosystem.config.cjs --fingerprint  hash of app definitions + variable names (no values)
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const tree = path.resolve(__dirname, '..');
const inRelease = path.basename(path.dirname(tree)) === 'releases';
const base = inRelease ? path.dirname(path.dirname(tree)) : tree;
const appRoot = inRelease ? path.join(base, 'current') : tree;
const envFile = process.env.VELUM_ENV_FILE || path.join(base, '.env');

/** KEY=VALUE parser: no expansion, no escapes; one pair of matching outer quotes removed; last wins. */
function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};

/** Variables each app reads. Nothing else from .env reaches it (hot keys reach only their worker). */
const ALLOW = {
  'velum-web': { keys: ['NODE_ENV', 'PORT_WEB', 'PUBLIC_SITE_URL'], prefixes: ['NEXT_PUBLIC_'] },
  'velum-api': {
    keys: ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'PORT_API', 'HOST', 'CORS_ORIGIN', 'RPC_URL', 'CHAIN_ID', 'VELUM_NETWORK', 'DEMO_MODE', 'LOG_LEVEL'],
    prefixes: ['RATE_LIMIT_'],
  },
  'velum-workers': {
    keys: [
      'NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'RPC_URL', 'CHAIN_ID', 'VELUM_NETWORK', 'DEMO_MODE',
      'PRICE_POLL_MS', 'PRICE_SOURCE', 'PRICE_TICK_RETENTION_DAYS', 'LOG_LEVEL', 'PRICE_RELAY_PRIVATE_KEY',
    ],
    prefixes: [],
  },
};

function envFor(name, defaults) {
  const { keys, prefixes } = ALLOW[name];
  const env = { ...defaults };
  for (const [k, v] of Object.entries(fileEnv)) {
    if (v === '') continue;
    if (keys.includes(k) || prefixes.some((p) => k.startsWith(p))) env[k] = v;
  }
  return env;
}

const port = (v, dflt) => (/^\d{1,5}$/.test(v || '') ? v : dflt);
const PORT_WEB = port(fileEnv.PORT_WEB, '3000');
const PORT_API = port(fileEnv.PORT_API, '4000');
// Executables live in the release; PM2 needs a PATH to find node for the forked workers.
const PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

// API force-exits 10 s after SIGTERM; give it time to drain before PM2 sends SIGKILL (audit L13).
const common = { filter_env: true, kill_timeout: 12_000, autorestart: true };

const apps = [
  {
    ...common,
    name: 'velum-web',
    cwd: path.join(appRoot, 'apps/web'),
    script: 'node_modules/next/dist/bin/next',
    args: `start -H 127.0.0.1 -p ${PORT_WEB}`,
    instances: 2,
    exec_mode: 'cluster',
    listen_timeout: 15_000,
    env: envFor('velum-web', { NODE_ENV: 'production', PORT_WEB, PATH }),
    max_memory_restart: '700M',
  },
  {
    ...common,
    name: 'velum-api',
    cwd: path.join(appRoot, 'apps/api'),
    script: 'dist/server.js',
    instances: 2,
    exec_mode: 'cluster',
    listen_timeout: 15_000,
    node_args: '--enable-source-maps',
    env: envFor('velum-api', { NODE_ENV: 'production', PORT_API, HOST: '127.0.0.1', PATH }),
    max_memory_restart: '500M',
  },
  {
    ...common,
    name: 'velum-workers',
    cwd: path.join(appRoot, 'apps/workers'),
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: envFor('velum-workers', { NODE_ENV: 'production', PATH }),
    max_memory_restart: '500M',
  },
];

module.exports = { apps };

if (require.main === module) {
  const shape = apps.map(({ env, ...rest }) => ({ ...rest, env: Object.keys(env).sort() }));
  if (process.argv.includes('--fingerprint')) {
    process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex') + '\n');
  } else if (process.argv.includes('--names')) {
    process.stdout.write(apps.map((a) => a.name).join(' ') + '\n');
  } else {
    for (const a of shape) process.stdout.write(`${a.name} (${a.cwd}): ${a.env.join(' ')}\n`);
  }
}
