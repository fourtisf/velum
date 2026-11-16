/**
 * Live signing check against the real Hyperliquid API (api.hyperliquid.xyz), with throwaway keys that hold nothing, so
 * every request is refused and nothing can trade. Hyperliquid names the address it recovered from each signature in
 * its refusal, which proves the web signs exactly what Hyperliquid verifies:
 *
 *  - an IOC order built by lib/hyperliquid/order.ts (planOpen -> orderParams) for xyz:TSLA, signed by a fresh agent key:
 *    refused with "User or API Wallet <agent> does not exist" (the L1 action hash and the agent signature match);
 *  - the same for updateLeverage (isolated) and agentSendAsset (main balance -> xyz), the other agent-signed actions;
 *  - approveAgent signed by the user's key with signatureChainId 0x1237 (Robinhood Chain, the wallet's chain in the
 *    app): refused with "Must deposit before performing actions. User: <user>" (the EIP-712 user signature matches).
 *
 * Also checks that the pinned markets are still at their indices in the live market list.
 *
 * Run (network access to api.hyperliquid.xyz):
 *   NODE_USE_ENV_PROXY=1 VELUM_NETWORK=mainnet NEXT_PUBLIC_VELUM_NETWORK=mainnet pnpm --filter @velum/workers exec tsx ../web/e2e/hyperliquid-live.e2e.ts
 */
import { HL_DEX, HL_MARKETS, HL_USDC_TOKEN, hlCheckMarket } from '@velum/config/src/hyperliquid';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { orderParams, planOpen } from '../lib/hyperliquid/order';

const transport = new HttpTransport({ timeout: 20_000 });
const info = new InfoClient({ transport });
const results: string[] = [];
let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

/** The refusal message of a request expected to be refused. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    const r = await p;
    return `UNEXPECTED SUCCESS ${JSON.stringify(r)}`;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

async function main() {
  const meta = await info.meta({ dex: HL_DEX });
  for (const sym of Object.keys(HL_MARKETS)) check(`${sym} is still at its pinned index in the live xyz market list`, hlCheckMarket(sym, meta.universe) !== null);
  const tsla = hlCheckMarket('TSLA', meta.universe)!;
  const mids = await info.allMids({ dex: HL_DEX });
  const mid = mids[tsla.coin];
  check('allMids answers the xyz:TSLA mid price', typeof mid === 'string' && Number(mid) > 0, String(mid));

  const user = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const asAgent = new ExchangeClient({ transport, wallet: agent });

  const plan = planOpen({ market: tsla, long: true, notionalUsd: '20', leverage: 2, markPx: mid!, slipBps: 50n });
  check('planOpen builds a 20 USD order from the live mid', plan.ok, JSON.stringify(plan));
  if (plan.ok) {
    const msg = await refusal(asAgent.order(orderParams({ ...plan.plan, reduceOnly: false }, null)));
    check('order: Hyperliquid recovers the agent from its signature', msg.toLowerCase().includes(`user or api wallet ${agent.address.toLowerCase()} does not exist`), msg);
  }
  const lev = await refusal(asAgent.updateLeverage({ asset: tsla.asset, isCross: false, leverage: 2 }));
  check('updateLeverage: Hyperliquid recovers the agent', lev.toLowerCase().includes(agent.address.toLowerCase()) && /does not exist/i.test(lev), lev);
  const move = await refusal(asAgent.agentSendAsset({ destination: user.address, sourceDex: '', destinationDex: HL_DEX, token: HL_USDC_TOKEN, amount: '1', fromSubAccount: '' }));
  check('agentSendAsset: Hyperliquid recovers the agent', move.toLowerCase().includes(agent.address.toLowerCase()) && /does not exist/i.test(move), move);

  // The user's wallet signs on Robinhood Chain (4663 = 0x1237), as in the app.
  const asUser = new ExchangeClient({ transport, wallet: user, signatureChainId: '0x1237' });
  const approve = await refusal(asUser.approveAgent({ agentAddress: agent.address, agentName: `velum valid_until ${Date.now() + 30 * 86_400_000}` }));
  check('approveAgent (signatureChainId 0x1237): Hyperliquid recovers the user', approve.toLowerCase().includes(user.address.toLowerCase()) && /deposit/i.test(approve), approve);

  console.log(results.join('\n'));
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
