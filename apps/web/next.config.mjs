/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@velum/config', '@velum/math'],
  eslint: { dirs: ['app', 'components', 'lib'] },
  // Local dev only: proxy /api to Fastify like Nginx does in production (set API_PROXY_TARGET).
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    return target ? [{ source: '/api/:path*', destination: `${target.replace(/\/$/, '')}/:path*` }] : [];
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
