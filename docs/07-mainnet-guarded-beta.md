# 07 — Guarded mainnet beta (runbook)

**Owner decision (November 2026):** skip the testnet and go straight to Robinhood Chain mainnet (4663) in guarded mode:
allowlisted wallets only, small deposit caps, and public opening only after the external audit. This document is the
runbook for that beta: what must be true before, the ETH it costs, the order of the steps, how to verify and watch it,
what you can and cannot do in an emergency, and how the guard is retired. It does not replace docs/05 (the server) or
`contracts/README.md` (the contracts, "Guarded launch").

The code path: `contracts/script/Deploy.s.sol` accepts chain 4663 only as the guarded beta (below);
`deploy/deploy-contracts.sh` runs it from the VPS; `apps/workers/e2e/fork/` rehearses everything on a mainnet fork.
CLAUDE.md rule 4 ("testnet first") and docs/04 §3 (audit gate) describe the original plan; the guarded beta is the
owner's exception to them, not their removal: opening to the public still waits for the audit.

## Risk statement (read before deciding)

The guard limits **how much** can be lost and **who** can lose it. It does not make the system safe.

- **Unaudited contracts.** Several internal audits found and fixed issues (contracts/README.md, "Audit hardening");
  no external audit has been done. The contracts are immutable: no owner, no pause, no upgrade. A bug found during the
  beta cannot be patched in place; the fix is a new deployment, and users leave the old one through the exits that
  always work (withdraw, close, forced exit, offer withdrawal, liquidity removal).
- **A hot key signs every price.** The oracle is relay-sourced: the signer's `PRICE_RELAY` key pushes Robinhood's
  public quotes (no verified Chainlink feed exists on Robinhood Chain yet). A stolen relay key can move any price,
  bounded by the rate limit: at most 1% per minute (5% per recording), so an honest 5x position cannot be made
  liquidatable sooner than about 8.6 minutes after it opens or insolvent sooner than 18 minutes, and doubling a price
  takes at least 69 minutes (contracts/README.md, "Why these choices"). The relay address is fixed in the oracle at
  deployment: replacing a compromised key means a new deployment. If the relay stops (key, RPC, server, Robinhood API),
  prices go stale within 60 s and opens, closes, margin removal, liquidations and funding stop; withdrawals of free
  balances, offer withdrawals and liquidity removal keep working, and forced exits settle at the entry price once the
  oracle has been dead for 14 days.
- **The issuers hold powers over the tokens** (observed on chain on 2026-11-15, from bytecode and calls; the explorer's
  verified sources were not reachable):
  - *Stock Tokens* (all ten): beacon proxies sharing **one** beacon, `0xe10b6f6B275de231345c20D14Ab812db62151b00`.
    Its role holders can upgrade all ten implementations at once, **pause** all ten (`paused()` is read on every
    transfer), and **block** addresses (`isBlocked(from)` and `isBlocked(to)` on every transfer: on the fork, every
    vault deposit and withdrawal made both calls). If the Velum vault were blocked or the tokens paused, nobody could
    deposit or withdraw those tokens until the issuer reverses it. Corporate actions change `uiMultiplier()` (NVDA,
    AAPL, META and MSFT are at 1.0004 to 1.0011 today); balances do not rebase, and Velum prices per token
    (share price x multiplier), which the fork run checked end to end.
  - *USDG* (Paxos): an ERC-1967 proxy (implementation `0x68184C449E1a8f34fA18d289737129FD27B66f8F`) with role-based
    admin (default-admin transfer rules, mint and burn roles), per-function pause flags (both read `false` for
    `transfer` today) and a companion policy contract (`0xdf5fff9cb88b3cab50572fae73e2eb08599d25d4`). On the fork a
    plain transfer made no external call. Paxos can freeze or upgrade; a frozen vault freezes every user's USDG.
  - Confirm these with the issuers before inviting testers (contracts/README.md, "Token requirements").
- **Keeper dependence.** Liquidations, matured forced exits and funding advances are sent by the signer's keeper.
  Anyone may liquidate, but in a small beta nobody else will. A side that is not liquidatable at a recorded price has at
  least about 9.5 minutes of liquidatable, solvent prices before it can become insolvent; if the keeper is down longer
  than that during a fast move, a winner can end with a deferred cover claim instead of being paid in full.
- **Operations.** One VPS runs everything; the hot keys live on it (isolated under their own user, docs/05 "The
  signer"); the RPC endpoint is a dependency (use a provider URL and `RPC_URL_SEND`). The US-equity session calendar
  stops prices on weekends and holidays: positions cannot be closed then (no fresh price), by design.
- **Legal.** Stock Tokens are restricted for US persons and in several jurisdictions; terms, geofencing and sanctions
  screening (docs/04 §4) are the owner's to put in place before testers are invited.

What the guard does: only allowlisted addresses can deposit or approve modules; each address can bring in at most its
account cap of each token; the vault never holds more than the global caps; withdrawals and every exit are never
blocked. What is at risk is bounded by account cap x allowlisted addresses (<= global cap) per token, plus whatever
the issuers or a contract bug do to tokens already inside.

## Prerequisites

- The server set up per docs/05 on a release of this version, with Velum's own Redis (`deploy/redis-velum.sh`: the
  on-chain workers refuse any other) and switched to mainnet: `sudo bash /srv/velum/deploy/set-network.sh mainnet`.
- A provider RPC URL for Robinhood Chain mainnet in `RPC_URL` (the public endpoint rate-limits), ideally a second
  trusted one in `RPC_URL_SEND` for the signer's transactions.
- The owner multisig on Robinhood Chain for `GUARD_ADMIN` (and `GUARDIAN`). If no multisig is available there yet, a
  hardware-wallet key works, but the deploy prints a warning: one stolen key then controls the allowlist and caps
  (it still cannot move funds).
- ETH on Robinhood Chain for the deployer, the price relayer and the keeper (next section).
- The fork rehearsal passed on the commit you deploy ("Rehearse on a fork").
- Caps decided (see "Allowlisting and caps"): account caps at least 2x the margin a tester needs (losses never restore
  room, G-02), global caps = account cap x the number of testers you plan.

## ETH budget

Measured on a fork of mainnet at block 115,125,637 (2026-11-15) with the contracts of this commit, all ten markets,
and the real token contracts; the real chain's `eth_estimateGas` for each contract creation was within 0.9% of the
fork's gas used, and `NodeInterface.gasEstimateL1Component` returned 0 (Robinhood Chain charges no L1 data fee
today). Robinhood Chain's base fee was 0.02000-0.02005 gwei (the ArbOS minimum is 0.02 gwei; `ArbGasInfo` reports an L1
base fee estimate of 0). Costs scale linearly with the base fee.

| What | Gas | ETH at 0.02005 gwei | Fund |
|---|---|---|---|
| Deployment: 5 creations + 5 setups (10 transactions) | 14,016,124 | 0.00028 | deployer: **0.005 ETH** (forge reserves 2x price and 1.3x gas; covers a retry) |
| Relayer: one push of all 10 markets (median of 14) | 266,454 | 0.0000053 | |
| Relayer: one trading day (a push every 9 s, 24 h: 9,600 pushes) | 2,558,000,000 | **0.0513** | |
| Relayer: 30 days (21 trading days in Nov 16 - Dec 15, 2026) | 53,700,000,000 | **1.08** | relayer: **2.2 ETH** (x2 margin) |
| Keeper: `advanceFunding` (one market) | 91,287 | 0.0000018 | |
| Keeper: liquidation / forced-exit settlement | 177,612 / 168,076 | 0.0000036 / 0.0000034 | |
| Keeper: 30 days (hourly funding on 10 markets with open interest, 100 liquidations or exits) | ~480,000,000 | ~0.0096 | keeper: **0.1 ETH** |
| **First month, all keys** | | **~1.09** | **~2.3 ETH** |

- The relayer is the cost: every market must be pushed at least every 10 s while the session is open (opens need a
  price at most 10 s old), whether or not its price moved; about 26.6k gas per market per push. Nothing is pushed on
  weekends and holidays. Levers, each an owner decision: list fewer markets (the mainnet gate deploys exactly the
  verified list of ten; a subset needs a change to `Deploy.s.sol` and a review), push every 10 s instead of 9 s
  (`PRICE_PUSH_INTERVAL_MS=10000`, -10%, and every delay of a push then costs opens), or a cheaper `pushPrices`
  (contract change, needs the audit).
- Set the low-balance alerts to days of runway, not the testnet defaults: `RELAYER_MIN_BALANCE_ETH=0.25` (about five
  trading days) and `KEEPER_MIN_BALANCE_ETH=0.02`. `RELAYER_MAX_GWEI=1` and `KEEPER_MAX_GWEI=1` leave 50x headroom over
  today's base fee.
- What testers pay (for the beta's instructions): deposit 134-180k gas, open 400-440k, close 130-135k, swap 82k (two
  hops 117k), add liquidity 210-227k, withdraw 72-89k: about 0.000003-0.000009 ETH each at today's base fee.

## Keys, and the order they are made in

| Key | Where | Made | Role |
|---|---|---|---|
| Deployer | encrypted Foundry keystore `/etc/velum/keystore/velum-deployer` (root) | by `deploy-contracts.sh` on first use (`cast wallet import`, hidden prompts) | sends the 10 deployment transactions; **no role afterwards** |
| `PRICE_RELAY_PRIVATE_KEY` | `/etc/velum/signer-keys.env` (root:velum-signer 640) | `new-key.sh`, **before the deployment** | the only address that can push prices, **fixed in the oracle forever** |
| `KEEPER_PRIVATE_KEY` | same file | `new-key.sh` | liquidations, forced exits, funding; replaceable any time |
| `GUARD_ADMIN` | the owner multisig, never on the server | the owner | allowlist, raise caps, lift the caps, open to the public |
| `GUARDIAN` (recommended) | an owner key or multisig, never on the server | the owner | close-only switch per market (corporate actions, emergencies) |

The deploy script refuses a relayer equal to the deployer or the guard admin, a guardian equal to the relayer or the
deployer, and the deployer as guard admin.

## Rehearse on a fork

Run both from a workstation or a scratch machine with this repository, Foundry 1.5.1, PostgreSQL 16 and Redis (not on
the production server). They read the public RPC and Robinhood's quote API, and send nothing to the real chain.

```bash
bash apps/workers/e2e/fork/fork-e2e.sh     # every flow, replayed quotes, chain id 31337 on the fork, plus the web
bash apps/workers/e2e/fork/fork-live.sh    # the real chain id (4663), the mainnet deploy path, live quotes, production processes
```

`fork-e2e.sh` deploys guarded against the real USDG and Stock Tokens, funds throwaway wallets by impersonating existing
holders on the fork, and runs the API, the indexer and the signer (relayer + keeper) through: allowlist and caps
(refusals included), deposits and withdrawals of the real tokens, spot swaps (one and two hops) and liquidity, maker
offers, perps on both sides with margin added and removed, a price move liquidated by the keeper, a funding advance by
the keeper, a forced exit (7 days) settled by the keeper and its bond claimed, the guardian's close-only, every exit,
`liftCaps` then `openToPublic`, the API's views over the index, and the web build showing the per-token oracle price for
the uiMultiplier tokens. `fork-live.sh` deploys through the mainnet gate (simulation, plan, phrase, broadcast) and runs
the production processes with `ONCHAIN_MAINNET_CONFIRMED=yes` against the live quote API for a few minutes; in an open
session the live prices must reach the oracle per token and a position opens and closes, with the session closed
nothing may be pushed. Run `fork-live.sh` once during US market hours before the real deployment.

## Deploy the contracts

1. As root on the server, in tmux. Create the keys and build the signer's copy (it derives the relay address, and the
   relay address must exist before the deployment). With no deployment file yet and `ONCHAIN_MAINNET_CONFIRMED` empty,
   the signer runs idle and signs nothing.

   ```bash
   sudo -i
   tmux new -s velum-mainnet
   bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY
   bash /srv/velum/deploy/new-key.sh KEEPER_PRIVATE_KEY
   nano /srv/velum/.env      # ONCHAIN_WORKERS=true, ONCHAIN_MAINNET_CONFIRMED= (empty), RELAYER_MIN_BALANCE_ETH=0.25,
                             # KEEPER_MIN_BALANCE_ETH=0.02, RPC_URL / RPC_URL_SEND = your provider
   bash /srv/velum/deploy/deploy.sh
   bash /srv/velum/deploy/new-key.sh PRICE_RELAY_PRIVATE_KEY   # now prints the relay address (the key is kept)
   bash /srv/velum/deploy/new-key.sh KEEPER_PRIVATE_KEY        # and the keeper address
   ```

2. Fund the relay address (2.2 ETH), the keeper address (0.1 ETH) and a fresh deployer address (0.005 ETH) on Robinhood
   Chain.

3. Write the settings file (root:root 600; read as data, never executed; only these keys are accepted):

   ```bash
   install -m 600 /dev/null /etc/velum/mainnet-deploy.env && nano /etc/velum/mainnet-deploy.env
   ```

   ```ini
   # Velum guarded mainnet beta: settings for deploy/deploy-contracts.sh
   GUARD_ADMIN=0x...            # the owner multisig
   GUARDIAN=0x...               # recommended: close-only switch (owner key or multisig)
   # Caps as token amounts. Global = account cap x the testers you plan (here 20); raise later from GUARD_ADMIN.
   GUARD_ACCOUNT_CAP_USDG=1000
   GUARD_GLOBAL_CAP_USDG=20000
   GUARD_ACCOUNT_CAP_TSLA=1
   GUARD_GLOBAL_CAP_TSLA=20
   # ...one pair for each of AMZN PLTR NVDA NFLX AMD AAPL META MSFT COIN (0 blocks a token until raised)
   # Optional: PRICE_MIN_USD / PRICE_MAX_USD (default 1 / 100000, must leave 5x around every price),
   # OI_CAP_TOKENS (default 10000 per side), DEPLOY_RPC_URL, PRICE_RELAYER (a cross-check), MAINNET_REF_PRICE_<SYMBOL>.
   ```

4. Deploy:

   ```bash
   bash /srv/velum/deploy/deploy-contracts.sh /etc/velum/mainnet-deploy.env
   ```

   It checks the base, `.env` (mainnet, no hot key), that the RPC answers chain 4663, that no deployment exists yet and
   that `contracts/` is the checked-out commit; installs Foundry v1.5.1 and solc 0.8.28 for root under
   `/opt/velum-tools` if missing (pinned SHA-256); asks cast to import the deployer key the first time (hidden prompts:
   the key, then a password) and the keystore password on every run; derives the relay and keeper addresses as the
   signer user; reads reference prices from Robinhood's quote API; runs the **simulation** and prints the summary
   (deployer and nonce, relayer, guard admin and whether it is a contract, guardian, tokens, caps, bounds, the plan
   hash, the confirmation phrase). Read it. Then type the phrase it shows (it names chain 4663, the guard admin and the
   relay address; a phrase copied from anywhere else is refused, and so is anything after the simulation is an hour
   old or with other settings, build or deployer nonce). It **broadcasts** one transaction at a time, checks every
   receipt, the code at every address and the roles read back from the chain, installs
   `/srv/velum/deployments/4663.json` (root:root 644: readable by velum, velum-web and velum-signer, writable by root
   only), sets `DEPLOYMENTS_DIR=/srv/velum/deployments` in `.env` (backed up first) and keeps the logs and forge's
   record in `/srv/velum/backups/contracts-4663-<time>/`.

   Without the script (any machine with the repository, for an audit trail or a hardware wallet), the same two steps:

   ```bash
   cd contracts
   export GUARD_ADMIN=... GUARDIAN=... PRICE_RELAYER=<relay address> GUARD_ACCOUNT_CAP_USDG=... # every cap
   export MAINNET_REF_PRICE_TSLA=... # every stock: its current price in USDG
   forge script script/Deploy.s.sol --rpc-url $RPC --account velum-deployer --sender $DEPLOYER          # 1. simulation
   VELUM_MAINNET_GUARDED_CONFIRM='<the phrase it printed>' \
   forge script script/Deploy.s.sol --rpc-url $RPC --account velum-deployer --sender $DEPLOYER --broadcast --slow   # 2.
   ```

   Then copy `contracts/deployments/4663.json` to `/srv/velum/deployments/` (root:root 644) and set `DEPLOYMENTS_DIR`.

## After the deployment

1. Let the signer sign on mainnet and run a release (the web is rebuilt with the deployment file; the signer reads it
   from `DEPLOYMENTS_DIR` through `signer.env`; the API and the indexer read it too):

   ```bash
   nano /srv/velum/.env          # ONCHAIN_MAINNET_CONFIRMED=yes
   bash /srv/velum/deploy/deploy.sh
   ```

2. Move the deployer's remaining ETH away and delete `/etc/velum/keystore/velum-deployer` once you no longer need it.
3. Optionally commit `deployments/4663.json` to the repository as `contracts/deployments/4663.json` for the record.

## Verification

```bash
S=/run/velum-api/api.sock
curl -s --unix-socket $S http://velum-api/v1/deployment | cat -v; echo     # chainId 4663, the five contracts, 11 tokens
curl -s --unix-socket $S http://velum-api/v1/health | cat -v; echo         # onchain.ok true, signer a few s, no reasons
bash /srv/velum/deploy/as-user.sh velum-signer pm2 status                  # velum-signer online
cat /srv/velum/signer.env | grep SIGNER_DEPLOYMENTS_DIR                    # /srv/velum/deployments
```

On chain (any machine, read-only; `V` = the vault, `O` = the oracle, `P` = perps):

```bash
cast call $V "guardAdmin()(address)"; cast call $V "allowlistActive()(bool)"; cast call $V "capsActive()(bool)"
cast call $O "relayer()(address)"     # the relay address new-key.sh printed
cast call $P "guardian()(address)"
cast call $O "relayed(address)(uint128,uint64,uint64)" <TSLA>   # in market hours: updated every ~9 s
```

In market hours `/v1/health` must show `onchain.relayer.lastPush` a few seconds old and every market `pushed`. On
weekends and holidays the relayer pushes nothing: Robinhood's quotes stand still, so they never confirm (the markets
read `unconfirmed`, or `closed` once a quote moved) and `/v1/markets` marks every market `stale` (`marketClosed`).

## Monitoring and alerts

- **Health endpoint** (from outside, rate-limited per client): `https://<domain>/api/v1/health`. Alert when `ok` is
  false, `onchain.ok` is false (the `reasons` say why: no push for two intervals in session, a role overdue, an alert,
  a stuck or low wallet, an indexer error, no signer status), `signer` or `workers` is older than 30 s, or
  `onchain.relayer.balanceLow` / `onchain.keeper.balanceLow` is true. Poll it every minute from an external uptime
  monitor.
- **Logs**: `bash /srv/velum/deploy/as-user.sh velum-signer pm2 logs velum-signer --lines 200 --nostream` (alerts,
  refused pushes, stuck transactions), same for `velum-workers` and `velum-api`.
- **Balances**: the relay address spends about 0.05 ETH per trading day; top it up weekly.
- **On chain**, daily: `totalInternal(token)` against `globalCap(token)` (what the beta holds), `insurance()`,
  open interest per market (`markets(token)`), new `Allowlisted` / `CapsRaised` events (only the admin can emit them),
  and the stock beacon's `paused()` and `isBlocked(<vault>)`.
- **Issuer watch**: an upgrade of the Stock Token beacon or the USDG proxy, a pause, a block of the vault, or a
  pending multiplier change (`pendingMultiplier` in api.robinhood.com/rhj/assets) needs a decision (close-only, below).

## Allowlisting and caps (from the guard admin)

Every allowlisted address must fit in every global cap: `globalCap >= accountCap x allowlistedCount` for each token
(G-01). Raise the global caps first, then allowlist. Caps only go up; there is no removal from the allowlist.

```bash
# Hardware wallet / EOA admin:
cast send $V "raiseCaps(address,uint256,uint256)" $USDG 1000000000 40000000000 --ledger    # 1,000 / 40,000 USDG (6 decimals): room for 40
cast send $V "addToAllowlist(address[])" "[0xTester1,0xTester2]" --ledger
cast call $V "allowlistedCount()(uint256)"
cast call $V "depositLimit(address,address)(uint256)" 0xTester1 $USDG
# Multisig admin: build the same call data and propose it in the multisig's interface:
cast calldata "addToAllowlist(address[])" "[0xTester1,0xTester2]"
cast calldata "raiseCaps(address,uint256,uint256)" $USDG 1000000000 40000000000
```

Stock caps are in 18-decimal base units (`1 TSLA = 1000000000000000000`). A cap of 0 blocks that token. Testers whose
losses used up their room can only deposit again when the account cap is raised for everyone (G-02).

## Emergency options and their limits

| Situation | What you can do | What you cannot do |
|---|---|---|
| A market must stop taking new positions (bug suspicion, corporate action, issuer event) | Guardian (if one was set): `setCloseOnly(market, true)`; closes, margin, liquidations, forced exits, funding keep working | Stop closes, withdrawals or liquidations; nobody can |
| Stop new money | Do not allowlist more addresses; do not raise caps | Remove an address, lower a cap, or block a deposit within an allowlisted account's own room |
| Wrong prices from Robinhood's API or a compromised relay key | Stop the signer (`ONCHAIN_WORKERS=false`, deploy.sh): prices go stale in 60 s, so opens, closes, liquidations and funding stop; the rate limit already caps a bad feed at 1%/min | Correct a price; replace the relay key (new deployment); prices stale also block honest closes |
| A contract bug | Close-only on every market, tell testers to close and withdraw, deploy a fixed version (new addresses) | Pause, upgrade or move funds: there is no admin over funds |
| An issuer pauses or blocks the vault | Ask the issuer; close-only | Move tokens out: transfers of that token fail until the issuer reverses it |
| Keeper down | Restart it; anyone (you, from any key) can call `liquidate(id)` / `settleForcedExit(id)` / `advanceFunding(market)` | Recover a shortfall that happened while nobody liquidated (it becomes a capped cover claim) |
| The site or API is compromised | Take the site down (Nginx); the contracts stay usable directly | Stop users acting on chain |

There is **no pause**. Withdrawals of free balances are always open. Without a guardian there is no close-only switch
either: set `GUARDIAN` at deployment.

## Retiring the guard after the external audit

The audit will most likely change the contracts. Since they are immutable, a fixed version is a **new deployment**:

1. Deploy the audited version (with or without a guard), switch the site to it (new deployment file, deploy.sh).
2. On the beta deployment: guardian close-only on every market, ask testers to close, withdraw offers and liquidity,
   and withdraw; makers can force-exit takers who do not close (7 days). Nothing ever prevents a withdrawal.

If the audit finds nothing that needs a code change, the beta deployment itself can be opened, from the guard admin,
in this order (both one-way):

```bash
cast send $V "liftCaps()"        # no more caps; the allowlist stays
cast send $V "openToPublic()"    # everyone may deposit; the admin role is cleared for good
```

`openToPublic()` is refused while the caps are active (G-01). Afterwards the vault behaves exactly like an unguarded
deployment: no role remains but the optional guardian's close-only switch.

## Fork results (2026-11-15)

`fork-e2e.sh` at mainnet block 115,125,637: 174 checks and transactions passed in 90 s plus the web build; the oracle
price of every market equalled the replayed quote's token price (NVDA via `bid`/`ask` x `currentMultiplier`, AAPL,
META and MSFT via `tokenBid`/`tokenAsk`), the API served the same per-token price, and the web showed the oracle price
(rounded to cents) for NVDA, AAPL, META, MSFT and TSLA. `deploy-contracts.sh` was run end to end as root against a fork
that keeps chain id 4663 (scratch base, scratch users, the pinned tools downloaded and verified, the keystore created
through cast's prompts, the phrase typed through a terminal), and every refusal it has was exercised. `fork-live.sh`
(chain id 4663, Sunday 2026-11-15, session closed) deployed through the mainnet gate, and the production processes read
the live quotes: the API served each market's per-token price (NVDA 155.1451 = the raw midpoint 155.025 x 1.000775;
AAPL 355.287 = 354.90 x 1.00109) marked `marketClosed`, the signer ran with `ONCHAIN_MAINNET_CONFIRMED=yes` and both
keys, read all ten quotes and, correctly, pushed nothing. The push of live prices in an open session is the part still
to be watched: run `fork-live.sh` once in market hours before the real deployment.
