# Professional threads for @velumtrade

Six ready-to-post threads in a professional voice (English), plus Indonesian versions of the two main ones. Each post
fits X's 280 characters (checked by `node design/marketing/check-x-posts.cjs design/marketing/threads-professional.md`,
links counted as 23), so every thread also works unchanged on Threads (500 per post). Paste as is; the links are real.

House rules: say "Stock Tokens"; spot (Uniswap) and perps (Hyperliquid) are **live**, private accounts are **in
development** and always phrased that way; Velum's own contracts are not deployed or audited yet; no partnership claims
(independent, not affiliated with Robinhood, Uniswap or Hyperliquid); no promised returns; perps posts carry a risk line.

Suggested order: Thread 1 (pin it), then 2 with the how-to video, then 3 to 6 over the following days.

---

## Thread 1. Introducing Velum (pin this)

Attach `velum-how-it-works-pro-1600x900.png` to the first post.

<!-- post -->
Introducing Velum: an exchange for Stock Tokens on Robinhood Chain.

Buy and sell $TSLA, $NVDA, $AAPL and more around the clock, trade stock perps with up to 5x, and track it all in one live Portfolio.

All from your own wallet.

A thread 🧵
<!-- /post -->

<!-- post -->
1/ Spot

Every spot trade is a real Uniswap swap on Robinhood Chain, straight from your wallet. Pay with USDG or with the ETH you already hold.

You own the token. There is no position to liquidate, and Velum adds no fee.
<!-- /post -->

<!-- post -->
2/ Perps

Go long or short on stock perps through your own Hyperliquid account, isolated margin, up to 5x.

You can fund it from inside Velum: deposit USDC from Arbitrum without leaving the app.
<!-- /post -->

<!-- post -->
3/ Portfolio

Your wallet value at live prices, every holding with its P&L from your own trades on the chain, and a Sell button next to each one.

ETH on Robinhood Chain and on Ethereum is counted too.
<!-- /post -->

<!-- post -->
4/ Custody

Velum never holds your keys or your funds. Connecting is read-only and asks for no signature. Every trade is signed in your wallet, one by one, after you have seen every amount.
<!-- /post -->

<!-- post -->
5/ What's next

Private accounts are in development: balances, positions and P&L designed to stay encrypted, with zero-knowledge proofs letting the chain verify each trade without seeing it.

Velum's own contracts launch only after an external audit.
<!-- /post -->

<!-- post -->
6/ Start in under a minute: velumtrade.com

Follow @velumtrade for updates.

Velum is independent and not affiliated with Robinhood, Uniswap or Hyperliquid. Perps are leveraged and can be liquidated. Not investment advice.
<!-- /post -->

## Thread 2. How to buy Stock Tokens on Velum

Attach `video/velum-how-to-buy-1080p.mp4` to the first post.

<!-- post -->
How to buy Stock Tokens on Velum, step by step.

Four steps, about a minute, and your stock lands in your own wallet. The full walkthrough is in the video.

🧵
<!-- /post -->

<!-- post -->
1/ Open velumtrade.com and select Launch app.

Connect your wallet. It takes one click: no account, no sign-up, no signature, and no deposit into Velum.
<!-- /post -->

<!-- post -->
2/ Choose a Stock Token from the market strip: $TSLA, $NVDA, $AAPL, $AMZN, $META, $MSFT and more, with live prices around the clock.

Select Spot to buy the token itself.
<!-- /post -->

<!-- post -->
3/ Pay with USDG, or with the ETH in your wallet.

With ETH, one Uniswap swap turns it into USDG and then into your stock. No approval step.

The ticket shows the order value in dollars, what you receive, both pool fees and the route.
<!-- /post -->

<!-- post -->
4/ Review, then confirm in your wallet.

Every amount is shown before you sign. A minimum output, set by your slippage limit (0.1%, 0.5% or 1%), protects you: if the price moves past it, the swap is refused and nothing is traded.
<!-- /post -->

<!-- post -->
5/ Your Portfolio updates with the new holding, its value and its P&L.

When you want out, select Sell next to it: the ticket opens with your whole balance filled in.

Try it: velumtrade.com
<!-- /post -->

## Thread 3. The Velum Portfolio

Attach a screenshot of the Portfolio (assets table with P&L and Sell) to the first post.

<!-- post -->
The Velum Portfolio: everything you hold on Robinhood Chain, at live prices, with P&L and one-tap Sell.

Here is what it shows and how it works 🧵
<!-- /post -->

<!-- post -->
1/ Wallet value

USDG, every Stock Token and ETH in your wallet, valued live. Your ETH on Ethereum at the same address is included, so the number matches what you actually own.
<!-- /post -->

<!-- post -->
2/ P&L you can trust

The cost of each holding comes from your own trades, read from the chain: what you paid in USDG, or what your ETH became inside the swap.

If the cost of some tokens is unknown, Velum shows a dash rather than a guess.
<!-- /post -->

<!-- post -->
3/ One-tap Sell

Every Stock Token has a Sell button. It opens the ticket with your whole balance filled in, so closing out takes one review and one confirmation.
<!-- /post -->

<!-- post -->
4/ Activity from the chain

Your buys, sells and transfers are listed with a link to each transaction on the explorer. Nothing is stored by Velum: trades made anywhere show up the same.

See yours: velumtrade.com/app/portfolio
<!-- /post -->

## Thread 4. Security and custody

<!-- post -->
How Velum handles your trades, and what it never touches.

A short thread on custody and safety 🧵
<!-- /post -->

<!-- post -->
1/ No keys, no funds

Velum never holds your private keys or your tokens. Spot trades settle straight to your wallet; perps margin stays in your own Hyperliquid account.
<!-- /post -->

<!-- post -->
2/ Read-only connection

Connecting your wallet asks for no signature. Velum only reads your public balances. Each trade is a separate transaction that you review and sign yourself.
<!-- /post -->

<!-- post -->
3/ Exact approvals only

Token approvals are for the exact amount of the trade, never unlimited, and the router allowance expires after 30 minutes. Paying with ETH needs no approval at all.
<!-- /post -->

<!-- post -->
4/ Protected execution

Every swap carries a minimum output from your slippage limit and a 20-minute deadline. If the price moves past your limit, the swap is refused onchain and nothing is traded.
<!-- /post -->

<!-- post -->
5/ Verified receipts

After each trade Velum checks the token transfers in the receipt: the exact amount left your wallet and at least the minimum arrived. Anything else is reported as a failure, not a success.
<!-- /post -->

<!-- post -->
6/ Honest status

Spot and perps run on Uniswap and Hyperliquid today. Velum's own contracts and private accounts are in development and launch only after an external audit.

velumtrade.com
<!-- /post -->

## Thread 5. Stock perps on Velum

<!-- post -->
Stock perps on Velum: go long or short on $TSLA, $NVDA and more, with up to 5x leverage, from your own Hyperliquid account.

How it works 🧵
<!-- /post -->

<!-- post -->
1/ Your account, your funds

Perps trade from your own Hyperliquid account. Velum never holds your margin, and you can see the same positions on Hyperliquid at any time.
<!-- /post -->

<!-- post -->
2/ Funding without leaving Velum

Deposit USDC from Arbitrum straight from the Perps ticket. It arrives in your Hyperliquid account at the same address, usually within a minute. Minimum 5 USDC.
<!-- /post -->

<!-- post -->
3/ Isolated margin, clear numbers

Each position uses isolated margin, so a loss stops at that position's margin. Before you confirm you see the size, margin, fee and estimated liquidation price.
<!-- /post -->

<!-- post -->
4/ Live P&L, one-click close

Open positions show live P&L. Closing is a single reduce-only order, and your fills are listed in the activity.
<!-- /post -->

<!-- post -->
5/ Know the risks

Leverage magnifies gains and losses. Funding is paid hourly, and a position can be liquidated if the price moves against it. Start small. Not investment advice.

velumtrade.com
<!-- /post -->

## Thread 6. What's next: private accounts

<!-- post -->
On a public chain, anyone can see your balance, copy your trades or watch your liquidation price.

Velum is building private accounts to change that. Here is the plan 🧵
<!-- /post -->

<!-- post -->
1/ Encrypted by design

Balances, positions and P&L are designed to stay encrypted. Only you will be able to read them, with keys that live in your browser and never reach a server.
<!-- /post -->

<!-- post -->
2/ Verified without being seen

Zero-knowledge proofs will let the chain verify that every trade follows the rules, without revealing its size, side or price.
<!-- /post -->

<!-- post -->
3/ Exit on your terms

The design includes a forced exit: if Velum ever went offline, you could still withdraw with your own wallet, and open positions would settle after 7 days.
<!-- /post -->

<!-- post -->
4/ Audit first

Private accounts are in development and will launch only after an external audit of the contracts and circuits. Until then, trades on Velum are public onchain.

Follow @velumtrade for progress.
<!-- /post -->

---

## Thread 1 (Bahasa Indonesia). Kenalan dengan Velum

<!-- post -->
Kenalan dengan Velum: exchange untuk Stock Tokens di Robinhood Chain.

Beli dan jual $TSLA, $NVDA, $AAPL dan lainnya kapan saja, trading perps saham hingga 5x, dan pantau semuanya di satu Portfolio yang live.

Langsung dari wallet kamu.

🧵
<!-- /post -->

<!-- post -->
1/ Spot

Setiap trade spot adalah swap Uniswap asli di Robinhood Chain, langsung dari wallet kamu. Bayar pakai USDG atau ETH yang sudah kamu punya.

Token jadi milikmu, tidak ada likuidasi, dan Velum tidak menambah biaya.
<!-- /post -->

<!-- post -->
2/ Perps

Long atau short perps saham lewat akun Hyperliquid milikmu sendiri, isolated margin, hingga 5x.

Isi saldonya langsung dari Velum: deposit USDC dari Arbitrum tanpa keluar dari aplikasi.
<!-- /post -->

<!-- post -->
3/ Portfolio

Nilai wallet dengan harga live, setiap aset dengan P&L dari transaksimu sendiri di chain, dan tombol Sell di setiap aset.

ETH di Robinhood Chain dan di Ethereum ikut dihitung.
<!-- /post -->

<!-- post -->
4/ Keamanan

Velum tidak pernah memegang key atau dana kamu. Connect wallet hanya membaca saldo, tanpa tanda tangan. Setiap trade kamu tanda tangani sendiri setelah melihat semua angkanya.
<!-- /post -->

<!-- post -->
5/ Berikutnya

Akun privat sedang dikembangkan: saldo, posisi dan P&L dirancang tetap terenkripsi, dengan zero-knowledge proof agar chain bisa memverifikasi trade tanpa melihat isinya.

Kontrak Velum sendiri baru diluncurkan setelah audit eksternal.
<!-- /post -->

<!-- post -->
6/ Mulai kurang dari semenit: velumtrade.com

Follow @velumtrade untuk update.

Velum adalah proyek independen, tidak berafiliasi dengan Robinhood, Uniswap atau Hyperliquid. Perps memakai leverage dan bisa terlikuidasi. Bukan saran investasi.
<!-- /post -->

## Thread 2 (Bahasa Indonesia). Cara beli Stock Tokens di Velum

Lampirkan `video/velum-how-to-buy-1080p.mp4` di post pertama.

<!-- post -->
Cara beli Stock Tokens di Velum, langkah demi langkah.

Empat langkah, sekitar satu menit, dan sahammu langsung masuk ke wallet sendiri. Panduan lengkapnya ada di video.

🧵
<!-- /post -->

<!-- post -->
1/ Buka velumtrade.com lalu pilih Launch app.

Connect wallet cukup sekali klik: tanpa akun, tanpa daftar, tanpa tanda tangan, dan tanpa deposit ke Velum.
<!-- /post -->

<!-- post -->
2/ Pilih Stock Token di daftar market: $TSLA, $NVDA, $AAPL, $AMZN, $META, $MSFT dan lainnya, dengan harga live kapan saja.

Pilih Spot untuk membeli tokennya langsung.
<!-- /post -->

<!-- post -->
3/ Bayar pakai USDG, atau pakai ETH di wallet kamu.

Dengan ETH, satu swap Uniswap mengubahnya jadi USDG lalu jadi saham pilihanmu. Tanpa approval.

Tiket menampilkan nilai order dalam dolar, jumlah yang kamu terima, biaya pool dan rutenya.
<!-- /post -->

<!-- post -->
4/ Review, lalu konfirmasi di wallet.

Semua angka tampil sebelum kamu tanda tangan. Batas minimum dari slippage (0.1%, 0.5% atau 1%) melindungimu: kalau harga bergerak melewatinya, swap ditolak dan tidak ada yang tertrade.
<!-- /post -->

<!-- post -->
5/ Portfolio langsung menampilkan aset baru, nilainya, dan P&L-nya.

Saat ingin keluar, tekan Sell di sebelahnya: tiket terbuka dengan seluruh saldo sudah terisi.

Coba sekarang: velumtrade.com
<!-- /post -->
