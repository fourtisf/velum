'use client';
/**
 * The real (Phase 3) views, loaded only on a real build (a deployment compiled in, lib/onchain/deployment.ts):
 * a build without one never downloads them. On a real build the first paint shows these placeholders where
 * the real views go, never the simulated demo (web audit W3-02).
 */
import dynamic from 'next/dynamic';

const Busy = ({ cls, label, h }: { cls: string; label?: string; h: number }) => <aside className={`card ${cls}`} aria-label={label} aria-busy="true" style={{ minHeight: h }} />;

export const OnchainTicket = dynamic(() => import('./Ticket').then((m) => m.OnchainTicket), { ssr: false, loading: () => <Busy cls="ticket" label="Order ticket" h={520} /> });
export const OcAccountCard = dynamic(() => import('./Account').then((m) => m.OcAccountCard), { ssr: false, loading: () => <Busy cls="acct" h={180} /> });
export const OcPortfolio = dynamic(() => import('./Account').then((m) => m.OcPortfolio), {
  ssr: false,
  loading: () => (
    <div className="vhead">
      <div>
        <h1 className="vtitle">Portfolio</h1>
      </div>
    </div>
  ),
});
export const OcWalletTotal = dynamic(() => import('./Account').then((m) => m.OcWalletTotal), { ssr: false });
export const OcMoveModal = dynamic(() => import('./Account').then((m) => m.OcMoveModal), { ssr: false });
export const OcPositionsCard = dynamic(() => import('./Positions').then((m) => m.OcPositionsCard), { ssr: false, loading: () => <Busy cls="posbox" h={160} /> });
export const ManageModal = dynamic(() => import('./Positions').then((m) => m.ManageModal), { ssr: false });
export const OcSwapView = dynamic(() => import('./Swap').then((m) => m.OcSwapView), { ssr: false });
export const OcLiquidityView = dynamic(() => import('./Earn').then((m) => m.OcLiquidityView), { ssr: false });
export const OcLpAddModal = dynamic(() => import('./Earn').then((m) => m.OcLpAddModal), { ssr: false });
export const OcMakersView = dynamic(() => import('./Earn').then((m) => m.OcMakersView), { ssr: false });
export const TxFlowModal = dynamic(() => import('../modals/TxFlow').then((m) => m.TxFlowModal), { ssr: false });
export const GuardBannerBadge = dynamic(() => import('./Banner').then((m) => m.GuardBannerBadge), { ssr: false });
