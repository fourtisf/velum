// PM2 process file. deploy/release.sh starts and reloads it; do not run `pm2 reload` on it by hand.
//
// Environment (audit M5, R2-L3): each app gets only the variables it reads, parsed here from an env
// file as data (same rules as deploy/lib/common.sh: KEY=VALUE, no shell evaluation). PM2 adds the
// environment of the `pm2` command itself on start and merges it into every app on reload (PM2's
// filter_env does not stop that: `true` is ignored by PM2 6.0.14 and no form filters reload or the
// daemon's environment that cluster workers inherit). So release.sh always runs pm2 under `env -i`
// with only HOME, PATH, LANG, PM2_HOME and VELUM_PM2_SCOPE. The daemon itself runs under its systemd
// unit (pm2-<user>, written by deploy.sh) with a fixed environment that holds no secret, and deploy.sh
// restarts a daemon whose own environment holds one (audit R3-01, I-2).
//
// Scopes (VELUM_PM2_SCOPE, audit R2-M3): on a server the web runs as its own user in its own PM2
// daemon and reads <base>/web.env (rendered by root, no secrets); api and workers run as the app user
// and read <base>/.env, which the web user cannot read.
//   backend  velum-api + velum-workers   (app user, .env)
//   web      velum-web                   (web user, web.env)
//   all      all three                   (single-user and local setups, .env)
//
// Layout: in a release directory (<base>/releases/<id>/deploy/…) the apps run from <base>/current,
// the symlink deploy.sh switches atomically. Run from a plain checkout (local or manual setups), the
// apps run from the checkout and the env files sit at its root.
//
//   node deploy/ecosystem.config.cjs --keys         app names and the variable NAMES each one gets
//   node deploy/ecosystem.config.cjs --fingerprint  hash of app definitions + variable names (no values)
//   node deploy/ecosystem.config.cjs --names        app names in this scope
//   node deploy/ecosystem.config.cjs --cwds         name=cwd for each app in this scope
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const tree = path.resolve(__dirname, '..');
const inRelease = path.basename(path.dirname(tree)) === 'releases';
const base = inRelease ? path.dirname(path.dirname(tree)) : tree;
const appRoot = inRelease ? path.join(base, 'current') : tree;
const scope = process.env.VELUM_PM2_SCOPE || 'all';
if (!['backend', 'web', 'all'].includes(scope)) throw new Error(`VELUM_PM2_SCOPE must be backend, web or all (got ${scope}).`);
const envFile = process.env.VELUM_ENV_FILE || path.join(base, scope === 'web' ? 'web.env' : '.env');

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

/**
 * Variables each app reads. Nothing else reaches it (hot keys reach only their worker). The web list
 * must match WEB_ENV_KEYS / WEB_ENV_PREFIX in deploy/lib/common.sh (what root writes to web.env).
 * `gated` keys reach the app only while `when` holds.
 */
// Phase 3 on-chain workers (apps/workers/src/onchain): the hot keys reach velum-workers only with the literal
// ONCHAIN_WORKERS=true in .env (the workers apply the same rule), and never reach the API or the web.
const onchainOn = (fileEnv.ONCHAIN_WORKERS || '').trim().toLowerCase() === 'true';
const ALLOW = {
  'velum-web': { keys: ['NODE_ENV', 'PORT_WEB', 'PUBLIC_SITE_URL'], prefixes: ['NEXT_PUBLIC_'] },
  'velum-api': {
    // API_SOCKET: on the server the API listens on a unix socket only Nginx can reach (audit R3-03).
    // DEPLOYMENTS_DIR: the Phase 3 reads (/v1/deployment, /v1/accounts/*, funding) use the deployment file.
    keys: ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'PORT_API', 'HOST', 'API_SOCKET', 'CORS_ORIGIN', 'RPC_URL', 'CHAIN_ID', 'VELUM_NETWORK', 'DEMO_MODE', 'LOG_LEVEL', 'PROXY_SECRET', 'DEPLOYMENTS_DIR'],
    prefixes: ['RATE_LIMIT_'],
  },
  'velum-workers': {
    keys: [
      'NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'RPC_URL', 'CHAIN_ID', 'VELUM_NETWORK', 'DEMO_MODE',
      'PRICE_POLL_MS', 'PRICE_SOURCE', 'PRICE_TICK_RETENTION_DAYS', 'LOG_LEVEL',
      // Phase 3 on-chain workers (no secrets): off unless ONCHAIN_WORKERS=true and the deployment file exists.
      'ONCHAIN_WORKERS', 'ONCHAIN_MAINNET_CONFIRMED', 'DEPLOYMENTS_DIR', 'PRICE_PUSH_INTERVAL_MS',
      'RELAYER_MAX_GWEI', 'KEEPER_MAX_GWEI', 'RELAYER_MIN_BALANCE_ETH', 'KEEPER_MIN_BALANCE_ETH', 'KEEPER_ETH_PRICE_USD',
      'INDEXER_START_BLOCK', 'CONFIRMATIONS', 'INDEXER_CHUNK_BLOCKS', 'INDEXER_POLL_MS', 'KEEPER_INTERVAL_MS', 'FUNDING_EPOCH_SECONDS',
    ],
    prefixes: [],
    // The price-relay and keeper hot keys (deploy/new-key.sh), two separate keys.
    gated: { when: onchainOn, keys: ['PRICE_RELAY_PRIVATE_KEY', 'KEEPER_PRIVATE_KEY'] },
  },
};
// A hot key must never be on the API's or the web's list, nor match a prefix there.
for (const name of ['velum-web', 'velum-api']) {
  const { keys, prefixes } = ALLOW[name];
  if (keys.some((k) => /PRIVATE_KEY|SECRET_KEY|MNEMONIC/.test(k)) || prefixes.some((p) => 'PRICE_RELAY_PRIVATE_KEY'.startsWith(p) || 'KEEPER_PRIVATE_KEY'.startsWith(p))) {
    throw new Error(`${name} must not receive a hot key`);
  }
}

function envFor(name, defaults) {
  const { keys, prefixes, gated } = ALLOW[name];
  const env = { ...defaults };
  for (const [k, v] of Object.entries(fileEnv)) {
    if (v === '') continue;
    if (keys.includes(k) || prefixes.some((p) => k.startsWith(p)) || (gated && gated.when && gated.keys.includes(k))) env[k] = v;
  }
  return env;
}

const port = (v, dflt) => (/^\d{1,5}$/.test(v || '') ? v : dflt);
const PORT_WEB = port(fileEnv.PORT_WEB, '3000');
const PORT_API = port(fileEnv.PORT_API, '4000');
// Executables live in the release; PM2 needs a PATH to find node for the forked workers.
const PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

// API force-exits 10 s after SIGTERM; give it time to drain before PM2 sends SIGKILL (audit L13).
const common = { kill_timeout: 12_000, autorestart: true };
// api and workers (audit M-3): a crash is restarted after 1 s, then 1.5x longer each time up to 15 s
// (PM2 resets the delay after 30 s up), so a process that cannot start yet (Postgres or Redis still
// booting) keeps being retried instead of PM2 marking it errored after max_restarts fast restarts. A run
// shorter than min_uptime counts as unstable; with the backoff fewer than max_restarts fit into PM2's
// min_uptime x max_restarts window. The workers also wait for Postgres and Redis themselves.
const backend = { exp_backoff_restart_delay: 1000, min_uptime: 5000, max_restarts: 16 };

const all = [
  {
    ...common,
    name: 'velum-web',
    cwd: path.join(appRoot, 'apps/web'),
    script: 'node_modules/next/dist/bin/next',
    args: `start -H 127.0.0.1 -p ${PORT_WEB}`,
    instances: 2,
    exec_mode: 'cluster',
    listen_timeout: 15_000,
    // NEXT_TELEMETRY_DISABLED: the web user's home stays free of Next's telemetry config.
    env: envFor('velum-web', { NODE_ENV: 'production', PORT_WEB, PATH, NEXT_TELEMETRY_DISABLED: '1' }),
    max_memory_restart: '700M',
  },
  {
    ...common,
    ...backend,
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
    ...backend,
    name: 'velum-workers',
    cwd: path.join(appRoot, 'apps/workers'),
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: envFor('velum-workers', { NODE_ENV: 'production', PATH }),
    max_memory_restart: '500M',
  },
];

const SCOPES = { backend: ['velum-api', 'velum-workers'], web: ['velum-web'], all: ['velum-web', 'velum-api', 'velum-workers'] };
const apps = all.filter((a) => SCOPES[scope].includes(a.name));

module.exports = { apps };

if (require.main === module) {
  const shape = apps.map(({ env, ...rest }) => ({ ...rest, env: Object.keys(env).sort() }));
  if (process.argv.includes('--fingerprint')) {
    process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex') + '\n');
  } else if (process.argv.includes('--names')) {
    process.stdout.write(apps.map((a) => a.name).join(' ') + '\n');
  } else if (process.argv.includes('--cwds')) {
    process.stdout.write(apps.map((a) => `${a.name}=${a.cwd}`).join(' ') + '\n');
  } else {
    for (const a of shape) process.stdout.write(`${a.name} (${a.cwd}): ${a.env.join(' ')}\n`);
  }
}
