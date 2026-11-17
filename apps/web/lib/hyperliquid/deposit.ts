'use client';
/**
 * Deposits into the user's own Hyperliquid account from inside Velum: native USDC on Arbitrum, sent by the user's wallet
 * to Hyperliquid's bridge, which credits the sender's address (packages/config/src/hyperliquid.ts HL_BRIDGE). Flow: switch
 * the wallet to Arbitrum -> transfer (balance and gas checked first; at least 5 USDC, since less is lost) -> wait until
 * Hyperliquid shows the USDC -> switch the wallet back to Robinhood Chain. The transfer is never sent twice: a retry
 * after it was sent only waits for that same transaction.
 */
import { CHAIN } from '@velum/config';
import { ARB_CHAIN_ID, ARB_RPC, ARB_USDC, ARB_USDC_DECIMALS, HL_BRIDGE, HL_DEX, HL_MIN_DEPOSIT_USDC } from '@velum/config/src/hyperliquid';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, createWalletClient, custom, erc20Abi, http, parseEventLogs, type EIP1193Provider, type Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import { getConnection } from 'wagmi/actions';
import { wagmiConfig } from '../wagmi';
import { info } from './client';
import type { HlFlowSpec, HlStep } from './flows';

const UNIT = 10n ** BigInt(ARB_USDC_DECIMALS);
export const MIN_DEPOSIT_UNITS = BigInt(HL_MIN_DEPOSIT_USDC) * UNIT;

export const arb = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC, { timeout: 20_000, retryCount: 2 }) });

export interface ArbBalances {
  /** Native USDC, base units (6 decimals). */
  usdc: bigint;
  /** ETH for gas, wei. */
  eth: bigint;
}

export async function readArbBalances(user: `0x${string}`): Promise<ArbBalances> {
  const [usdc, eth] = await Promise.all([arb.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [user] }), arb.getBalance({ address: user })]);
  return { usdc, eth };
}

export function useArbBalances(user: `0x${string}` | undefined) {
  return useQuery({ queryKey: ['arb-balances', user], enabled: !!user, refetchInterval: 15_000, staleTime: 10_000, retry: 1, queryFn: () => readArbBalances(user!) });
}

/** Base units of a USDC amount typed by the user (at most 6 decimals), or null when it is not a plain amount. */
export function usdcUnits(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1]!) * UNIT + BigInt((m[2] ?? '').padEnd(ARB_USDC_DECIMALS, '0'));
}

/** USDC base units as a plain amount, rounded down to cents ("12.34"). */
export const usdcText = (u: bigint): string => `${u / UNIT}.${((u % UNIT) / 10_000n).toString().padStart(2, '0')}`;

export type DepositRefusal = 'amount' | 'min' | 'balance' | 'gas' | 'loading';

/** Whether `input` can be deposited from `bal`: a plain amount, at least 5 USDC, within the balance, with ETH for gas. */
export function planDeposit(input: string, bal: ArbBalances | null): { ok: true; units: bigint } | { ok: false; reason: DepositRefusal } {
  const units = usdcUnits(input);
  if (units === null || units === 0n) return { ok: false, reason: 'amount' };
  if (units < MIN_DEPOSIT_UNITS) return { ok: false, reason: 'min' };
  if (!bal) return { ok: false, reason: 'loading' };
  if (units > bal.usdc) return { ok: false, reason: 'balance' };
  if (bal.eth === 0n) return { ok: false, reason: 'gas' };
  return { ok: true, units };
}

/** The connected wallet's provider, refusing when the wallet now holds another account than `user`. */
async function walletProvider(user: `0x${string}`): Promise<EIP1193Provider> {
  const c = getConnection(wagmiConfig);
  if (c.status !== 'connected' || c.address.toLowerCase() !== user.toLowerCase()) throw new Error('Your wallet switched to another account. Reconnect the account you trade with.');
  return (await c.connector.getProvider()) as EIP1193Provider;
}

const ARB_PARAMS = { chainId: '0xa4b1', chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [ARB_RPC], blockExplorerUrls: ['https://arbiscan.io'] };

/** Switches the wallet to `chainId` (adding Arbitrum when the wallet does not know it); false when it was already there. */
export async function switchWallet(provider: EIP1193Provider, chainId: number, add?: typeof ARB_PARAMS): Promise<boolean> {
  if (Number(await provider.request({ method: 'eth_chainId' })) === chainId) return false;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (!add || !(code === 4902 || /unrecognized|not been added|unknown chain/i.test(String((e as Error)?.message)))) throw e;
    await provider.request({ method: 'wallet_addEthereumChain', params: [add] });
  }
  return true;
}

/** USDC on Hyperliquid across the balances a deposit can land in (perps, stock perps, spot), to see a deposit arrive. */
export async function hlUsdcTotal(user: `0x${string}`): Promise<number> {
  const [main, xyz, spot] = await Promise.all([info.clearinghouseState({ user }), info.clearinghouseState({ user, dex: HL_DEX }), info.spotClearinghouseState({ user })]);
  const usdc = spot.balances.find((b) => b.coin === 'USDC');
  return Number(main.withdrawable) + Number(xyz.withdrawable) + Number(usdc?.total ?? 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** The deposit flow for the dialog (components/hyperliquid/HlFlowModal.tsx). `pollMs`/`waitMs` are shortened by tests only. */
export function depositFlow(p: { user: `0x${string}`; units: bigint; pollMs?: number; waitMs?: number }): HlFlowSpec {
  const amount = usdcText(p.units);
  const steps: HlStep[] = [
    {
      t: 'Switch your wallet to Arbitrum',
      wallet: true,
      d: 'USDC deposits arrive from Arbitrum',
      run: async (ctx) => ((await switchWallet(await walletProvider(ctx.user), ARB_CHAIN_ID, ARB_PARAMS)) ? 'Switched to Arbitrum' : null),
    },
    {
      t: `Send ${amount} USDC to your perps account`,
      wallet: true,
      d: 'A USDC transfer on Arbitrum from your wallet to the deposit bridge',
      run: async (ctx) => {
        let hash = ctx.out.depositHash as Hex | undefined;
        if (!hash) {
          const bal = await readArbBalances(ctx.user);
          if (bal.usdc < p.units) throw new Error(`Your wallet holds ${usdcText(bal.usdc)} USDC on Arbitrum, less than ${amount}. Nothing was sent.`);
          if (bal.eth === 0n) throw new Error('Your wallet needs a little ETH on Arbitrum to pay the gas. Nothing was sent.');
          ctx.out.base = await hlUsdcTotal(ctx.user);
          const provider = await walletProvider(ctx.user);
          if (Number(await provider.request({ method: 'eth_chainId' })) !== ARB_CHAIN_ID) throw new Error('Your wallet is not on Arbitrum. Try again to switch it. Nothing was sent.');
          const wallet = createWalletClient({ account: ctx.user, chain: arbitrum, transport: custom(provider) });
          hash = await wallet.writeContract({ address: ARB_USDC, abi: erc20Abi, functionName: 'transfer', args: [HL_BRIDGE, p.units] });
          ctx.out.depositHash = hash;
        }
        const rc = await arb.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (rc.status !== 'success') {
          ctx.out.depositHash = undefined;
          throw new Error('The transfer was reverted on Arbitrum, so nothing was sent. Try again.');
        }
        const moved = parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: 'Transfer' }).some(
          (l) => l.address.toLowerCase() === ARB_USDC.toLowerCase() && l.args.from.toLowerCase() === ctx.user.toLowerCase() && l.args.to.toLowerCase() === HL_BRIDGE && l.args.value === p.units,
        );
        if (!moved) throw new Error(`Transaction ${short(hash)} confirmed without the expected USDC transfer. Check it on Arbiscan before trying again.`);
        return `Confirmed on Arbitrum (${short(hash)})`;
      },
    },
    {
      t: 'Wait for the deposit to be credited',
      d: 'Usually under a minute',
      active: 'Waiting for the deposit to be credited…',
      run: async (ctx) => {
        const base = Number(ctx.out.base ?? 0);
        const need = Number(amount) * 0.99;
        const end = Date.now() + (p.waitMs ?? 180_000);
        while (Date.now() < end) {
          const now = await hlUsdcTotal(ctx.user).catch(() => null);
          if (now !== null && now - base >= need) return `${amount} USDC credited`;
          await sleep(p.pollMs ?? 4000);
        }
        throw new Error('The deposit has not shown up yet. The transfer is confirmed on Arbitrum and deposits usually arrive within a minute: try again to keep waiting.');
      },
    },
    {
      t: `Switch your wallet back to ${CHAIN.label}`,
      wallet: true,
      d: 'Where spot trading on Velum runs',
      run: async (ctx) => {
        try {
          return (await switchWallet(await walletProvider(ctx.user), CHAIN.id)) ? 'Switched back' : null;
        } catch {
          return 'Switch back from your wallet when you are ready';
        }
      },
    },
  ];
  return {
    title: 'Deposit USDC to your perps account',
    review: [
      ['Amount', `${amount} USDC`],
      ['From', 'Your wallet on Arbitrum'],
      ['To', 'Your perps account (this same address)'],
      ['Venue', 'Hyperliquid, where your perps account is held'],
      ['Network fee', 'A little ETH on Arbitrum'],
      ['Arrives', 'Usually within a minute'],
    ],
    note: "A real USDC transfer on Arbitrum from your wallet to the deposit bridge contract, credited to your perps account at this same address. Velum never holds the funds. Deposits under 5 USDC are lost, so Velum only sends 5 USDC or more.",
    ack: 'I understand this sends real USDC from my wallet on Arbitrum to my perps account.',
    confirmLabel: 'Deposit',
    steps,
    done: (ctx) => {
      const h = ctx.out.depositHash as string | undefined;
      return {
        rows: [
          ['Deposited', `${amount} USDC`],
          ['To', 'Your perps account'],
          ['Arbitrum transfer', h ? short(h) : '—'],
        ],
        toast: 'Deposit credited',
      };
    },
    user: p.user,
  };
}
