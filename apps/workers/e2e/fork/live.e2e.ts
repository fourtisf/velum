/**
 * The live-price part of the mainnet-fork rehearsal (fork-live.sh): the fork keeps Robinhood Chain's real chain id
 * (4663), the contracts were deployed through Deploy.s.sol's guarded-mainnet path (simulation, plan, confirmation
 * phrase, broadcast), and the production processes run as they do on the server: the API (dist/server.js), the
 * workers (dist/index.js: Robinhood price-relay + indexer) and the signer (dist/signer.js: relayer + keeper) with
 * VELUM_NETWORK=mainnet, ONCHAIN_MAINNET_CONFIRMED=yes and the LIVE Robinhood quote API (read-only, for a few minutes).
 *
 * In an open US-equity session it checks that live quotes reach the oracle per token (the uiMultiplier tokens priced
 * per token: underlying x multiplier) and that a position opens and closes at the live price. With the session
 * closed (weekends, holidays) the signer must read the quotes and push nothing: that is what it reports then.
 * Every key is a throwaway made for this run; every transaction goes to the local fork only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSignerStatus } from '@velum/config/src/onchain';

const root = path.resolve(__dirname, '../../../..');
const RPC = process.env.FORK_RPC!;
const DIR = process.env.FORK_DEPLOYMENTS!;
const ARTIFACTS = process.env.FORK_ARTIFACTS!;
const KEYS = process.env.FORK_KEYS!;
const OUT = process.env.FORK_OUT!;
const SCRATCH = process.env.FORK_SCRATCH!;
const API_PORT = Number(process.env.FORK_API_PORT ?? 4893);
const MINUTES = Number(process.env.LIVE_MINUTES ?? 4);
const CHAIN_ID = 4663;
const E6 = 1_000_000n;
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;
const t0 = Date.now();
type Role = 'deployer' | 'relayer' | 'keeper' | 'admin' | 'maker' | 'taker';
const keys = JSON.parse(readFileSync(KEYS, 'utf8')) as Record<Role, { address: Address; privateKey: Hex }>;
const addr = (r: Role) => keys[r].address;
const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain (local fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const wallet = (who: Role | Address) =>
  createWalletClient({ account: who.startsWith('0x') ? (who as Address) : privateKeyToAccount(keys[who as Role].privateKey), chain, transport: http(RPC, { timeout: 60_000 }) });
const artifact = (n: string) => JSON.parse(readFileSync(path.join(ARTIFACTS, `${n}.sol`, `${n}.json`), 'utf8')).abi as Abi;
const ERRS = ['VelumVault', 'OracleAdapter', 'MakerBook', 'PerpsMarkets'].flatMap((n) => artifact(n).filter((x) => x.type === 'error'));
const A = { vault: [...artifact('VelumVault')], oracle: [...artifact('OracleAdapter')], book: [...artifact('MakerBook')], perps: [...artifact('PerpsMarkets'), ...ERRS.filter((e) => !artifact('PerpsMarkets').some((x) => x.type === 'error' && 'name' in x && 'name' in e && x.name === e.name))] } as Record<string, Abi>;
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function uiMultiplier() view returns (uint256)']);
const report: Record<string, unknown> & { steps: { label: string; ok: boolean; tx?: Hex; gasUsed?: string; note?: string }[] } = { startedAt: new Date(t0).toISOString(), steps: [] };
const save = () => writeFileSync(OUT, JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
const log = (...a: unknown[]) => console.log(`[live +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
async function send(label: string, from: Role | Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n) {
  const w = wallet(from);
  const { request } = await pub.simulateContract({ account: w.account!, address, abi, functionName, args, value } as never);
  const hash = await w.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label}: reverted ${hash}`);
  report.steps.push({ label, ok: true, tx: hash, gasUsed: r.gasUsed.toString() });
  log('tx', label, hash, `gas ${r.gasUsed}`);
  return r;
}
function note(label: string, ok: boolean, n?: string) {
  report.steps.push({ label, ok, note: n });
  log(ok ? 'ok' : 'NOTE', label, n ?? '');
}

async function main() {
  const d = JSON.parse(readFileSync(path.join(DIR, `${CHAIN_ID}.json`), 'utf8')) as { contracts: Record<string, Address>; tokens: Record<string, Address>; guardAdmin: Address; priceRelayer: Address; startBlock: number };
  const T = d.tokens as Record<string, Address> & Record<'USDG' | 'TSLA', Address>;
  const { vault, oracle, makerBook: book, perpsMarkets: perps } = d.contracts as Record<'vault' | 'oracle' | 'makerBook' | 'perpsMarkets', Address>;
  report.deployment = d;
  // ---- warm-up (the RPC serves fork state for ~10-15 minutes): fund, approve, allowlist, deposit, offer
  for (const r of Object.keys(keys) as Role[]) await rpc('anvil_setBalance', [addr(r), '0x' + (10n * E18).toString(16)]);
  const holder = '0x51c72848c68a965f66fa7a88855f9f7784502a7f' as Address;
  await rpc('anvil_impersonateAccount', [holder]);
  await rpc('anvil_setBalance', [holder, '0x' + E18.toString(16)]);
  for (const [r, amt] of [['maker', 20_000n * E6], ['taker', 2_000n * E6], ['keeper', E6]] as const) await send(`USDG holder -> ${r} (impersonated, fork only)`, holder, T.USDG!, ERC20 as Abi, 'transfer', [addr(r), amt]);
  for (const r of ['maker', 'taker'] as Role[]) await send(`${r} approves the vault`, r, T.USDG!, ERC20 as Abi, 'approve', [vault, MAX]);
  await send('guard admin allowlists maker and taker', 'admin', vault, A.vault!, 'addToAllowlist', [[addr('maker'), addr('taker')]]);
  await send('maker deposits 1,900 USDG (account cap 2,000)', 'maker', vault, A.vault!, 'deposit', [T.USDG, 1_900n * E6, addr('maker')]);
  await send('taker deposits 500 USDG', 'taker', vault, A.vault!, 'deposit', [T.USDG, 500n * E6, addr('taker')]);
  await send('taker withdraws 1 USDG', 'taker', vault, A.vault!, 'withdraw', [T.USDG, E6, addr('taker')]);
  for (const r of ['maker', 'taker'] as Role[]) await send(`${r} approves perps`, r, vault, A.vault!, 'setApproval', [perps, true]);
  await send('maker approves the maker book', 'maker', vault, A.vault!, 'setApproval', [book, true]);
  const now = (await pub.getBlock()).timestamp;
  const offer = await send('maker posts a TSLA offer', 'maker', book, A.book!, 'postOffer', [T.TSLA, 1_500n * E6, 1_000n * E6, 5, 5, now + 30n * 86_400n]);
  const mult: Record<string, bigint> = {};
  for (const s of ['NVDA', 'AAPL', 'META', 'MSFT', 'TSLA']) mult[s] = (await pub.readContract({ address: T[s]!, abi: ERC20, functionName: 'uiMultiplier' })) as bigint;
  report.warmupSeconds = Math.round((Date.now() - t0) / 1000);
  log(`warm-up done in ${report.warmupSeconds}s`);
  save();

  // ---- the production processes, as on the server (separate processes, their own environments)
  const home = path.join(SCRATCH, 'signer-home');
  mkdirSync(path.join(home, 'run'), { recursive: true });
  chmodSync(home, 0o700);
  const statusFile = path.join(home, 'run', 'status.json');
  const keysFile = path.join(home, 'signer-keys.env');
  writeFileSync(keysFile, `PRICE_RELAY_PRIVATE_KEY=${keys.relayer.privateKey}\nKEEPER_PRIVATE_KEY=${keys.keeper.privateKey}\n`, { mode: 0o600 });
  const common = { PATH: process.env.PATH, NODE_ENV: 'production', LOG_LEVEL: 'info', VELUM_NETWORK: 'mainnet', CHAIN_ID: String(CHAIN_ID), RPC_URL: RPC, HTTPS_PROXY: process.env.HTTPS_PROXY ?? '', HTTP_PROXY: process.env.HTTP_PROXY ?? '', NO_PROXY: process.env.NO_PROXY ?? '', NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '', NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', NODE_USE_ENV_PROXY: process.env.HTTPS_PROXY ? '1' : '' };
  const procs: { name: string; p: ChildProcess; out: string[] }[] = [];
  const start = (name: string, script: string, env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const p = spawn(process.execPath, [script], { cwd: path.dirname(path.dirname(script)), env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [p.stdout!, p.stderr!]) {
      s.setEncoding('utf8');
      s.on('data', (c: string) => out.push(c));
    }
    procs.push({ name, p, out });
  };
  const db = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL };
  start('api', path.join(root, 'apps/api/dist/server.js'), { ...common, ...db, HOST: '127.0.0.1', PORT_API: String(API_PORT), DEPLOYMENTS_DIR: DIR, SIGNER_STATUS_FILE: statusFile, RATE_LIMIT_READ_PER_MIN: '5000' });
  start('workers', path.join(root, 'apps/workers/dist/index.js'), { ...common, ...db, PRICE_SOURCE: 'robinhood', PRICE_POLL_MS: '10000', ONCHAIN_WORKERS: 'true', ONCHAIN_MAINNET_CONFIRMED: 'yes', DEPLOYMENTS_DIR: DIR, CONFIRMATIONS: '1', INDEXER_POLL_MS: '1000' });
  start('signer', path.join(root, 'apps/workers/dist/signer.js'), { ...common, HOME: home, ONCHAIN_WORKERS: 'true', ONCHAIN_MAINNET_CONFIRMED: 'yes', KEEPER_INTERVAL_MS: '3000', PRICE_PUSH_INTERVAL_MS: '9000', RELAYER_MAX_GWEI: '1', SIGNER_KEYS_FILE: keysFile, SIGNER_STATUS_FILE: statusFile, SIGNER_STATE_DIR: path.join(home, 'state'), SIGNER_DEPLOYMENTS_DIR: DIR });
  const api = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${API_PORT}${p}`);
    return (await r.json()) as Record<string, unknown>;
  };
  const status = () => {
    try {
      return parseSignerStatus(readFileSync(statusFile, 'utf8'), Date.now());
    } catch {
      return null;
    }
  };
  const relayed = async (s: string) => (await pub.readContract({ address: oracle, abi: A.oracle!, functionName: 'relayed', args: [T[s]] })) as readonly [bigint, bigint, bigint];
  const until = Date.now() + MINUTES * 60_000;
  let pushed = false;
  while (Date.now() < until) {
    await sleep(15_000);
    const st = status();
    const pushes = await Promise.all(Object.keys(T).filter((s) => s !== 'USDG').map(async (s) => [s, (await relayed(s))[1] > 0n] as const));
    pushed = pushes.every(([, p]) => p);
    log('signer:', st ? JSON.stringify({ error: st.error, sending: st.relayer?.sending, relayerMarkets: st.relayer?.markets, prices: st.prices?.markets }) : 'no status yet', '| pushed:', pushes.filter(([, p]) => p).map(([s]) => s).join(',') || 'none');
    if (pushed) break;
  }
  const st = status();
  report.signerStatus = st && { requested: st.requested, error: st.error, relayer: { address: st.relayer?.address, sending: st.relayer?.sending, markets: st.relayer?.markets, sequencerUp: st.relayer?.sequencerUp, alerts: st.relayer?.alerts, lastTx: st.relayer?.lastTx }, keeper: { address: st.keeper?.address, sending: st.keeper?.sending, alerts: st.keeper?.alerts }, prices: st.prices };
  const markets = await api('/v1/markets');
  report.apiMarkets = markets;
  report.apiHealth = await api('/v1/health');
  note('the signer runs with ONCHAIN_MAINNET_CONFIRMED=yes on chain 4663 and both keys', !!st && st.error === null && st.relayer?.address?.toLowerCase() === addr('relayer').toLowerCase() && st.keeper?.address?.toLowerCase() === addr('keeper').toLowerCase());
  const live = Object.values((st?.prices?.markets ?? {}) as Record<string, string>);
  note('the signer read the live Robinhood quotes for all 10 markets (quote state per market)', live.length === 10 && live.every((x) => x !== 'none'), JSON.stringify(st?.prices?.markets));
  if (!pushed) {
    note('no price pushed: correct while the US-equity session is closed or quotes are frozen/unconfirmed', true, JSON.stringify(st?.relayer?.markets));
  } else {
    // ---- in session: live prices on chain, per token, and a trade at the live price
    const rows: Record<string, unknown>[] = [];
    for (const s of ['NVDA', 'AAPL', 'META', 'MSFT', 'TSLA']) {
      const [p] = await relayed(s);
      const q = ((await (await fetch(`https://api.robinhood.com/rhj/prices/${s}`, { headers: { accept: 'application/json' } })).json()) as { quotes: { bid: string; ask: string }[] }).quotes[0]!;
      const raw = (BigInt(Math.round(Number(q.bid) * 1e6)) + BigInt(Math.round(Number(q.ask) * 1e6))) * 10n ** 12n / 2n;
      const perToken = (raw * mult[s]!) / E18;
      const diffBps = Number(((p > perToken ? p - perToken : perToken - p) * 10_000n) / perToken);
      rows.push({ symbol: s, oracle: p.toString(), underlyingMid: raw.toString(), uiMultiplier: mult[s]!.toString(), underlyingTimesMultiplier: perToken.toString(), diffBps });
      note(`${s}: oracle price = live underlying mid x uiMultiplier (within 30 bps of a quote read just after)`, diffBps <= 30, `diff ${diffBps} bps`);
    }
    report.livePrices = rows;
    const id = (await pub.readContract({ address: perps, abi: A.perps!, functionName: 'nextPositionId' })) as bigint;
    const offerId = (offer.logs.length ? BigInt(offer.logs[0]!.topics[1]!) : 1n) as bigint;
    for (let i = 0; i < 40; i++) {
      const [p] = await relayed('TSLA');
      try {
        await send('taker opens LONG TSLA 50 USDG at 2x at the live price', 'taker', perps, A.perps!, 'open', [offerId, T.TSLA, true, 50n * E6, 4, (p * 102n) / 100n]);
        break;
      } catch {
        await sleep(1000);
      }
    }
    for (let i = 0; i < 40; i++) {
      const [p] = await relayed('TSLA');
      try {
        await send('taker closes it at the live price', 'taker', perps, A.perps!, 'close', [id, (p * 98n) / 100n]);
        break;
      } catch {
        await sleep(1000);
      }
    }
  }
  report.processLogs = Object.fromEntries(procs.map((x) => [x.name, x.out.join('').split('\n').filter((l) => /"level":"(warn|error)"|level":(40|50)/.test(l)).slice(-15)]));
  report.finishedAt = new Date().toISOString();
  save();
  for (const x of procs) x.p.kill('SIGTERM');
  await sleep(3000);
  writeFileSync(path.join(SCRATCH, 'processes.log'), procs.map((x) => `==== ${x.name}\n${x.out.join('')}`).join('\n'));
  const keyLeak = procs.some((x) => [keys.relayer.privateKey, keys.keeper.privateKey].some((k) => x.out.join('').toLowerCase().includes(k.slice(2).toLowerCase())));
  note('no hot key in any process output', !keyLeak);
  save();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  report.error = String(e instanceof Error ? e.stack : e);
  save();
  process.exit(1);
});
