// Puts Multicall3 at its canonical address on the local anvil (Robinhood Chain has it there; a fresh anvil
// does not). The creation code is viem's own copy (viem/_cjs/constants/contracts.js, multicall3Bytecode).
// Usage: node multicall.cjs <anvil rpc>
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const rpcUrl = process.argv[2];
const CANONICAL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const src = fs.readFileSync(path.join(path.dirname(req.resolve('viem/package.json')), '_cjs/constants/contracts.js'), 'utf8');
const code = /multicall3Bytecode = '(0x[0-9a-f]+)'/.exec(src)?.[1];
if (!code) throw new Error('multicall3 bytecode not found in viem');

const rpc = async (method, params = []) => {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const b = await res.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
};

(async () => {
  const hash = await rpc('eth_sendTransaction', [{ from: DEPLOYER, data: code }]);
  let r = null;
  for (let i = 0; i < 50 && !r; i++) {
    r = await rpc('eth_getTransactionReceipt', [hash]);
    if (!r) await new Promise((s) => setTimeout(s, 100));
  }
  const runtime = await rpc('eth_getCode', [r.contractAddress, 'latest']);
  await rpc('anvil_setCode', [CANONICAL, runtime]);
  console.log(`Multicall3 at ${CANONICAL} (${(runtime.length - 2) / 2} bytes)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
