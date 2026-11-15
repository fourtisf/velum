import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDeploymentFile } from '@velum/config/src/deployment-file';
import { parseDeployment, parseOnchainStatus, type OnchainStatus } from '@velum/config/src/onchain';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { abis } from './chain';
import { contractNames, decodeLog, indexedAddresses, toJsonArg, type RawLog } from './decode';
import { fmtUnits } from './projections';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const raw = {
  chainId: 31337,
  startBlock: 12,
  contracts: { vault: A(1), oracle: A(2), spotPools: A(3), makerBook: A(4), perpsMarkets: A(5) },
  guardian: '0x0000000000000000000000000000000000000000',
  priceRelayer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  tokens: { USDG: A(10), TSLA: A(11), AMZN: A(12) },
};

describe('deployment file', () => {
  it('parses what Deploy.s.sol writes, addresses in lower case, zero guardian as none', () => {
    const r = parseDeployment(raw, 31337);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deployment.priceRelayer).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(r.deployment.guardian).toBeNull();
    expect(r.deployment.tokens.TSLA).toBe(A(11));
    expect(indexedAddresses(r.deployment)).toHaveLength(5);
  });

  it('keeps extra contract addresses (a later allowlist contract) and ignores unknown keys', () => {
    const r = parseDeployment({ ...raw, contracts: { ...raw.contracts, allowlist: A(6), note: 'x' }, extra: { anything: true } }, 31337);
    expect(r.ok && r.deployment.contracts.allowlist).toBe(A(6));
    expect(r.ok && indexedAddresses(r.deployment)).toHaveLength(6);
    expect(r.ok && contractNames(r.deployment).get(A(6))).toBe('allowlist');
  });

  it('refuses the wrong chain, missing or duplicate contracts, bad tokens', () => {
    expect(parseDeployment(raw, 46630)).toEqual({ ok: false, error: expect.stringMatching(/chainId/) });
    expect(parseDeployment({ ...raw, contracts: { ...raw.contracts, vault: undefined } }, 31337)).toMatchObject({ ok: false, error: expect.stringMatching(/vault/) });
    expect(parseDeployment({ ...raw, contracts: { ...raw.contracts, oracle: A(1) } }, 31337)).toMatchObject({ ok: false, error: expect.stringMatching(/share/) });
    expect(parseDeployment({ ...raw, tokens: { TSLA: A(11) } }, 31337)).toMatchObject({ ok: false, error: expect.stringMatching(/USDG/) });
    expect(parseDeployment({ ...raw, tokens: { ...raw.tokens, 'bad sym': A(13) } }, 31337)).toMatchObject({ ok: false });
    expect(parseDeployment({ ...raw, startBlock: -1 }, 31337)).toMatchObject({ ok: false });
    expect(parseDeployment([], 31337)).toMatchObject({ ok: false });
  });

  it('reads the file for the chain: missing, invalid or ok', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'velum-deploy-'));
    expect(readDeploymentFile(dir, 31337).status).toBe('missing');
    writeFileSync(path.join(dir, '31337.json'), '{ nope');
    expect(readDeploymentFile(dir, 31337)).toMatchObject({ status: 'invalid', error: expect.stringMatching(/JSON/) });
    writeFileSync(path.join(dir, '31337.json'), JSON.stringify(raw));
    expect(readDeploymentFile(dir, 31337)).toMatchObject({ status: 'ok', deployment: { startBlock: 12 } });
    expect(readDeploymentFile(dir, 46630).status).toBe('missing');
  });
});

describe('log decoding', () => {
  const d = (() => {
    const r = parseDeployment(raw, 31337);
    if (!r.ok) throw new Error(r.error);
    return r.deployment;
  })();
  const names = contractNames(d);
  const log = (address: string, topics: Hex[], data: Hex): RawLog => ({ address: address as Hex, topics, data, blockNumber: 7n, blockHash: `0x${'ab'.repeat(32)}`, transactionHash: `0x${'cd'.repeat(32)}`, logIndex: 3 });

  it('decodes a known event to JSON-safe args (decimal strings, lower-case addresses)', () => {
    const topics = encodeEventTopics({ abi: abis.vault, eventName: 'Deposited', args: { from: raw.priceRelayer as Hex, to: A(20), token: A(10) } }) as Hex[];
    const ev = decodeLog(log(A(1), topics, encodeAbiParameters([{ type: 'uint256' }], [123_456_789n])), names, new Date(0));
    expect(ev).toMatchObject({ contract: 'vault', kind: 'Deposited', known: true, block: 7n, logIndex: 3 });
    expect(ev.args).toEqual({ from: raw.priceRelayer.toLowerCase(), to: A(20), token: A(10), amount: '123456789' });
  });

  it('keeps an event this ABI version does not know as unknown:<topic0> (never an error)', () => {
    const topic0 = `0x${'99'.repeat(32)}` as Hex;
    const ev = decodeLog(log(A(1), [topic0, `0x${'00'.repeat(31)}01`], '0x1234'), names, new Date(0));
    expect(ev).toMatchObject({ kind: `unknown:${topic0}`, known: false, contract: 'vault' });
    expect(ev.args).toEqual({ topics: [topic0, `0x${'00'.repeat(31)}01`], data: '0x1234' });
    // A log from a contract the file lists but no ABI covers.
    const other = decodeLog(log(A(99), [topic0], '0x'), names, new Date(0));
    expect(other).toMatchObject({ contract: 'other', known: false });
  });

  it('signed integers and arrays', () => {
    expect(toJsonArg(-5n)).toBe('-5');
    expect(toJsonArg([A(1).toUpperCase().replace('0X', '0x'), 2n])).toEqual([A(1), '2']);
    expect(fmtUnits(1_500_000n, 6)).toBe('1.5');
    expect(fmtUnits(-1n, 18)).toBe('-0.000000000000000001');
    expect(fmtUnits(0n, 6)).toBe('0');
  });
});

describe('on-chain status payload', () => {
  const sender = { enabled: true, address: A(7), sending: true, balanceWei: '1', balanceLow: false, inflight: false, stuck: false, gasCapped: false, lastTx: null, lastConfirmedAt: null, error: null };
  const status: OnchainStatus = {
    v: 1,
    at: 1000,
    chainId: 46630,
    deployment: A(5),
    indexer: { enabled: true, block: 10, head: 12, lagBlocks: 2, lastRunAt: 999, reorgs: 0, error: null },
    relayer: { ...sender, lastPushAt: 990, lastPushBlockTime: 1, sequencerUp: true, markets: { TSLA: 'pushed' } },
    keeper: { ...sender, lastRunAt: 995, liquidations: 1, forcedExits: 0, fundingAdvances: 2, coverPayouts: 0 },
  };
  it('round-trips and refuses malformed, future-dated or oversized values', () => {
    expect(parseOnchainStatus(JSON.stringify(status), 2000)).toEqual(status);
    expect(parseOnchainStatus(JSON.stringify({ ...status, at: 100_000 }), 2000)).toBeNull();
    expect(parseOnchainStatus(JSON.stringify({ ...status, v: 2 }), 2000)).toBeNull();
    expect(parseOnchainStatus(JSON.stringify({ ...status, relayer: { ...status.relayer, balanceLow: 'no' } }), 2000)).toBeNull();
    expect(parseOnchainStatus(JSON.stringify({ ...status, keeper: { ...status.keeper, liquidations: '1' } }), 2000)).toBeNull();
    expect(parseOnchainStatus('x'.repeat(20_000), 2000)).toBeNull();
    expect(parseOnchainStatus('{', 2000)).toBeNull();
  });
});
