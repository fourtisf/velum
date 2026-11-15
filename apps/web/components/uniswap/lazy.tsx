'use client';
/**
 * Real spot trading through Uniswap (Robinhood Chain mainnet builds only, lib/uniswap): loaded on demand, so testnet
 * builds and pages without a ticket never download it.
 */
import dynamic from 'next/dynamic';

const Busy = ({ h }: { h: number }) => <div aria-busy="true" style={{ minHeight: h }} />;

export const UniSpotTicket = dynamic(() => import('./UniSpotTicket').then((m) => m.UniSpotTicket), { ssr: false, loading: () => <Busy h={480} /> });
export const UniSwapView = dynamic(() => import('./UniSwapView').then((m) => m.UniSwapView), { ssr: false, loading: () => <Busy h={560} /> });
