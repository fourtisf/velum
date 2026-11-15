/**
 * Turns a failed simulation, a rejected wallet request or a reverted transaction into one plain sentence.
 * Reverts are decoded from the contracts' custom errors (lib/onchain/abi.ts); amounts are formatted with the
 * token's own decimals. Nothing here guesses: an error that cannot be decoded says so and shows viem's
 * short message.
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, formatUnits, type Hex } from 'viem';
import { ALL_ERRORS_ABI } from './abi';

export interface ErrorContext {
  /** Symbol of a token address (lower or mixed case), or null when unknown. */
  sym: (addr: string) => string | null;
  /** Decimals of a token address, or null when unknown. */
  dec: (addr: string) => number | null;
}

export interface DecodedError {
  /** The custom error's name, when it was decoded. */
  name: string | null;
  message: string;
  /** The user declined in the wallet: nothing was sent. */
  rejected: boolean;
}

const time = (s: bigint) => new Date(Number(s) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const px = (p: unknown) => (typeof p === 'bigint' ? Number(formatUnits(p, 18)).toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(p));

function amount(ctx: ErrorContext, token: unknown, v: unknown): string {
  if (typeof v !== 'bigint') return String(v);
  const t = typeof token === 'string' ? token : '';
  const d = ctx.dec(t);
  const s = ctx.sym(t);
  return d === null ? `${v.toString()} base units` : `${formatUnits(v, d)}${s ? ` ${s}` : ''}`;
}

/** What the caller knows about the transaction that helps word its errors. */
export interface RevertExtra {
  /** The token a swap or liquidity removal pays out (for Slippage amounts). */
  outToken?: string;
}

/** The sentence for a decoded custom error. `usdg` is the USDG token address (for USDG-denominated args). */
export function describeRevert(name: string, args: readonly unknown[], ctx: ErrorContext, usdg: string, extra: RevertExtra = {}): string {
  const a = args;
  const usd = (v: unknown) => amount(ctx, usdg, v);
  switch (name) {
    case 'PriceLimit':
      return `The price moved past your slippage limit: the trade would execute at ${px(a[0])}, beyond your limit of ${px(a[1])}. Nothing was traded. Try again, or allow more slippage.`;
    case 'Slippage':
      return extra.outToken
        ? `The pool price moved past your slippage limit: you would get ${amount(ctx, extra.outToken, a[0])}, below your minimum of ${amount(ctx, extra.outToken, a[1])}. Nothing was traded. Try again, or allow more slippage.`
        : 'The pool price moved past your slippage limit, so nothing was traded. Try again, or allow more slippage.';
    case 'NoPriceLimit':
    case 'NoMinimum':
      return 'The transaction had no price protection, so the contract refused it.';
    case 'PriceLagging':
      return 'The onchain price is still catching up with the market, so trading is paused for a moment. Try again in a few seconds.';
    case 'StalePrice':
      return 'The onchain price is too old to trade on (opens need a price at most 10 seconds old). Wait for the next price update and try again.';
    case 'NoPrice':
      return 'This market has no onchain price yet.';
    case 'SequencerDown':
      return 'The network sequencer is down or just came back, so this action is paused for now.';
    case 'CloseOnly':
      return 'This market only accepts closes right now.';
    case 'InsufficientBalance':
      return `Not enough in your vault balance: you have ${amount(ctx, a[1], a[2])}, this needs ${amount(ctx, a[1], a[3])}.`;
    case 'NotApproved':
      return 'This Velum module is not allowed to use your vault balance yet. Approve it and try again.';
    case 'NotAllowlisted':
      return 'This wallet is not on the guarded beta allowlist, so it cannot deposit or approve trading yet. Withdrawals and closes always work.';
    case 'AccountCapExceeded':
      return `This deposit is above your guarded beta limit: it would bring your deposits to ${amount(ctx, a[1], a[2])}, over the cap of ${amount(ctx, a[1], a[3])}.`;
    case 'GlobalCapExceeded':
      return `The guarded beta is full for this token: total deposits would reach ${amount(ctx, a[0], a[1])}, over the cap of ${amount(ctx, a[0], a[2])}.`;
    case 'PositionTooSmall':
      return `Positions must be at least ${usd(a[1])}.`;
    case 'BadQuantity':
      return 'This size is above the 100-token limit per position at the current price.';
    case 'BadLeverage':
      return 'Leverage must be between 1x and 5x in 0.5 steps.';
    case 'OpenInterestCap':
      return 'This side of the market is at its open-interest cap.';
    case 'SelfTrade':
      return 'You cannot fill your own maker offer.';
    case 'OfferInactive':
    case 'OfferExpired':
    case 'WrongMarket':
      return 'The maker offer is no longer available. Refresh and try again.';
    case 'FillTooLarge':
      return `This size is above what the best maker offer fills at once (${usd(a[1])}). Lower the size.`;
    case 'InsufficientBacking':
      return 'The maker offer does not have enough backing left for this size.';
    case 'BelowInitialMargin':
      return 'That would take the position below the 20% initial margin. Remove less.';
    case 'ExceedsMargin':
      return `You can remove at most ${usd(a[1])}.`;
    case 'NotOpen':
      return 'This position is already closed.';
    case 'NotTaker':
    case 'NotParty':
      return 'Only a party to this position can do that.';
    case 'AlreadyRequested':
      return 'A forced exit was already requested for this position.';
    case 'NotRequested':
      return 'No forced exit was requested for this position.';
    case 'TooEarly':
      return `The forced exit can be settled from ${typeof a[0] === 'bigint' ? time(a[0]) : 'later'}.`;
    case 'BadBond':
      return 'A forced exit needs exactly the 0.001 ETH bond.';
    case 'NothingToClaim':
      return 'There is nothing to claim.';
    case 'NotLiquidatable':
      return 'This position is not liquidatable.';
    case 'BadOffer':
      return 'The offer terms are not valid: backing and largest fill above zero, largest fill at most the backing, open spread 2 to 500 bps, close spread at most 500 bps, and an end time in the future.';
    case 'NotMaker':
      return 'Only the maker can withdraw this offer.';
    case 'NoLiquidity':
    case 'UnknownPool':
      return 'This pool has no liquidity yet.';
    case 'InsufficientShares':
      return 'You do not hold that many pool shares.';
    case 'Expired':
      return 'The transaction waited too long and its deadline passed. Try again.';
    case 'SameToken':
      return 'Choose two different tokens.';
    case 'ZeroAmount':
      return 'The amount is too small.';
    case 'ModuleRecipient':
    case 'ProtocolRecipient':
      return 'Tokens cannot be sent to a Velum contract address. Use a wallet address.';
    case 'UnknownToken':
    case 'UnknownMarket':
      return 'This token is not listed in this deployment.';
    case 'ERC20InsufficientAllowance':
      return 'The token approval is lower than the amount. Approve the exact amount and try again.';
    case 'ERC20InsufficientBalance':
      return 'Your wallet does not hold enough of this token.';
    case 'SafeERC20FailedOperation':
      return 'The token transfer failed: check your wallet balance and approval.';
    default:
      return `The contract refused this transaction (${name}).`;
  }
}

/** Raw revert data anywhere in a viem error chain. */
function rawData(err: BaseError): Hex | null {
  let found: Hex | null = null;
  err.walk((e) => {
    const d = (e as { data?: unknown; raw?: unknown }).raw ?? (e as { data?: unknown }).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) found = d as Hex;
    return false;
  });
  return found;
}

export function isUserRejection(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return true;
  const code = (e as { code?: number; cause?: { code?: number } })?.code ?? (e as { cause?: { code?: number } })?.cause?.code;
  return code === 4001 || /user (rejected|denied)|rejected the request|request rejected/i.test(String((e as Error)?.message ?? ''));
}

/** One sentence for anything a write can throw. */
export function decodeTxError(e: unknown, ctx: ErrorContext, usdg: string, extra: RevertExtra = {}): DecodedError {
  if (isUserRejection(e)) return { name: null, message: 'You declined the request in your wallet. Nothing was sent.', rejected: true };
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName) {
      const name = reverted.data.errorName;
      if (name === 'Error' || name === 'Panic') return { name, message: panicText(reverted), rejected: false };
      return { name, message: describeRevert(name, reverted.data.args ?? [], ctx, usdg, extra), rejected: false };
    }
    const raw = rawData(e);
    if (raw) {
      try {
        const d = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: raw });
        return { name: d.errorName, message: describeRevert(d.errorName, d.args ?? [], ctx, usdg, extra), rejected: false };
      } catch {
        /* not one of ours: fall through */
      }
    }
    if (/insufficient funds/i.test(e.message)) return { name: null, message: 'Your wallet does not have enough ETH to pay the gas.', rejected: false };
    return { name: null, message: (e.shortMessage || e.message).split('\n')[0]!.slice(0, 200), rejected: false };
  }
  return { name: null, message: String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 200), rejected: false };
}

function panicText(e: ContractFunctionRevertedError): string {
  if (e.data?.errorName === 'Panic') return 'The transaction would fail (an amount is larger than a balance or allowance).';
  const reason = e.reason ?? (typeof e.data?.args?.[0] === 'string' ? e.data.args[0] : null);
  return reason ? `The contract refused this transaction: ${reason}` : 'The contract refused this transaction.';
}
