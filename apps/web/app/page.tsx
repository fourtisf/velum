import Link from 'next/link';
import { HeroFrame, LandingMarkets, PoolSpark, PrivacyRows, RevealCard } from '@/components/landing/Islands';
import { I, Mark } from '@/components/icons';
import { Nav } from '@/components/Nav';

const STEPS_MINI: Array<[string, string]> = [
  ['Lock margin in a private note', ''],
  ['Generate proof in your browser', '1.8s'],
  ['Relayer submits and pays gas', ''],
];

export default function Landing() {
  return (
    <>
      <Nav variant="landing" />
      <main className="landing">
        <section className="hero">
          <div className="wrap">
            <Link className="pill" href="/app/trade/TSLA">
              <span className="badge acc">Testnet</span>
              <span className="pt">Private perps are live on Robinhood Chain</span>
              <span>
                <I.chev />
              </span>
            </Link>
            <h1>Trade stocks onchain, privately.</h1>
            <p className="lead">Velum is a private exchange for tokenized stocks. Spot and perps, with your balance, positions and P&amp;L encrypted end to end.</p>
            <div className="ctas">
              <Link className="btn btn-white btn-lg" href="/app/trade/TSLA">
                Start trading
              </Link>
              <a className="btn btn-dark btn-lg" href="#how">
                How it works
              </a>
            </div>
          </div>
          <HeroFrame />
          <p className="frame-cap">Live demo with test prices. Connect a test wallet to place a private trade.</p>
        </section>

        <div className="wrap">
          <div className="stats4">
            <div>
              <b className="num">10</b>
              <small>Stock markets, spot and perps</small>
            </div>
            <div>
              <b className="num">5×</b>
              <small>Max leverage, long or short</small>
            </div>
            <div>
              <b className="num">0</b>
              <small>Admin keys that can touch funds</small>
            </div>
            <div>
              <b className="num">~2s</b>
              <small>To prove a trade in your browser</small>
            </div>
          </div>

          <section className="sec" id="features">
            <span className="eyebrow">Product</span>
            <h2>Everything a trader needs. Nothing anyone else can see.</h2>
            <div className="bento">
              <RevealCard>
                <span className="badge hinttag">Hover to reveal</span>
                <h3>Private by default</h3>
                <p>Your balance, positions and profit live in encrypted notes that only your device can read. Everyone else sees a commitment.</p>
                <div className="vis">
                  <div className="mini">
                    <div className="mini-h">
                      <span>Private balance</span>
                      <span className="badge acc">
                        <span className="d" />
                        Encrypted
                      </span>
                    </div>
                    <div className="mini-big num pvd">$24,180.52</div>
                    <div className="mini-row">
                      <span className="av sm">T</span>
                      <div>
                        <b>TSLA</b> <small>Long 2×</small>
                      </div>
                      <b className="v num up pvd">+$231.06</b>
                    </div>
                    <div className="mini-row">
                      <span className="av sm">N</span>
                      <div>
                        <b>NVDA</b> <small>Spot</small>
                      </div>
                      <b className="v num pvd">$1,864.00</b>
                    </div>
                    <div className="mini-row">
                      <span className="av sm">A</span>
                      <div>
                        <b>AMZN</b> <small>Short 3×</small>
                      </div>
                      <b className="v num down pvd">-$12.40</b>
                    </div>
                  </div>
                </div>
              </RevealCard>
              <div className="bc">
                <h3>Long or short, up to 5×</h3>
                <p>Post margin, pick a side, and a maker&apos;s standing offer fills you. Close on your own at any time.</p>
                <div className="vis">
                  <div className="mini">
                    <div className="sides" style={{ pointerEvents: 'none' }} aria-hidden="true">
                      <button className="on long" tabIndex={-1}>
                        Long
                      </button>
                      <button tabIndex={-1}>Short</button>
                    </div>
                    <div className="kv2" style={{ marginTop: 12 }}>
                      <span>Leverage</span>
                      <b className="num">3.0×</b>
                    </div>
                    <div className="lbar">
                      <i style={{ width: '50%' }} />
                    </div>
                    <div className="kv2">
                      <span>Position</span>
                      <b className="num">7.70 TSLA</b>
                    </div>
                    <div className="kv2">
                      <span>Liquidation</span>
                      <b className="num">290.11</b>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bc">
                <h3>Proofs made on your device</h3>
                <p>Your browser proves each trade follows the rules. The chain checks the math, never the trade.</p>
                <div className="vis">
                  <div className="steps-mini">
                    {STEPS_MINI.map(([t, s]) => (
                      <div key={t}>
                        <span className="ck">
                          <I.check />
                        </span>
                        {t}
                        {s ? <small>{s}</small> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="bc">
                <h3>Nobody can freeze your funds</h3>
                <p>No admin key, no pause on balances. If services go quiet, a forced exit settles your position.</p>
                <div className="vis">
                  <div style={{ display: 'flex', gap: 28 }}>
                    <div>
                      <div className="bignum">0</div>
                      <div className="bignote">admin keys</div>
                    </div>
                    <div>
                      <div className="bignum">7d</div>
                      <div className="bignote">to exit on your own</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bc">
                <h3>Earn from every swap</h3>
                <p>Add to a pool and keep 0.30% of each trade through it. Your share stays private.</p>
                <div className="vis">
                  <div className="mini">
                    <div className="mini-h">
                      <span>TSLA / USDG pool</span>
                      <span className="badge up">14.2% est. APR</span>
                    </div>
                    <PoolSpark />
                  </div>
                </div>
              </div>
              <div className="bc span3" id="developers">
                <div className="devgrid">
                  <div>
                    <h3>Built for builders</h3>
                    <p>Read markets with a plain HTTP API. Make proofs on the client with the SDK. The relayer submits them and never holds a key.</p>
                    <div style={{ marginTop: 22 }}>
                      <div className="ep">
                        <code>GET /v1/markets</code>
                        <span>Prices, funding and open interest</span>
                      </div>
                      <div className="ep">
                        <code>GET /v1/pools</code>
                        <span>Pool list with rounded sizes</span>
                      </div>
                      <div className="ep">
                        <code>POST /v1/quote</code>
                        <span>Swap estimate</span>
                      </div>
                      <div className="ep">
                        <code>POST /v1/relay</code>
                        <span>Submit a proof you already made</span>
                      </div>
                    </div>
                  </div>
                  <pre className="code" aria-label="Code example" tabIndex={0}>
                    <span className="k">import</span> {'{ openAccount, proveTrade }'} <span className="k">from</span> <span className="s">&quot;@velum/sdk&quot;</span>;{'\n\n'}
                    <span className="c">{'// One wallet signature derives keys on the client.'}</span>
                    {'\n'}
                    <span className="k">const</span> account = <span className="k">await</span> <span className="f">openAccount</span>(signature);{'\n\n'}
                    <span className="c">{'// The proof shows the trade is valid without revealing it.'}</span>
                    {'\n'}
                    <span className="k">const</span> proof = <span className="k">await</span> <span className="f">proveTrade</span>(account, {'{'}
                    {'\n  '}market: <span className="s">&quot;TSLA&quot;</span>, side: <span className="s">&quot;long&quot;</span>, size: <span className="s">500</span>, leverage: <span className="s">2</span>,{'\n'}
                    {'});'}
                    {'\n\n'}
                    <span className="k">await</span> relay.<span className="f">submit</span>(proof); <span className="c">{'// relayer pays gas'}</span>
                  </pre>
                </div>
              </div>
            </div>
          </section>

          <section className="sec" id="how">
            <span className="eyebrow">How it works</span>
            <h2>From wallet to private position in four steps.</h2>
            <div className="steps">
              <div className="step">
                <small>Step 1</small>
                <h3>Shield</h3>
                <p>Move USDG or stock tokens from your wallet into your private balance. This deposit is public.</p>
              </div>
              <div className="step">
                <small>Step 2</small>
                <h3>Prove</h3>
                <p>Pick a trade. Your browser builds a zero-knowledge proof that it follows the rules.</p>
              </div>
              <div className="step">
                <small>Step 3</small>
                <h3>Relay</h3>
                <p>A relayer submits the proof and pays gas, so your wallet never shows up on the trade.</p>
              </div>
              <div className="step">
                <small>Step 4</small>
                <h3>Settle</h3>
                <p>The contract checks the proof and updates your encrypted notes. Only you can read the result.</p>
              </div>
            </div>
          </section>

          <section className="sec" id="privacy">
            <span className="eyebrow">Privacy</span>
            <h2>Same trade. Two very different views.</h2>
            <p className="lead">On a public chain anyone can copy your trades or hunt your liquidation price. Here they can&apos;t.</p>
            <div className="duo">
              <div className="card pcard">
                <div className="hd">
                  <b>What everyone sees</b>
                  <span className="badge">Public chain</span>
                </div>
                <PrivacyRows priv={false} />
              </div>
              <div className="card pcard">
                <div className="hd">
                  <b>What you see</b>
                  <span className="badge up">
                    <span className="d" />
                    Only you
                  </span>
                </div>
                <PrivacyRows priv />
              </div>
            </div>
          </section>

          <section className="sec" id="markets">
            <div className="sec-top">
              <div>
                <span className="eyebrow">Markets</span>
                <h2>Ten stocks. One private balance.</h2>
              </div>
              <Link className="btn btn-dark" href="/app/markets">
                View all markets
              </Link>
            </div>
            <div className="card tbl-wrap" style={{ marginTop: 40 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">Price</th>
                    <th className="r">24h</th>
                    <th className="hide-sm">Last hour</th>
                    <th className="r hide-sm">Open interest</th>
                    <th className="r">
                      <span className="sr">Trade</span>
                    </th>
                  </tr>
                </thead>
                <LandingMarkets />
              </table>
            </div>
          </section>

          <section className="sec" id="faq">
            <div className="faqgrid">
              <div>
                <span className="eyebrow">FAQ</span>
                <h2>Questions, answered.</h2>
              </div>
              <div className="faq">
                <details open>
                  <summary>Is this real money?</summary>
                  <p>No. Velum runs on Robinhood Chain testnet. Test tokens have no value, so you can learn how private trading works without risk.</p>
                </details>
                <details>
                  <summary>Can I go long and short?</summary>
                  <p>Yes. Perps let you go long or short on each stock with up to 5× leverage. A maker takes the other side, and you can close on your own at any time.</p>
                </details>
                <details>
                  <summary>Who can see my trades?</summary>
                  <p>You can. The maker on the other side sees that one position, against a one-time address. Two risk services can read what they need to liquidate. The public only sees that a position changed.</p>
                </details>
                <details>
                  <summary>Is it anonymous?</summary>
                  <p>No. Moving tokens in and out is public. If you want deposits harder to link, vary amounts and timing and withdraw to a fresh wallet.</p>
                </details>
                <details>
                  <summary>Can I lose more than my margin?</summary>
                  <p>No. Each position has its own margin and losses stop there. You can lose all of it, so start small.</p>
                </details>
                <details>
                  <summary>What if Velum goes offline?</summary>
                  <p>Your free balance is yours. You can unshield with your own wallet as long as the chain runs, and a forced exit settles open positions after 7 days.</p>
                </details>
              </div>
            </div>
          </section>
        </div>

        <section className="cta">
          <h2>Your trades are nobody&apos;s business.</h2>
          <p>Get free test USDG from the faucet and make your first private trade in under a minute.</p>
          <div className="ctas">
            <Link className="btn btn-white btn-lg" href="/app/trade/TSLA">
              Start trading
            </Link>
            <Link className="btn btn-dark btn-lg" href="/app/portfolio">
              Open portfolio
            </Link>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-in">
          <div>
            <Link href="/" className="brand">
              <Mark />
              <span>Velum</span>
            </Link>
            <p>An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet with simulated trading. Test tokens have no value.</p>
          </div>
          <div>
            <h3>Product</h3>
            <Link href="/app/trade/TSLA">Trade</Link>
            <Link href="/app/markets">Markets</Link>
            <Link href="/app/swap">Swap</Link>
            <Link href="/app/liquidity">Earn</Link>
          </div>
          <div>
            <h3>Learn</h3>
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
            <a href="#faq">FAQ</a>
          </div>
          <div>
            <h3>Developers</h3>
            <a href="#developers">API</a>
            <a href="#developers">SDK</a>
            <Link href="/">Contact</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
