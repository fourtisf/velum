'use client';
/**
 * The real (Phase 3) views, loaded only once a deployment is live (lib/onchain/deployment.ts): a build
 * without one, or a page before the check, never downloads them.
 */
import dynamic from 'next/dynamic';

export const OnchainTicket = dynamic(() => import('./Ticket').then((m) => m.OnchainTicket), { ssr: false });
export const OcAccountCard = dynamic(() => import('./Account').then((m) => m.OcAccountCard), { ssr: false });
export const OcPortfolio = dynamic(() => import('./Account').then((m) => m.OcPortfolio), { ssr: false });
export const OcWalletTotal = dynamic(() => import('./Account').then((m) => m.OcWalletTotal), { ssr: false });
export const OcMoveModal = dynamic(() => import('./Account').then((m) => m.OcMoveModal), { ssr: false });
export const OcPositionsCard = dynamic(() => import('./Positions').then((m) => m.OcPositionsCard), { ssr: false });
export const ManageModal = dynamic(() => import('./Positions').then((m) => m.ManageModal), { ssr: false });
export const OcSwapView = dynamic(() => import('./Swap').then((m) => m.OcSwapView), { ssr: false });
export const OcLiquidityView = dynamic(() => import('./Earn').then((m) => m.OcLiquidityView), { ssr: false });
export const OcLpAddModal = dynamic(() => import('./Earn').then((m) => m.OcLpAddModal), { ssr: false });
export const OcMakersView = dynamic(() => import('./Earn').then((m) => m.OcMakersView), { ssr: false });
export const TxFlowModal = dynamic(() => import('../modals/TxFlow').then((m) => m.TxFlowModal), { ssr: false });
export const GuardBannerBadge = dynamic(() => import('./Banner').then((m) => m.GuardBannerBadge), { ssr: false });
