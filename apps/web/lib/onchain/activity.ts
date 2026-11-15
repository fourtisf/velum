/**
 * The API's activity items (GET /v1/accounts/:address/activity, Phase 3) as the prototype's activity rows:
 * a title, a line under it and an icon. Amounts arrive as exact decimal strings and are only formatted
 * here; anything malformed shows as a dash, never as a guessed number. Words come from a fixed vocabulary
 * (web audit W3-12): market and token names must be symbols of this build's deployment, an unknown kind is
 * "Other contract activity", and no text chosen by the API is ever shown.
 */
import { parseWad } from '@velum/math';
import type { IconName } from '@/components/icons';
import type { ActivityDTO } from '../api';
import { fmt, shortH } from '../format';

export interface ActivityRow {
  t: number;
  title: string;
  sub: string;
  icon: IconName;
  tx: string;
}

const DEC_RE = /^-?\d{1,40}(\.\d{1,36})?$/;

/** An exact decimal string formatted to `dp` decimals, or a dash when it is not one. */
export function dec(v: unknown, dp = 2): string {
  if (typeof v !== 'string' || !DEC_RE.test(v)) return '—';
  const w = parseWad(v);
  return w === null ? '—' : fmt(w, dp);
}

const signed = (v: unknown): string => {
  const s = dec(v);
  return s === '—' ? s : s.startsWith('-') ? `-$${s.slice(1)}` : `+$${s}`;
};

/** A whole number shown as such (ids, basis points), else '?'. */
const num = (v: unknown): string => (typeof v === 'string' && /^\d{1,30}$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : '?');
const dp = (sym: string) => (sym === 'USDG' ? 2 : 4);
/** A 0x address shortened, else '?'. */
const addr = (v: unknown): string => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? shortH(v) : '?');

const MODULE: Record<string, string> = { perpsMarkets: 'perps market', spotPools: 'spot pools', makerBook: 'maker book' };

/** The fallback for a kind this build does not know: fixed words only. */
export const OTHER_ACTIVITY = 'Other contract activity';

/**
 * One activity row. `syms` are the deployment's token symbols: any other market or token name from the API
 * shows as '?'.
 */
export function activityRow(a: ActivityDTO, me: string, syms: ReadonlySet<string>): ActivityRow {
  const d = a.data;
  const str = (v: unknown): string => (typeof v === 'string' && syms.has(v) ? v : '?');
  const mkt = str(a.market ?? '');
  const t = typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : 0;
  const base = { t, tx: a.tx };
  const side = d.side === 'short' ? 'short' : 'long';
  const role = d.role === 'maker' ? 'maker' : 'taker';
  switch (a.kind) {
    case 'deposit': {
      const tok = str(d.token);
      const fromMe = typeof d.from === 'string' && d.from.toLowerCase() === me.toLowerCase();
      return { ...base, icon: 'shieldIn', title: `Shielded ${dec(d.amount, dp(tok))} ${tok}`, sub: fromMe ? 'Public deposit into your vault balance' : `Deposit from ${addr(d.from)}` };
    }
    case 'withdraw': {
      const tok = str(d.token);
      return { ...base, icon: 'shieldOut', title: `Unshielded ${dec(d.amount, dp(tok))} ${tok}`, sub: `To ${addr(d.to)}` };
    }
    case 'approval':
      return { ...base, icon: 'info', title: `${d.approved === false ? 'Revoked' : 'Approved'} the ${MODULE[String(d.module)] ?? 'module'}`, sub: 'Vault approval' };
    case 'position_open':
      return role === 'taker'
        ? { ...base, icon: 'trade', title: `Opened ${side} ${mkt}`, sub: `${dec(d.qty, 4)} ${mkt} at ${dec(d.entry)}, ${dec(d.takerMargin)} USDG margin` }
        : { ...base, icon: 'offer', title: `Your offer filled a ${side} ${mkt}`, sub: `${dec(d.qty, 4)} ${mkt} at ${dec(d.entry)}, ${dec(d.makerMargin)} USDG of your margin` };
    case 'position_close':
      return { ...base, icon: 'trade', title: `Closed ${side} ${mkt}`, sub: role === 'taker' ? `At ${dec(d.price)}` : 'Closed by the taker' };
    case 'position_add_margin':
      return { ...base, icon: 'trade', title: `Added margin to ${mkt} #${num(d.positionId)}`, sub: `Margin now ${dec(role === 'taker' ? d.takerMargin : d.makerMargin)} USDG` };
    case 'position_remove_margin':
      return { ...base, icon: 'trade', title: `Removed margin from ${mkt} #${num(d.positionId)}`, sub: `Margin now ${dec(d.takerMargin)} USDG` };
    case 'position_liquidate':
      return { ...base, icon: 'trade', title: `Liquidated ${side} ${mkt}`, sub: `At ${dec(d.price)}` };
    case 'position_forced_exit':
      return { ...base, icon: 'trade', title: `Forced exit of ${side} ${mkt}`, sub: `At ${dec(d.price)}` };
    case 'position_settled':
      return {
        ...base,
        icon: 'trade',
        title: `Settled ${mkt} #${num(d.positionId)}`,
        sub: d.role === 'maker' ? `${dec(d.payout)} USDG back to your vault` : `P&L ${signed(d.pnl)}, ${dec(d.payout)} USDG back to your vault`,
      };
    case 'forced_exit_requested':
      return { ...base, icon: 'info', title: `Forced exit requested on ${mkt} #${num(d.positionId)}`, sub: typeof d.settleAfter === 'number' ? `Settles from ${new Date(d.settleAfter).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '' };
    case 'liquidation_reward':
      return { ...base, icon: 'trade', title: `Liquidation reward on ${mkt} #${num(d.positionId)}`, sub: `${dec(d.reward)} USDG` };
    case 'offer_posted':
      return { ...base, icon: 'offer', title: `Posted a ${mkt} offer`, sub: `${dec(d.backing)} USDG backing, ${num(d.openSpreadBps)}/${num(d.closeSpreadBps)} bps` };
    case 'offer_filled':
      return { ...base, icon: 'offer', title: `Offer #${num(d.offerId)} filled`, sub: `${dec(d.fillSize)} USDG position, ${dec(d.backingLeft)} USDG backing left` };
    case 'offer_withdrawn':
      return { ...base, icon: 'offer', title: `Withdrew offer #${num(d.offerId)}`, sub: `${dec(d.returned)} USDG back to your vault` };
    case 'swap': {
      const tin = str(d.tokenIn);
      const tout = str(d.tokenOut);
      return { ...base, icon: 'swapI', title: `Swapped ${dec(d.amountIn, dp(tin))} ${tin} for ${dec(d.amountOut, dp(tout))} ${tout}`, sub: 'Through the Velum pools' };
    }
    case 'liquidity_add':
      return { ...base, icon: 'drop', title: `Added liquidity to the ${mkt} pool`, sub: `${dec(d.usdgAmount)} USDG and ${dec(d.stockAmount, 4)} ${mkt}` };
    case 'liquidity_remove':
      return { ...base, icon: 'drop', title: `Removed liquidity from the ${mkt} pool`, sub: `${dec(d.usdgAmount)} USDG and ${dec(d.stockAmount, 4)} ${mkt}` };
    case 'bond_refund':
      return { ...base, icon: 'info', title: 'Forced-exit bond refund deferred', sub: `${dec(d.amountEth, 4)} ETH to claim` };
    case 'bond_claimed':
      return { ...base, icon: 'info', title: 'Claimed your forced-exit bond', sub: `${dec(d.amountEth, 4)} ETH` };
    case 'insurance_funded':
      return { ...base, icon: 'info', title: 'Funded the insurance fund', sub: `${dec(d.amount)} USDG` };
    case 'cover_claim':
      return { ...base, icon: 'info', title: 'Shortfall cover claim filed', sub: `${dec(d.amount)} USDG` };
    case 'cover_paid':
      return { ...base, icon: 'info', title: 'Shortfall cover paid', sub: `${dec(d.paid)} USDG` };
    default:
      return { ...base, icon: 'info', title: OTHER_ACTIVITY, sub: '' };
  }
}

