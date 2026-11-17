# Velum bios

Bios for every profile, in English and Indonesian, each within the platform's limit (checked by the snippet at the end
of this file). Rules: say "Stock Tokens"; spot and perps are live, private accounts are **in development**; independent,
never implying a partnership with Robinhood; no venue names in bios; no promised returns.

Display name: **Velum** (or **Velum | Stock Tokens** where the name field allows it). Handle: **@velumtrade**.
Website field: **velumtrade.com**.

## X (160 characters)

<!-- bio x 160 -->
The exchange for Stock Tokens on Robinhood Chain. Buy with ETH or USDG, trade stock perps up to 5x, track your P&L. All from your own wallet.
<!-- /bio -->

<!-- bio x 160 -->
Trade Stock Tokens onchain, 24/7, from your own wallet. Spot, stock perps and a live Portfolio on Robinhood Chain. Private accounts in development.
<!-- /bio -->

<!-- bio x 160 -->
Stock Tokens, onchain. Self-custodial spot and perps on Robinhood Chain. Your wallet, your keys, your P&L.
<!-- /bio -->

Indonesian:

<!-- bio x 160 -->
Exchange Stock Tokens di Robinhood Chain. Beli pakai ETH atau USDG, trading perps saham hingga 5x, pantau P&L. Semua dari wallet kamu sendiri.
<!-- /bio -->

## Telegram channel description (255 characters)

<!-- bio telegram 255 -->
Official Velum channel. An exchange for Stock Tokens on Robinhood Chain: buy $TSLA, $NVDA and more with ETH or USDG, trade stock perps up to 5x and track your P&L, all from your own wallet.

velumtrade.com · X: @velumtrade
Admins never DM first.
<!-- /bio -->

Indonesian:

<!-- bio telegram 255 -->
Channel resmi Velum. Exchange Stock Tokens di Robinhood Chain: beli $TSLA, $NVDA dan lainnya pakai ETH atau USDG, trading perps saham hingga 5x, pantau P&L, langsung dari wallet kamu.

velumtrade.com · X: @velumtrade
Admin tidak pernah DM duluan.
<!-- /bio -->

## Instagram (150 characters)

<!-- bio instagram 150 -->
Trade Stock Tokens onchain 📈
Spot, stock perps and live P&L on Robinhood Chain
Your wallet, your keys
👇 Start in under a minute
<!-- /bio -->

## TikTok (80 characters)

<!-- bio tiktok 80 -->
Trade Stock Tokens onchain, from your own wallet 📈 velumtrade.com
<!-- /bio -->

## One-liners (website, LinkedIn tagline, link-in-bio pages)

- Trade Stock Tokens onchain, from your own wallet.
- The exchange for Stock Tokens on Robinhood Chain.
- Stock Tokens, spot and perps, self-custodial.
- Indonesian: Trading Stock Tokens onchain, langsung dari wallet kamu.

## About (long, for LinkedIn, CoinGecko-style listings and press)

> Velum is an exchange for Stock Tokens on Robinhood Chain. People buy and sell tokenized stocks such as TSLA, NVDA and
> AAPL around the clock with ETH or USDG, trade stock perpetuals with up to 5x leverage, and follow their holdings, value
> and P&L in one live Portfolio, all from their own wallet: Velum never holds user keys or funds. Private accounts, with
> balances and positions designed to stay encrypted and verified by zero-knowledge proofs, are in development and will
> launch after an external audit. Velum is an independent project and is not affiliated with Robinhood.
>
> Website: velumtrade.com · X: @velumtrade · Telegram: t.me/velumtrade

## Checking the lengths

```bash
python3 - <<'PY'
import re
s = open('design/marketing/bio-copy.md').read()
for m in re.finditer(r'<!-- bio (\w+) (\d+) -->\n(.*?)\n<!-- /bio -->', s, re.S):
    name, limit, text = m.group(1), int(m.group(2)), m.group(3)
    n = sum(2 if ord(c) > 0x2FFF else 1 for c in text)  # emoji counted as 2, to be safe
    print(('ok  ' if n <= limit else 'OVER'), f'{n:>3}/{limit}', name, text.splitlines()[0][:50])
PY
```
