# Article: Introducing Velum

For X Articles, Medium, Mirror or the website blog. For X Articles, paste from the copy page
(https://claude.ai/artifact/DBFZhhQWgsUHBvpHBdyHc9): X's editor does not read Markdown. Cover images: `velum-article-cover-1500x600.png` (5:2, X Articles
and Mirror headers) and `velum-article-cover-1600x900.png` (16:9, Medium, blog, link previews), source
`article-cover.html`. English first, then formal Bahasa Indonesia. Replace `[link]` with the site URL.

Facts in this article match what is live on mainnet (README, November 16 2026). If Velum's builder fee is turned on,
change the "Fees" section.

---

## English

# Introducing Velum: Stock Tokens, traded from accounts you control

*How spot and perpetual trading work on Velum today, and where the privacy layer comes in.*

## In short

- Trade Stock Tokens such as TSLA, NVDA and AAPL from your own wallet. No account, no custody.
- **Spot**, 24/7 through Uniswap, settled directly to your wallet.
- **Perpetuals**, long or short up to 5x, from your own Hyperliquid account.
- **Next:** private execution, with encrypted positions verified by zero-knowledge proofs.

Stock markets keep office hours. They close in the evening and over the weekend, and access usually runs through a
broker who holds your assets for you. Stock Tokens on Robinhood Chain change part of that equation: a stock exposure
that lives onchain and moves like any other token.

Velum is built for that market. It is a trading interface for Stock Tokens that offers spot and perpetual trading
without asking you to hand over your keys or your funds. This article explains how it works today, what happens behind
each trade, and what comes next.

## What Velum is

Velum is an independent project on Robinhood Chain. It connects your own wallet to two sources of real liquidity:

- **Spot**, through Uniswap pools on Robinhood Chain, available 24 hours a day, seven days a week.
- **Perpetuals**, through Hyperliquid's stock perpetual markets, from your own Hyperliquid account.

There is no Velum account to register and no deposit into Velum. Velum does not take custody at any point.

## How it works

### 1. Connect a self-custody wallet

Open Velum and connect any wallet that supports Robinhood Chain. That wallet is your identity, your balance and your
signature. Velum never receives your private key.

### 2. Trade spot, around the clock

The Spot ticket and the Swap page trade Stock Tokens against USDG through a curated set of Uniswap pools on Robinhood
Chain. Velum quotes each pool onchain for your exact amount and routes the trade to the best one.

Before anything is signed, the review shows what you pay, the quoted amount and the **minimum** you will accept, which
comes from your slippage setting. If the price moves past that minimum, the swap is refused and nothing is traded.
Approvals are exact rather than unlimited, and the tokens settle directly into your wallet. You pay the pool fee and a
small amount of ETH for gas.

Because these pools trade continuously, Velum's prices and charts are built from real swaps, so they keep moving on
weekends and holidays when traditional markets are closed.

### 3. Open leveraged positions

For long and short exposure, the Perps ticket places orders on Hyperliquid's stock perpetual markets from **your own
Hyperliquid account**.

- **Funding the account.** Deposit USDC on Hyperliquid with the same wallet. Velum links there until your account
  holds a first deposit.
- **Enabling trading.** Your wallet signs one approval, without gas, that lets your browser place orders for 30 days.
  The key behind that approval is generated in your browser and stays there. It can place and close orders, but it
  cannot withdraw or transfer funds out of your account.
- **Placing an order.** Choose long or short, a size in USD, leverage from 1x to 5x and a slippage limit. Positions use
  isolated margin, so a loss is limited to the margin of that position. Each order is an immediate limit order: it
  fills within your price limit or it is cancelled, so it never fills at a worse price than you approved.
- **Managing positions.** Your open positions and fills appear in Velum. Closing a position sends a reduce-only order
  for the whole size, which can only close, never open the other way.

Velum caps positions at 5x leverage and 100 tokens per position. Funding is paid hourly, and a position can be
liquidated if the market moves against it.

### 4. Review before you sign

Every trade on Velum, spot or perpetual, opens a review first. It shows the size, the margin, the worst price you
accept, the estimated liquidation price for perpetuals, and the fees. For perpetuals you also tick a statement
confirming that the trade uses real money and can lose its margin. Nothing is signed until you confirm.

## Markets

Velum lists ten Stock Token markets: **TSLA, NVDA, AAPL, META, AMZN, MSFT, COIN, PLTR, AMD and NFLX**. Each has spot
liquidity on Uniswap and a perpetual market on Hyperliquid. The trade terminal shows the live mark price, hourly
funding and open interest of each perpetual market.

## Custody and security

Velum's model is simple: **you keep your keys and your assets.**

- Spot trades move tokens from your wallet to your wallet, through Uniswap's contracts.
- Perpetual positions sit in your own Hyperliquid account. The browser-held key that places orders cannot withdraw.
- Velum's servers never receive a seed phrase, a private key or a signature-derived key.

That also means today's trades are **public**: spot trades are visible onchain, and perpetual positions are visible on
Hyperliquid. Which brings us to what comes next.

## What's next: private execution

On a public chain, anyone can follow a wallet, copy its trades or estimate where its positions would be liquidated.
Velum's name comes from the Latin for "veil", and privacy is the reason the project exists.

The privacy layer is **in development**. It is designed to keep balances, positions and P&L in encrypted notes that
only your device can read, with zero-knowledge proofs generated in your browser so the chain can verify that each
trade follows the rules without seeing it. A relayer will submit those proofs, so your wallet does not appear on the
trade. Velum's own contracts will hold funds only after an external audit.

## Fees

Velum currently adds no fee of its own. On spot trades you pay the Uniswap pool fee and gas; on perpetuals you pay
Hyperliquid's trading fee and funding.

## Getting started

1. Connect your wallet at [link].
2. For spot, hold USDG and a little ETH for gas on Robinhood Chain.
3. For perpetuals, deposit USDC on Hyperliquid with the same wallet, then open the Perps tab.

Follow [@veliumtrade](https://x.com/veliumtrade) for updates on the privacy layer.

---

*Velum is an independent project on Robinhood Chain and is not affiliated with Robinhood, Uniswap or Hyperliquid.
Leveraged trading involves significant risk, including the loss of margin. This article is for information only and
is not investment advice.*

---

## Bahasa Indonesia

# Mengenal Velum: Trading Stock Token dari akun yang Anda kendalikan

*Cara kerja trading spot dan perpetual di Velum saat ini, dan peran lapisan privasi ke depannya.*

## Ringkasnya

- Trading Stock Token seperti TSLA, NVDA dan AAPL dari wallet Anda sendiri. Tanpa akun, tanpa kustodian.
- **Spot**, 24/7 melalui Uniswap, langsung diterima di wallet Anda.
- **Perpetual**, long atau short hingga 5x, dari akun Hyperliquid Anda sendiri.
- **Berikutnya:** eksekusi privat, dengan posisi terenkripsi yang diverifikasi zero-knowledge proof.

Pasar saham punya jam kerja. Bursa tutup di malam hari dan akhir pekan, dan aksesnya biasanya melalui broker yang
menyimpan aset Anda. Stock Token di Robinhood Chain mengubah sebagian dari itu: eksposur saham yang hidup di onchain dan
bisa berpindah seperti token lainnya.

Velum dibangun untuk pasar tersebut. Velum adalah antarmuka trading Stock Token yang menyediakan trading spot dan
perpetual tanpa meminta Anda menyerahkan kunci maupun dana. Artikel ini menjelaskan cara kerjanya saat ini, apa yang
terjadi di balik setiap transaksi, dan apa yang akan datang.

## Apa itu Velum

Velum adalah proyek independen di Robinhood Chain yang menghubungkan wallet Anda ke dua sumber likuiditas nyata:

- **Spot**, melalui pool Uniswap di Robinhood Chain, tersedia 24 jam sehari, tujuh hari seminggu.
- **Perpetual**, melalui pasar perpetual saham Hyperliquid, dari akun Hyperliquid Anda sendiri.

Tidak ada akun Velum yang perlu didaftarkan dan tidak ada deposit ke Velum. Velum tidak pernah memegang aset Anda.

## Cara kerjanya

### 1. Hubungkan wallet self-custody

Buka Velum dan hubungkan wallet apa pun yang mendukung Robinhood Chain. Wallet itu adalah identitas, saldo, dan tanda
tangan Anda. Velum tidak pernah menerima private key Anda.

### 2. Trading spot sepanjang waktu

Tiket Spot dan halaman Swap memperdagangkan Stock Token terhadap USDG melalui sejumlah pool Uniswap terpilih di
Robinhood Chain. Velum mengambil kuotasi onchain dari setiap pool untuk jumlah persis Anda dan memilih yang terbaik.

Sebelum apa pun ditandatangani, ringkasan transaksi menampilkan jumlah yang Anda bayar, jumlah yang dikuotasikan, dan
**jumlah minimum** yang Anda terima sesuai batas slippage. Jika harga bergerak melewati batas tersebut, swap dibatalkan
dan tidak ada yang diperdagangkan. Persetujuan token bersifat persis, bukan tanpa batas, dan token langsung masuk ke
wallet Anda. Anda membayar biaya pool dan sedikit ETH untuk gas.

Karena pool ini aktif terus-menerus, harga dan grafik di Velum dibangun dari swap nyata, sehingga tetap bergerak di
akhir pekan dan hari libur ketika bursa tradisional tutup.

### 3. Buka posisi dengan leverage

Untuk posisi long dan short, tiket Perps menempatkan order di pasar perpetual saham Hyperliquid dari **akun
Hyperliquid Anda sendiri**.

- **Mengisi akun.** Deposit USDC di Hyperliquid dengan wallet yang sama. Velum menampilkan tautannya sampai akun Anda
  memiliki deposit pertama.
- **Mengaktifkan trading.** Wallet Anda menandatangani satu persetujuan tanpa gas yang mengizinkan browser menempatkan
  order selama 30 hari. Kunci untuk persetujuan itu dibuat di browser Anda dan tetap di sana. Kunci ini bisa membuka
  dan menutup order, tetapi tidak bisa menarik atau memindahkan dana keluar dari akun Anda.
- **Menempatkan order.** Pilih long atau short, ukuran dalam USD, leverage 1x hingga 5x, dan batas slippage. Posisi
  memakai isolated margin, sehingga kerugian terbatas pada margin posisi tersebut. Setiap order adalah limit order
  instan: terisi di dalam batas harga Anda atau dibatalkan, sehingga tidak pernah terisi di harga yang lebih buruk dari
  yang Anda setujui.
- **Mengelola posisi.** Posisi terbuka dan riwayat transaksi tampil di Velum. Menutup posisi mengirim order
  reduce-only untuk seluruh ukuran, yang hanya bisa menutup dan tidak akan membuka posisi berlawanan.

Velum membatasi leverage hingga 5x dan 100 token per posisi. Funding dibayar setiap jam, dan posisi bisa terlikuidasi
jika pasar bergerak berlawanan.

### 4. Tinjau sebelum menandatangani

Setiap transaksi di Velum, spot maupun perpetual, selalu diawali ringkasan: ukuran, margin, harga terburuk yang Anda
terima, perkiraan harga likuidasi untuk perpetual, dan biaya. Untuk perpetual, Anda juga mencentang pernyataan bahwa
transaksi ini memakai uang sungguhan dan bisa kehilangan margin. Tidak ada yang ditandatangani sebelum Anda konfirmasi.

## Pasar

Velum menyediakan sepuluh pasar Stock Token: **TSLA, NVDA, AAPL, META, AMZN, MSFT, COIN, PLTR, AMD dan NFLX**.
Masing-masing memiliki likuiditas spot di Uniswap dan pasar perpetual di Hyperliquid. Terminal trading menampilkan
harga mark, funding per jam, dan open interest dari setiap pasar perpetual secara langsung.

## Kustodi dan keamanan

Prinsip Velum sederhana: **kunci dan aset tetap milik Anda.**

- Transaksi spot memindahkan token dari wallet Anda ke wallet Anda, melalui kontrak Uniswap.
- Posisi perpetual berada di akun Hyperliquid Anda sendiri. Kunci di browser yang menempatkan order tidak bisa menarik
  dana.
- Server Velum tidak pernah menerima seed phrase, private key, maupun kunci turunan dari tanda tangan.

Artinya, transaksi saat ini masih **publik**: swap spot terlihat di onchain dan posisi perpetual terlihat di
Hyperliquid. Inilah alasan langkah berikutnya.

## Selanjutnya: eksekusi privat

Di chain publik, siapa pun bisa mengikuti sebuah wallet, menyalin transaksinya, atau memperkirakan di harga berapa
posisinya terlikuidasi. Nama Velum berasal dari bahasa Latin yang berarti "tirai", dan privasi adalah alasan proyek ini
ada.

Lapisan privasi **sedang dalam pengembangan**. Lapisan ini dirancang untuk menyimpan saldo, posisi, dan P&L dalam
catatan terenkripsi yang hanya bisa dibaca perangkat Anda, dengan zero-knowledge proof yang dibuat di browser agar chain
dapat memverifikasi setiap transaksi tanpa melihat isinya. Relayer akan mengirimkan proof tersebut sehingga wallet Anda
tidak muncul di transaksi. Kontrak milik Velum baru akan memegang dana setelah audit eksternal.

## Biaya

Saat ini Velum tidak menambahkan biaya apa pun. Untuk spot, Anda membayar biaya pool Uniswap dan gas; untuk perpetual,
Anda membayar biaya trading Hyperliquid dan funding.

## Cara memulai

1. Hubungkan wallet Anda di [link].
2. Untuk spot, siapkan USDG dan sedikit ETH untuk gas di Robinhood Chain.
3. Untuk perpetual, deposit USDC di Hyperliquid dengan wallet yang sama, lalu buka tab Perps.

Ikuti [@veliumtrade](https://x.com/veliumtrade) untuk kabar terbaru tentang lapisan privasi.

---

*Velum adalah proyek independen di Robinhood Chain dan tidak berafiliasi dengan Robinhood, Uniswap maupun
Hyperliquid. Trading dengan leverage memiliki risiko tinggi, termasuk kehilangan margin. Artikel ini hanya untuk
informasi dan bukan saran investasi.*
