// Mock EIP-1193 wallet announced through EIP-6963, for the on-chain end-to-end test. It holds a throwaway
// key generated for the run and signs real transactions with it against the local anvil only (never a
// public network). Every request is logged, so the test can assert, for example, that nothing was sent
// while the wallet was on the wrong network.
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { createWalletClient, http } = req('viem');
const { privateKeyToAccount } = req('viem/accounts');

const INJECT = (info) => `
(() => {
  const listeners = {};
  const provider = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      const r = await window.__walletRpc(JSON.stringify({ method, params: params ?? [] }));
      const o = JSON.parse(r);
      if (o.error) { const e = new Error(o.error.message); e.code = o.error.code; throw e; }
      if (method === 'wallet_switchEthereumChain') setTimeout(() => window.__walletEmit('chainChanged', params[0].chainId), 0);
      return o.result;
    },
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); return provider; },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  window.__walletEmit = (ev, arg) => (listeners[ev] || []).forEach((f) => { try { f(arg); } catch (e) { console.error(e); } });
  const detail = Object.freeze({ info: Object.freeze(${JSON.stringify(info)}), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

const READS = new Set([
  'eth_call', 'eth_estimateGas', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
]);

/**
 * opts.privateKey (throwaway), opts.rpc (anvil URL), opts.chainId (where the wallet starts), opts.anvilChainId,
 * opts.name (the name it announces; default "Test Wallet"), opts.chains ({ chainId: anvil URL } when the wallet knows
 * several local chains, e.g. Robinhood Chain and Arbitrum forks: it signs on whichever it is switched to and refuses a
 * switch to any other chain with 4902, like a real wallet that does not know it), opts.perpsTerms (false: leave the perps
 * statement unaccepted; by default it is accepted for this wallet, as after a first visit).
 * Returns the wallet state: { log, sent, sentOn ([{ hash, chainId }]), typed (EIP-712 requests), wrongChainSends,
 * setChain(id), rejectNext }.
 */
async function installWallet(context, opts) {
  const account = privateKeyToAccount(opts.privateKey);
  const anvilChainId = opts.anvilChainId ?? 31337;
  const chain = { id: anvilChainId, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [opts.rpc] } } };
  const chains = opts.chains ?? { [anvilChainId]: opts.rpc };
  const signers = {};
  const signerFor = (id) => {
    if (!signers[id]) {
      const c = id === anvilChainId ? chain : { id, name: `anvil-${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chains[id]] } } };
      signers[id] = { client: createWalletClient({ account, chain: c, transport: http(chains[id]) }), chain: c };
    }
    return signers[id];
  };
  const state = { chainId: opts.chainId ?? anvilChainId, connected: false, log: [], sent: [], sentOn: [], typed: [], wrongChainSends: 0, rejectNext: false, address: account.address };
  const forward = async (method, params) => {
    const res = await fetch(chains[state.chainId] ?? opts.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return res.json();
  };
  await context.exposeBinding('__walletRpc', async (_src, raw) => {
    const { method, params } = JSON.parse(raw);
    state.log.push({ method, t: Date.now(), chainId: state.chainId });
    const ok = (result) => JSON.stringify({ result });
    const err = (code, message) => JSON.stringify({ error: { code, message } });
    switch (method) {
      case 'eth_requestAccounts':
        state.connected = true;
        return ok([account.address]);
      case 'eth_accounts':
        return ok(state.connected ? [account.address] : []);
      case 'eth_chainId':
        return ok('0x' + state.chainId.toString(16));
      case 'net_version':
        return ok(String(state.chainId));
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return ok([{ parentCapability: 'eth_accounts' }]);
      case 'wallet_revokePermissions':
        state.connected = false;
        return ok(null);
      case 'wallet_switchEthereumChain': {
        const id = Number.parseInt(params[0].chainId, 16);
        if (opts.chains && !chains[id]) return err(4902, 'Unrecognized chain ID');
        if (state.rejectNext) {
          state.rejectNext = false;
          return err(4001, 'User rejected the request.');
        }
        state.chainId = id;
        return ok(null);
      }
      case 'wallet_addEthereumChain':
        state.added = params[0];
        return ok(null);
      case 'personal_sign':
        return ok(await account.signMessage({ message: { raw: params[0] } }));
      case 'eth_signTypedData_v4': {
        // EIP-712 (Hyperliquid approvals): recorded for the test, signed with the throwaway key.
        if (state.rejectNext) {
          state.rejectNext = false;
          return err(4001, 'User rejected the request.');
        }
        const typed = JSON.parse(params[1]);
        // Like MetaMask: a domain chain id must be the wallet's active chain.
        if (typed.domain?.chainId !== undefined && Number(typed.domain.chainId) !== state.chainId) return err(-32602, `Provided chainId "${Number(typed.domain.chainId)}" must match the active chainId "${state.chainId}"`);
        state.typed.push({ chainId: state.chainId, typed });
        const { EIP712Domain: _domain, ...types } = typed.types;
        return ok(await account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message }));
      }
      case 'eth_sendTransaction': {
        if (!chains[state.chainId]) {
          state.wrongChainSends++;
          return err(4901, 'wallet is on another chain');
        }
        if (state.rejectNext) {
          state.rejectNext = false;
          return err(4001, 'User rejected the request.');
        }
        const tx = params[0];
        try {
          const { client, chain: c } = signerFor(state.chainId);
          const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : undefined, chain: c });
          state.sent.push(hash);
          state.sentOn.push({ hash, chainId: state.chainId });
          return ok(hash);
        } catch (e) {
          return err(-32000, String(e.shortMessage || e.message).split('\n')[0]);
        }
      }
      default:
        if (READS.has(method)) {
          const r = await forward(method, params);
          return r.error ? err(r.error.code ?? -32000, r.error.message) : ok(r.result);
        }
        return err(4200, `Unsupported method ${method}`);
    }
  });
  await context.addInitScript(INJECT({ uuid: '00000000-0000-4000-8000-000000000002', name: opts.name ?? 'Test Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.velum.wallet' }));
  // The perps statement (lib/geo.ts) is accepted for this wallet unless a test checks it (opts.perpsTerms === false).
  if (opts.perpsTerms !== false) {
    const version = /LEGAL_VERSION = '([^']+)'/.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'legal.ts'), 'utf8'))[1];
    await context.addInitScript(([k]) => {
      try {
        localStorage.setItem(k, '1');
      } catch {
        /* no storage */
      }
    }, [`velum.perpsTerms.${version}.${account.address.toLowerCase()}`]);
  }
  state.setChain = async (page, id) => {
    state.chainId = id;
    await page.evaluate((hex) => window.__walletEmit('chainChanged', hex), '0x' + id.toString(16));
  };
  return state;
}

module.exports = { installWallet };
