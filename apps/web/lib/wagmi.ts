import { http, createConfig } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { robinhoodTestnet } from './chain';
import { ENV } from './env';

const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: 'Velum', preference: 'all' }),
  ...(ENV.walletConnectProjectId
    ? [
        walletConnect({
          projectId: ENV.walletConnectProjectId,
          showQrModal: true,
          metadata: {
            name: 'Velum',
            description: 'Private stock trading on Robinhood Chain testnet',
            url: ENV.siteUrl || 'https://velum.example',
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors,
  transports: { [robinhoodTestnet.id]: http(ENV.rpcUrl, { batch: true }) },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
