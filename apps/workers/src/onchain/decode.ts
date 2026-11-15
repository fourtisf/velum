/**
 * Turns contract logs into JSON-safe events: integers as decimal strings, addresses in lower case. A log no
 * known ABI decodes (a newer contract version's extra event, a contract the deployment file adds later) is
 * kept as "unknown:<topic0>" with its raw topics and data: stored, never an error.
 */
import { REQUIRED_CONTRACTS, type Deployment, type LowerAddress } from '@velum/config/src/onchain';
import { decodeEventLog, type Abi, type Hex } from 'viem';
import { abis } from './chain';

export type JsonArg = string | boolean | JsonArg[];
export type JsonArgs = Record<string, JsonArg>;

export interface RawLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

/** One decoded (or unknown) log with its position in the chain. */
export interface ChainLogEvent {
  /** Emitting contract, lower case. */
  address: LowerAddress;
  /** Deployment name of the emitting contract ("perpsMarkets", ...), or "other". */
  contract: string;
  /** Event name, or "unknown:<topic0>". */
  kind: string;
  known: boolean;
  args: JsonArgs;
  block: bigint;
  blockHash: Hex;
  logIndex: number;
  txHash: Hex;
  at: Date;
}

const ABI_BY_CONTRACT: Record<string, Abi> = {
  vault: abis.vault,
  oracle: abis.oracle,
  spotPools: abis.spotPools,
  makerBook: abis.makerBook,
  perpsMarkets: abis.perpsMarkets,
};

/** Address -> deployment contract name, for every contract the file names (extra ones included). */
export function contractNames(d: Deployment): Map<LowerAddress, string> {
  return new Map(Object.entries(d.contracts).map(([name, addr]) => [addr, name]));
}

/** Every address the indexer reads logs from: the core contracts and any extra contract the file names. */
export const indexedAddresses = (d: Deployment): LowerAddress[] => [...new Set(Object.values(d.contracts))];

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function toJsonArg(v: unknown): JsonArg {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return ADDR.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(toJsonArg);
  return String(v);
}

export function decodeLog(log: RawLog, names: Map<LowerAddress, string>, at: Date): ChainLogEvent {
  const address = log.address.toLowerCase() as LowerAddress;
  const contract = names.get(address) ?? 'other';
  const base = { address, contract, block: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, txHash: log.transactionHash, at };
  const abi = ABI_BY_CONTRACT[contract];
  if (abi && log.topics.length > 0) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }) as { eventName?: string; args?: unknown };
      const args: JsonArgs = {};
      for (const [k, v] of Object.entries((ev.args ?? {}) as Record<string, unknown>)) args[k] = toJsonArg(v);
      if (ev.eventName) return { ...base, kind: ev.eventName, known: true, args };
    } catch {
      /* unknown to this ABI version: kept raw below */
    }
  }
  return { ...base, kind: `unknown:${log.topics[0] ?? 'none'}`, known: false, args: { topics: log.topics.map((t) => t.toLowerCase()), data: log.data.toLowerCase() } };
}

/** Core contract names, for tests. */
export const CORE = REQUIRED_CONTRACTS;
