/**
 * Mainnet-fork end-to-end run of the whole Velum stack (the owner's substitute for testnet), driven by fork-e2e.sh:
 * anvil forks Robinhood Chain mainnet (read-only public RPC) with chain id 31337, the contracts are deployed GUARDED
 * against the REAL USDG and Stock Token contracts, throwaway wallets get real-token balances on the fork by
 * impersonating existing holders, and then the real API + indexer (in-process, as apps/web/e2e/stack.ts wires them)
 * and the separate signer process (`node dist/signer.js`: relayer + keeper, own keys file, no Postgres, no Redis)
 * run against the fork with a replayed Robinhood quote feed (apps/workers/e2e/fork/quotes-*.json, served on
 * 127.0.0.1 through the signer's anvil-only SIGNER_TEST_* settings).
 *
 * Time matters at the start: the public RPC serves state for only ~10-15 minutes back, and anvil fetches state
 * lazily. So the first phase ("warm-up") touches every real-token storage slot the run will ever need (holders ->
 * wallets, approvals, deposits and withdrawals through the vault, reads of every token for every account) within a
 * few minutes of the fork's start; later flows only touch cached slots and Velum's own (local) contracts.
 *
 * Nothing here signs for the real chain: every key is a throwaway generated for this run (keys.json), every RPC is
 * the local anvil fork. The report (FORK_OUT) lists every flow with its fork tx hashes and gas.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const root = path.resolve(__dirname, '../../../..');
const fromApi = createRequire(path.join(root, 'apps/api/package.json'));
const fromWorkers = createRequire(path.join(root, 'apps/workers/package.json'));

const RPC = process.env.FORK_RPC!;
const DIR = process.env.FORK_DEPLOYMENTS!;
const ARTIFACTS = process.env.FORK_ARTIFACTS!;
const KEYS = process.env.FORK_KEYS!;
const OUT = process.env.FORK_OUT!;
const QUOTES = process.env.FORK_QUOTES!;
const SCRATCH = process.env.FORK_SCRATCH!;
const DB = process.env.DATABASE_URL!;
const REDIS = process.env.REDIS_URL!;
const API_PORT = Number(process.env.FORK_API_PORT ?? 4891);
const HOLD = process.env.FORK_HOLD === '1';
const SIGNER_JS = path.join(root, 'apps/workers/dist/signer.js');
const CHAIN_ID = 31337;
const E6 = 1_000_000n;
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
// Monday 2026-11-16 10:00 US Eastern: the session calendar is open on the signer's injected clock.
const OPEN = Date.UTC(2026, 10, 16, 15, 0, 0);
const t0 = Date.now();
const clock = () => OPEN + (Date.now() - t0);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

/** Existing mainnet holders impersonated on the fork only (found read-only from recent Transfer logs). */
const HOLDERS: Record<string, Address[]> = {
  USDG: ['0x51c72848c68a965f66fa7a88855f9f7784502a7f', '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', '0x7615926023bb149f36095645c2a81dc367d39750'],
  TSLA: ['0x8366a39cc670b4001a1121b8f6a443a643e40951', '0xcb4d2ebf88de5235723be83ef96ccc24af2df473'],
  NVDA: ['0x62ab521f71431f78ac374cdbadc6cda3c8916b6c', '0xc33acc93942105c57602e59e8e448c20ba718a85', '0xa1513da56f71b83d98124d645828a14a191b8010'],
};

type Role = 'deployer' | 'relayer' | 'keeper' | 'admin' | 'guardian' | 'maker' | 'takerA' | 'takerC' | 'outsider' | 'web';
const keys = JSON.parse(readFileSync(KEYS, 'utf8')) as Record<Role, { address: Address; privateKey: Hex }>;
const addr = (r: Role) => keys[r].address;

const chain = { ...foundry, id: CHAIN_ID, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) }) as PublicClient;
const wallets = new Map<string, ReturnType<typeof createWalletClient>>();
const walletOf = (who: Role | Address) => {
  const k = typeof who === 'string' && who.startsWith('0x') ? who : who;
  if (!wallets.has(k)) {
    const account = (k as string).startsWith('0x') ? (k as Address) : privateKeyToAccount(keys[k as Role].privateKey);
    wallets.set(k, createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000 }) }));
  }
  return wallets.get(k)!;
};

// ---------------------------------------------------------------- ABIs from the forge artifacts
const artifact = (name: string) => JSON.parse(readFileSync(path.join(ARTIFACTS, `${name}.sol`, `${name}.json`), 'utf8')).abi as Abi;
const ERRORS = ['VelumVault', 'OracleAdapter', 'SpotPools', 'MakerBook', 'PerpsMarkets'].flatMap((n) => artifact(n).filter((x) => x.type === 'error'));
const withErrors = (abi: Abi): Abi => [...abi, ...ERRORS.filter((e) => !abi.some((x) => x.type === 'error' && 'name' in x && 'name' in e && x.name === e.name))];
const A = {
  vault: withErrors(artifact('VelumVault')),
  oracle: withErrors(artifact('OracleAdapter')),
  pools: withErrors(artifact('SpotPools')),
  book: withErrors(artifact('MakerBook')),
  perps: withErrors(artifact('PerpsMarkets')),
};
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function uiMultiplier() view returns (uint256)',
]);

// ---------------------------------------------------------------- report
interface Step {
  flow: string;
  label: string;
  ok: boolean;
  tx?: Hex;
  gasUsed?: string;
  note?: string;
}
const report: Record<string, unknown> & { steps: Step[]; quirks: string[]; checks: Record<string, unknown> } = { startedAt: new Date(t0).toISOString(), steps: [], quirks: [], checks: {} };
let flow = 'setup';
const save = () => writeFileSync(OUT, JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
const log = (...a: unknown[]) => console.log(`[fork +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
function check(label: string, cond: boolean, note?: string): void {
  report.steps.push({ flow, label, ok: cond, note });
  if (!cond) {
    save();
    throw new Error(`check failed: ${flow} / ${label}${note ? ` (${note})` : ''}`);
  }
  log('ok', label, note ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last).slice(0, 300)})` : ''}`);
}
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** The custom error name a simulated call reverts with, or null when it succeeds. */
async function revertOf(from: Role | Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): Promise<string | null> {
  const account = typeof from === 'string' && from.startsWith('0x') ? (from as Address) : addr(from as Role);
  try {
    await pub.simulateContract({ account, address, abi, functionName, args, value } as never);
    return null;
  } catch (err) {
    if (err instanceof BaseError) {
      const r = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (r) return r.data?.errorName ?? r.reason ?? r.signature ?? 'revert';
    }
    return `error: ${String(err).split('\n')[0]}`;
  }
}

/** Sends a transaction (simulated first: a revert throws with the error name), waits for it, records it. */
async function send(label: string, from: Role | Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): Promise<{ hash: Hex; gasUsed: bigint; logs: { address: Address; topics: Hex[]; data: Hex }[]; block: bigint }> {
  const w = walletOf(from);
  const why = await revertOf(from, address, abi, functionName, args, value);
  if (why) throw new Error(`${label}: reverts with ${why}`);
  const hash = await w.writeContract({ address, abi, functionName, args, value, chain, account: w.account! } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`${label}: transaction ${hash} reverted`);
  report.steps.push({ flow, label, ok: true, tx: hash, gasUsed: r.gasUsed.toString() });
  log('tx', label, hash, `gas ${r.gasUsed}`);
  return { hash, gasUsed: r.gasUsed, logs: r.logs as never, block: r.blockNumber };
}

/** The call must be refused with `error` (checked by simulation: nothing is sent). */
async function refused(label: string, from: Role | Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[], error: string, value = 0n): Promise<void> {
  const why = await revertOf(from, address, abi, functionName, args, value);
  check(label, why === error, `refused with ${why}`);
}

/** Retries a send while it reverts with one of `retryOn` (a fresh, non-lagging price is about to land). */
async function sendWhenPriced(label: string, from: Role, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n, retryOn = ['StalePrice', 'PriceLagging']) {
  return waitFor(label, async () => {
    const why = await revertOf(from, address, abi, functionName, args, value);
    if (why && retryOn.includes(why)) return null;
    return send(label, from, address, abi, functionName, args, value);
  }, 120_000, 400);
}

function events(logs: { address: Address; topics: Hex[]; data: Hex }[], abi: Abi, name: string) {
  const out: Record<string, unknown>[] = [];
  for (const l of logs) {
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (e.eventName === name) out.push(e.args as unknown as Record<string, unknown>);
    } catch {
      /* another contract's event */
    }
  }
  return out;
}

// ---------------------------------------------------------------- replayed Robinhood quotes
interface Recorded {
  recordedAt: string;
  quotes: Record<string, { bid: string; ask: string; tokenBid?: string; tokenAsk?: string }>;
  multipliers: Record<string, string>;
}
const recorded = JSON.parse(readFileSync(QUOTES, 'utf8')) as Recorded;
const SYMS = ['TSLA', 'AMZN', 'PLTR', 'NVDA', 'NFLX', 'AMD', 'AAPL', 'META', 'MSFT', 'COIN'];
/** Served with the documented raw bid/ask only: the signer must apply currentMultiplier from /assets itself. */
const RAW_ONLY = new Set(['NVDA', 'META']);
const toWad = (s: string): bigint => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * E18 + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
const fromWad = (v: bigint, dp = 18): string => {
  const w = v / E18;
  const f = (v % E18).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
};
/** Underlying (share) mid per symbol, as a wad: the recorded quote's raw mid, then moved by the run. */
const mid: Record<string, bigint> = {};
for (const s of SYMS) {
  const q = recorded.quotes[s]!;
  mid[s] = (toWad(q.bid) + toWad(q.ask)) / 2n;
  mid[s] = (mid[s]! / 10n ** 14n) * 10n ** 14n; // 4 decimals
}
const frozen = new Set<string>();
let tick = 0;
/** The quote served for `s` now: a 2 bps spread around the mid; tokenBid/tokenAsk = raw x multiplier unless RAW_ONLY. */
function quote(s: string) {
  const m = mid[s]!;
  const half = m / 10_000n; // 1 bp each side
  const bid = m - half;
  const ask = m + half;
  const mult = toWad(recorded.multipliers[s]!);
  const q: Record<string, unknown> = {
    tokenSymbol: s,
    deployments: [{ chainId: 4663, contractAddress: TOKENS_BY_SYMBOL[s] }],
    bid: fromWad(bid, 6),
    ask: fromWad(ask, 6),
    isTradingHalt: false,
    generatedAt: new Date(clock()).toISOString(),
  };
  if (!RAW_ONLY.has(s)) {
    q.tokenBid = fromWad((toWad(fromWad(bid, 6)) * mult) / E18);
    q.tokenAsk = fromWad((toWad(fromWad(ask, 6)) * mult + E18 - 1n) / E18);
  }
  return q;
}
/** What the signer must push for the quote served now (rhTokenBidAsk + rhMid, written independently here). */
function expectedTokenPrice(s: string): bigint {
  const q = quote(s) as { bid: string; ask: string; tokenBid?: string; tokenAsk?: string };
  const mult = toWad(recorded.multipliers[s]!);
  const [b, a] = q.tokenBid ? [toWad(q.tokenBid), toWad(q.tokenAsk!)] : [(toWad(q.bid) * mult) / E18, (toWad(q.ask) * mult + E18 - 1n) / E18];
  const m = (b + a) / 2n;
  return (m / 10n ** 14n) * 10n ** 14n;
}
let TOKENS_BY_SYMBOL: Record<string, Address> = {};
let quoteServer: Server | undefined;
function startQuotes(): Promise<number> {
  quoteServer = createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (url.startsWith('/assets')) {
      res.end(JSON.stringify({ assets: SYMS.map((s) => ({ tokenSymbol: s, deployments: [{ chainId: 4663, contractAddress: TOKENS_BY_SYMBOL[s] }], currentMultiplier: recorded.multipliers[s], pendingMultiplier: '' })) }));
      return;
    }
    const sym = decodeURIComponent(url.split('/').pop() ?? '');
    if (!url.startsWith('/prices/') || !SYMS.includes(sym)) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ quotes: [quote(sym)] }));
  });
  return new Promise((resolve) => quoteServer!.listen(0, '127.0.0.1', () => resolve((quoteServer!.address() as { port: number }).port)));
}
// A small deterministic walk every 2 s (the signer confirms a quote only after it has seen it change, audit F-6).
let walkTimer: NodeJS.Timeout | undefined;
function startWalk(): void {
  walkTimer = setInterval(() => {
    tick++;
    for (const [i, s] of SYMS.entries()) {
      if (frozen.has(s)) continue;
      const dir = ((tick * 7 + i * 3) % 5) - 2; // -2..2
      mid[s] = mid[s]! + (BigInt(dir) * mid[s]!) / 100_000n; // up to 0.002% a step
      mid[s] = (mid[s]! / 10n ** 14n) * 10n ** 14n;
    }
  }, 2000);
}

// ---------------------------------------------------------------- the run
async function main() {
  const { readDeploymentFile } = fromWorkers('@velum/config/src/deployment-file') as typeof import('../../../../packages/config/src/deployment-file');
  const read = readDeploymentFile(DIR, CHAIN_ID);
  if (read.status !== 'ok') throw new Error(`deployment file: ${read.status}`);
  const d = read.deployment;
  const raw = JSON.parse(readFileSync(path.join(DIR, `${CHAIN_ID}.json`), "utf8")) as { guardAdmin?: string; guardian?: string; priceRelayer?: string; startBlock: number };
  const START = BigInt(raw.startBlock);
  // Every listed symbol is in the deployment (checked below), so the token map is total for the run's symbols.
  const T = d.tokens as Record<string, Address> & Record<'USDG' | 'TSLA' | 'NVDA', Address>;
  TOKENS_BY_SYMBOL = T;
  const { vault, oracle, spotPools: pools, makerBook: book, perpsMarkets: perps } = d.contracts as Record<'vault' | 'oracle' | 'spotPools' | 'makerBook' | 'perpsMarkets', Address>;
  report.deployment = d;
  report.fork = { rpc: 'anvil (local fork of rpc.mainnet.chain.robinhood.com)', block: process.env.FORK_BLOCK, chainIdOverride: CHAIN_ID };
  check('deployment is guarded with the expected admin, relayer and guardian', raw.guardAdmin?.toLowerCase() === addr('admin').toLowerCase() && raw.priceRelayer?.toLowerCase() === addr('relayer').toLowerCase() && raw.guardian?.toLowerCase() === addr('guardian').toLowerCase());
  for (const s of ['USDG', ...SYMS]) check(`${s} is the real mainnet token`, T[s]!.toLowerCase() === (fromWorkers('@velum/config') as { MAINNET_TOKEN_ADDRESSES: Record<string, string> }).MAINNET_TOKEN_ADDRESSES[s]!.toLowerCase());

  // ==================== warm-up (time-critical: the RPC serves fork state for only ~10-15 minutes)
  flow = 'warm-up and funding';
  const roles = Object.keys(keys) as Role[];
  for (const r of roles) await rpc('anvil_setBalance', [addr(r), '0x' + (100n * E18).toString(16)]);
  check('Multicall3 has code on the fork (the web reads balances through it)', ((await pub.getCode({ address: MULTICALL3 })) ?? '0x').length > 2);
  const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
  const want: Record<string, Partial<Record<Role, bigint>>> = {
    USDG: { maker: 75_000n * E6, takerA: 12_000n * E6, takerC: 12_000n * E6, outsider: 1_000n * E6, keeper: 1n * E6, web: 5_000n * E6 },
    TSLA: { maker: 45n * E18, takerA: 3n * E18, takerC: 1n * E18, outsider: 1n * E18, web: 1n * E18 },
    NVDA: { maker: 65n * E18, takerA: 2n * E18, takerC: 1n * E18, outsider: 1n * E18, web: 1n * E18 },
  };
  for (const [sym, plan] of Object.entries(want)) {
    const total = Object.values(plan).reduce((a, b) => a + b!, 0n);
    let holder: Address | null = null;
    for (const h of HOLDERS[sym]!) if ((await bal(T[sym]!, h)) >= total) holder = h;
    check(`a ${sym} holder with ${sym === 'USDG' ? fromWad(total * 10n ** 12n) : fromWad(total)} found on the fork`, holder !== null, holder ?? 'none');
    await rpc('anvil_impersonateAccount', [holder]);
    await rpc('anvil_setBalance', [holder, '0x' + (10n * E18).toString(16)]);
    for (const [r, amount] of Object.entries(plan)) await send(`${sym} holder -> ${r} (impersonated, fork only)`, holder!, T[sym]!, ERC20 as Abi, 'transfer', [addr(r as Role), amount]);
    await rpc('anvil_stopImpersonatingAccount', [holder]);
  }
  for (const r of ['maker', 'takerA', 'takerC', 'outsider', 'web'] as Role[]) {
    for (const sym of ['USDG', 'TSLA', 'NVDA']) await send(`${r} approves the vault for ${sym}`, r, T[sym]!, ERC20 as Abi, 'approve', [vault, MAX]);
  }
  // Every read of every listed token for every account the run uses (cached by anvil from now on).
  const everyone = [...roles.map(addr), vault, pools, book, perps, oracle];
  for (const s of ['USDG', ...SYMS]) {
    await Promise.all([
      pub.readContract({ address: T[s]!, abi: ERC20, functionName: 'symbol' }),
      pub.readContract({ address: T[s]!, abi: ERC20, functionName: 'decimals' }),
      ...everyone.map((a) => bal(T[s]!, a)),
      ...everyone.map((a) => pub.readContract({ address: T[s]!, abi: ERC20, functionName: 'allowance', args: [a, vault] })),
    ]);
  }
  const uiMult: Record<string, string> = {};
  for (const s of SYMS) uiMult[s] = fromWad((await pub.readContract({ address: T[s]!, abi: ERC20, functionName: 'uiMultiplier' })) as bigint);
  report.checks.uiMultiplierOnChain = uiMult;
  for (const s of SYMS) check(`${s} uiMultiplier on chain equals the quote API's currentMultiplier (${recorded.multipliers[s]})`, toWad(uiMult[s]!) === toWad(recorded.multipliers[s]!));

  // ==================== flow 1: the launch guard (also warms every vault <-> wallet transfer path)
  flow = '1 launch guard: allowlist, caps, refusals';
  check('vault is guarded, allowlist and caps active, nobody allowlisted', (await pub.readContract({ address: vault, abi: A.vault, functionName: 'guarded' })) === true && (await pub.readContract({ address: vault, abi: A.vault, functionName: 'allowlistedCount' })) === 0n);
  await refused('non-allowlisted wallet: deposit refused', 'outsider', vault, A.vault, 'deposit', [T.USDG, 100n * E6, addr('outsider')], 'NotAllowlisted');
  await refused('non-allowlisted wallet: module approval refused', 'outsider', vault, A.vault, 'setApproval', [perps, true], 'NotAllowlisted');
  await refused('only the guard admin can allowlist', 'maker', vault, A.vault, 'addToAllowlist', [[addr('maker')]], 'NotGuardAdmin');
  await send('guard admin allowlists 2 wallets (maker, takerA)', 'admin', vault, A.vault, 'addToAllowlist', [[addr('maker'), addr('takerA')]]);
  await refused('a third wallet is refused while the global caps leave room for 2 (G-01)', 'admin', vault, A.vault, 'addToAllowlist', [[addr('takerC')]], 'Oversubscribed');
  await send('maker deposits 60,000 USDG (real USDG transferFrom)', 'maker', vault, A.vault, 'deposit', [T.USDG, 60_000n * E6, addr('maker')]);
  await refused('maker deposit over the 60,000 USDG account cap refused', 'maker', vault, A.vault, 'deposit', [T.USDG, 1n * E6, addr('maker')], 'AccountCapExceeded');
  await send('maker deposits 40 TSLA', 'maker', vault, A.vault, 'deposit', [T.TSLA, 40n * E18, addr('maker')]);
  await send('maker deposits 60 NVDA', 'maker', vault, A.vault, 'deposit', [T.NVDA, 60n * E18, addr('maker')]);
  await send('takerA deposits 6,000 USDG', 'takerA', vault, A.vault, 'deposit', [T.USDG, 6_000n * E6, addr('takerA')]);
  await send('takerA deposits 2 TSLA', 'takerA', vault, A.vault, 'deposit', [T.TSLA, 2n * E18, addr('takerA')]);
  await send('takerA withdraws 100 USDG while the guard is on', 'takerA', vault, A.vault, 'withdraw', [T.USDG, 100n * E6, addr('takerA')]);
  await send('takerA withdraws 1 TSLA', 'takerA', vault, A.vault, 'withdraw', [T.TSLA, 1n * E18, addr('takerA')]);
  await send('maker withdraws 1 NVDA', 'maker', vault, A.vault, 'withdraw', [T.NVDA, 1n * E18, addr('maker')]);
  check('vault holds exactly what was deposited (USDG)', (await bal(T.USDG!, vault)) === 65_900n * E6);
  check('depositLimit shows takerA its own remaining room', (await pub.readContract({ address: vault, abi: A.vault, functionName: 'depositLimit', args: [addr('takerA'), T.USDG] })) === 54_100n * E6);
  const dump = await rpc<string>('anvil_dumpState');
  writeFileSync(path.join(SCRATCH, 'fork-state-after-warmup.hex'), dump);
  report.warmupSeconds = Math.round((Date.now() - t0) / 1000);
  log(`warm-up done in ${report.warmupSeconds}s`);
  writeFileSync(path.join(SCRATCH, 'warmup.done'), String(Date.now()));
  save();

  // ==================== services: API + indexer (in-process), price snapshots, quotes, the signer process
  flow = 'services';
  const { buildApp } = fromApi('./src/app') as typeof import('../../../api/src/app');
  const { loadEnv } = fromApi('./src/env') as typeof import('../../../api/src/env');
  const { prismaDb, redisCache, viemChain, fileSigner } = fromApi('./src/lib/adapters') as typeof import('../../../api/src/lib/adapters');
  const { deploymentSource, prismaOnchain } = fromApi('./src/lib/onchain') as typeof import('../../../api/src/lib/onchain');
  const { createCacheMac } = fromApi('@velum/config/src/cache-mac') as typeof import('../../../../packages/config/src/cache-mac');
  const cfg = fromApi('@velum/config') as typeof import('../../../../packages/config/src/index');
  const { PrismaClient } = fromApi('@velum/db') as typeof import('@velum/db');
  const { Redis } = fromApi('ioredis') as typeof import('ioredis');
  const conn = cfg.parseRedisUrl(REDIS);
  if (!conn.ok) throw new Error(conn.error);
  const signerHome = path.join(SCRATCH, 'signer-home');
  mkdirSync(path.join(signerHome, 'run'), { recursive: true });
  chmodSync(signerHome, 0o700);
  const signerStatusFile = path.join(signerHome, 'run', 'status.json');
  const env = { ...loadEnv({ ...process.env, VELUM_NETWORK: 'testnet', CHAIN_ID: '', RPC_URL: RPC, DEPLOYMENTS_DIR: DIR, PORT_API: String(API_PORT), RATE_LIMIT_READ_PER_MIN: '5000', LOG_LEVEL: 'warn', SIGNER_STATUS_FILE: signerStatusFile }), chainId: CHAIN_ID };
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  const redis = new Redis({ ...conn.options, maxRetriesPerRequest: 1 });
  const mac = createCacheMac(DB, 'testnet');
  const app = await buildApp({ env, cache: redisCache(redis, { mac }), signer: fileSigner(signerStatusFile), db: prismaDb(prisma), chain: viemChain(RPC), deployment: deploymentSource(DIR, CHAIN_ID, 1000), onchain: prismaOnchain(prisma), rateLimitRedis: redis });
  await app.listen({ host: '127.0.0.1', port: API_PORT });
  const { startOnchain } = fromWorkers('./src/onchain/index') as typeof import('../../src/onchain/index');
  const { loadOnchainEnv } = fromWorkers('./src/onchain/env') as typeof import('../../src/onchain/env');
  const quiet = { debug: () => undefined, info: () => undefined, warn: (m: string, x?: object) => console.error('[indexer]', m, JSON.stringify(x ?? {})), error: (m: string, x?: object) => console.error('[indexer]', m, JSON.stringify(x ?? {})) };
  const bull = new Redis({ ...conn.options, maxRetriesPerRequest: null });
  const handle = await startOnchain({ env: loadOnchainEnv({ ONCHAIN_WORKERS: 'true', DEPLOYMENTS_DIR: DIR, CONFIRMATIONS: '1', INDEXER_POLL_MS: '500' }), chainId: CHAIN_ID, rpcUrl: RPC, prisma: prisma as never, redis: bull, mac, log: quiet });
  check('indexer started (workers process code, no hot key)', !!handle && handle.status().relayer.enabled === false && handle.status().keeper.enabled === false);
  const port = await startQuotes();
  startWalk();
  // The API's /v1/markets prices: the workers' own Robinhood source code (robinhoodSource) reading the same replayed
  // feed, sealed into Redis like price-relay does, so the UI's market prices follow the same path as production.
  const { robinhoodSource } = fromWorkers('./src/sources/robinhood') as typeof import('../../src/sources/robinhood');
  const rh = robinhoodSource(quiet as never, fetch, { pricesUrl: `http://127.0.0.1:${port}/prices`, assetsUrl: `http://127.0.0.1:${port}/assets` });
  const apiPrices: Record<string, string> = {};
  const writeSnapshots = async () => {
    const at = Date.now();
    const got = await rh.read(new Map(Object.entries(apiPrices)), clock());
    const pipe = redis.pipeline();
    for (const [symbol, price] of got) {
      apiPrices[symbol] = price;
      const snap = { symbol, price, mark: price, open24h: price, spark: [price], source: 'robinhood', updatedAt: at, checkedAt: at };
      pipe.set(cfg.cacheKeys.price(symbol), mac.seal(cfg.cacheKeys.price(symbol), JSON.stringify(snap)));
    }
    await pipe.exec();
  };
  const snapTimer = setInterval(() => void writeSnapshots().catch((e) => console.error('[snap]', String(e))), 2000);

  const keysFile = path.join(signerHome, 'signer-keys.env');
  writeFileSync(keysFile, `PRICE_RELAY_PRIVATE_KEY=${keys.relayer.privateKey}\nKEEPER_PRIVATE_KEY=${keys.keeper.privateKey}\n`, { mode: 0o600 });
  chmodSync(keysFile, 0o600);
  const signerOut: string[] = [];
  const signer: ChildProcess = spawn(process.execPath, ['--enable-source-maps', SIGNER_JS], {
    cwd: path.dirname(path.dirname(SIGNER_JS)),
    env: {
      PATH: process.env.PATH,
      HOME: signerHome,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: RPC,
      ONCHAIN_WORKERS: 'true',
      CONFIRMATIONS: '1',
      KEEPER_INTERVAL_MS: '1000',
      PRICE_PUSH_INTERVAL_MS: '8000',
      FUNDING_EPOCH_SECONDS: '60',
      RELAYER_MAX_GWEI: '1',
      KEEPER_ETH_PRICE_USD: '3000',
      SIGNER_KEYS_FILE: keysFile,
      SIGNER_STATUS_FILE: signerStatusFile,
      SIGNER_STATE_DIR: path.join(signerHome, 'state'),
      SIGNER_DEPLOYMENTS_DIR: DIR,
      SIGNER_TEST_PRICES_URL: `http://127.0.0.1:${port}/prices`,
      SIGNER_TEST_ASSETS_URL: `http://127.0.0.1:${port}/assets`,
      SIGNER_TEST_CLOCK_OFFSET_MS: String(OPEN - t0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [signer.stdout!, signer.stderr!]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      signerOut.push(chunk);
      for (const l of chunk.split('\n')) if (/"level":"(warn|error)"/.test(l)) process.stderr.write(`signer: ${l.slice(0, 400)}\n`);
    });
  }
  const { parseSignerStatus } = fromWorkers('@velum/config/src/onchain') as typeof import('../../../../packages/config/src/onchain');
  const status = () => parseSignerStatus(readFileSync(signerStatusFile, 'utf8'), Date.now());
  const relayed = async (s: string) => (await pub.readContract({ address: oracle, abi: A.oracle, functionName: 'relayed', args: [T[s]] })) as readonly [bigint, bigint, bigint];
  const latest = async (s: string) => (await pub.readContract({ address: oracle, abi: A.oracle, functionName: 'latest', args: [T[s]] })) as readonly [bigint, bigint];

  // ==================== flow 2: prices: replayed Robinhood quotes -> signer -> oracle, per token (uiMultiplier)
  flow = '2 prices per token: quote feed -> signer relayer -> oracle (uiMultiplier)';
  await waitFor('the signer pushed every market', async () => {
    for (const s of SYMS) if ((await relayed(s))[1] === 0n) return null;
    return true;
  }, 180_000, 1000);
  check('the signer relayer pushed all 10 markets (each quote confirmed by a change first)', true);
  // Freeze the feed, wait for a push of the frozen quotes, then compare exactly.
  for (const s of SYMS) frozen.add(s);
  const frozenAt = Date.now();
  await waitFor('a push of the frozen quotes', async () => {
    const st = status();
    return st && st.relayer.lastConfirmedAt && st.relayer.lastConfirmedAt > frozenAt + 3000 ? true : null;
  }, 60_000, 1000);
  await sleep(10_000);
  const priceRows: Record<string, unknown>[] = [];
  for (const s of SYMS) {
    const [p] = await relayed(s);
    const exp = expectedTokenPrice(s);
    const q = quote(s) as { bid: string; ask: string };
    priceRows.push({ symbol: s, underlyingMid: fromWad((toWad(q.bid) + toWad(q.ask)) / 2n), multiplier: recorded.multipliers[s], path: RAW_ONLY.has(s) ? 'bid/ask x currentMultiplier (/assets)' : 'tokenBid/tokenAsk', expectedTokenPrice: fromWad(exp), oracle: fromWad(p), api: apiPrices[s] ?? null });
    check(`${s}: oracle price = token price (underlying x ${recorded.multipliers[s]}) = ${fromWad(exp)}`, p === exp, `oracle ${fromWad(p)}`);
  }
  report.checks.prices = priceRows;
  for (const s of ['NVDA', 'AAPL', 'META', 'MSFT']) check(`${s} (multiplier ${recorded.multipliers[s]}) priced per token, not per share`, toWad(apiPrices[s] ?? '0') === expectedTokenPrice(s), `API ${apiPrices[s]}`);
  frozen.clear();

  // ==================== flow 3: spot pools: liquidity, swaps TSLA <-> USDG and TSLA -> NVDA (2 hops)
  flow = '3 spot: liquidity add, swaps (1 and 2 hops)';
  for (const m of [pools, book, perps]) await send(`maker approves module ${m === pools ? 'spotPools' : m === book ? 'makerBook' : 'perps'}`, 'maker', vault, A.vault, 'setApproval', [m, true]);
  for (const m of [pools, perps]) await send(`takerA approves module ${m === pools ? 'spotPools' : 'perps'}`, 'takerA', vault, A.vault, 'setApproval', [m, true]);
  const now = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp;
  const tslaPx = (await latest('TSLA'))[0];
  const nvdaPx = (await latest('NVDA'))[0];
  const usdgFor = (qty: bigint, px: bigint) => (qty * px) / E18 / 10n ** 12n;
  await send('maker adds TSLA/USDG liquidity (20 TSLA + value in USDG)', 'maker', pools, A.pools, 'addLiquidity', [T.TSLA, 20n * E18, usdgFor(20n * E18, tslaPx), 1n, (await now()) + 3600n]);
  await send('maker adds NVDA/USDG liquidity (40 NVDA + value in USDG)', 'maker', pools, A.pools, 'addLiquidity', [T.NVDA, 40n * E18, usdgFor(40n * E18, nvdaPx), 1n, (await now()) + 3600n]);
  const vbal = (who: Role, s: string) => pub.readContract({ address: vault, abi: A.vault, functionName: 'balanceOf', args: [addr(who), T[s]] }) as Promise<bigint>;
  const pool = async (s: string) => (await pub.readContract({ address: pools, abi: A.pools, functionName: 'pools', args: [T[s]] })) as readonly [bigint, bigint, bigint, boolean];
  const out1 = (amt: bigint, rIn: bigint, rOut: bigint) => {
    const inF = (amt * 9970n) / 10_000n;
    return (inF * rOut) / (rIn + inF);
  };
  {
    const [rS, rU] = await pool('TSLA');
    const expOut = out1(500n * E6, rU, rS);
    const before = await vbal('takerA', 'TSLA');
    await send('takerA swaps 500 USDG -> TSLA (1 hop, 0.30%)', 'takerA', pools, A.pools, 'swap', [T.USDG, T.TSLA, 500n * E6, (expOut * 995n) / 1000n, (await now()) + 600n]);
    check('USDG -> TSLA output = x*y=k with one 0.30% fee', (await vbal('takerA', 'TSLA')) - before === expOut, fromWad(expOut));
    const [rS2, rU2] = await pool('TSLA');
    const back = out1(expOut, rS2, rU2);
    const u0 = await vbal('takerA', 'USDG');
    await send('takerA swaps the TSLA back -> USDG', 'takerA', pools, A.pools, 'swap', [T.TSLA, T.USDG, expOut, (back * 995n) / 1000n, (await now()) + 600n]);
    check('TSLA -> USDG output exact; the round trip lost two fees', (await vbal('takerA', 'USDG')) - u0 === back && back < 500n * E6, `${Number(back) / 1e6} USDG back of 500`);
    const [tS, tU] = await pool('TSLA');
    const [nS, nU] = await pool('NVDA');
    const midU = out1(E18 / 2n, tS, tU);
    const exp2 = out1(midU, nU, nS);
    const quoted = (await pub.readContract({ address: pools, abi: A.pools, functionName: 'getAmountOut', args: [T.TSLA, T.NVDA, E18 / 2n] })) as bigint;
    const n0 = await vbal('takerA', 'NVDA');
    await send('takerA swaps 0.5 TSLA -> NVDA (2 hops through USDG, two fees)', 'takerA', pools, A.pools, 'swap', [T.TSLA, T.NVDA, E18 / 2n, (exp2 * 99n) / 100n, (await now()) + 600n]);
    check('TSLA -> NVDA = two hops, two 0.30% fees, equals getAmountOut', (await vbal('takerA', 'NVDA')) - n0 === exp2 && quoted === exp2, fromWad(exp2));
  }

  // ==================== flow 4: maker offers, guard raise + third wallet, perps both sides, margin add/remove
  flow = '4 maker offers, raiseCaps, perps both sides, margin';
  const expiry = (await now()) + 90n * 86_400n;
  const offerTsla = await send('maker posts a TSLA offer (10,000 USDG backing, 5,000 largest fill, 5/5 bps)', 'maker', book, A.book, 'postOffer', [T.TSLA, 10_000n * E6, 5_000n * E6, 5, 5, expiry]);
  const offerNvda = await send('maker posts an NVDA offer (10,000 USDG backing, 5,000 largest fill, 5/5 bps)', 'maker', book, A.book, 'postOffer', [T.NVDA, 10_000n * E6, 5_000n * E6, 5, 5, expiry]);
  const tslaOffer = events(offerTsla.logs, A.book, 'OfferPosted')[0]!.id as bigint;
  const nvdaOffer = events(offerNvda.logs, A.book, 'OfferPosted')[0]!.id as bigint;
  const caps = async (s: string) => [await pub.readContract({ address: vault, abi: A.vault, functionName: 'accountCap', args: [T[s]] }), await pub.readContract({ address: vault, abi: A.vault, functionName: 'globalCap', args: [T[s]] })] as [bigint, bigint];
  for (const s of ['USDG', ...SYMS]) {
    const [acc, glob] = await caps(s);
    await send(`guard admin raises the ${s} global cap for a third wallet`, 'admin', vault, A.vault, 'raiseCaps', [T[s], acc, glob + glob / 2n]);
  }
  await refused('a cap can never be lowered', 'admin', vault, A.vault, 'raiseCaps', [T.USDG, 1n, 1n], 'CapDecrease');
  await send('guard admin allowlists takerC (room for 3 now)', 'admin', vault, A.vault, 'addToAllowlist', [[addr('takerC')]]);
  await send('takerC deposits 6,000 USDG', 'takerC', vault, A.vault, 'deposit', [T.USDG, 6_000n * E6, addr('takerC')]);
  await send('takerC approves perps', 'takerC', vault, A.vault, 'setApproval', [perps, true]);
  const nextId = async () => (await pub.readContract({ address: perps, abi: A.perps, functionName: 'nextPositionId' })) as bigint;
  const pos = async (id: bigint) => (await pub.readContract({ address: perps, abi: A.perps, functionName: 'getPosition', args: [id] })) as { open: boolean; takerMargin: bigint; entry: bigint; qty: bigint };
  const limit = (px: bigint, long: boolean) => (long ? (px * 102n) / 100n : (px * 98n) / 100n);
  const id = await nextId();
  const longId = id;
  await sendWhenPriced('takerA opens LONG TSLA 1,000 USDG at 2x', 'takerA', perps, A.perps, 'open', [tslaOffer, T.TSLA, true, 1_000n * E6, 4, limit((await latest('TSLA'))[0], true)]);
  const shortId = await nextId();
  await sendWhenPriced('takerC opens SHORT NVDA 600 USDG at 3x', 'takerC', perps, A.perps, 'open', [nvdaOffer, T.NVDA, false, 600n * E6, 6, limit((await latest('NVDA'))[0], false)]);
  check('both positions open on chain', (await pos(longId)).open && (await pos(shortId)).open);
  const m0 = (await pos(longId)).takerMargin;
  await send('takerA adds 50 USDG margin', 'takerA', perps, A.perps, 'addMargin', [longId, 50n * E6]);
  await sendWhenPriced('takerA removes 50 USDG margin (needs a 10 s fresh price)', 'takerA', perps, A.perps, 'removeMargin', [longId, 50n * E6]);
  check('margin back where it was', (await pos(longId)).takerMargin === m0);
  await refused('removing margin below the initial margin is refused', 'takerA', perps, A.perps, 'removeMargin', [longId, m0 - 1n], 'BelowInitialMargin');
  const a0 = await vbal('takerA', 'USDG');
  const c1 = await sendWhenPriced('takerA closes the TSLA long', 'takerA', perps, A.perps, 'close', [longId, limit((await latest('TSLA'))[0], false)]);
  const s1 = events(c1.logs, A.perps, 'PositionSettled')[0];
  check('long closed: the taker got its claim back in the vault', !(await pos(longId)).open && (await vbal('takerA', 'USDG')) > a0, `takerOut ${s1 ? String(s1.takerOut) : '?'}`);
  await sendWhenPriced('takerC closes the NVDA short', 'takerC', perps, A.perps, 'close', [shortId, limit((await latest('NVDA'))[0], true)]);
  check('short closed', !(await pos(shortId)).open);

  // ==================== flow 5: price move -> keeper liquidation
  flow = '5 price move -> keeper liquidation (signer keeper)';
  const liqId = await nextId();
  await sendWhenPriced('takerA opens LONG TSLA 1,000 USDG at 5x', 'takerA', perps, A.perps, 'open', [tslaOffer, T.TSLA, true, 1_000n * E6, 10, limit((await latest('TSLA'))[0], true)]);
  frozen.add('TSLA');
  mid.TSLA = (mid.TSLA! * 88n) / 100n; // -12%: the rate limit walks it down (5% per recording, 1%/min)
  mid.TSLA = (mid.TSLA / 10n ** 14n) * 10n ** 14n;
  for (let i = 0; i < 6; i++) {
    const [, last] = await relayed('TSLA');
    await rpc('evm_increaseTime', [300]);
    await rpc('evm_mine');
    await waitFor('a TSLA push after the warp', async () => (await relayed('TSLA'))[1] > last, 90_000);
    if (!(await pos(liqId)).open) break;
  }
  const liquidatedBy = await waitFor('the keeper liquidates the 5x long', async () => {
    if ((await pos(liqId)).open) return null;
    const logs = await pub.getContractEvents({ address: perps, abi: A.perps, eventName: 'Liquidated', fromBlock: START });
    const hit = logs.find((l) => (l.args as { id?: bigint }).id === liqId);
    return hit ? { liquidator: (hit.args as { liquidator?: Address }).liquidator, tx: hit.transactionHash } : null;
  }, 180_000, 1000);
  const liqRcpt = await pub.getTransactionReceipt({ hash: liquidatedBy.tx! });
  report.steps.push({ flow, label: 'keeper liquidation transaction', ok: true, tx: liquidatedBy.tx!, gasUsed: liqRcpt.gasUsed.toString() });
  check('liquidated by the signer keeper key', liquidatedBy.liquidator?.toLowerCase() === addr('keeper').toLowerCase(), liquidatedBy.tx!);
  await waitFor('the indexer records the liquidation', async () => {
    const row = await prisma.perpPosition.findUnique({ where: { chainId_perps_positionId: { chainId: CHAIN_ID, perps: perps.toLowerCase(), positionId: liqId } } });
    return row?.status === 'liquidated' ? row : null;
  }, 60_000);
  check('indexer: position liquidated', true);
  mid.TSLA = (mid.TSLA * 100n) / 88n;
  mid.TSLA = (mid.TSLA / 10n ** 14n) * 10n ** 14n; // back up (walked at the rate limit)
  frozen.delete('TSLA');

  // ==================== flow 6: funding advance by the keeper
  flow = '6 funding advance (keeper)';
  const fundId = await nextId();
  await sendWhenPriced('takerC opens LONG NVDA 500 USDG at 2x (one-sided open interest)', 'takerC', perps, A.perps, 'open', [nvdaOffer, T.NVDA, true, 500n * E6, 4, limit((await latest('NVDA'))[0], true)]);
  const fundingBefore = (await pub.getContractEvents({ address: perps, abi: A.perps, eventName: 'FundingAdvanced', fromBlock: START })).length;
  await rpc('evm_increaseTime', [120]);
  await rpc('evm_mine');
  const fundTx = await waitFor('the keeper advances NVDA funding', async () => {
    const logs = await pub.getContractEvents({ address: perps, abi: A.perps, eventName: 'FundingAdvanced', fromBlock: START });
    const mine = logs.slice(fundingBefore).find((l) => (l.args as { market?: Address }).market?.toLowerCase() === T.NVDA!.toLowerCase());
    if (!mine) return null;
    const tx = await pub.getTransaction({ hash: mine.transactionHash! });
    return tx.from.toLowerCase() === addr('keeper').toLowerCase() && tx.input.startsWith('0x') && tx.to?.toLowerCase() === perps.toLowerCase() ? mine.transactionHash : null;
  }, 120_000, 1000);
  const fr = await pub.getTransactionReceipt({ hash: fundTx! });
  report.steps.push({ flow, label: 'keeper advanceFunding(NVDA)', ok: true, tx: fundTx!, gasUsed: fr.gasUsed.toString() });
  check('funding advanced by the keeper', true, fundTx!);

  // ==================== flow 7: forced exit: request, 7-day warp, settle, bond claim
  flow = '7 forced exit: request, 7 days, settle, bond claim';
  await send('maker requests a forced exit of the NVDA long (0.001 ETH bond)', 'maker', perps, A.perps, 'requestForcedExit', [fundId], 10n ** 15n);
  await refused('settling before 7 days is refused', 'outsider', perps, A.perps, 'settleForcedExit', [fundId], 'TooEarly');
  await rpc('evm_increaseTime', [7 * 86_400 + 60]);
  await rpc('evm_mine');
  const settledTx = await waitFor('the keeper settles the matured forced exit', async () => {
    if ((await pos(fundId)).open) return null;
    const logs = await pub.getContractEvents({ address: perps, abi: A.perps, eventName: 'ForcedExitSettled', fromBlock: START });
    return logs.find((l) => (l.args as { id?: bigint }).id === fundId)?.transactionHash ?? null;
  }, 180_000, 1000);
  const sr = await pub.getTransactionReceipt({ hash: settledTx! });
  report.steps.push({ flow, label: 'forced exit settled (signer keeper)', ok: true, tx: settledTx!, gasUsed: sr.gasUsed.toString() });
  check('forced exit settled after 7 days', (await pub.getTransaction({ hash: settledTx! })).from.toLowerCase() === addr('keeper').toLowerCase(), settledTx!);
  const ethBefore = await pub.getBalance({ address: addr('maker') });
  const claim = await send('maker claims the 0.001 ETH bond (pull refund, F-01)', 'maker', perps, A.perps, 'claimBond', []);
  const ethAfter = await pub.getBalance({ address: addr('maker') });
  check('bond returned (minus the claim gas)', ethAfter + claim.gasUsed * (await pub.getTransaction({ hash: claim.hash })).gasPrice! - ethBefore === 10n ** 15n);

  // ==================== flow 8: guardian close-only (emergency option)
  flow = '8 guardian close-only';
  await send('guardian puts TSLA in close-only', 'guardian', perps, A.perps, 'setCloseOnly', [T.TSLA, true]);
  await refused('opens refused in close-only', 'takerA', perps, A.perps, 'open', [tslaOffer, T.TSLA, true, 100n * E6, 4, limit((await latest('TSLA'))[0], true)], 'CloseOnly');
  await refused('only the guardian switches close-only', 'admin', perps, A.perps, 'setCloseOnly', [T.TSLA, false], 'NotGuardian');
  await send('guardian lifts close-only', 'guardian', perps, A.perps, 'setCloseOnly', [T.TSLA, false]);

  // ==================== flow 9: exits: offers, liquidity, keeper rewards, every balance withdrawn
  flow = '9 exits: offer withdraw, liquidity remove, withdrawals';
  await send('maker withdraws the TSLA offer', 'maker', book, A.book, 'withdrawOffer', [tslaOffer]);
  await send('maker withdraws the NVDA offer', 'maker', book, A.book, 'withdrawOffer', [nvdaOffer]);
  for (const s of ['TSLA', 'NVDA']) {
    const shares = (await pub.readContract({ address: pools, abi: A.pools, functionName: 'sharesOf', args: [T[s], addr('maker')] })) as bigint;
    await send(`maker removes all ${s} liquidity`, 'maker', pools, A.pools, 'removeLiquidity', [T[s], shares, 1n, 1n, (await now()) + 600n]);
  }
  const keeperReward = await vbal('keeper', 'USDG');
  check('the keeper (not allowlisted) earned rewards in the vault', keeperReward > 0n, `${Number(keeperReward) / 1e6} USDG`);
  await send('keeper withdraws its rewards (never blocked by the guard)', 'keeper', vault, A.vault, 'withdraw', [T.USDG, keeperReward, addr('keeper')]);
  for (const r of ['maker', 'takerA', 'takerC'] as Role[]) {
    for (const s of ['USDG', 'TSLA', 'NVDA']) {
      const b = await vbal(r, s);
      if (b > 0n) await send(`${r} withdraws all ${s}`, r, vault, A.vault, 'withdraw', [T[s], b, addr(r)]);
    }
  }

  // ==================== flow 10: retire the guard: liftCaps, then openToPublic
  flow = '10 guard wind-down: liftCaps then openToPublic';
  await refused('openToPublic refused while caps are active (G-01)', 'admin', vault, A.vault, 'openToPublic', [], 'CapsStillActive');
  await send('guard admin lifts the caps (one-way)', 'admin', vault, A.vault, 'liftCaps', []);
  await refused('the outsider is still not allowlisted', 'outsider', vault, A.vault, 'deposit', [T.USDG, 100n * E6, addr('outsider')], 'NotAllowlisted');
  await send('guard admin opens to the public (one-way; retires the guard)', 'admin', vault, A.vault, 'openToPublic', []);
  check('guard admin role cleared', ((await pub.readContract({ address: vault, abi: A.vault, functionName: 'guardAdmin' })) as string) === '0x0000000000000000000000000000000000000000');
  await send('outsider deposits 100 USDG after openToPublic', 'outsider', vault, A.vault, 'deposit', [T.USDG, 100n * E6, addr('outsider')]);
  await send('outsider withdraws it', 'outsider', vault, A.vault, 'withdraw', [T.USDG, 100n * E6, addr('outsider')]);

  // ==================== flow 11: the API over the index, health, logs
  flow = '11 API, health, logs';
  await waitFor('the indexer catches up', async () => {
    const st = handle!.status().indexer;
    return st.lagBlocks !== null && st.lagBlocks <= 3 ? st : null;
  }, 120_000, 1000);
  const api = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${API_PORT}${p}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const dep = await api('/v1/deployment');
  check('/v1/deployment serves the fork deployment', dep.status === 200 && (dep.body.contracts as Record<string, string>).vault?.toLowerCase() === vault.toLowerCase());
  const posA = await api(`/v1/accounts/${addr('takerA')}/positions`);
  const posRows = (Array.isArray(posA.body) ? posA.body : []) as unknown as { id?: string; status?: string }[];
  report.checks.apiPositionsTakerA = posRows;
  const statuses = posRows.map((p) => p.status).sort();
  check('/v1/accounts/:takerA/positions lists its 2 positions: one closed, one liquidated', posA.status === 200 && statuses.join(',') === 'closed,liquidated', statuses.join(','));
  const actA = await api(`/v1/accounts/${addr('takerA')}/activity?limit=200`);
  const kinds = ((actA.body.items ?? []) as { kind?: string }[]).map((x) => x.kind!);
  report.checks.apiActivityKindsTakerA = kinds;
  check('/v1/accounts/:takerA/activity has deposits, withdrawals, swaps, opens, margin, a close and the liquidation', actA.status === 200 && ['deposit', 'withdraw', 'swap', 'position_open', 'position_liquidate'].every((k) => kinds.includes(k)), [...new Set(kinds)].join(','));
  const mk = await api('/v1/markets');
  report.checks.apiMarkets = mk.body;
  const health = await api('/v1/health');
  report.checks.apiHealth = health.body;
  // The status file is rewritten every 5 s: wait for the counters of the actions just seen on chain.
  const st = await waitFor('the signer status to count the keeper actions', async () => {
    const x = status();
    return x && x.keeper.liquidations >= 1 && x.keeper.forcedExits >= 1 && x.keeper.fundingAdvances >= 1 ? x : null;
  }, 30_000, 1000);
  check('/v1/health: onchain ok, the signer status read by the API', health.status === 200 && (health.body.onchain as { ok?: boolean })?.ok === true && typeof health.body.signer === 'number', `signer age ${String(health.body.signer)}`);
  report.checks.signer = { relayer: { address: st.relayer.address, lastTx: st.relayer.lastTx, alerts: st.relayer.alerts }, keeper: { address: st.keeper.address, liquidations: st.keeper.liquidations, forcedExits: st.keeper.forcedExits, fundingAdvances: st.keeper.fundingAdvances, alerts: st.keeper.alerts } };
  check('signer status: relayer and keeper ran with their own keys', st.relayer.address?.toLowerCase() === addr('relayer').toLowerCase() && st.keeper.address?.toLowerCase() === addr('keeper').toLowerCase() && st.keeper.liquidations >= 1 && st.keeper.forcedExits >= 1);
  const all = signerOut.join('').toLowerCase();
  check('no hot key in the signer output', ![keys.relayer.privateKey, keys.keeper.privateKey].some((k) => all.includes(k.slice(2).toLowerCase())));

  // ==================== gas of the relayer's pushes (all 10 markets per push)
  const pushes = await pub.getContractEvents({ address: oracle, abi: A.oracle, eventName: 'PriceRelayed', fromBlock: START });
  const pushTxs = [...new Set(pushes.map((l) => l.transactionHash!))];
  const pushGas: { tx: Hex; markets: number; gasUsed: string }[] = [];
  for (const h of pushTxs.slice(-60)) {
    const r = await pub.getTransactionReceipt({ hash: h });
    pushGas.push({ tx: h, markets: pushes.filter((l) => l.transactionHash === h).length, gasUsed: r.gasUsed.toString() });
  }
  report.relayerPushes = { count: pushTxs.length, sample: pushGas };
  report.finishedAt = new Date().toISOString();
  report.ok = true;
  save();
  log('ALL FLOWS PASSED');

  if (HOLD) {
    // fork-e2e.sh checks the web against this stack, then removes the hold file. Quotes stand still meanwhile, so
    // the web's oracle price can be compared with the chain's exactly.
    for (const s of SYMS) frozen.add(s);
    writeFileSync(path.join(SCRATCH, 'flows.done'), String(Date.now()));
    report.webHold = true;
    while (existsSync(path.join(SCRATCH, 'flows.done'))) {
      await sleep(1000);
      void writeSnapshots().catch(() => undefined);
    }
  }
  clearInterval(snapTimer);
  if (walkTimer) clearInterval(walkTimer);
  signer.kill('SIGTERM');
  await new Promise((r) => (signer.exitCode !== null ? r(null) : signer.once('exit', r)));
  writeFileSync(path.join(SCRATCH, 'signer.log'), signerOut.join(''));
  quoteServer?.close();
  await handle!.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  redis.disconnect();
  bull.disconnect();
  setTimeout(() => process.exit(0), 2000).unref();
}

main().catch((e) => {
  console.error(e);
  report.ok = false;
  report.error = String(e instanceof Error ? e.stack ?? e.message : e);
  save();
  process.exit(1);
});
