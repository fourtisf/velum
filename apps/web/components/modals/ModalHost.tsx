'use client';
import { CHAIN, getMarket } from '@velum/config';
import { WAD, type Wad } from '@velum/math';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRejectedRequestError, type Address, type Hex } from 'viem';
import { useAccount, useConfig, useConnect, useDisconnect, useSwitchChain, type Connector, type CreateConnectorFn } from 'wagmi';
import { getAccount, signMessage } from 'wagmi/actions';
import { accountFingerprint, buildSignMessage, checkPublicAddress, checkSignature, derivePrivateAddress, isPrivateAddress } from '@/lib/account';
import { amountHint, amountInputProps, amountOrZero } from '@/lib/amount';
import { usePublicBalances } from '@/lib/balances';
import { lpGo, moveGo, receiptRows, type MoveKind } from '@/lib/demo';
import { dp, floorTo, fmt, fmtBal, shortH } from '@/lib/format';
import { CLOSED, COPY, P, SIM, UI } from '@/lib/copy';
import { mk, useLivePrice } from '@/lib/markets';
import { coinbaseConnector, walletConnectConnector } from '@/lib/wagmi';
import {
  bal,
  emptyLedger,
  forgetSession,
  loadLedger,
  markSignerVerified,
  recallAccountFingerprint,
  rememberAccountFingerprint,
  rememberSession,
  seedLedger,
  signerVerified,
  useApp,
  type FlowSpec,
  type ModalState,
} from '@/lib/store';
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
      <p className="m-text">{UI.connectIntro}</p>
      {detected.length ? (
        detected.map((c) => (
          <button key={c.uid} className="wopt" disabled={isPending} aria-busy={busy === c.uid} onClick={() => void connect(c, c.uid)}>
            <span className="ic">
              {/* EIP-6963 icons must be data: images; anything else (a remote URL that would track the
                  visitor, javascript:, data:text/html) is ignored and the generic icon shown (audit web F8). */}
              {c.icon?.startsWith('data:image/') ? (
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
type SignStage = 'idle' | 'first' | 'second' | 'deriving';
const SIGN_LABEL: Record<SignStage, string> = {
  idle: 'Sign message',
  first: 'Waiting for your signature…',
  second: 'Sign once more to check your wallet…',
  deriving: UI.signDeriving,
};
/** A pending wallet request can be abandoned after this long (audit round 2, N7). */
const CANCEL_AFTER_MS = 5000;

/** Why a wallet can't open a private account (audit web L8; round 2, N1). */
type Refusal = 'unstable' | 'format' | 'signer';
const REFUSAL: Record<Refusal, string> = {
  unstable: "This wallet signed the same message two different ways, so it would open a different private account every time. It can't open a private account yet.",
  format: "This wallet didn't return a regular signature from a private key, so it can't open a private account yet.",
  signer: "This signature wasn't made by the connected wallet's own key, so it can't open a private account yet.",
};

function SignModal() {
  const { address } = useAccount();
  const config = useConfig();
  const { disconnectAsync } = useDisconnect();
  const s = useApp();
  const [stage, setStage] = useState<SignStage>('idle');
  const [err, setErr] = useState('');
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [changed, setChanged] = useState<{ wallet: Address; paddr: string; fp: string } | null>(null);
  const [slow, setSlow] = useState(false);
  // Each attempt has an id; a wallet answer that arrives after Cancel (or after this dialog closed) is dropped.
  const attempt = useRef(0);
  const busy = stage !== 'idle';
  const waiting = stage === 'first' || stage === 'second';

  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = setTimeout(() => setSlow(true), CANCEL_AFTER_MS);
    return () => clearTimeout(t);
  }, [waiting, stage]);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );

  /** The wallet is still connected to this account (checked after every await: it can switch account meanwhile). */
  const stillOn = (wallet: Address) => {
    const a = getAccount(config);
    return a.status === 'connected' && a.address?.toLowerCase() === wallet.toLowerCase();
  };
  const walletChanged = () => {
    setChanged(null);
    setErr('Your wallet switched to another account, so nothing was opened. Sign again with the account you want to use.');
    stop();
  };
  const finish = (wallet: Address, paddr: string, fp: string) => {
    // Never open the previous account's session after the wallet moved on (audit web F5).
    if (!stillOn(wallet)) return walletChanged();
    rememberAccountFingerprint(wallet, fp);
    rememberSession(wallet, paddr);
    s.set({ account: { addr: wallet, paddr }, ledger: loadLedger(wallet) ?? seedLedger(), modal: null, modalLocked: false });
    s.toast('Wallet connected');
  };
  const stop = () => {
    setStage('idle');
    s.set({ modalLocked: false });
  };

  const sign = async () => {
    if (!address) {
      s.openModal({ kind: 'connect' });
      return;
    }
    const my = ++attempt.current;
    const live = () => attempt.current === my;
    setErr('');
    setStage('first');
    s.set({ modalLocked: true });
    try {
      // wagmi's core action, not the useSignMessage hook: the signature never enters the TanStack
      // mutation cache, and lives only in this function until it is hashed (audit web L8).
      const message = buildSignMessage(address);
      const first = await checkSignature(await signMessage(config, { message, account: address }), message, address);
      if (!live()) return;
      if (!stillOn(address)) return walletChanged();
      if (!first.ok) {
        setRefused(first.reason);
        return stop();
      }
      let sig: Hex | null = first.sig;
      if (!signerVerified(address)) {
        // First time in this browser: sign again and compare. A wallet whose signatures differ
        // (passkey and many smart-contract wallets) would silently open a new account every time.
        setStage('second');
        const again = await checkSignature(await signMessage(config, { message, account: address }), message, address);
        if (!live()) return;
        if (!stillOn(address)) return walletChanged();
        if (!again.ok || again.sig !== sig) {
          sig = null;
          setRefused(again.ok ? 'unstable' : again.reason);
          return stop();
        }
        markSignerVerified(address);
      }
      setStage('deriving');
      const paddr = derivePrivateAddress(sig);
      sig = null;
      await sleep(700);
      if (!live()) return;
      if (!stillOn(address)) return walletChanged();
      const fp = accountFingerprint(CHAIN.id, address, paddr);
      const before = recallAccountFingerprint(address);
      if (before && before !== fp) {
        // Same wallet, different account than last time in this browser: say so before opening it.
        setChanged({ wallet: address, paddr, fp });
        return stop();
      }
      finish(address, paddr, fp);
    } catch (e) {
      if (!live()) return;
      setErr(errText(e));
      stop();
    }
  };
  const cancel = () => {
    attempt.current++;
    setErr('Cancelled. If your wallet still shows the request, reject it there.');
    stop();
  };
  const switchWallet = async () => {
    await disconnectAsync().catch(() => undefined);
    s.openModal({ kind: 'connect' });
  };
  if (refused)
    return (
      <>
        <Head title="Open your private account" />
        <p className="m-text">{REFUSAL[refused]}</p>
        <div className="boxnote warn">
          <I.info />
          <span>Passkey and smart-contract wallets often sign this way. Support for them is planned for a later release. For now, use a wallet with a regular key, such as a browser extension.</span>
        </div>
        <button className="btn btn-white btn-block" onClick={switchWallet}>
          Use another wallet
        </button>
      </>
    );
  if (changed)
    return (
      <>
        <Head title="A different private account" />
        <p className="m-text">
          This signature opens a different private account than this wallet opened before in this browser. That happens when a wallet changes how it signs. Once Velum holds funds, the new account
          would not see the old one&apos;s balance.
        </p>
        <div className="receipt">
          <div>
            <span>This signature opens</span>
            <b>{changed.paddr.slice(0, 12) + '…' + changed.paddr.slice(-6)}</b>
          </div>
        </div>
        <button className="btn btn-white btn-block" style={{ marginTop: 12 }} onClick={() => finish(changed.wallet, changed.paddr, changed.fp)}>
          Open this account
        </button>
        <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={() => s.closeModal(true)}>
          Cancel
        </button>
      </>
    );
  return (
    <>
      <Head title="Open your private account" closable={!busy} />
      <p className="m-text" aria-live="polite">
        {stage === 'second'
          ? 'Sign the same message once more. This checks that your wallet always gives the same signature, so it always opens the same account. You only do this once in this browser.'
          : UI.signIntro}
      </p>
      <div className="boxnote warn">
        <I.info />
        <span>Only sign this message on Velum. Anyone with this signature can open your private account.</span>
      </div>
      <button className="btn btn-white btn-block" disabled={busy} onClick={sign}>
        {SIGN_LABEL[stage]}
      </button>
      {waiting && slow ? (
        <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={cancel}>
          Cancel
        </button>
      ) : null}
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
        {UI.accountNote}
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
const ADDRESS_HINT = {
  format: 'Enter a public address: 0x followed by 40 characters.',
  checksum: 'This address fails its checksum, so it may have a typo. Copy it again from your wallet.',
  zero: 'This is the zero address. Tokens sent there are lost for good.',
} as const;

function MoveModal({ kind }: { kind: MoveKind }) {
  const s = useApp();
  const pub = usePublicBalances(s.account?.addr);
  // Tokens whose balance could not be read are not offered (nothing known to shield).
  const pubBal = pub.data?.bal ?? {};
  const shieldable = (t: string): Wad => {
    const v = bal(pubBal, t) - bal(s.ledger.shielded, t);
    return v > 0n ? v : 0n;
  };
  const toks =
    kind === 'shield'
      ? Object.keys(pubBal).filter((t) => t !== 'ETH' && shieldable(t) > 10n ** 11n)
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
  const a = amountOrZero(amt);
  const bad = amountHint(amt);
  const over = a > have;
  const title = { shield: 'Shield tokens', unshield: 'Unshield tokens', send: 'Send privately' }[kind];
  const text = SIM.moveText(kind);
  const go = () => {
    // Private addresses are lowercase hex; accept a pasted upper-case copy, then check the exact format.
    const dest = kind === 'send' ? to.trim().toLowerCase() : to.trim();
    if (kind === 'send' && !isPrivateAddress(dest)) return setHint('Enter a private address that starts with velum1.');
    if (kind === 'unshield') {
      const check = checkPublicAddress(dest);
      if (check !== 'ok') return setHint(ADDRESS_HINT[check]);
    }
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
          {pub.isLoading ? 'Reading your public wallet…' : CHAIN.faucets.usdg ? 'No test tokens in this wallet yet. ' : 'No USDG or supported Stock Tokens in this wallet yet.'}
          {pub.isLoading || !CHAIN.faucets.usdg ? null : (
            <>
              Get ETH and Stock Tokens from the{' '}
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
            {fmtBal(have, dp(t))} {t}
          </b>
        </span>
      </div>
      <div className="inp">
        <input
          id="mv-amt"
          {...amountInputProps(amt, 'mv-hint')}
          placeholder="0.00"
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
            <input id="mv-to" placeholder="velum1…" autoComplete="off" spellCheck={false} maxLength={80} aria-describedby="mv-hint" value={to} onChange={(e) => (setTo(e.target.value), setHint(''))} />
          </div>
        </>
      ) : null}
      {kind === 'unshield' ? (
        <>
          <div className="fl">
            <label htmlFor="mv-to">To public address</label>
          </div>
          <div className="inp sm">
            <input id="mv-to" autoComplete="off" spellCheck={false} maxLength={42} aria-describedby="mv-hint" style={{ fontSize: 13 }} value={to} onChange={(e) => (setTo(e.target.value), setHint(''))} />
          </div>
        </>
      ) : null}
      <div className={`boxnote ${kind === 'send' ? '' : 'warn'}`}>
        <I.info />
        <span>{SIM.moveNote(kind)}</span>
      </div>
      <button className="btn btn-white btn-block" disabled={!t || !!bad || a <= 0n || over} onClick={go}>
        {{ shield: 'Shield', unshield: 'Unshield', send: 'Send' }[kind]} {t}
      </button>
      <p className="hint" id="mv-hint">
        {hint || bad || (over ? `You have ${fmtBal(have, dp(t))} ${t} available.` : '')}
      </p>
    </>
  );
}

/* ---------- add liquidity ---------- */
function LpAddModal({ sym }: { sym: string }) {
  const s = useApp();
  const [amt, setAmt] = useState('1000');
  const a = amountOrZero(amt);
  const bad = amountHint(amt);
  const have = bal(s.ledger.priv, 'USDG');
  // The tradable price only; without one nothing can be added (audit round 2, M4).
  const price = useLivePrice(sym);
  const half = a / 2n;
  const [visK, visV] = SIM.visibleRow('The pool changed');
  return (
    <>
      <Head title={`Add liquidity to ${sym}`} />
      <p className="m-text">Pays from your private USDG. Half is swapped into {sym} in the same action, so you add equal value of both.</p>
      <div className="fl">
        <label htmlFor="lp-amt">Amount</label>
        <span>
          Available <b className="num pv">{fmtBal(have)} USDG</b>
        </span>
      </div>
      <div className="inp">
        <input id="lp-amt" {...amountInputProps(amt, 'lp-hint')} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <span className="unit">USDG</span>
      </div>
      <div className="sumbox">
        <div>
          <span>Added as USDG</span>
          <b>{fmt(half)} USDG</b>
        </div>
        <div>
          <span>Added as {sym}</span>
          <b>{price ? `${fmt((half * WAD) / price, 4)} ${sym}` : '—'}</b>
        </div>
        <div>
          <span>You earn</span>
          <b>{P.poolFee} of swaps</b>
        </div>
        <div>
          <span>{visK}</span>
          <b>{visV}</b>
        </div>
      </div>
      <button className="btn btn-white btn-block" disabled={!!bad || a <= 0n || a > have || !getMarket(sym) || price === null} onClick={() => lpGo(sym, a)}>
        Add liquidity
      </button>
      <p className="hint" id="lp-hint">
        {bad || (price === null ? (mk(sym).closed ? CLOSED.hint : `No live price for ${sym} right now, so liquidity can't be added.`) : a > have ? `You have ${fmtBal(have)} USDG available.` : '')}
      </p>
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
      setResult({ rows: receiptRows(r.rows) });
      set({ modalLocked: false });
      toast(r.toast, r.warn);
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
        <h3 id="m-title">{SIM.flowTitle(flow.title)}</h3>
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

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Wallet SDK overlays that draw above this host (Reown AppKit / WalletConnect QR modal, z-index 999). */
const OVERLAY_TAGS = /^(W3M|APPKIT|WCM)-MODAL$/;

/**
 * The wallet overlay currently open on top of our dialog, if any (audit round 2, N4). AppKit keeps
 * its element in the page and toggles an `open` class; the legacy WalletConnect Modal marks its
 * overlay `.wcm-active` inside its shadow root.
 */
function walletOverlay(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('w3m-modal.open, appkit-modal.open');
  if (el) return el;
  const wcm = document.querySelector<HTMLElement>('wcm-modal');
  return wcm?.shadowRoot?.querySelector('.wcm-active') ? wcm : null;
}
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);

/** Where focus goes back to on close: the trigger, or the nearest part of the page that still exists. */
interface Restore {
  el: HTMLElement | null;
  trail: HTMLElement[];
}

function captureRestore(): Restore {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body) return { el: null, trail: [] };
  const trail: HTMLElement[] = [];
  for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) trail.push(p);
  return { el: a, trail };
}

function restoreFocus(r: Restore) {
  if (r.el?.isConnected) {
    r.el.focus({ preventScroll: true });
    return;
  }
  // The trigger is gone (a closed position's row, a withdrawn offer): focus the nearest surviving
  // ancestor, temporarily focusable, so keyboard and screen reader users keep their place.
  const anc = r.trail.find((el) => el.isConnected);
  if (!anc) return;
  if (!anc.hasAttribute('tabindex')) {
    anc.setAttribute('tabindex', '-1');
    anc.addEventListener('blur', () => anc.removeAttribute('tabindex'), { once: true });
  }
  anc.focus({ preventScroll: true });
}

/**
 * Modal dialog host (audit web L4): while open, everything rendered before it is inert (no focus,
 * clicks or screen reader access), Tab cycles inside the dialog, the dialog itself holds focus
 * when it has nothing focusable (a running flow), and focus returns to the trigger on close.
 * Only the page's own elements are made inert, not third-party overlays such as WalletConnect's
 * QR modal, which are appended after this host and must stay usable on top of it. While such an
 * overlay is open the trap is suspended: focus moves to it, Tab and Escape are left to it (Escape
 * closes only the topmost layer), and focus comes back to our dialog when it closes (round 2, N4).
 */
export function ModalHost() {
  const modal = useApp((s) => s.modal);
  const close = useApp((s) => s.closeModal);
  const bg = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const open = modal !== null;
  const key = modal ? (modal.kind === 'flow' ? `flow-${modal.id}` : modal.kind) : '';

  const inerted = useRef(new Set<Element>());
  const path = usePathname();
  const inertPage = () => {
    for (let el = bg.current?.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || OVERLAY_TAGS.test(el.tagName) || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      inerted.current.add(el);
    }
  };

  useEffect(() => {
    if (!open) return;
    const restore = captureRestore();
    const made = inerted.current;
    inertPage();
    return () => {
      made.forEach((el) => el.removeAttribute('inert'));
      made.clear();
      restoreFocus(restore);
    };
  }, [open]);

  // A navigation while a modal is open (browser back) renders a new page: keep it inert too.
  useEffect(() => {
    if (open) inertPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('input,select,.wopt,.btn');
    (first && !first.matches(':disabled') ? first : el).focus({ preventScroll: true });
  }, [key]);

  // Hand focus to a wallet overlay when it opens above us, and take it back when it closes. While it
  // is open our own dialog is inert too, so Tab can only reach the overlay (not our dialog behind it).
  useEffect(() => {
    if (!open) return;
    const layer = bg.current;
    let handed: HTMLElement | null = null;
    const t = setInterval(() => {
      const o = walletOverlay();
      if (o && handed !== o) {
        const card = o.shadowRoot?.querySelector<HTMLElement>('wui-card, [role="alertdialog"], [role="dialog"]');
        if (!card) return; // not rendered yet: try again on the next tick
        handed = o;
        if (!o.contains(document.activeElement) && document.activeElement !== o) card.focus({ preventScroll: true });
        layer?.setAttribute('inert', '');
      } else if (!o && handed) {
        handed = null;
        layer?.removeAttribute('inert');
        const el = box.current;
        const a = document.activeElement;
        if (el && (!a || a === document.body || !el.contains(a))) {
          const first = focusables(el)[0];
          (first ?? el).focus({ preventScroll: true });
        }
      }
    }, 200);
    return () => {
      clearInterval(t);
      layer?.removeAttribute('inert');
    };
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      // A wallet overlay is on top: its own handlers own Tab and Escape (Escape closes only it).
      if (walletOverlay()) return;
      const active = document.activeElement;
      // Focus is in a third-party overlay on top of ours (e.g. WalletConnect's QR modal): leave it alone.
      if (active && active !== document.body && !el.contains(active)) return;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(el);
      e.preventDefault();
      if (!items.length) {
        el.focus({ preventScroll: true });
        return;
      }
      const i = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
      items[next]!.focus();
    };
    // If the focused control disappears or is disabled mid-step, keep focus on the dialog, not the page.
    const onFocusOut = (e: FocusEvent) => {
      const el = box.current;
      if (!el || e.relatedTarget || walletOverlay()) return;
      setTimeout(() => {
        if (box.current === el && (document.activeElement === document.body || document.activeElement === null)) el.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [close]);

  if (!modal) return null;
  return (
    <div
      className="modal-bg open"
      ref={bg}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-title" tabIndex={-1} ref={box} key={key}>
        <Content m={modal} />
      </div>
    </div>
  );
}
