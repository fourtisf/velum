'use client';
/**
 * Velum's token contract address ("CA"), in the landing hero and footer only (owner request). Not set:
 * "CA · Coming soon" with a copy button that is announced as unavailable and does nothing. Set (a
 * checksummed NEXT_PUBLIC_TOKEN_CA, lib/token-ca): the shortened address (the full one in its title and
 * for screen readers), a button that copies the full address, and a link to it on the Robinhood Chain
 * explorer. Only "CA" and the address: no price, return or sale wording.
 */
import type { Address } from 'viem';
import { ENV } from '@/lib/env';
import { useApp } from '@/lib/store';
import { caExplorerUrl, copyTokenCa, shortCa } from '@/lib/token-ca';
import { ExtLink, I } from '../icons';

export const CA_COPY = {
  label: 'CA',
  soon: 'Coming soon',
  soonTitle: 'Contract address coming soon',
  copied: 'Contract address copied',
  copyFailed: "Couldn't copy the contract address",
} as const;

export function ContractPill({ ca = ENV.tokenCa, className = '' }: { ca?: Address | null; className?: string }) {
  const toast = useApp((s) => s.toast);
  const explorer = ca ? caExplorerUrl(ca) : null;
  const copy = async () => {
    if (!ca) return;
    const ok = await copyTokenCa(ca);
    toast(ok ? CA_COPY.copied : CA_COPY.copyFailed, !ok);
  };
  return (
    <div className={`pill ca-pill ${className}`.trim()} role="group" aria-label="Contract address">
      <span className="badge acc">{CA_COPY.label}</span>
      {ca ? (
        <span className="ca-addr" title={ca}>
          <span aria-hidden="true">{shortCa(ca)}</span>
          <span className="sr">{ca}</span>
        </span>
      ) : (
        <span className="ca-soon">{CA_COPY.soon}</span>
      )}
      {ca ? (
        <button type="button" className="icb" title="Copy contract address" aria-label={`Copy contract address ${ca}`} onClick={() => void copy()}>
          <I.copy />
        </button>
      ) : (
        // Unavailable but still focusable and announced (aria-disabled, not disabled): it explains itself.
        <button type="button" className="icb" title={CA_COPY.soonTitle} aria-label={CA_COPY.soonTitle} aria-disabled="true">
          <I.copy />
        </button>
      )}
      {explorer ? (
        <a className="icb" href={explorer} target="_blank" rel="noopener noreferrer" title="View on the Robinhood Chain explorer" aria-label="View the contract on the Robinhood Chain explorer">
          <ExtLink />
        </a>
      ) : null}
    </div>
  );
}
