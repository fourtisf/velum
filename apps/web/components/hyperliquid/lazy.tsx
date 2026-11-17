'use client';
/**
 * Real perps through Hyperliquid (Robinhood Chain mainnet builds only, lib/hyperliquid): loaded on demand, so testnet
 * builds and pages without a ticket never download the Hyperliquid SDK.
 */
import dynamic from 'next/dynamic';

const Busy = ({ h }: { h: number }) => <div aria-busy="true" style={{ minHeight: h }} />;
const BusyCard = ({ h }: { h: number }) => <section className="card posbox" aria-busy="true" style={{ minHeight: h }} />;

export const HlPerpsTicket = dynamic(() => import('./HlPerpsTicket').then((m) => m.HlPerpsTicket), { ssr: false, loading: () => <Busy h={520} /> });
export const HlPositionsCard = dynamic(() => import('./HlPositions').then((m) => m.HlPositionsCard), { ssr: false, loading: () => <BusyCard h={160} /> });
export const HlPortfolioPositions = dynamic(() => import('./HlPositions').then((m) => m.HlPortfolioPositions), { ssr: false, loading: () => <Busy h={80} /> });
export const HlPortfolioActivity = dynamic(() => import('./HlPositions').then((m) => m.HlPortfolioActivity), { ssr: false, loading: () => <Busy h={80} /> });
export const HlOrderBook = dynamic(() => import('./HlOrderBook').then((m) => m.HlOrderBook), { ssr: false, loading: () => <section className="card obook" aria-busy="true" /> });
export const HlFlowModal = dynamic(() => import('./HlFlowModal').then((m) => m.HlFlowModal), { ssr: false, loading: () => <Busy h={320} /> });
export const HlAccountRows = dynamic(() => import('./HlAccountRows').then((m) => m.HlAccountRows), { ssr: false, loading: () => null });
export const HlDepositModal = dynamic(() => import('./HlDeposit').then((m) => m.HlDepositModal), { ssr: false, loading: () => <Busy h={360} /> });
