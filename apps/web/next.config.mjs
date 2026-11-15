import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Security headers as defence in depth (audit web L9). Nginx sends these too (and owns CSP and HSTS);
 * keep the values compatible. The app needs no inline event handlers and talks only to its own /api,
 * the configured network's RPC, and WalletConnect / Coinbase hosts when the user picks those wallets.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Cross-origin requests (RPC, wallet SDKs) see the origin only, never the path (e.g. which market).
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Powerful features the app never uses. Clipboard and WebAuthn keep their same-origin defaults.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), browsing-topics=()',
  },
];

/**
 * The Phase 3 deployment this build may send transactions to: contracts/deployments/<chainId>.json of the
 * tree being built (written by contracts/script/Deploy.s.sol, committed after a deployment; deploy/deploy.sh
 * builds every release from a tree that carries it), or DEPLOYMENTS_DIR/<chainId>.json. Its addresses are
 * compiled into the bundle, so a compromised API cannot point users at other contracts; at runtime the web
 * also requires GET /v1/deployment to return the same deployment before anything becomes real
 * (lib/onchain/deployment.ts). Without the file the build is exactly the simulated Phase 2 app and never
 * calls that endpoint. A file that exists but cannot be read fails the build.
 */
function pinnedDeployment() {
  const network = (process.env.NEXT_PUBLIC_VELUM_NETWORK || 'testnet').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
  const net = JSON.parse(readFileSync(new URL(`../../packages/config/robinhood-${network}.json`, import.meta.url), 'utf8'));
  // The local development chain (lib/env.ts localChainRpc): a testnet build with chain 31337 and a loopback RPC.
  const local = network === 'testnet' && process.env.NEXT_PUBLIC_CHAIN_ID === '31337' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test((process.env.NEXT_PUBLIC_RPC_URL || '').trim());
  const chainId = local ? 31337 : net.network.chainId;
  const dir = process.env.DEPLOYMENTS_DIR?.trim() || fileURLToPath(new URL('../../contracts/deployments', import.meta.url));
  const file = path.join(path.resolve(dir), `${chainId}.json`);
  if (!existsSync(file)) return '';
  const st = statSync(file);
  if (!st.isFile() || st.size > 64 * 1024) throw new Error(`${file}: not a regular deployment file`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || raw.chainId !== chainId) throw new Error(`${file}: chainId does not match ${chainId}`);
  return JSON.stringify(raw);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_VELUM_DEPLOYMENT: pinnedDeployment() },
  poweredByHeader: false,
  // The pnpm workspace root. Next 15 otherwise guesses it from the outermost lockfile it finds, which on
  // the server can be the base clone above a release directory.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // No image optimizer: removes the attack surface of several Next 14 advisories (audit web M5).
  images: { unoptimized: true },
  transpilePackages: ['@velum/config', '@velum/math'],
  eslint: { dirs: ['app', 'components', 'lib'] },
  // Local dev only: proxy /api to Fastify like Nginx does in production (set API_PROXY_TARGET).
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    return target ? [{ source: '/api/:path*', destination: `${target.replace(/\/$/, '')}/:path*` }] : [];
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async redirects() {
    return [
      { source: '/app', destination: '/app/trade/TSLA', permanent: false },
    ];
  },
  webpack: (config) => {
    // Optional peer deps pulled in by wallet SDKs; not used in the browser bundle.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // React Native storage, referenced only by WalletConnect's react-native build. Resolve it to an empty
    // module. (wagmi v3: connectors are imported one by one, so the optional SDKs Velum does not install,
    // such as Base Account and its x402 packages, are never resolved.)
    const unused = ['@react-native-async-storage/async-storage'];
    config.resolve.alias = { ...config.resolve.alias, ...Object.fromEntries(unused.map((m) => [m, false])) };
    return config;
  },
};

export default nextConfig;
