# 01 — Product spec

Everything here is visible in `prototype/index.html`. When this doc and the prototype
disagree, the prototype wins for visuals and copy; this doc wins for numbers and rules.

## 1. Users and promise

- **Traders** who want stock exposure on-chain without broadcasting size, entry, P&L or
  liquidation price.
- **Liquidity providers** who earn swap fees on private pools.
- **Makers** who back perps positions with standing offers and earn spreads.

Promise: *"Trade stocks onchain, privately."* Honest limits are shown in the UI: deposits
and withdrawals are public; makers and risk services see the positions they need.

## 2. Global UI

### Navigation (sticky top bar, 60 px, blurred background)
- **Landing:** logo, links (Product, How it works, Privacy, Markets, Developers),
  right side `Connect wallet` (ghost) + `Launch app` (white).
- **App:** logo, tabs (Trade, Markets, Swap, Portfolio, Earn, Makers), right side
  eye button (privacy mode), wallet button (avatar, short address, private total) or
  `Connect wallet` (white).
- **≤ 960 px:** app tabs become a fixed bottom bar.

### Privacy mode
Eye button toggles `veiled`. Every private number (`.pv`) gets `filter: blur(6px)`.
Public numbers (prices, public wallet) stay visible. Chart entry labels hide prices.

### Toasts
Bottom-right, 3 s. Label matches the action that produced it:

| Action button | Toast |
|---|---|
| Connect wallet | Wallet connected |
| Open long/short privately | Long opened on TSLA / Short opened on TSLA |
| Close | Position closed |
| Buy/Sell TSLA privately | Bought TSLA / Sold TSLA |
| Swap privately | Swapped |
| Add liquidity / Remove | Liquidity added / Liquidity removed |
| Shield / Unshield / Send | Shielded USDG / Unshielded USDG / Sent USDG privately |
| Post offer / Withdraw | Offer posted / Offer withdrawn |
| Disconnect | Disconnected |

### Flow modal (every write action)
A modal lists steps; each step spins, then checks. Proof steps show a progress bar.
After the last step: a receipt (key/value rows) and a `Done` button. The modal can't be
closed while running. Step copy per action is in §7.

## 3. Landing page `/`

1. **Hero** (centered): pill "Testnet · Private perps are live on Robinhood Chain",
   H1 "Trade stocks onchain, privately.", lead, buttons `Start trading`, `How it works`.
2. **Live demo frame:** the full trade terminal inside a framed card. Starts tilted
   (`rotateX(20deg) scale(.94)`) and settles flat when 18% visible (IntersectionObserver,
   1.4 s ease-out). Disabled for reduced motion and ≤ 960 px.
3. **Stats strip:** 10 markets · 5× · 0 admin keys · ~2 s proof.
4. **Bento (3 columns):** Private by default (hover reveals blurred balance), Long or short
   up to 5×, Proofs made on your device, Nobody can freeze your funds, Earn from every swap
   (live sparkline), Built for builders (endpoints + SDK code).
5. **How it works:** Shield → Prove → Relay → Settle.
6. **Privacy comparison:** "What everyone sees" (deposit + market only, rest hidden) vs
   "What you see" (all values, live P&L).
7. **Markets table:** first 6 markets, price, 24h, sparkline, OI, Trade button.
8. **FAQ** (6 items, first open), **CTA**, **Footer** (with independence disclaimer).

## 4. App pages

### Trade `/app/trade/[symbol]`
- **Market strip:** horizontally scrollable chips (avatar, symbol, price, 24h change).
  Active chip is scrolled into view.
- **Chart card:** symbol header, Spot/Perps segmented control, timeframe (15m, 1h, 4h, 1D),
  stats (price, 24h, mark, funding/h, OI), OHLC readout, canvas candlestick chart with
  crosshair, last-price tag, and dashed entry lines for the user's positions in this market.
- **Positions card:** tabs Positions (count) / Activity. Positions table: market + side/lev,
  size, entry, liq. price, P&L (live), `Chain view` (expands a row showing commitment, block,
  "Size, side, price, owner: Hidden"), `Close`.
- **Ticket (perps):** Long/Short, Size (USDG) with Available, 25/50/75/Max, leverage slider
  1–5× step 0.5, summary (Entry price, Position, Margin, Liquidation price, Fee, Funding),
  primary button, note about encryption + 15-minute refund.
- **Ticket (spot):** Buy/Sell, You pay, presets, You get (est.), slippage 0.1/0.5/1%,
  summary (Price, Pool fee, Minimum you get, Liquidation: None), button.
- **Private account card:** total (private), free balance, in positions,
  "Last thing the public chain saw" (what, commitment, block).

Button states (perps; spot is analogous):

| Condition | Label | Style | Enabled |
|---|---|---|---|
| Not connected | Connect wallet | white | yes → opens connect |
| size ≤ 0 | Enter a size | dark | no |
| margin + fee > free USDG | Not enough private USDG | dark | no (+ hint) |
| qty > 100 | Above the 100-token limit | dark | no (+ hint) |
| OK | Open long privately / Open short privately | green / red | yes |

### Markets `/app/markets`
Title, search (filters by symbol or name; Enter opens the first match), 4 stat cards,
table: market, price, 24h, last-hour sparkline, funding/h, OI, max leverage, `Buy`,
`Long or short`.

### Swap `/app/swap`
Pay box (amount, token select, presets), flip button, receive box (estimate, token select,
rate). Summary: Route (`NVDA › USDG › AMZN` when two hops), Pool fee, Minimum you get,
Visible onchain. Same-token → disabled "Choose two different tokens".

### Portfolio `/app/portfolio`
Not connected → empty state with Connect. Connected → private balance hero (private address
with copy), Shield / Unshield / Send privately; Private assets table; Public wallet table
(not blurred, it is public); Open positions (wide table with Side, Mark, Margin); Activity.

Shield / Unshield / Send modal: token select, amount + Max, recipient (send: `velum1…`
private address; unshield: public `0x…` address, prefilled with own wallet), warning box
("This step is public…") for shield/unshield. Validation messages:
- "Enter a private address that starts with velum1."
- "Enter a public address: 0x followed by 40 characters."
- "You have X TOKEN available."

### Earn `/app/liquidity`
Pool cards: pair, 0.30% fee badge, pool size (rounded), est. APR, your liquidity (private),
price, `Remove` (if any) + `Add liquidity`. Add modal: amount in USDG; half is swapped
into the stock in the same action. Note on hourly rounded totals.

### Makers `/app/makers`
Form: market, backing (USDG), largest single fill, open spread (bps), close spread (bps),
offer ends in (6 h / 24 h / 7 d). Summary: earn per $1,000 opened, takers pay to close,
backing locked, most you can lose. Validation: backing ≤ free USDG; 0 < largest fill ≤
backing. Offers table: market, backing, fills, earned, spreads, ends, `Withdraw`.
"What others can see about you" table.

### Connect flow
1. Modal "Connect wallet": Browser wallet, WalletConnect, Passkey account.
2. Modal "Open your private account": explains one signature derives keys in the browser,
   costs no gas; warning "Only sign this message on Velum…"; `Sign message`.
3. On success: toast "Wallet connected". Account modal (wallet button) shows public wallet,
   private address, network, `Disconnect`.

## 5. Markets data (demo seed)

| Symbol | Name | Seed price | Vol/tick | OI | Funding/h |
|---|---|---|---|---|---|
| TSLA | Tesla | 391.65 | .0017 | 742,000 | .0042% |
| AMZN | Amazon | 233.40 | .0011 | 518,000 | .0018% |
| PLTR | Palantir | 165.85 | .0020 | 466,000 | .0061% |
| NVDA | Nvidia | 186.40 | .0016 | 903,000 | .0035% |
| NFLX | Netflix | 112.30 | .0013 | 284,000 | .0027% |
| AMD | AMD | 221.60 | .0018 | 377,000 | .0049% |
| AAPL | Apple | 268.90 | .0009 | 655,000 | .0012% |
| META | Meta | 612.40 | .0012 | 431,000 | .0021% |
| MSFT | Microsoft | 508.10 | .0008 | 389,000 | .0009% |
| COIN | Coinbase | 301.70 | .0024 | 212,000 | .0068% |

These are **Stock Tokens** on Robinhood Chain (the brand's term; Velum copy never says "tokenized stocks").
Phase 2+: replace the seed with real prices (mainnet: official Robinhood quotes, docs/03). Testnet
Stock Tokens known today: TSLA, AMZN, PLTR, NFLX, AMD (see `packages/config/robinhood-testnet.json`).
Others render as "Coming soon". On mainnet all ten exist; open interest and funding have no real source
before Phase 3 and show "—".

Avatars (owner decision, replacing the prototype's neutral initials): each stock shows its company logo
on a disc in the brand colour, from `apps/web/lib/logos.ts` (Simple Icons glyphs for eight companies,
used only to identify each company's Stock Token, with the attribution and trademark note kept in that
file; Amazon and Microsoft get a monogram in their brand colour). USDG, ETH and unknown tokens keep the
neutral circle with the initial. Robinhood's logo is never used (CLAUDE.md brand rules).

## 6. Formulas

Let `P` = mark/oracle price, `S` = size in USDG, `L` = leverage, `maxL` = 5, `mm = 0.5 / maxL`.

**Perps open**
```
entry  = side == long ? P * 1.0005 : P * 0.9995      // maker open spread (demo 5 bps)
margin = S / L
qty    = S / entry
fee    = S * 0.0006
liq    = long  ? (L <= 1 ? none : entry * (1 - 1/L) / (1 - mm))
               : entry * (1 + 1/L) / (1 + mm)
require margin + fee <= freeUSDG and qty <= 100
```
**P&L** `long: qty * (P - entry)`, `short: qty * (entry - P)`.

**Liquidation** when `margin + pnl < mm * qty * P`. Return `max(0, equity - 0.01 * qty * P)`.

**Close** `exit = long ? P * (1 - closeSpread) : P * (1 + closeSpread)`;
`fee = qty * exit * 0.0006`; `returned = max(0, margin + pnl(exit) - fee)`.

**Spot buy** `out = amt * (1 - 0.003) / (P * (1 + 0.0008))`; **sell**
`out = amt * P * (1 - 0.0008) * (1 - 0.003)`; `min = out * (1 - slippage)`.

**Swap** `hops = (from == USDG || to == USDG) ? 1 : 2`;
`out = a * pFrom / pTo * (1 - 0.003)^hops * (1 - 0.0008 * hops)`.

**Max size preset (perps)** `maxSize = free * L / (1 + 0.0006 * L)`.

**Private total** `free USDG + Σ token balances × price + Σ (margin + pnl) + Σ LP + Σ maker backing + earned`.

All production math: fixed-point (e.g. 1e18 wad for USDG, 1e12 price scale), round in the
protocol's favor, display with `Intl.NumberFormat('en-US')`.

## 7. Flow step copy

**Open perps:** Locking margin in a private note → Generating proof in your browser (bar)
→ Relayer submitting proof → Matching with a maker.
Receipt: Market, Side, Position, Entry, Liquidation, Fee, Visible onchain "A position
changed", Receipt #.

**Close:** Generating proof in your browser (bar) → Relayer submitting proof → Settling at
the oracle price. Receipt: Exit price, P&L, Fee, Returned, Receipt #.

**Spot:** Locking your tokens in a private swap request → Generating proof in your browser
(bar) → Relayer submitting proof → Filling against the private pool.

**Swap:** same as spot; last step "Filling both pools in one action" when 2 hops.

**Shield:** Approving TOKEN → Sending public deposit → Adding a note to your private balance.
**Unshield:** Generating proof → Relayer submitting proof → Sending tokens to the public address.
**Send:** Generating proof → Relayer submitting proof → Creating an encrypted note for the recipient.
**Add liquidity:** Generating proof → Relayer submitting proof → Swapping half into TOKEN and adding both.
**Post offer:** Locking backing in a private note → Generating proof → Sending your offer to the coordinator.

In Phase 2 (demo) these are timed. In Phase 3+ each step maps to a real event
(signature, proof generated, tx hash, confirmation, indexer seen).

## 8. Copy rules

Sentence case. Plain verbs. Buttons say exactly what happens. Errors say what's wrong and
how to fix it, no apologies. Numbers: tabular figures. Keep all landing copy from the
prototype verbatim unless a fact changes.
