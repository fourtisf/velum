/**
 * ETH on Ethereum mainnet (the "ERC20" network) in the mainnet Portfolio: read only after the RPC answers chain 1,
 * valued at the live ETH price, and added to the wallet total; when it cannot be read the total says it is left out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ViemModule from 'viem';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VELUM_NETWORK = 'mainnet';
});

const h = vi.hoisted(() => ({ chainId: 1, balance: 0n, chainCalls: 0, urls: [] as string[], fail: false }));

vi.mock('viem', async (orig) => {
  const real = await orig<typeof ViemModule>();
  return {
    ...real,
    http: (url: string) => {
      h.urls.push(url);
      return real.http(url);
    },
    createPublicClient: () => ({
      getChainId: async () => {
        h.chainCalls++;
        if (h.fail) throw new Error('network down');
        return h.chainId;
      },
      getBalance: async () => h.balance,
    }),
  };
});

import { ETH_L1_RPC } from '@velum/config/src/ethereum';
import { useMarkets } from '@/lib/markets';
import { fullTotal, l1EthValue, walletValue } from '@/lib/walletValue';
import { W, setLiveMarkets } from './helpers';

const ME = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  vi.resetModules();
  h.chainId = 1;
  h.balance = 0n;
  h.chainCalls = 0;
  h.fail = false;
});

describe('reading ETH on Ethereum', () => {
  it('uses the public Ethereum RPC and reads the balance once it answers chain 1', async () => {
    const { readEthereumEth } = await import('@/lib/ethereumEth');
    expect(h.urls).toContain(ETH_L1_RPC);
    expect(ETH_L1_RPC).toBe('https://ethereum-rpc.publicnode.com');
    h.balance = W('0.25');
    expect(await readEthereumEth(ME)).toBe(W('0.25'));
    await readEthereumEth(ME);
    expect(h.chainCalls).toBe(1); // checked once per page load
  });

  it('refuses an RPC that is not Ethereum mainnet', async () => {
    const { readEthereumEth } = await import('@/lib/ethereumEth');
    h.chainId = 4663;
    await expect(readEthereumEth(ME)).rejects.toThrow(/not answer as Ethereum mainnet/);
  });

  it('checks the chain again after a network error', async () => {
    const { readEthereumEth } = await import('@/lib/ethereumEth');
    h.fail = true;
    await expect(readEthereumEth(ME)).rejects.toThrow();
    h.fail = false;
    h.balance = 5n;
    expect(await readEthereumEth(ME)).toBe(5n);
    expect(h.chainCalls).toBe(2);
  });
});

describe('the wallet total with ETH on Ethereum', () => {
  it('adds ETH on Ethereum at the live ETH price', () => {
    setLiveMarkets({ TSLA: '400' });
    useMarkets.setState({ ethPx: { px: W('2000'), at: Date.now() } });
    const rh = walletValue({ USDG: W('10'), TSLA: W('1'), ETH: W('0.1') });
    expect(rh.total).toBe(W('610'));
    expect(l1EthValue(W('0.5'))).toBe(W('1000'));
    expect(fullTotal(rh, { wei: W('0.5'), pending: false, error: false })).toEqual({ total: W('1610'), l1Missing: false });
    expect(fullTotal(rh, { wei: 0n, pending: false, error: false })).toEqual({ total: W('610'), l1Missing: false });
  });

  it('waits while it loads, and says it is left out when it cannot be read', () => {
    setLiveMarkets({});
    useMarkets.setState({ ethPx: { px: W('2000'), at: Date.now() } });
    const rh = walletValue({ USDG: W('10'), ETH: 0n });
    expect(fullTotal(rh, { wei: undefined, pending: true, error: false })).toEqual({ total: null, l1Missing: false });
    expect(fullTotal(rh, { wei: undefined, pending: false, error: true })).toEqual({ total: W('10'), l1Missing: true });
  });

  it('no ETH price: no total, never a guess', () => {
    useMarkets.setState({ ethPx: null });
    const rh = walletValue({ USDG: W('10'), ETH: 0n });
    expect(l1EthValue(W('1'))).toBeNull();
    expect(fullTotal(rh, { wei: W('1'), pending: false, error: false }).total).toBeNull();
  });
});
