/**
 * Ethereum mainnet, read-only (owner request of 2026-11-17): the mainnet Portfolio shows the wallet's ETH on Ethereum
 * (the "ERC20" network, same address) next to its ETH on Robinhood Chain. Only the balance is read, from the browser,
 * through PublicNode's free public RPC (no key, no account); the web checks it answers chain 1 before trusting it.
 * deploy/lib/common.sh adds this origin to the Content-Security-Policy on mainnet.
 */
export const ETH_L1_CHAIN_ID = 1;
export const ETH_L1_RPC = 'https://ethereum-rpc.publicnode.com';
