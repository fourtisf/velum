'use client';
/**
 * The perps statement each wallet accepts once per version of the terms (lib/geo.ts usePerpsTerms): where perps are not
 * offered, the Terms of Use and Risk Disclosure, and what leverage can cost.
 */
import Link from 'next/link';
import { useState } from 'react';
import { usePerpsTerms } from '@/lib/geo';
import { PERPS_RESTRICTED } from '@/lib/legal';
import { useApp } from '@/lib/store';
import { I } from '../icons';

export function HlTermsModal() {
  const s = useApp();
  const accept = usePerpsTerms((t) => t.accept);
  const [a, setA] = useState([false, false, false]);
  const user = s.account?.addr;
  const items = [
    <>I am not a resident or citizen of the United States, and I am not in {PERPS_RESTRICTED.replace('the United States, ', '')}.</>,
    <>
      I have read the{' '}
      <Link href="/terms" target="_blank">
        Terms of Use
      </Link>{' '}
      and the{' '}
      <Link href="/risk" target="_blank">
        Risk Disclosure
      </Link>
      .
    </>,
    <>I understand perps use leverage, that positions can be liquidated, and that I can lose all the margin I put in.</>,
  ];
  return (
    <>
      <div className="m-head">
        <h3 id="m-title">Before you trade perps</h3>
        <button className="xbtn" aria-label="Close" onClick={() => s.closeModal(true)}>
          <I.x />
        </button>
      </div>
      <p className="m-text">Perps are real leveraged trades from your own account. Please confirm each statement. You only do this once per wallet.</p>
      <div className="terms-list">
        {items.map((t, i) => (
          <label key={i} className="boxnote" style={{ cursor: 'pointer', color: 'var(--text)' }}>
            <input type="checkbox" checked={a[i]} onChange={(e) => setA((v) => v.map((x, j) => (j === i ? e.target.checked : x)))} style={{ width: 15, height: 15, flex: 'none', marginTop: 2, accentColor: 'var(--acc)' }} />
            <span>{t}</span>
          </label>
        ))}
      </div>
      <button
        className="btn btn-white btn-block"
        style={{ marginTop: 12 }}
        disabled={!user || a.some((x) => !x)}
        onClick={() => {
          if (!user) return;
          accept(user);
          s.closeModal(true);
          s.toast('Perps terms accepted');
        }}
      >
        Accept and continue
      </button>
    </>
  );
}
