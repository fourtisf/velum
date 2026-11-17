/**
 * Buying Stock Tokens with ETH, rehearsed on a local fork of Robinhood Chain mainnet (anvil): the calldata the web sends
 * (lib/uniswap/encode.ts encodeEthBuy: WRAP_ETH, then a v3 exact-input swap WETH -> USDG -> stock) against the deployed
 * Universal Router 2.1.2, QuoterV2, the ETH leg (WETH/USDG 0.01%) and every market's v3 pools, with real tokens. Every
 * transaction goes to the local fork only.
 *
 * For each market: quote 0.05 ETH over each v3 pool (QuoterV2.quoteExactInput) and take the best, execute with
 * value = amountIn -> the wallet received exactly the quote (same block state) and spent exactly amountIn plus gas;
 * then the same swap with a minimum one unit above the quote must revert (V3TooLittleReceived), and nothing moves.
 *
 * Run: anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8547 (in another shell), then
 *   FORK_RPC=http://127.0.0.1:8547 VELUM_NETWORK=mainnet NEXT_PUBLIC_VELUM_NETWORK=mainnet pnpm --filter @velum/workers exec tsx ../web/e2e/uniswap-eth-fork.e2e.ts
 */
import { UNISWAP } from '@velum/config/src/uniswap';
import { createPublicClient, createTestClient, createWalletClient, decodeErrorResult, defineChain, erc20Abi, http, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { QUOTER_V2_ABI, UNIVERSAL_ROUTER_ABI, UNI_ERRORS_ABI } from '../lib/uniswap/abi';
import { encodeEthBuy, ethBuyPath } from '../lib/uniswap/encode';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8547';
if (!UNISWAP) throw new Error('Run with VELUM_NETWORK=mainnet.');
const cfg = UNISWAP;
const chain = defineChain({ id: 4663, name: 'Robinhood Chain (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 120_000 }) });
const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 120_000 }) });
const AMOUNT = 5n * 10n ** 16n; // 0.05 ETH
const results: string[] = [];
let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

async function main() {
  await test.setBalance({ address: account.address, value: 10n ** 18n });
  for (const [sym, pools] of Object.entries(cfg.pools)) {
    const v3 = pools.filter((p) => p.version === 3);
    const quotes = await Promise.all(
      v3.map(async (pool) => {
        try {
          const r = await pub.simulateContract({ address: cfg.contracts.quoterV2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInput', args: [ethBuyPath(cfg.contracts.weth, cfg.ethLeg.fee, pool), AMOUNT] });
          return { pool, out: r.result[0] };
        } catch {
          return null;
        }
      }),
    );
    const best = quotes.filter((q): q is NonNullable<typeof q> => q !== null && q.out > 0n).sort((a, b) => (b.out > a.out ? 1 : -1))[0];
    if (!best) {
      check(`${sym}: a v3 pool quotes 0.05 ETH`, false, 'no quote');
      continue;
    }
    const stock = best.pool.stock;
    const deadline = (await pub.getBlock()).timestamp + 1200n;
    // Below the minimum: one unit above the quote must revert, and nothing moves.
    const tooHigh = encodeEthBuy({ weth: cfg.contracts.weth, ethFee: cfg.ethLeg.fee, pool: best.pool, amountIn: AMOUNT, minOut: best.out + 1n, recipient: account.address });
    const eth0 = await pub.getBalance({ address: account.address });
    const tok0 = await pub.readContract({ address: stock, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    let reverted = '';
    try {
      await pub.simulateContract({ account, address: cfg.contracts.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [tooHigh.commands, tooHigh.inputs, deadline], value: tooHigh.value });
    } catch (e) {
      const data = (e as { cause?: { data?: Hex }; data?: Hex }).cause?.data ?? (e as { data?: Hex }).data;
      try {
        reverted = data ? decodeErrorResult({ abi: UNI_ERRORS_ABI, data }).errorName : String((e as Error).message).slice(0, 80);
      } catch {
        reverted = String((e as Error).message).slice(0, 80);
      }
    }
    check(`${sym}: a minimum one unit above the quote is refused`, /TooLittleReceived|ExecutionFailed/.test(reverted), reverted);
    // The real swap at the quote.
    const ok = encodeEthBuy({ weth: cfg.contracts.weth, ethFee: cfg.ethLeg.fee, pool: best.pool, amountIn: AMOUNT, minOut: best.out, recipient: account.address });
    const hash = await wallet.writeContract({ address: cfg.contracts.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [ok.commands, ok.inputs, deadline], value: ok.value, chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const tok1 = await pub.readContract({ address: stock, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const eth1 = await pub.getBalance({ address: account.address });
    const gas = rc.gasUsed * rc.effectiveGasPrice;
    check(`${sym}: 0.05 ETH bought exactly the quoted ${sym} through v3 ${best.pool.fee}`, rc.status === 'success' && tok1 - tok0 === best.out, `${tok1 - tok0} vs ${best.out}`);
    check(`${sym}: the wallet spent exactly 0.05 ETH plus gas`, eth0 - eth1 === AMOUNT + gas, `${eth0 - eth1} vs ${AMOUNT + gas}`);
  }
  console.log(results.join('\n'));
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
