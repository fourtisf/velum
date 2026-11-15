// Adversarial variant of apps/web/e2e/wallet.cjs (from the web audit of the real-transaction wiring): the same
// EIP-6963 mock wallet signing with a throwaway key, plus:
//  - hold: eth_sendTransaction waits until released (a wallet prompt left open), every request is logged;
//  - rejectNext: the next request is declined (4001);
//  - failAfterSend: the next request IS broadcast but the wallet reports an error (an outcome the app cannot know);
//  - gasPrice: the fee to sign with (to replace a pending transaction from outside).
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.join(__dirname, '..', '..', 'package.json'));
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

const READS = new Set(['eth_call', 'eth_estimateGas', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);

async function installWallet(context, opts) {
  const account = privateKeyToAccount(opts.privateKey);
  const anvilChainId = 31337;
  const chain = { id: anvilChainId, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [opts.rpc] } } };
  const signer = createWalletClient({ account, chain, transport: http(opts.rpc) });
  const state = { chainId: opts.chainId ?? anvilChainId, connected: false, log: [], sent: [], txs: [], wrongChainSends: 0, rejectNext: false, failAfterSend: false, address: account.address, hold: false, pending: [], gasPrice: undefined };
  const forward = async (method, params) => {
    const res = await fetch(opts.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return res.json();
  };
  state.releaseAll = () => { const p = state.pending.splice(0); p.forEach((r) => r()); return p.length; };
  await context.exposeBinding('__walletRpc', async (_src, raw) => {
    const { method, params } = JSON.parse(raw);
    state.log.push({ method, t: Date.now(), chainId: state.chainId });
    const ok = (result) => JSON.stringify({ result });
    const err = (code, message) => JSON.stringify({ error: { code, message } });
    switch (method) {
      case 'eth_requestAccounts': state.connected = true; return ok([account.address]);
      case 'eth_accounts': return ok(state.connected ? [account.address] : []);
      case 'eth_chainId': return ok('0x' + state.chainId.toString(16));
      case 'net_version': return ok(String(state.chainId));
      case 'wallet_requestPermissions': case 'wallet_getPermissions': return ok([{ parentCapability: 'eth_accounts' }]);
      case 'wallet_revokePermissions': state.connected = false; return ok(null);
      case 'wallet_switchEthereumChain': state.chainId = Number.parseInt(params[0].chainId, 16); return ok(null);
      case 'wallet_addEthereumChain': state.added = params[0]; return ok(null);
      case 'personal_sign': return ok(await account.signMessage({ message: { raw: params[0] } }));
      case 'eth_sendTransaction': {
        const tx = params[0];
        state.txs.push({ to: tx.to, data: tx.data, value: tx.value, chainIdParam: tx.chainId, walletChain: state.chainId });
        if (state.hold) await new Promise((r) => state.pending.push(r));
        if (state.chainId !== anvilChainId) { state.wrongChainSends++; return err(4901, 'wallet is on another chain'); }
        if (state.rejectNext) { state.rejectNext = false; return err(4001, 'User rejected the request.'); }
        try {
          const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : 3_000_000n, chain, ...(state.gasPrice ? { gasPrice: state.gasPrice } : {}) });
          state.sent.push(hash);
          if (state.failAfterSend) { state.failAfterSend = false; return err(-32603, 'Internal JSON-RPC error.'); }
          return ok(hash);
        } catch (e) { return err(-32000, String(e.shortMessage || e.message).split('\n')[0]); }
      }
      default:
        if (READS.has(method)) { const r = await forward(method, params); return r.error ? err(r.error.code ?? -32000, r.error.message) : ok(r.result); }
        return err(4200, `Unsupported method ${method}`);
    }
  });
  await context.addInitScript(INJECT({ uuid: '00000000-0000-4000-8000-000000000002', name: 'Test Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.velum.wallet' }));
  state.setChain = async (page, id) => { state.chainId = id; await page.evaluate((hex) => window.__walletEmit('chainChanged', hex), '0x' + id.toString(16)); };
  return state;
}
module.exports = { installWallet };
