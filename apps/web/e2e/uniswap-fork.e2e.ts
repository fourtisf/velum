/**
 * Real spot trades through Uniswap, rehearsed on a local fork of Robinhood Chain mainnet (anvil): the calldata the web
 * sends (lib/uniswap/encode.ts) against the deployed Universal Router 2.1.2, Permit2, quoters and the curated pools,
 * with real Stock Tokens and USDG. Every trade goes to the local fork only.
 *
 * For a v3 and a v4 pool, both token orders (stock as token0 and as token1), buy and sell:
 *   quote (QuoterV2 / V4Quoter) -> exact ERC-20 approval to Permit2 -> exact Permit2 allowance for the router ->
 *   execute -> the wallet paid exactly the input and received exactly the quote (same block state);
 * then a swap whose minimum is one unit above the quote must revert with V3TooLittleReceived / V4TooLittleReceived
 * (the web decodes either, and an ExecutionFailed wrapper), and nothing moves.
 *
 * Run: anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8547 (in another shell), then
 *   FORK_RPC=http://127.0.0.1:8547 VELUM_NETWORK=mainnet NEXT_PUBLIC_VELUM_NETWORK=mainnet pnpm --filter @velum/workers exec tsx ../web/e2e/uniswap-fork.e2e.ts
 */
import { UNISWAP, type UniPool } from '@velum/config/src/uniswap';
import { createPublicClient, createTestClient, createWalletClient, decodeErrorResult, defineChain, erc20Abi, http, parseEventLogs, type Address, type Hex } from 'viem';
import { ERC20_TRANSFER_ABI, PERMIT2_ABI, QUOTER_V2_ABI, UNIVERSAL_ROUTER_ABI, UNI_ERRORS_ABI, V4_QUOTER_ABI } from '../lib/uniswap/abi';
import { encodeSwap, hopFor, minOutFor, zeroForOne, type Hop } from '../lib/uniswap/encode';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8547';
if (!UNISWAP) throw new Error('Run with VELUM_NETWORK=mainnet.');
const cfg = UNISWAP;
const chain = defineChain({ id: 4663, name: 'Robinhood Chain (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
/** anvil's first default account (unlocked on the fork; never a real key). */
const ME: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const wallet = (account: Address) => createWalletClient({ account, chain, transport: http(RPC, { timeout: 120_000 }) });
const results: string[] = [];
let failed = 0;
const ok = (m: string) => results.push(`ok   ${m}`);
const bad = (m: string) => {
  failed++;
  results.push(`FAIL ${m}`);
};

async function send(from: Address, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const { request } = await pub.simulateContract({ account: from, address, abi: abi as never, functionName, args } as never);
  const hash = await wallet(from).writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}

/** Funds ME from a holder (impersonated) that is not one of the pools traded through below. */
async function fund(token: Address, holder: Address, amount: bigint) {
  await test.impersonateAccount({ address: holder });
  await test.setBalance({ address: holder, value: 10n ** 18n });
  await send(holder, token, erc20Abi, 'transfer', [ME, amount]);
  await test.stopImpersonatingAccount({ address: holder });
}

async function quote(h: Hop, amountIn: bigint): Promise<bigint> {
  const p = h.pool;
  if (p.version === 3) {
    const r = await pub.simulateContract({ address: cfg.contracts.quoterV2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn: h.tokenIn, tokenOut: h.tokenOut, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }] });
    return r.result[0];
  }
  const r = await pub.simulateContract({ address: cfg.contracts.v4Quoter, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks }, zeroForOne: zeroForOne(h), exactAmount: amountIn, hookData: '0x' }] });
  return r.result[0];
}

const sumTransfers = (logs: readonly { address: string }[], token: Address, pick: (f: string, t: string) => boolean) =>
  (parseEventLogs({ abi: ERC20_TRANSFER_ABI, logs: logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()) as never }) as unknown as Array<{ args: { from: string; to: string; value: bigint } }>)
    .filter((e) => pick(e.args.from.toLowerCase(), e.args.to.toLowerCase()))
    .reduce((s, e) => s + e.args.value, 0n);

async function trade(label: string, h: Hop, amountIn: bigint) {
  const q = await quote(h, amountIn);
  const min = minOutFor(q, 50n);
  // Exact approvals, like the web (lib/uniswap/flows.tsx).
  await send(ME, h.tokenIn, erc20Abi, 'approve', [cfg.contracts.permit2, amountIn]);
  const now = (await pub.getBlock()).timestamp;
  await send(ME, cfg.contracts.permit2, PERMIT2_ABI, 'approve', [h.tokenIn, cfg.contracts.universalRouter, amountIn, Number(now + 1800n)]);
  const { commands, inputs } = encodeSwap(h, amountIn, min, ME);
  const r = await send(ME, cfg.contracts.universalRouter, UNIVERSAL_ROUTER_ABI, 'execute', [commands, inputs, now + 1200n]);
  const me = ME.toLowerCase();
  const paid = sumTransfers(r.logs, h.tokenIn, (f) => f === me);
  const got = sumTransfers(r.logs, h.tokenOut, (_f, t) => t === me);
  if (paid === amountIn && got === q) ok(`${label}: paid ${paid}, received ${got} (= quote), gas ${r.gasUsed}`);
  else bad(`${label}: paid ${paid} (want ${amountIn}), received ${got} (quote ${q}, min ${min})`);
  return got;
}

async function slippageRevert(label: string, h: Hop, amountIn: bigint) {
  const q = await quote(h, amountIn);
  await send(ME, h.tokenIn, erc20Abi, 'approve', [cfg.contracts.permit2, amountIn]);
  const now = (await pub.getBlock()).timestamp;
  await send(ME, cfg.contracts.permit2, PERMIT2_ABI, 'approve', [h.tokenIn, cfg.contracts.universalRouter, amountIn, Number(now + 1800n)]);
  const { commands, inputs } = encodeSwap(h, amountIn, q + 1n, ME);
  try {
    await pub.simulateContract({ account: ME, address: cfg.contracts.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [commands, inputs, now + 1200n] });
    bad(`${label}: a minimum above the quote did not revert`);
  } catch (e) {
    const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown };
    const rev = err.walk?.((x) => (x as { name?: string }).name === 'ContractFunctionRevertedError') as { data?: { errorName?: string; args?: readonly unknown[] } } | undefined;
    const name = rev?.data?.errorName;
    let inner = '';
    if (name === 'ExecutionFailed' && typeof rev?.data?.args?.[1] === 'string') {
      try {
        inner = decodeErrorResult({ abi: UNI_ERRORS_ABI, data: rev.data.args[1] as Hex }).errorName;
      } catch {
        inner = '?';
      }
    }
    // Universal Router 2.1.2 bubbles the router's own error up as is; an older wrapper would use ExecutionFailed.
    if (/TooLittleReceived/.test(name ?? '') || (name === 'ExecutionFailed' && /TooLittleReceived/.test(inner))) ok(`${label}: a minimum above the quote reverts with ${name}${inner ? `(${inner})` : ''}, nothing traded`);
    else bad(`${label}: unexpected revert ${name} ${inner}`);
  }
}

const pool = (sym: string, version: 3 | 4, fee: number): UniPool => {
  const p = cfg.pools[sym]!.find((x) => x.version === version && x.fee === fee);
  if (!p) throw new Error(`no ${sym} v${version} ${fee} pool in the curated list`);
  return p;
};

async function main() {
  const block = await pub.getBlockNumber();
  results.push(`fork of Robinhood Chain mainnet at block ${block}`);
  await test.setBalance({ address: ME, value: 10n ** 18n });
  const usdg = cfg.usdg.address;
  // Funding holders: pools that are not traded through below (their balances are plain ERC-20 balances).
  const tsla1pct = pool('TSLA', 3, 10000).address;
  await fund(usdg, tsla1pct, 5_000n * 10n ** 6n);

  // TSLA: the stock is token0 (0x322f… < USDG 0x5fc5…).
  const tslaV3 = pool('TSLA', 3, 3000);
  const tslaV4 = pool('TSLA', 4, 3000);
  if (!tslaV3.stockIsToken0) bad('TSLA should be token0');
  const t1 = await trade('TSLA v3 0.30% buy 1000 USDG', hopFor(tslaV3, 'buy'), 1000n * 10n ** 6n);
  await trade('TSLA v3 0.30% sell', hopFor(tslaV3, 'sell'), t1 / 2n);
  const t2 = await trade('TSLA v4 0.30% buy 1000 USDG', hopFor(tslaV4, 'buy'), 1000n * 10n ** 6n);
  await trade('TSLA v4 0.30% sell', hopFor(tslaV4, 'sell'), t2 / 2n);

  // META: the stock is token1 (USDG 0x5fc5… < META 0xc0d6…).
  const metaV4 = pool('META', 4, 3000);
  const metaV3 = pool('META', 3, 3000);
  if (metaV4.stockIsToken0) bad('META should be token1');
  const m1 = await trade('META v4 0.30% buy 1000 USDG', hopFor(metaV4, 'buy'), 1000n * 10n ** 6n);
  await trade('META v4 0.30% sell', hopFor(metaV4, 'sell'), m1);
  const m2 = await trade('META v3 0.30% buy 500 USDG', hopFor(metaV3, 'buy'), 500n * 10n ** 6n);
  await trade('META v3 0.30% sell', hopFor(metaV3, 'sell'), m2);

  await slippageRevert('TSLA v3 slippage', hopFor(tslaV3, 'buy'), 100n * 10n ** 6n);
  await slippageRevert('META v4 slippage', hopFor(metaV4, 'buy'), 100n * 10n ** 6n);

  for (const r of results) console.log(r);
  if (failed) {
    console.error(`FAILED: ${failed} check(s)`);
    process.exit(1);
  }
  console.log('OK: every Uniswap trade path works against the deployed contracts');
}

main().catch((e: unknown) => {
  for (const r of results) console.log(r);
  console.error(e);
  process.exit(1);
});
