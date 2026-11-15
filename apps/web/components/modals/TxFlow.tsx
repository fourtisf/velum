'use client';
/**
 * The dialog of a real (Phase 3) flow, in the prototype's flow shape (step list, then a receipt):
 *  1. review: the exact amounts, fees and limits, and nothing asked of the wallet yet (plus a statement to
 *     tick when the flow carries one, e.g. a high close spread);
 *  2. one step per transaction with its real state: checking against the chain (simulation), waiting for a
 *     fresh price, signature requested, submitted (hash, explorer link), confirmed, skipped or failed with the
 *     contract's reason decoded;
 *  3. the receipt with every transaction.
 * A wallet on the wrong network is refused before anything is sent, with a button to switch.
 *
 * Never twice (web audit W3-01): "Cancel" while the wallet prompt is open stops nothing in the wallet, so the
 * request stays tracked: a hash that arrives afterwards is followed to its receipt and shown, and a step that
 * reached the signature is never sent again blindly. Before any retry of such a step the account's pending
 * nonce is compared with the one recorded before it, and a retry is refused while the wallet request is still
 * open, once a hash is known, or when the nonce moved ("a transaction may already be pending").
 */
import { CHAIN } from '@velum/config';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hash, TransactionReceipt } from 'viem';
import { COPY } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { shortH } from '@/lib/format';
import { decodeTxError, isUserRejection, type ErrorContext } from '@/lib/onchain/errors';
import { ReceiptMismatch, type Row, type TxFlowSpec, type TxRunCtx, type TxStepSpec } from '@/lib/onchain/flow';
import { RETRY_COPY, refusedRetry, retryVerdict, type SignRecord } from '@/lib/onchain/retry';
import { SendRefused, TxReplaced, TxReverted, TxUnexpected, pendingNonce, sendTx, switchToDeployment, txUrl, type TxStage } from '@/lib/onchain/tx';
import { useApp } from '@/lib/store';
import { I } from '../icons';

type StepState = { stage: 'idle' | TxStage | 'skipped' | 'failed'; hash?: Hash; error?: string };
type Phase = 'review' | 'running' | 'failed' | 'done';
/**
 * retry: nothing was sent, "Try again" (still guarded). final: no retry. wrong-chain: switch offer.
 * open: cancelled while the wallet request is open (tracked, no retry). resume: a late transaction of an
 * earlier step confirmed, "Continue" with the next step.
 */
type Fail = { message: string; kind: 'wrong-chain' | 'retry' | 'final' | 'open' | 'resume'; hash?: Hash };

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
  const [acked, setAcked] = useState(!flow.ack);
  const ctx = useRef<TxRunCtx>({ d: flow.d, proto: flow.proto, account: flow.account, out: {}, txs: [] });
  const from = useRef(0);
  const attempt = useRef(0);
  /** Per step: its wallet request, once one was made (W3-01). */
  const signed = useRef<Array<SignRecord | undefined>>([]);
  /** The step whose wallet request is open right now. */
  const signing = useRef<number | null>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);

  const errCtx: ErrorContext = {
    sym: (a) => Object.entries(flow.d.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0] ?? null,
    dec: (a) => {
      const s = Object.entries(flow.d.tokens).find(([, t]) => t.toLowerCase() === a.toLowerCase())?.[0];
      return s ? (flow.proto.decimals[s] ?? null) : null;
    },
  };
  const setStep = (i: number, st: StepState) => setStates((all) => all.map((x, j) => (j === i ? st : x)));
  const inSign = states.some((s) => s.stage === 'sign');

  useEffect(() => {
    setSlow(false);
    if (!inSign) return;
    const t = setTimeout(() => setSlow(true), CANCEL_AFTER_MS);
    return () => clearTimeout(t);
  }, [inSign]);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      attempt.current++;
      mounted.current = false;
    },
    [],
  );
  /** Unlocks the dialog, unless this one is gone (a late outcome must not unlock another flow's dialog). */
  const unlock = () => {
    if (mounted.current) set({ modalLocked: false });
  };
  useEffect(() => {
    if (phase === 'done') doneBtn.current?.focus({ preventScroll: true });
  }, [phase]);

  const refresh = () => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('oc-') || q.queryKey[0] === 'public-balances' });

  const finish = () => {
    const r = flow.done(ctx.current);
    setRows([...r.rows, ...ctx.current.txs.map(({ label, hash }): Row => [`${label} tx`, <TxLink key={hash} hash={hash} />])]);
    setFail(null);
    setPhase('done');
    unlock();
    toast(r.toast);
    refresh();
  };

  /** A failure of step `i`, decoded into one sentence and whether a retry may be offered. */
  const describe = async (i: number, step: TxStepSpec, e: unknown, rec: SignRecord | undefined): Promise<{ f: Fail; label: string }> => {
    if (e instanceof SendRefused) {
      const f: Fail =
        e.reason === 'wrong-chain'
          ? { kind: 'wrong-chain', message: `Your wallet is on another network. Switch it to ${COPY.chainLabel} (chain ID ${flow.d.chainId}) to continue. Nothing was sent.` }
          : e.reason === 'account-changed'
            ? { kind: 'final', message: 'Your wallet switched to another account, so nothing was sent. Start again from the account you want to use.' }
            : e.reason === 'not-connected'
              ? { kind: 'final', message: 'Your wallet is not connected. Connect it and try again. Nothing was sent.' }
              : { kind: 'final', message: 'This build does not send transactions on this network. Nothing was sent.' };
      return { f, label: f.kind === 'wrong-chain' ? 'Not sent: wrong network' : 'Not sent' };
    }
    if (e instanceof TxReplaced) {
      const what = e.reason === 'cancelled' ? 'cancelled it' : 'replaced it with a different transaction';
      return { f: { kind: 'final', hash: e.replacement, message: `Your wallet ${what} before it confirmed, so this step did not happen. Check your wallet's activity before doing it again.` }, label: e.reason === 'cancelled' ? 'Cancelled in your wallet' : 'Replaced in your wallet' };
    }
    if (e instanceof TxReverted) {
      return { f: { kind: 'final', hash: e.hash, message: `The transaction was mined but reverted. ${decodeTxError(e.reason, errCtx, flow.d.tokens.USDG!, { outToken: step.outToken }).message}` }, label: 'Reverted onchain' };
    }
    if (e instanceof TxUnexpected || e instanceof ReceiptMismatch) {
      const hash = e instanceof TxUnexpected ? e.hash : rec?.hash;
      return { f: { kind: 'final', hash, message: 'A transaction confirmed, but its receipt does not show what this step does, so it is not shown as done. Check your wallet and your activity before doing it again.' }, label: 'Unexpected result' };
    }
    if (rec?.hash) {
      return { f: { kind: 'final', hash: rec.hash, message: 'The transaction was submitted, but its confirmation could not be read. It may still confirm: check it in the explorer (or your wallet) before doing this again.' }, label: 'Submitted, not confirmed' };
    }
    const d = decodeTxError(e, errCtx, flow.d.tokens.USDG!, { outToken: step.outToken });
    // Before the wallet was asked (simulation, network): nothing can have been sent.
    if (!rec) return { f: { kind: d.rejected ? 'retry' : d.name ? 'final' : 'retry', message: d.message }, label: 'Not sent' };
    // The wallet was asked and declined: nothing was sent (a retry is still checked when pressed).
    if (isUserRejection(e)) return { f: { kind: 'retry', message: d.message }, label: 'Not sent' };
    // The wallet was asked and failed without a hash: unclear. Never offer a blind retry of a step that cannot
    // run twice; check the nonce now.
    if (!step.idempotent) {
      const v = retryVerdict(rec, await pendingNonce(flow.account));
      if (v !== 'ok') return { f: { kind: 'final', message: `${d.message} ${v === 'pending' ? RETRY_COPY.pending : RETRY_COPY.unknownNonce}` }, label: 'Outcome unclear' };
    }
    return { f: { kind: 'retry', message: d.message }, label: 'Not sent' };
  };

  const failStep = (i: number, f: Fail, label: string) => {
    setStep(i, { stage: 'failed', error: label, hash: f.hash });
    setFail(f);
    setPhase('failed');
    unlock();
    toast(f.kind === 'wrong-chain' ? 'Wrong network' : 'Transaction not completed', true);
    if (ctx.current.txs.length) refresh();
  };

  /** A confirmed receipt of step `i`: read its expected events (throws ReceiptMismatch), record the hash. */
  const record = (i: number, step: TxStepSpec, hash: Hash, receipt: TransactionReceipt) => {
    step.after?.(receipt, ctx.current);
    ctx.current.txs.push({ label: step.label, hash });
    setStep(i, { stage: 'confirmed', hash });
  };

  /** The outcome of a wallet request the user cancelled in this dialog, arriving later (W3-01). */
  const late = {
    hash: (i: number, h: Hash) => {
      setStep(i, { stage: 'submitted', hash: h });
      setFail({ kind: 'open', message: RETRY_COPY.sentLate, hash: h });
    },
    done: (i: number, step: TxStepSpec, hash: Hash, receipt: TransactionReceipt) => {
      try {
        record(i, step, hash, receipt);
      } catch (e) {
        void describe(i, step, e, signed.current[i]).then(({ f, label }) => failStep(i, f, label));
        return;
      }
      if (i === flow.steps.length - 1) {
        finish();
        return;
      }
      from.current = i + 1;
      setFail({ kind: 'resume', message: RETRY_COPY.resume, hash });
      toast(`${step.label} confirmed after Cancel`);
      refresh();
    },
    failed: (i: number, step: TxStepSpec, e: unknown) => {
      const rec = signed.current[i];
      if (!rec?.hash && isUserRejection(e)) {
        setStep(i, { stage: 'failed', error: 'Declined in your wallet' });
        setFail({ kind: 'retry', message: RETRY_COPY.declinedLate });
        return;
      }
      void describe(i, step, e, rec).then(({ f, label }) => failStep(i, f, label));
    },
  };

  const run = async () => {
    if (!acked) return;
    const my = ++attempt.current;
    const live = () => attempt.current === my;
    setFail(null);
    setPhase('running');
    set({ modalLocked: true });
    for (let i = from.current; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      from.current = i;
      const prev = signed.current[i];
      if (prev) {
        // This step already asked the wallet once: never again blindly (W3-01).
        const v = step.idempotent && prev.settled && !prev.hash ? 'ok' : retryVerdict(prev, prev.settled && !prev.hash ? await pendingNonce(flow.account) : null);
        if (!live()) return;
        if (v !== 'ok') {
          failStep(i, { kind: v === 'open' ? 'open' : 'final', message: refusedRetry(v), hash: prev.hash }, v === 'open' ? 'Waiting for your wallet' : 'Not sent again');
          return;
        }
        signed.current[i] = undefined;
      }
      let rec: SignRecord | undefined;
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
          onSign: (nonce) => {
            rec = { nonce, settled: false, cancelled: false };
            signed.current[i] = rec;
            signing.current = i;
          },
          onStage: (stage, h) => {
            if (stage === 'submitted' && rec) {
              rec.hash = h;
              if (signing.current === i) signing.current = null;
            }
            if (live()) setStep(i, { stage, hash: h });
            else if (rec?.cancelled && stage === 'submitted' && h) late.hash(i, h);
          },
        });
        if (rec) rec.settled = true;
        if (signing.current === i) signing.current = null;
        if (!live()) {
          if (rec?.cancelled) late.done(i, step, hash, receipt);
          return;
        }
        record(i, step, hash, receipt);
      } catch (e) {
        if (rec) rec.settled = true;
        if (signing.current === i) signing.current = null;
        if (!live()) {
          if (rec?.cancelled) late.failed(i, step, e);
          return;
        }
        const { f, label } = await describe(i, step, e, rec);
        if (!live()) return;
        failStep(i, f, label);
        return;
      }
    }
    finish();
  };

  const cancel = () => {
    attempt.current++;
    const i = signing.current;
    const rec = i === null ? undefined : signed.current[i];
    if (rec && !rec.settled) rec.cancelled = true;
    setFail(rec && !rec.settled ? { kind: 'open', message: RETRY_COPY.cancelledOpen } : { kind: 'retry', message: 'Cancelled. Nothing was sent.' });
    setStates((all) => all.map((s, j) => (j === i && rec && !rec.settled ? { stage: 'failed', error: 'Cancelled here, request still open in your wallet' } : s.stage === 'sign' || s.stage === 'checking' || s.stage === 'waiting' ? { stage: 'idle' } : s)));
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
          {flow.ack ? (
            <label className="boxnote warn" style={{ cursor: 'pointer', color: 'var(--text)' }}>
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ width: 15, height: 15, flex: 'none', marginTop: 2, accentColor: 'var(--acc)' }} />
              <span>{flow.ack}</span>
            </label>
          ) : null}
          <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={!acked} onClick={() => void run()}>
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
          {phase === 'running' && inSign && slow ? (
            <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={cancel}>
              Cancel
            </button>
          ) : null}
          {phase === 'failed' && fail ? (
            <>
              <div className="boxnote warn" role="alert">
                <I.info />
                <span>
                  {fail.message}
                  {fail.hash && fail.kind !== 'final' ? (
                    <>
                      {' '}
                      <TxLink hash={fail.hash} />
                    </>
                  ) : null}
                </span>
              </div>
              {fail.kind === 'wrong-chain' ? (
                <button className="btn btn-white btn-block" style={{ marginTop: 12 }} disabled={switching} onClick={() => void doSwitch()}>
                  {switching ? 'Waiting for your wallet…' : COPY.switchTo}
                </button>
              ) : fail.kind === 'retry' ? (
                <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => void run()}>
                  Try again
                </button>
              ) : fail.kind === 'resume' ? (
                <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => void run()}>
                  Continue
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
