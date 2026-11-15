/**
 * Settings of the signer process (velum-signer, on-chain audit M-2). On the server they come from <base>/signer.env,
 * which root renders from .env on every release with only the signer's own, non-secret settings (no DATABASE_URL, no
 * REDIS_URL, no PROXY_SECRET: the signer needs no Postgres and no Redis), plus the paths below. The hot keys are never
 * settings: the signer reads them from SIGNER_KEYS_FILE itself (files.ts), so they reach neither its environment nor
 * PM2's process list.
 *
 *  SIGNER_KEYS_FILE        the hot keys (default /etc/velum/signer-keys.env, root:<signer group> 640)
 *  SIGNER_STATUS_FILE      the status for /v1/health (default /run/velum-signer/status.json)
 *  SIGNER_STATE_DIR        small state in the signer's own home (default $HOME/state, 0700)
 *  SIGNER_DEPLOYMENTS_DIR  the deployment files (default contracts/deployments of the tree the signer runs from, which
 *                          is its own copy of the release: never the app user's files)
 * Test-only, honoured on the local anvil chain (31337) and refused anywhere else: SIGNER_TEST_PRICES_URL,
 * SIGNER_TEST_ASSETS_URL (a fake Robinhood API) and SIGNER_TEST_CLOCK_OFFSET_MS (the price and session clock).
 */
import os from 'node:os';
import path from 'node:path';
import { CHAIN, NETWORK, type NetworkName } from '@velum/config';
import { defaultDeploymentsDir } from '@velum/config/src/deployment-file';
import { ANVIL_CHAIN_ID, SIGNER_HOT_KEYS, SIGNER_KEYS_FILE_DEFAULT, SIGNER_STATUS_FILE_DEFAULT } from '@velum/config/src/onchain';
import { redactUrls } from '../lib/redact';
import { loadOnchainEnv, type OnchainEnv } from '../onchain/env';

export interface SignerEnv {
  chainId: number;
  network: NetworkName;
  rpcUrl: string;
  /** The shared on-chain settings (ONCHAIN_WORKERS, ONCHAIN_MAINNET_CONFIRMED, cadences, fee ceilings, RPC_URL_SEND, ...). */
  onchain: OnchainEnv;
  keysFile: string;
  statusFile: string;
  stateDir: string;
  deploymentsDir: string;
  /** Hot keys found in the environment (ignored: they belong in SIGNER_KEYS_FILE). Names only. */
  envKeys: string[];
  test: { pricesUrl: string | null; assetsUrl: string | null; clockOffsetMs: number };
}

const ABS = /^\/[A-Za-z0-9._/-]{1,250}$/;

/** Reads and validates the signer's settings. Never throws: `error` lists every problem (variable names, never values). */
export function loadSignerEnv(e: NodeJS.ProcessEnv = process.env): { env: SignerEnv | null; error: string | null; statusFile: string } {
  const problems: string[] = [];
  const statusRaw = (e.SIGNER_STATUS_FILE ?? '').trim();
  const statusFile = statusRaw && ABS.test(statusRaw) ? statusRaw : SIGNER_STATUS_FILE_DEFAULT;
  if (statusRaw && !ABS.test(statusRaw)) problems.push('SIGNER_STATUS_FILE must be an absolute path of plain characters.');

  let onchain: OnchainEnv | null = null;
  try {
    onchain = loadOnchainEnv(e);
  } catch (err) {
    problems.push(...String(err instanceof Error ? err.message : err).split('\n').slice(1).map((l) => l.replace(/^\s*-\s*/, '')));
  }

  const rawChain = (e.CHAIN_ID ?? '').trim();
  const chainId = rawChain === '' ? CHAIN.id : Number(rawChain);
  if (!Number.isSafeInteger(chainId) || chainId < 1) problems.push(`CHAIN_ID must be a positive integer (got "${rawChain}").`);
  else if (chainId !== CHAIN.id && chainId !== ANVIL_CHAIN_ID) {
    problems.push(`CHAIN_ID ${chainId} does not match VELUM_NETWORK=${NETWORK} (${CHAIN.label}, chain ${CHAIN.id}). Set VELUM_NETWORK and CHAIN_ID together (deploy/set-network.sh does both).`);
  }
  const network: NetworkName = (e.VELUM_NETWORK ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : NETWORK;
  const rpcUrl = e.RPC_URL && !e.RPC_URL.startsWith('VERIFY') ? e.RPC_URL : CHAIN.rpcUrl;
  if (!/^https?:\/\/\S+$/.test(rpcUrl)) problems.push('RPC_URL must be an http(s) URL.');
  const otherNet = NETWORK === 'mainnet' ? 'rpc.testnet.chain.robinhood.com' : 'rpc.mainnet.chain.robinhood.com';
  if (rpcUrl.includes(otherNet)) problems.push(`RPC_URL points at the other network (${redactUrls(rpcUrl)}) but VELUM_NETWORK=${NETWORK}.`);

  const pathSetting = (name: string, dflt: string): string => {
    const v = (e[name] ?? '').trim();
    if (!v) return dflt;
    if (!ABS.test(v) || v.split('/').includes('..')) {
      problems.push(`${name} must be an absolute path of plain characters (letters, digits, . _ - /).`);
      return dflt;
    }
    return v;
  };
  const home = (e.HOME ?? '').trim() || os.homedir();
  const keysFile = pathSetting('SIGNER_KEYS_FILE', SIGNER_KEYS_FILE_DEFAULT);
  const stateDir = pathSetting('SIGNER_STATE_DIR', path.join(home, 'state'));
  const deploymentsDir = pathSetting('SIGNER_DEPLOYMENTS_DIR', defaultDeploymentsDir());

  // Test-only settings: a fake quote API and a shifted clock make sense only on the local anvil chain.
  const testPrices = (e.SIGNER_TEST_PRICES_URL ?? '').trim();
  const testAssets = (e.SIGNER_TEST_ASSETS_URL ?? '').trim();
  const testOffset = (e.SIGNER_TEST_CLOCK_OFFSET_MS ?? '').trim();
  const anyTest = testPrices || testAssets || testOffset;
  if (anyTest && chainId !== ANVIL_CHAIN_ID) problems.push(`SIGNER_TEST_* settings are refused on chain ${chainId}: they exist only for the local anvil test chain (${ANVIL_CHAIN_ID}).`);
  for (const [name, v] of [['SIGNER_TEST_PRICES_URL', testPrices], ['SIGNER_TEST_ASSETS_URL', testAssets]] as const) {
    if (v && !/^http:\/\/127\.0\.0\.1:\d{1,5}(\/\S*)?$/.test(v)) problems.push(`${name} must be an http://127.0.0.1:<port> URL.`);
  }
  const offset = testOffset ? Number(testOffset) : 0;
  if (!Number.isSafeInteger(offset)) problems.push('SIGNER_TEST_CLOCK_OFFSET_MS must be an integer.');

  const envKeys = SIGNER_HOT_KEYS.filter((k) => (e[k] ?? '').trim() !== '');
  if (problems.length || !onchain) return { env: null, error: `Invalid signer settings:\n  - ${problems.join('\n  - ')}`, statusFile };
  return {
    env: {
      chainId,
      network,
      rpcUrl,
      onchain,
      keysFile,
      statusFile,
      stateDir,
      deploymentsDir,
      envKeys,
      test: { pricesUrl: testPrices || null, assetsUrl: testAssets || null, clockOffsetMs: offset },
    },
    error: null,
    statusFile,
  };
}
