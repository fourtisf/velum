'use client';
import { CHAIN, IS_MAINNET, getMarket } from '@velum/config';
import { parseOrZero, type Wad } from '@velum/math';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRejectedRequestError } from 'viem';
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain, type Connector, type CreateConnectorFn } from 'wagmi';
import { derivePrivateAddress, isPrivateAddress, isPublicAddress, SIGN_MESSAGE } from '@/lib/account';
import { usePublicBalances } from '@/lib/balances';
import { lpGo, moveGo, type MoveKind } from '@/lib/demo';
import { dp, floorTo, fmt, shortH } from '@/lib/format';
import { COPY } from '@/lib/copy';
import { mk } from '@/lib/markets';
import { coinbaseConnector, walletConnectConnector } from '@/lib/wagmi';
import { bal, emptyLedger, forgetSession, loadLedger, rememberSession, seedLedger, useApp, type FlowSpec, type ModalState } from '@/lib/store';
import { I } from '../icons';
import { Pv } from '../ui';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, reduced() ? Math.min(ms, 120) : ms));

function errText(e: unknown): string {
  if (e instanceof UserRejectedRequestError || (e as { code?: number })?.code === 4001 || /reject|denied/i.test(String((e as Error)?.message)))
    return 'The request was rejected in your wallet. Try again when you are ready.';
  const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? 'Something went wrong.';
  return msg.split('\n')[0]!.slice(0, 160);
}

function Head({ title, closable = true }: { title: string; closable?: boolean }) {
  const close = useApp((s) => s.closeModal);
  return (
    <div className="m-head">
      <h3 id="m-title">{title}</h3>
      {closable ? (
        <button className="xbtn" aria-label="Close" onClick={() => close(true)}>
          <I.x />
        </button>
      ) : null}
    </div>
  );
}

/* ---------- connect ---------- */
function ConnectModal({ error }: { error?: string }) {
  const { connectors, connectAsync, isPending } = useConnect();
  const openModal = useApp((s) => s.openModal);
  const [err, setErr] = useState(error ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  // Wallets announced through EIP-6963 (MetaMask, Rabby, Phantom, OKX, …), one entry each.
  const detected = connectors.filter((x, i, all) => x.type === 'injected' && x.id !== 'injected' && all.findIndex((y) => y.name === x.name) === i);
  const generic = connectors.find((x) => x.id === 'injected');

  const connect = async (c: Connector | CreateConnectorFn, key: string) => {
    setErr('');
    setBusy(key);
    try {
      const res = await connectAsync({ connector: c, chainId: CHAIN.id });
      openModal(res.chainId === CHAIN.id ? { kind: 'sign' } : { kind: 'network' });
    } catch (e) {
      const rejected = e instanceof UserRejectedRequestError || (e as { code?: number })?.code === 4001;
      if (rejected) {
        setErr(errText(e));
        setBusy(null);
        return;
      }
      // Some wallets reject the chainId hint: connect first, then ask to switch.
      try {
        const res = await connectAsync({ connector: c });
        openModal(res.chainId === CHAIN.id ? { kind: 'sign' } : { kind: 'network' });
      } catch {
        setErr(errText(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const pickGeneric = () => {
    if (!generic || (typeof window !== 'undefined' && !(window as { ethereum?: unknown }).ethereum)) {
      setErr('No browser wallet found. Install a wallet extension, or use WalletConnect.');
      return;
    }
    void connect(generic, 'injected');
  };
  const pickWalletConnect = () => {
    const c = connectors.find((x) => x.id === 'walletConnect') ?? walletConnectConnector();
    if (!c) {
      setErr('WalletConnect is not set up on this site yet. Use a browser wallet for now.');
      return;
    }
    void connect(c, 'walletConnect');
  };
  const pickPasskey = () => void connect(connectors.find((x) => x.id === 'coinbaseWalletSDK') ?? coinbaseConnector(), 'passkey');

  return (
    <>
      <Head title="Connect wallet" />
      <p className="m-text">Your wallet is your public address. Next, one signature opens your private account.</p>
      {detected.length ? (
        detected.map((c) => (
          <button key={c.uid} className="wopt" disabled={isPending} aria-busy={busy === c.uid} onClick={() => void connect(c, c.uid)}>
            <span className="ic">
              {c.icon ? (
                // eslint-disable-next-line @next/next/no-img-element -- wallet-provided data: URI icon
                <img src={c.icon} alt="" width={22} height={22} />
              ) : (
                <I.wallet />
              )}
            </span>
            <div>
              <b>{c.name}</b>
              <small>{busy === c.uid ? 'Check your wallet…' : 'Installed in this browser'}</small>
            </div>
          </button>
        ))
      ) : (
        <button className="wopt" disabled={isPending} onClick={pickGeneric}>
          <span className="ic">
            <I.wallet />
          </span>
          <div>
            <b>Browser wallet</b>
            <small>{busy === 'injected' ? 'Check your wallet…' : 'An extension wallet in this browser'}</small>
          </div>
        </button>
      )}
      <button className="wopt" disabled={isPending} onClick={pickWalletConnect}>
        <span className="ic">
          <I.qr />
        </span>
        <div>
          <b>WalletConnect</b>
          <small>{busy === 'walletConnect' ? 'Check your wallet…' : 'Scan with a wallet on your phone'}</small>
        </div>
      </button>
      <button className="wopt" disabled={isPending} onClick={pickPasskey}>
        <span className="ic">
          <I.key />
        </span>
        <div>
          <b>Passkey account</b>
          <small>{busy === 'passkey' ? 'Check your wallet…' : 'For smart-contract and multi-party wallets'}</small>
        </div>
      </button>
      <p className="hint" role="alert">
        {err}
      </p>
    </>
  );
}

/* ---------- wrong network ---------- */
function NetworkModal() {
  const { switchChainAsync, isPending } = useSwitchChain();
  const account = useApp((s) => s.account);
  const openModal = useApp((s) => s.openModal);
  const close = useApp((s) => s.closeModal);
  const [err, setErr] = useState('');
  const go = async () => {
    setErr('');
    try {
      await switchChainAsync({ chainId: CHAIN.id });
      if (account) close(true);
      else openModal({ kind: 'sign' });
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <>
      <Head title="Switch network" />
      <p className="m-text">
        Velum runs on {COPY.chainLabel} (chain ID {CHAIN.id}). Switch your wallet to this network to continue.{COPY.networkNotice}
      </p>
      <button className="btn btn-white btn-block" disabled={isPending} onClick={go}>
        {isPending ? 'Waiting for your wallet…' : COPY.switchTo}
      </button>
      <p className="hint" role="alert">
        {err}
      </p>
    </>
  );
}

/* ---------- sign ---------- */
function SignModal() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const s = useApp();
  const [label, setLabel] = useState('Sign message');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sign = async () => {
    if (!address) {
      s.openModal({ kind: 'connect' });
      return;
    }
    setErr('');
    setBusy(true);
    s.set({ modalLocked: true });
    setLabel('Waiting for your signature…');
    try {
      const sig = await signMessageAsync({ message: SIGN_MESSAGE, account: address });
      setLabel('Creating your private keys…');
      const paddr = derivePrivateAddress(sig);
      await sleep(700);
      rememberSession(address, paddr);
      s.set({ account: { addr: address, paddr }, ledger: loadLedger(address) ?? seedLedger(), modal: null, modalLocked: false });
      s.toast('Wallet connected');
    } catch (e) {
      setErr(errText(e));
      setLabel('Sign message');
      setBusy(false);
      s.set({ modalLocked: false });
    }
  };
  return (
    <>
      <Head title="Open your private account" closable={!busy} />
      <p className="m-text">Sign one message to create your private keys in this browser. It costs no gas and sends nothing to a server. The same wallet opens the same account on any device.</p>
      <div className="boxnote warn">
        <I.info />
        <span>Only sign this message on Velum. Anyone with this signature can open your private account.</span>
      </div>
      <button className="btn btn-white btn-block" disabled={busy} onClick={sign}>
        {label}
      </button>
      <p className="hint" role="alert">
        {err}
      </p>
    </>
  );
}

/* ---------- account ---------- */
function AccountModal() {
  const s = useApp();
  const { chainId } = useAccount();
  const { disconnectAsync } = useDisconnect();
  if (!s.account) return null;
  const { addr, paddr } = s.account;
  const wrong = chainId !== undefined && chainId !== CHAIN.id;
  const disconnect = async () => {
    forgetSession(addr);
    s.set({ account: null, ledger: emptyLedger(), openChain: {}, modal: null, modalLocked: false });
    s.toast('Disconnected');
    await disconnectAsync().catch(() => undefined);
  };
  return (
    <>
      <Head title="Your account" />
      <div className="receipt">
        <div>
          <span>Public wallet</span>
          <b>{shortH(addr)}</b>
        </div>
        <div>
          <span>Private address</span>
          <b>
            <Pv>{paddr.slice(0, 12) + '…' + paddr.slice(-6)}</Pv>
          </b>
        </div>
        <div>
          <span>Network</span>
          <b className={wrong ? 'down' : ''}>{wrong ? 'Wrong network' : COPY.chainLabel}</b>
        </div>
      </div>
      <p className="m-text" style={{ marginTop: 12 }}>
        Nothing onchain links these two addresses. Disconnecting removes your keys from this browser; signing again restores them.
      </p>
      {wrong ? (
        <button className="btn btn-white btn-block" onClick={() => s.openModal({ kind: 'network' })}>
          {COPY.switchTo}
        </button>
      ) : null}
      <button className="btn btn-dark btn-block" onClick={disconnect}>
        Disconnect
      </button>
    </>
  );
}

/* ---------- shield / unshield / send ---------- */
function MoveModal({ kind }: { kind: MoveKind }) {
  const s = useApp();
  const pub = usePublicBalances(s.account?.addr);
  const shieldable = (t: string): Wad => {
    const v = bal(pub.data ?? {}, t) - bal(s.ledger.shielded, t);
    return v > 0n ? v : 0n;
  };
  const toks =
    kind === 'shield'
      ? Object.keys(pub.data ?? {}).filter((t) => t !== 'ETH' && shieldable(t) > 10n ** 11n)
      : Object.keys(s.ledger.priv).filter((t) => t !== 'ETH' && bal(s.ledger.priv, t) > 10n ** 11n);
  const [tok, setTok] = useState(toks[0] ?? '');
  const [amt, setAmt] = useState('');
  const [to, setTo] = useState(kind === 'unshield' ? (s.account?.addr ?? '') : '');
  const [hint, setHint] = useState('');
  const t = tok || toks[0] || '';
  useEffect(() => {
    if (!tok && toks[0]) setTok(toks[0]);
  }, [tok, toks]);
  const have = t ? (kind === 'shield' ? shieldable(t) : bal(s.ledger.priv, t)) : 0n;
  const a = parseOrZero(amt);
  const over = a > have;
  const title = { shield: 'Shield tokens', unshield: 'Unshield tokens', send: 'Send privately' }[kind];
  const text = {
    shield: 'Move tokens from your public wallet into your private balance.',
    unshield: 'Move tokens from your private balance back to a public address.',
    send: 'Send to another private address. The amount and both parties stay hidden.',
  }[kind];
  const go = () => {
    const dest = to.trim();
    if (kind === 'send' && !isPrivateAddress(dest)) return setHint('Enter a private address that starts with velum1.');
    if (kind === 'unshield' && !isPublicAddress(dest)) return setHint('Enter a public address: 0x followed by 40 characters.');
    moveGo(kind, t, a, dest);
  };
  const emptyShield = kind === 'shield' && !toks.length;
  return (
    <>
      <Head title={title} />
      <p className="m-text">{text}</p>
      <div className="fl">
        <label htmlFor="mv-tok">Token</label>
      </div>
      <select className="sel full" id="mv-tok" value={t} onChange={(e) => setTok(e.target.value)}>
        {toks.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      {emptyShield ? (
        <p className="m-text" style={{ marginTop: 10, fontSize: 13 }}>
          {pub.isLoading ? 'Reading your public wallet…' : CHAIN.faucets.usdg ? 'No test tokens in this wallet yet. ' : 'No USDG or supported stock tokens in this wallet yet.'}
          {pub.isLoading || !CHAIN.faucets.usdg ? null : (
            <>
              Get ETH and stock tokens from the{' '}
              <a className="lnk" href={CHAIN.faucets.ethAndStockTokens} target="_blank" rel="noreferrer">
                Robinhood Chain faucet
              </a>{' '}
              and USDG from the{' '}
              <a className="lnk" href={CHAIN.faucets.usdg} target="_blank" rel="noreferrer">
                Paxos faucet
              </a>
              .
            </>
          )}
        </p>
      ) : null}
      <div className="fl">
        <label htmlFor="mv-amt">Amount</label>
        <span>
          {kind === 'shield' ? 'In wallet' : 'Available'}{' '}
          <b className="num">
            {fmt(have, dp(t))} {t}
          </b>
        </span>
      </div>
      <div className="inp">
        <input
          id="mv-amt"
          inputMode="decimal"
          placeholder="0.00"
          autoComplete="off"
          value={amt}
          onChange={(e) => {
            setAmt(e.target.value);
            setHint('');
          }}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => setAmt(floorTo(have, dp(t)))}>
          Max
        </button>
      </div>
      {kind === 'send' ? (
        <>
          <div className="fl">
            <label htmlFor="mv-to">Recipient&apos;s private address</label>
          </div>
          <div className="inp sm">
            <input id="mv-to" placeholder="velum1…" autoComplete="off" value={to} onChange={(e) => (setTo(e.target.value), setHint(''))} />
          </div>
        </>
      ) : null}
      {kind === 'unshield' ? (
        <>
          <div className="fl">
            <label htmlFor="mv-to">To public address</label>
          </div>
          <div className="inp sm">
            <input id="mv-to" autoComplete="off" style={{ fontSize: 13 }} value={to} onChange={(e) => (setTo(e.target.value), setHint(''))} />
          </div>
        </>
      ) : null}
      <div className={`boxnote ${kind === 'send' ? '' : 'warn'}`}>
        <I.info />
        <span>
          {kind === 'send'
            ? 'Nothing about this transfer is published in readable form.'
            : 'This step is public: anyone can see the wallet, token, amount and time. Vary amounts and wait between moves to make them harder to link.'}
        </span>
      </div>
      <button className="btn btn-white btn-block" disabled={!t || a <= 0n || over} onClick={go}>
        {{ shield: 'Shield', unshield: 'Unshield', send: 'Send' }[kind]} {t}
      </button>
      <p className="hint">{hint || (over ? `You have ${fmt(have, dp(t))} ${t} available.` : '')}</p>
    </>
  );
}

/* ---------- add liquidity ---------- */
function LpAddModal({ sym }: { sym: string }) {
  const s = useApp();
  const [amt, setAmt] = useState('1000');
  const a = parseOrZero(amt);
  const have = bal(s.ledger.priv, 'USDG');
  const price = mk(sym).price;
  const half = a / 2n;
  return (
    <>
      <Head title={`Add liquidity to ${sym}`} />
      <p className="m-text">Pays from your private USDG. Half is swapped into {sym} in the same action, so you add equal value of both.</p>
      <div className="fl">
        <label htmlFor="lp-amt">Amount</label>
        <span>
          Available <b className="num pv">{fmt(have)} USDG</b>
        </span>
      </div>
      <div className="inp">
        <input id="lp-amt" inputMode="decimal" value={amt} autoComplete="off" onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDG</span>
      </div>
      <div className="sumbox">
        <div>
          <span>Added as USDG</span>
          <b>{fmt(half)} USDG</b>
        </div>
        <div>
          <span>Added as {sym}</span>
          <b>
            {fmt(price > 0n ? (half * 10n ** 18n) / price : 0n, 4)} {sym}
          </b>
        </div>
        <div>
          <span>You earn</span>
          <b>0.30% of swaps</b>
        </div>
        <div>
          <span>Visible onchain</span>
          <b>The pool changed</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" disabled={a <= 0n || a > have || !getMarket(sym)} onClick={() => lpGo(sym, a)}>
        Add liquidity
      </button>
      <p className="hint">{a > have ? `You have ${fmt(have)} USDG available.` : ''}</p>
    </>
  );
}

/* ---------- flow (steps + receipt) ---------- */
function ProofBar({ active, ms }: { active: boolean; ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!active) return;
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    return () => cancelAnimationFrame(r);
  }, [active]);
  return (
    <div className="bar">
      <i style={go ? { width: '100%', transition: `width ${reduced() ? 100 : ms}ms linear` } : undefined} />
    </div>
  );
}

function FlowModal({ flow }: { flow: FlowSpec }) {
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const close = useApp((s) => s.closeModal);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<{ rows: Array<[ReactNode, ReactNode]> } | null>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);
  const startAddr = useRef(useApp.getState().account?.addr);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < flow.steps.length; i++) {
        if (cancelled) return;
        setStep(i);
        await sleep(flow.steps[i]!.ms || 700);
      }
      if (cancelled) return;
      setStep(flow.steps.length);
      if (useApp.getState().account?.addr !== startAddr.current) {
        // The wallet changed mid-flow: apply nothing to the new wallet (audit web L2).
        setResult({ rows: [['Status', 'Cancelled: your wallet changed']] });
        set({ modalLocked: false });
        return;
      }
      const r = flow.done();
      // On mainnet, say plainly on every receipt that nothing touched the chain.
      setResult({
        rows: IS_MAINNET
          ? [...r.rows.filter(([k]) => k !== 'Visible onchain'), ['Demo', 'Simulated, nothing was sent onchain']]
          : r.rows,
      });
      set({ modalLocked: false });
      toast(r.toast);
    })();
    return () => {
      cancelled = true;
    };
  }, [flow, set, toast]);
  useEffect(() => {
    if (result) doneBtn.current?.focus({ preventScroll: true });
  }, [result]);
  return (
    <>
      <div className="m-head">
        <h3 id="m-title">{IS_MAINNET ? `Simulated: ${flow.title}` : flow.title}</h3>
      </div>
      <ol className="flow">
        {flow.steps.map((st, i) => {
          const cls = i < step ? 'done' : i === step ? 'active' : '';
          return (
            <li key={i} className={cls}>
              <span className="ic">{i < step ? <I.check /> : null}</span>
              <div>
                <div className="t">{st.t}</div>
                <div className="d">{st.d ?? ''}</div>
                {st.proof ? <ProofBar active={i <= step} ms={st.ms} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        {result ? (
          <>
            <div className="receipt">
              {result.rows.map(([k, v], i) => (
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
      </div>
    </>
  );
}

function Content({ m }: { m: ModalState }) {
  switch (m.kind) {
    case 'connect':
      return <ConnectModal error={m.error} />;
    case 'network':
      return <NetworkModal />;
    case 'sign':
      return <SignModal />;
    case 'account':
      return <AccountModal />;
    case 'move':
      return <MoveModal kind={m.move} />;
    case 'lpadd':
      return <LpAddModal sym={m.sym} />;
    case 'flow':
      return <FlowModal key={m.id} flow={m.flow} />;
  }
}

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  const close = useApp((s) => s.closeModal);
  const box = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const key = modal ? (modal.kind === 'flow' ? `flow-${modal.id}` : modal.kind) : '';

  useEffect(() => {
    if (!modal) {
      restore.current?.focus?.({ preventScroll: true });
      restore.current = null;
      return;
    }
    if (!restore.current) restore.current = document.activeElement as HTMLElement | null;
    const f = box.current?.querySelector<HTMLElement>('input,select,.wopt,.btn');
    f?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  if (!modal) return null;
  return (
    <div
      className="modal-bg open"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-title" ref={box} key={key}>
        <Content m={modal} />
      </div>
    </div>
  );
}

