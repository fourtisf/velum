import { http, createConfig, type CreateConnectorFn } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { robinhoodTestnet } from './chain';
import { ENV } from './env';

/**
 * Privacy: third-party wallet SDKs (Coinbase, WalletConnect) phone home when they initialise,
 * and wagmi initialises every configured connector on reconnect. So they are only created when
 * the user picks them, or on reload when they were the wallet last used.
 */
export const coinbaseConnector = (): CreateConnectorFn => coinbaseWallet({ appName: 'Velum', preference: { options: 'all', telemetry: false } });

export const walletConnectConnector = (): CreateConnectorFn | null =>
  ENV.walletConnectProjectId
    ? walletConnect({
        projectId: ENV.walletConnectProjectId,
        showQrModal: true,
        telemetryEnabled: false,
        metadata: {
          name: 'Velum',
          description: 'Private stock trading on Robinhood Chain testnet',
          url: ENV.siteUrl || 'https://velum.example',
          icons: [],
        },
      })
    : null;

function recentConnectorId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem('wagmi.recentConnectorId');
    return v ? (JSON.parse(v) as string) : null;
  } catch {
    return null;
  }
}

function initialConnectors(): CreateConnectorFn[] {
  const list: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  const recent = recentConnectorId();
  if (recent === 'coinbaseWalletSDK') list.push(coinbaseConnector());
  const wc = recent === 'walletConnect' ? walletConnectConnector() : null;
  if (wc) list.push(wc);
  return list;
}

export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors: initialConnectors(),
  transports: { [robinhoodTestnet.id]: http(ENV.rpcUrl, { batch: true }) },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
