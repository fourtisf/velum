'use client';
/**
 * The dialog of a real (Phase 3) flow, in the prototype's flow shape (step list, then a receipt):
 *  1. review: the exact amounts, fees and limits, and nothing asked of the wallet yet;
 *  2. one step per transaction with its real state: checking against the chain (simulation), waiting for a
 *     fresh price, signature requested, submitted (hash, explorer link), confirmed, skipped or failed with the
 *     contract's reason decoded;
 *  3. the receipt with every transaction.
 * A wallet on the wrong network is refused before anything is sent, with a button to switch.
 */
import { CHAIN } from '@velum/config';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hash } from 'viem';
import { COPY } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { shortH } from '@/lib/format';
import { decodeTxError, type ErrorContext } from '@/lib/onchain/errors';
import type { Row, TxFlowSpec, TxRunCtx } from '@/lib/onchain/flow';
import { SendRefused, TxReverted, sendTx, switchToDeployment, txUrl, type TxStage } from '@/lib/onchain/tx';
import { useApp } from '@/lib/store';
import { I } from '../icons';

type StepState = { stage: 'idle' | TxStage | 'skipped' | 'failed'; hash?: Hash; error?: string };
type Phase = 'review' | 'running' | 'failed' | 'done';
type Fail = { message: string; kind: 'wrong-chain' | 'retry' | 'final'; hash?: Hash };

/** A transaction hash, linked to the explorer when there is one. */
export function TxLink({ hash }: { hash: string }) {
  const url = txUrl(hash);
  return url ? (
    <a className="lnk" href={url} target="_blank" rel="noopener noreferrer">
      {shortH(hash)}
    </a>
  ) : (
    <span title={hash}>{shortH(hash)}</span>
  );
}

const STAGE_TEXT: Record<TxStage, string> = {
  checking: 'Checking the transaction against the chain…',
  waiting: 'Waiting for a fresh onchain price…',
  sign: 'Confirm in your wallet',
  submitted: 'Submitted, waiting for confirmation',
  confirmed: 'Confirmed',
};

const CANCEL_AFTER_MS = 5000;

export function TxFlowModal({ flow }: { flow: TxFlowSpec }) {
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const close = useApp((s) => s.closeModal);
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('review');
  const [states, setStates] = useState<StepState[]>(() => flow.steps.map(() => ({ stage: 'idle' })));
  const [fail, setFail] = useState<Fail | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [slow, setSlow] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ctx = useRef<TxRunCtx>({ d: flow.d, proto: flow.proto, account: flow.account, out: {}, txs: [] });
  const from = useRef(0);
  const attempt = useRef(0);
  const doneBtn = useRef<HTMLButtonElement>(null);

  const errCtx: ErrorContext = {
    sym: (a) => Object.entries(flow.d.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0] ?? null,
    dec: (a) => {
      const s = Object.entries(flow.d.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0];
      return s ? (flow.proto.decimals[s] ?? null) : null;
    },
  };
  const setStep = (i: number, st: StepState) => setStates((all) => all.map((x, j) => (j === i ? st : x)));
  const signing = states.some((s) => s.stage === 'sign');

  useEffect(() => {
    setSlow(false);
    if (!signing) return;
    const t = setTimeout(() => setSlow(true), CANCEL_AFTER_MS);
    return () => clearTimeout(t);
  }, [signing]);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  useEffect(() => {
    if (phase === 'done') doneBtn.current?.focus({ preventScroll: true });
  }, [phase]);

  const refresh = () => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('oc-') || q.queryKey[0] === 'public-balances' });

  const run = async () => {
    const my = ++attempt.current;
    const live = () => attempt.current === my;
    setFail(null);
    setPhase('running');
    set({ modalLocked: true });
    for (let i = from.current; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      from.current = i;
      // Once a transaction is submitted, a failure to read its receipt must never offer "Try again": it may
      // still confirm, and sending it again would do it twice.
      let submitted: Hash | undefined;
      try {
        setStep(i, { stage: 'checking' });
        const call = await step.call(ctx.current);
        if (!live()) return;
        if (!call) {
          setStep(i, { stage: 'skipped' });
          continue;
        }
        const { hash, receipt } = await sendTx(flow.d, flow.account, call, {
          waitFor: step.waitFor,
          live,
          onStage: (stage, h) => {
            if (stage === 'submitted') submitted = h;
            if (live()) setStep(i, { stage, hash: h });
          },
        });
        if (!live()) return;
        step.after?.(receipt, ctx.current);
        ctx.current.txs.push({ label: step.label, hash });
        setStep(i, { stage: 'confirmed', hash });
      } catch (e) {
        if (!live()) return;
        let f: Fail;
        if (e instanceof SendRefused) {
          f =
            e.reason === 'wrong-chain'
              ? { kind: 'wrong-chain', message: `Your wallet is on another network. Switch it to ${COPY.chainLabel} (chain ID ${flow.d.chainId}) to continue. Nothing was sent.` }
              : e.reason === 'account-changed'
                ? { kind: 'final', message: 'Your wallet switched to another account, so nothing was sent. Start again from the account you want to use.' }
                : e.reason === 'not-connected'
                  ? { kind: 'final', message: 'Your wallet is not connected. Connect it and try again. Nothing was sent.' }
                  : { kind: 'final', message: 'This build does not send transactions on this network. Nothing was sent.' };
        } else if (submitted && !(e instanceof TxReverted)) {
          f = { kind: 'final', hash: submitted, message: 'The transaction was submitted, but its confirmation could not be read. It may still confirm: check it in the explorer (or your wallet) before doing this again.' };
        } else if (e instanceof TxReverted) {
          f = { kind: 'final', hash: e.hash, message: `The transaction was mined but reverted. ${decodeTxError(e.reason, errCtx, flow.d.tokens.USDG!, { outToken: step.outToken }).message}` };
        } else {
          const d = decodeTxError(e, errCtx, flow.d.tokens.USDG!, { outToken: step.outToken });
          f = { kind: d.rejected ? 'retry' : d.name ? 'final' : 'retry', message: d.message };
        }
        const label = e instanceof TxReverted ? 'Reverted onchain' : f.hash ? 'Submitted, not confirmed' : f.kind === 'wrong-chain' ? 'Not sent: wrong network' : 'Not sent';
        setStep(i, { stage: 'failed', error: label, hash: f.hash });
        setFail(f);
        setPhase('failed');
        set({ modalLocked: false });
        toast(f.kind === 'wrong-chain' ? 'Wrong network' : 'Transaction not completed', true);
        if (ctx.current.txs.length) refresh();
        return;
      }
    }
    const r = flow.done(ctx.current);
    setRows([...r.rows, ...ctx.current.txs.map(({ label, hash }): Row => [`${label} tx`, <TxLink key={hash} hash={hash} />])]);
    setPhase('done');
    set({ modalLocked: false });
    toast(r.toast);
    refresh();
  };

  const cancel = () => {
    attempt.current++;
    setFail({ kind: 'retry', message: 'Cancelled. If your wallet still shows the request, reject it there.' });
    setStates((all) => all.map((s) => (s.stage === 'sign' || s.stage === 'checking' || s.stage === 'waiting' ? { stage: 'idle' } : s)));
    setPhase('failed');
    set({ modalLocked: false });
  };

  const doSwitch = async () => {
    setSwitching(true);
    try {
      await switchToDeployment(flow.d);
      setFail(null);
      void run();
    } catch (e) {
      setFail({ kind: 'wrong-chain', message: decodeTxError(e, errCtx, flow.d.tokens.USDG!).message });
    } finally {
      setSwitching(false);
    }
  };

  const detail = (st: StepState, d?: string): ReactNode => {
    if (st.stage === 'failed')
      return (
        <span className="down">
          {st.error}
          {st.hash ? (
            <>
              : <TxLink hash={st.hash} />
            </>
          ) : null}
        </span>
      );
    if (st.stage === 'skipped') return 'Already done';
    if (st.stage === 'idle') return d ?? '';
    if ((st.stage === 'submitted' || st.stage === 'confirmed') && st.hash)
      return (
        <>
          {STAGE_TEXT[st.stage]}: <TxLink hash={st.hash} />
        </>
      );
    return STAGE_TEXT[st.stage];
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
          <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => void run()}>
            {flow.confirmLabel ?? 'Confirm in wallet'}
          </button>
          <p className="ph-sub" style={{ textAlign: 'center', paddingTop: 8 }}>
            {ENV.localRpc ? 'Local test chain.' : CHAIN.testnet ? 'Testnet. Test tokens have no value.' : `${CHAIN.label}.`} Each step asks your wallet to sign one transaction.
          </p>
        </>
      ) : (
        <>
          <ol className="flow">
            {flow.steps.map((st, i) => {
              const s = states[i]!;
              const cls = s.stage === 'confirmed' || s.stage === 'skipped' ? 'done' : s.stage === 'failed' ? 'fail' : s.stage === 'idle' ? '' : 'active';
              return (
                <li key={i} className={cls}>
                  <span className="ic">{cls === 'done' ? <I.check /> : cls === 'fail' ? <I.x /> : null}</span>
                  <div>
                    <div className="t">{st.t}</div>
                    <div className="d" aria-live="polite">
                      {detail(s, st.d)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {phase === 'running' && signing && slow ? (
            <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={cancel}>
              Cancel
            </button>
          ) : null}
          {phase === 'failed' && fail ? (
            <>
              <div className="boxnote warn" role="alert">
                <I.info />
                <span>{fail.message}</span>
              </div>
              {fail.kind === 'wrong-chain' ? (
                <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={switching} onClick={() => void doSwitch()}>
                  {switching ? 'Waiting for your wallet…' : COPY.switchTo}
                </button>
              ) : fail.kind === 'retry' ? (
                <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => void run()}>
                  Try again
                </button>
              ) : null}
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
