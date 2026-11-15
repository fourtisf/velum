import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { describe, expect, it } from 'vitest';
import { abis } from './chain';
import { describeError, errorText, revertName, throttledWarn } from './errors';

describe('error helpers', () => {
  it('names a decoded contract revert with its arguments', () => {
    const data = encodeErrorResult({ abi: abis.perpsMarkets, errorName: 'NotLiquidatable', args: [7n] });
    const err = new BaseError('call failed', { cause: new ContractFunctionRevertedError({ abi: abis.perpsMarkets, data, functionName: 'liquidate' }) });
    expect(describeError(err)).toBe('NotLiquidatable(7)');
    expect(revertName(err)).toBe('NotLiquidatable');
    expect(revertName(new Error('x'))).toBeNull();
  });

  it('redacts URLs, keeps one line, bounds the length', () => {
    const msg = describeError(new Error('request to https://user:pw@rpc.example.com/v2/SECRETKEY failed\nstack…'));
    expect(msg).toBe('request to https://rpc.example.com/… failed');
    expect(describeError('x'.repeat(1000))).toHaveLength(300);
  });

  it('throttles a repeated warning to once per interval and counts what it held back', () => {
    const out: Array<[string, Record<string, unknown> | undefined]> = [];
    let t = 0;
    const warn = throttledWarn({ warn: (m, d) => out.push([m, d]) }, 60_000, () => t);
    warn('indexer tick failed', { err: 'RPC down' });
    t = 1000;
    warn('indexer tick failed', { err: 'RPC down' });
    warn('other', {});
    t = 61_000;
    warn('indexer tick failed', { err: 'RPC down' });
    expect(out).toEqual([
      ['indexer tick failed', { err: 'RPC down' }],
      ['other', {}],
      ['indexer tick failed', { err: 'RPC down', repeated: 1 }],
    ]);
  });

  it('collects the cause chain for matching node errors', () => {
    const err = new Error('send failed', { cause: Object.assign(new Error('rpc error'), { details: 'nonce too low: next nonce 3' }) });
    expect(errorText(err)).toContain('nonce too low');
  });
});
