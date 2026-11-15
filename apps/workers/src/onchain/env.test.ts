import { describe, expect, it } from 'vitest';
import { loadOnchainEnv, parseFixed, validKey, weiToGwei } from './env';

// Throwaway values only (never real keys): 0x...01 and 0x...02 are valid secp256k1 scalars.
const K1 = `0x${'0'.repeat(63)}1`;
const K2 = `0x${'0'.repeat(63)}2`;

describe('on-chain env', () => {
  it('is off by default, with the documented defaults', () => {
    const e = loadOnchainEnv({});
    expect(e.requested).toBe(false);
    expect(e.mainnetConfirmed).toBe(false);
    expect(e.relayIntervalMs).toBe(9000);
    expect(e.confirmations).toBe(3);
    expect(e.chunkBlocks).toBe(2000);
    expect(e.startBlock).toBeNull();
    expect(e.relayMaxFeeWei).toBe(10n ** 9n);
    expect(e.keeperMaxFeeWei).toBe(10n ** 9n);
    expect(e.relayMinBalanceWei).toBe(5n * 10n ** 16n);
    expect(e.keeperMinBalanceWei).toBe(5n * 10n ** 16n);
    expect(e.fundingEpochSeconds).toBe(3600);
    expect(e.keys.relay()).toBeNull();
    expect(e.keys.keeper()).toBeNull();
    expect(e.deploymentsDir).toMatch(/contracts[/\\]deployments$/);
  });

  it('only the literal true turns it on (deploy/ecosystem.config.cjs uses the same rule for the keys)', () => {
    expect(loadOnchainEnv({ ONCHAIN_WORKERS: 'true' }).requested).toBe(true);
    expect(loadOnchainEnv({ ONCHAIN_WORKERS: ' TRUE ' }).requested).toBe(true);
    expect(loadOnchainEnv({ ONCHAIN_WORKERS: 'false' }).requested).toBe(false);
    expect(() => loadOnchainEnv({ ONCHAIN_WORKERS: '1' })).toThrow(/ONCHAIN_WORKERS must be true or false/);
    expect(() => loadOnchainEnv({ ONCHAIN_WORKERS: 'yes' })).toThrow(/ONCHAIN_WORKERS/);
    expect(loadOnchainEnv({ ONCHAIN_MAINNET_CONFIRMED: 'yes' }).mainnetConfirmed).toBe(true);
    expect(loadOnchainEnv({ ONCHAIN_MAINNET_CONFIRMED: 'no' }).mainnetConfirmed).toBe(false);
    expect(() => loadOnchainEnv({ ONCHAIN_MAINNET_CONFIRMED: 'true' })).toThrow(/ONCHAIN_MAINNET_CONFIRMED must be yes or no/);
  });

  it('keeps the push cadence within 8-10 s', () => {
    expect(loadOnchainEnv({ PRICE_PUSH_INTERVAL_MS: '8000' }).relayIntervalMs).toBe(8000);
    expect(loadOnchainEnv({ PRICE_PUSH_INTERVAL_MS: '10000' }).relayIntervalMs).toBe(10_000);
    expect(() => loadOnchainEnv({ PRICE_PUSH_INTERVAL_MS: '5000' })).toThrow(/PRICE_PUSH_INTERVAL_MS must be an integer between 8000 and 10000/);
    expect(() => loadOnchainEnv({ PRICE_PUSH_INTERVAL_MS: '11000' })).toThrow(/PRICE_PUSH_INTERVAL_MS/);
  });

  it('parses gas ceilings and balance thresholds exactly', () => {
    const e = loadOnchainEnv({ RELAYER_MAX_GWEI: '0.05', KEEPER_MAX_GWEI: '2', RELAYER_MIN_BALANCE_ETH: '0.01', KEEPER_MIN_BALANCE_ETH: '0.2' });
    expect(e.relayMaxFeeWei).toBe(5n * 10n ** 7n);
    expect(e.keeperMaxFeeWei).toBe(2n * 10n ** 9n);
    expect(e.relayMinBalanceWei).toBe(10n ** 16n);
    expect(e.keeperMinBalanceWei).toBe(2n * 10n ** 17n);
    expect(() => loadOnchainEnv({ RELAYER_MAX_GWEI: '0' })).toThrow(/RELAYER_MAX_GWEI must be a positive decimal/);
    expect(() => loadOnchainEnv({ RELAYER_MAX_GWEI: '-1' })).toThrow(/RELAYER_MAX_GWEI/);
    expect(() => loadOnchainEnv({ RELAYER_MAX_GWEI: '0.0000000001' })).toThrow(/at most 9 decimals/);
    expect(() => loadOnchainEnv({ RELAYER_MIN_BALANCE_ETH: 'lots' })).toThrow(/RELAYER_MIN_BALANCE_ETH/);
  });

  it('reads INDEXER_START_BLOCK (0 or empty: the deployment file) and CONFIRMATIONS', () => {
    expect(loadOnchainEnv({ INDEXER_START_BLOCK: '0' }).startBlock).toBeNull();
    expect(loadOnchainEnv({ INDEXER_START_BLOCK: '153118480' }).startBlock).toBe(153118480);
    expect(loadOnchainEnv({ CONFIRMATIONS: '0' }).confirmations).toBe(0);
    expect(() => loadOnchainEnv({ CONFIRMATIONS: '-1' })).toThrow(/CONFIRMATIONS/);
  });

  it('validates the hot keys without ever printing them, and refuses one key for both roles', () => {
    const e = loadOnchainEnv({ PRICE_RELAY_PRIVATE_KEY: K1, KEEPER_PRIVATE_KEY: K2 });
    expect(e.keys.relay()).toBe(K1);
    expect(e.keys.keeper()).toBe(K2);
    // The settings serialise without the keys (they sit behind functions).
    expect(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(K1.slice(2));
    let msg = '';
    try {
      loadOnchainEnv({ PRICE_RELAY_PRIVATE_KEY: `${K1}zz`, KEEPER_PRIVATE_KEY: K1.toUpperCase().replace('0X', '0x') });
    } catch (err) {
      msg = String(err);
    }
    expect(msg).toMatch(/PRICE_RELAY_PRIVATE_KEY is not a private key/);
    expect(msg).not.toContain(K1.slice(2));
    expect(() => loadOnchainEnv({ PRICE_RELAY_PRIVATE_KEY: K1, KEEPER_PRIVATE_KEY: K1.toUpperCase().replace('0X', '0x') })).toThrow(/must not be the price-relay key/);
    expect(validKey(`0x${'0'.repeat(64)}`)).toBe('invalid');
    expect(validKey(`0x${'f'.repeat(64)}`)).toBe('invalid'); // above the group order
    expect(validKey('')).toBeNull();
  });

  it('helpers', () => {
    expect(parseFixed('1.5', 9)).toBe(1_500_000_000n);
    expect(parseFixed('1.', 9)).toBeNull();
    expect(parseFixed('1e3', 9)).toBeNull();
    expect(weiToGwei(1_500_000_000n)).toBe('1.5');
    expect(weiToGwei(2n * 10n ** 9n)).toBe('2');
  });
});
