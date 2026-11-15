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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
    // wagmi/connectors re-exports every connector; Base Account's payment code imports
    // optional x402 packages we never call. Resolve them to empty modules.
    const unused = ['@react-native-async-storage/async-storage', '@x402/core/client', '@x402/evm', '@x402/evm/exact/client', '@x402/evm/upto/client', '@x402/svm/exact/client'];
    config.resolve.alias = { ...config.resolve.alias, ...Object.fromEntries(unused.map((m) => [m, false])) };
    return config;
  },
};

export default nextConfig;
