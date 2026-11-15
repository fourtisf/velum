/**
 * The Phase 3 switch and its safety rules: the compiled deployment and the API must agree before anything is
 * real (lib/onchain/deployment.ts), a transaction goes out only on the deployment's chain, never on mainnet
 * unless the deployment is for mainnet (lib/onchain/refusal.ts), amounts keep the token's exact decimals
 * (lib/onchain/units.ts), the launch guard gates deposits and trades but never exits (lib/onchain/guard.ts),
 * and the local development chain needs a testnet build with a loopback RPC (lib/env.ts).
 */
import { describe, expect, it } from 'vitest';
import { localChainRpc } from '@/lib/env';
import { apiCloseOnly, pinnedDeployment, sameDeployment } from '@/lib/onchain/deployment';
import { GUARD_COPY, MAX_UINT256, depositRefusal, guardView } from '@/lib/onchain/guard';
import { sendRefusal } from '@/lib/onchain/refusal';
import type { GuardState } from '@/lib/onchain/reads';
import { exactUnits, unitsToInput, unitsToWad, wadToUnits } from '@/lib/onchain/units';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const FILE = {
  chainId: 46630,
  startBlock: 1,
  contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) },
  tokens: { USDG: A(10), TSLA: A(11), AMZN: A(12) },
  priceRelayer: A(20),
  guardian: A(0),
  guardAdmin: A(0),
};
const json = (o: unknown) => JSON.stringify(o);

describe('the deployment compiled into the build', () => {
  it('is read for this app chain only', () => {
    expect(pinnedDeployment(json(FILE), 46630)?.contracts.vault).toBe(A(1));
    expect(pinnedDeployment(json(FILE), 4663)).toBeNull();
    expect(pinnedDeployment(json({ ...FILE, chainId: 31337 }), 31337)?.chainId).toBe(31337);
  });

  it('absent, malformed or incomplete: none (the app stays simulated)', () => {
    expect(pinnedDeployment('', 46630)).toBeNull();
    expect(pinnedDeployment(undefined, 46630)).toBeNull();
    expect(pinnedDeployment('{not json', 46630)).toBeNull();
    expect(pinnedDeployment(json({ ...FILE, contracts: { ...FILE.contracts, vault: undefined } }), 46630)).toBeNull();
    expect(pinnedDeployment(json({ ...FILE, tokens: { TSLA: A(11) } }), 46630)).toBeNull();
  });

  it('mainnet only with a mainnet deployment (the guarded beta)', () => {
    expect(pinnedDeployment(json({ ...FILE, chainId: 4663 }), 4663)?.chainId).toBe(4663);
    expect(pinnedDeployment(json(FILE), 4663)).toBeNull();
  });
});

describe('the API must serve the same deployment', () => {
  const pinned = pinnedDeployment(json(FILE), 46630)!;
  it('same chain, contracts and tokens (any letter case, extra contracts allowed)', () => {
    expect(sameDeployment(pinned, { ...FILE, guard: { guardian: null, closeOnly: {} }, indexer: null })).toBe(true);
    expect(sameDeployment(pinned, { ...FILE, contracts: { ...FILE.contracts, vault: A(1).toUpperCase().replace('0X', '0x'), allowlist: A(30) } })).toBe(true);
  });

  it('anything different keeps everything simulated', () => {
    expect(sameDeployment(pinned, { ...FILE, contracts: { ...FILE.contracts, vault: A(99) } })).toBe(false);
    expect(sameDeployment(pinned, { ...FILE, chainId: 4663 })).toBe(false);
    expect(sameDeployment(pinned, { ...FILE, tokens: { ...FILE.tokens, NFLX: A(13) } })).toBe(false);
    expect(sameDeployment(pinned, { ...FILE, tokens: { USDG: A(10), TSLA: A(11) } })).toBe(false);
    expect(sameDeployment(pinned, { ...FILE, tokens: { ...FILE.tokens, TSLA: A(12), AMZN: A(11) } })).toBe(false);
    expect(sameDeployment(pinned, null)).toBe(false);
    expect(sameDeployment(pinned, 'x')).toBe(false);
  });

  it('close-only flags are validated', () => {
    expect(apiCloseOnly({ guard: { closeOnly: { TSLA: true, AMZN: false, bad: true, NFLX: 'yes' } } })).toEqual({ TSLA: true, AMZN: false });
    expect(apiCloseOnly({ guard: { closeOnly: null } })).toBeNull();
    expect(apiCloseOnly({})).toBeNull();
  });
});

describe('when a transaction may be sent', () => {
  const ok = { walletChainId: 46630, walletAddress: A(7), account: A(7), deploymentChainId: 46630, appChainId: 46630 };
  it('only from the signed-in wallet on the deployment chain', () => {
    expect(sendRefusal(ok)).toBeNull();
    expect(sendRefusal({ ...ok, walletAddress: undefined })).toBe('not-connected');
    expect(sendRefusal({ ...ok, walletAddress: A(8) })).toBe('account-changed');
    expect(sendRefusal({ ...ok, walletAddress: A(7).toUpperCase().replace('0X', '0x') })).toBeNull();
    expect(sendRefusal({ ...ok, walletChainId: 1 })).toBe('wrong-chain');
    expect(sendRefusal({ ...ok, walletChainId: undefined })).toBe('wrong-chain');
  });

  it('never on Robinhood Chain mainnet unless the deployment is for mainnet', () => {
    expect(sendRefusal({ ...ok, walletChainId: 4663 })).toBe('wrong-chain');
    expect(sendRefusal({ ...ok, walletChainId: 4663, appChainId: 4663 })).toBe('deployment');
    expect(sendRefusal({ ...ok, walletChainId: 4663, appChainId: 4663, deploymentChainId: 4663 })).toBeNull();
    expect(sendRefusal({ ...ok, deploymentChainId: 31337 })).toBe('deployment');
  });
});

describe('token units', () => {
  it('a typed amount in base units with the exact decimals, refused when it has more', () => {
    expect(wadToUnits(1_500_000_000_000_000_000n, 6)).toEqual({ ok: true, units: 1_500_000n });
    expect(wadToUnits(1n, 6)).toEqual({ ok: false, reason: 'decimals' });
    expect(wadToUnits(1n, 18)).toEqual({ ok: true, units: 1n });
    expect(wadToUnits(-1n, 18)).toEqual({ ok: false, reason: 'negative' });
    expect(() => wadToUnits(1n, 19)).toThrow();
  });

  it('base units back to a Wad, an input string (floored) and an exact string', () => {
    expect(unitsToWad(1_500_000n, 6)).toBe(1_500_000_000_000_000_000n);
    expect(unitsToInput(1_234_567n, 6, 2)).toBe('1.23');
    expect(unitsToInput(1_239_999n, 6, 2)).toBe('1.23');
    expect(unitsToInput(123_456_789_123_456_789n, 18, 4)).toBe('0.1234');
    expect(exactUnits(1_500_000n, 6)).toBe('1.5');
  });
});

describe('launch guard', () => {
  const g = (o: Partial<GuardState> = {}): GuardState => ({ guarded: true, allowlistActive: true, capsActive: true, guardAdmin: A(9) as `0x${string}`, allowlisted: false, depositLimit: { USDG: 0n }, ...o });

  it('off the allowlist: blocked, with its status', () => {
    const v = guardView(g(), true);
    expect(v).toMatchObject({ guarded: true, blocked: true, status: 'not-allowlisted' });
    expect(depositRefusal(v, 'USDG', 1n)).toBe('not-allowlisted');
  });

  it('allowlisted: allowed up to the remaining limit', () => {
    const v = guardView(g({ allowlisted: true, depositLimit: { USDG: 1000n } }), true);
    expect(v).toMatchObject({ blocked: false, status: 'allowlisted', limits: { USDG: 1000n } });
    expect(depositRefusal(v, 'USDG', 1000n)).toBeNull();
    expect(depositRefusal(v, 'USDG', 1001n)).toBe('over-limit');
  });

  it('caps lifted (unlimited) or no guard: never refused', () => {
    expect(depositRefusal(guardView(g({ allowlisted: true, depositLimit: { USDG: MAX_UINT256 } }), true), 'USDG', 10n ** 40n)).toBeNull();
    const off = guardView(g({ guarded: false, allowlistActive: false, capsActive: false }), true);
    expect(off).toMatchObject({ guarded: false, blocked: false, status: null, limits: null });
    expect(depositRefusal(off, 'USDG', 10n ** 40n)).toBeNull();
    expect(guardView(undefined, true)).toMatchObject({ guarded: false, blocked: false });
  });

  it('open to the public with caps still on: nobody blocked, limits apply', () => {
    const v = guardView(g({ allowlistActive: false, depositLimit: { USDG: 5n } }), true);
    expect(v).toMatchObject({ blocked: false, status: null });
    expect(depositRefusal(v, 'USDG', 6n)).toBe('over-limit');
  });

  it('the copy never says exits are blocked', () => {
    expect(GUARD_COPY.blocked).toMatch(/Withdrawals and closes always work/);
  });
});

describe('local development chain', () => {
  it('a testnet build with chain 31337 and a loopback RPC only', () => {
    expect(localChainRpc({ chainId: '31337', rpcUrl: 'http://127.0.0.1:8545' }, false)).toBe('http://127.0.0.1:8545');
    expect(localChainRpc({ chainId: '31337', rpcUrl: 'http://localhost:8545/' }, false)).toBe('http://localhost:8545');
    expect(localChainRpc({ chainId: '31337', rpcUrl: 'http://127.0.0.1:8545' }, true)).toBeNull();
    expect(localChainRpc({ chainId: '31337', rpcUrl: 'https://rpc.example.com' }, false)).toBeNull();
    expect(localChainRpc({ chainId: '46630', rpcUrl: 'http://127.0.0.1:8545' }, false)).toBeNull();
    expect(localChainRpc({ chainId: '31337', rpcUrl: 'not a url' }, false)).toBeNull();
    expect(localChainRpc({ chainId: '31337' }, false)).toBeNull();
  });
});
