'use client';
/**
 * The dialog of a real perps flow on Hyperliquid (lib/hyperliquid/flows.ts), in the app's flow shape: the review with
 * every number and a statement to tick, then each step with its live state, then the receipt. The dialog stays open
 * (and cannot be dismissed) while a step runs; a failed step says why in one sentence and offers to try again, which
 * re-runs from that step (every step re-reads what it needs, so nothing is done twice).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { HlCtx, HlFlowSpec, Row } from '@/lib/hyperliquid/flows';
import { hlErrorText } from '@/lib/hyperliquid/flows';
import { useApp } from '@/lib/store';
import { I } from '../icons';

type St = { stage: 'idle' | 'active' | 'done' | 'skipped' | 'failed'; text?: string };

export function HlFlowModal({ flow }: { flow: HlFlowSpec }) {
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const close = useApp((s) => s.closeModal);
  const qc = useQueryClient();
  const [phase, setPhase] = useState<'review' | 'running' | 'failed' | 'done'>('review');
  const [states, setStates] = useState<St[]>(() => flow.steps.map(() => ({ stage: 'idle' })));
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [acked, setAcked] = useState(!flow.ack);
  const ctx = useRef<HlCtx>({ user: flow.user, agent: null, out: {} });
  const from = useRef(0);
  const mounted = useRef(true);
  const doneBtn = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (phase === 'done') doneBtn.current?.focus({ preventScroll: true });
  }, [phase]);
  const setStep = (i: number, st: St) => mounted.current && setStates((all) => all.map((x, j) => (j === i ? st : x)));
  const refresh = () => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('hl-') });

  const run = async () => {
    if (!acked) return;
    setPhase('running');
    setError(null);
    set({ modalLocked: true });
    for (let i = from.current; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      setStep(i, { stage: 'active' });
      try {
        const text = await step.run(ctx.current);
        setStep(i, text === null ? { stage: 'skipped' } : { stage: 'done', text });
        from.current = i + 1;
      } catch (e) {
        const msg = hlErrorText(e);
        setStep(i, { stage: 'failed', text: msg });
        if (!mounted.current) return;
        setError(msg);
        setPhase('failed');
        set({ modalLocked: false });
        toast('Trade not completed', true);
        refresh();
        return;
      }
    }
    if (!mounted.current) return;
    const r = flow.done(ctx.current);
    setRows(r.rows);
    setPhase('done');
    set({ modalLocked: false });
    toast(r.toast);
    refresh();
  };

  return (
    <>
      <div className="m-head">
        <h3 id="m-title">{flow.title}</h3>
        {phase === 'review' || phase === 'failed' ? (
          <button className="xbtn" aria-label="Close" onClick={() => close(true)}>
            <I.x />
          </button>
        ) : null}
      </div>
      {phase === 'review' ? (
        <>
          <div className="receipt">
            {flow.review.map(([k, v], i) => (
              <div key={i}>
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>
          {flow.note ? (
            <div className="boxnote">
              <I.info />
              <span>{flow.note}</span>
            </div>
          ) : null}
          {flow.ack ? (
            <label className="boxnote warn" style={{ cursor: 'pointer', color: 'var(--text)' }}>
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ width: 15, height: 15, flex: 'none', marginTop: 2, accentColor: 'var(--acc)' }} />
              <span>{flow.ack}</span>
            </label>
          ) : null}
          <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!acked} onClick={() => void run()}>
            {flow.confirmLabel ?? 'Confirm'}
          </button>
          <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
            Your wallet signs only approvals (no gas). Orders are signed in this browser, which can never withdraw your funds.
          </p>
        </>
      ) : (
        <>
          <ol className="flow">
            {flow.steps.map((st, i) => {
              const s = states[i]!;
              const cls = s.stage === 'done' || s.stage === 'skipped' ? 'done' : s.stage === 'failed' ? 'fail' : s.stage === 'idle' ? '' : 'active';
              const line = s.stage === 'skipped' ? 'Already done' : s.stage === 'active' ? (st.wallet ? 'Checking, then your wallet may ask to sign…' : 'Sending to Hyperliquid…') : s.stage === 'failed' ? <span className="down">{s.text}</span> : (s.text ?? st.d ?? '');
              return (
                <li key={i} className={cls}>
                  <span className="ic">{cls === 'done' ? <I.check /> : cls === 'fail' ? <I.x /> : null}</span>
                  <div>
                    <div className="t">{st.t}</div>
                    <div className="d" aria-live="polite">
                      {line}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {phase === 'failed' && error ? (
            <>
              <div className="boxnote warn" role="alert">
                <I.info />
                <span>{error}</span>
              </div>
              <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => void run()}>
                Try again
              </button>
              <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={() => close(true)}>
                Close
              </button>
            </>
          ) : null}
          {phase === 'done' && rows ? (
            <>
              <div className="receipt">
                {rows.map(([k, v], i) => (
                  <div key={i}>
                    <span>{k}</span>
                    <b>{v}</b>
                  </div>
                ))}
              </div>
              <button ref={doneBtn} className="btn btn-white btn-block" onClick={() => close(true)}>
                Done
              </button>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
