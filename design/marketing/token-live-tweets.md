# "Token is live" tweets for @velumtrade

Two-post thread for the token launch, in English and Indonesian, plus a one-post version. Before posting, replace:

- `$TICKER` with the token's ticker;
- `0x________________________________________` with the token's contract address (42 characters, EIP-55 checksum,
  exactly as the explorer shows it);
- "on Uniswap" if the token trades somewhere else.

Lengths are checked with the placeholders at full size (`node design/marketing/check-x-posts.cjs
design/marketing/token-live-tweets.md`). Rules: no price talk, no promised returns, no "investment" language; always
point people to the official address. Also set `NEXT_PUBLIC_TOKEN_CA` in the VPS `.env` and run `deploy/deploy.sh`, so
the landing page shows the same address (it reads "Coming soon" until then).

## English (post 1, then post 2 as its reply)

<!-- post -->
$TICKER is live on Robinhood Chain.

The official Velum token is now trading on Uniswap.

CA: 0x________________________________________

Only trust the address shown on velumtrade.com and posted here by @velumtrade. Anything else is not ours.
<!-- /post -->

<!-- post -->
Velum is an exchange for Stock Tokens on Robinhood Chain.

Buy $TSLA, $NVDA and more with ETH or USDG, trade stock perps up to 5x, and track your P&L in one live Portfolio, all from your own wallet.

velumtrade.com

Not investment advice. DYOR.
<!-- /post -->

## Bahasa Indonesia (post 1, lalu post 2 sebagai balasan)

<!-- post -->
$TICKER sudah live di Robinhood Chain.

Token resmi Velum kini bisa diperdagangkan di Uniswap.

CA: 0x________________________________________

Hanya percaya alamat yang tampil di velumtrade.com dan diposting @velumtrade. Selain itu bukan milik kami.
<!-- /post -->

<!-- post -->
Velum adalah exchange untuk Stock Tokens di Robinhood Chain.

Beli $TSLA, $NVDA dan lainnya pakai ETH atau USDG, trading perps saham hingga 5x, dan pantau P&L di satu Portfolio live, langsung dari wallet kamu.

velumtrade.com

Bukan saran investasi. DYOR.
<!-- /post -->

## One-post version

<!-- post -->
$TICKER, the official Velum token, is live on Robinhood Chain.

CA: 0x________________________________________

Verify it on velumtrade.com. Velum: buy Stock Tokens with ETH or USDG, trade stock perps, track your P&L, all from your own wallet.

Not investment advice.
<!-- /post -->
