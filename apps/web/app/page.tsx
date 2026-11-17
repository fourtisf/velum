import { POOLS } from '@velum/config';
import Link from 'next/link';
import { ContractPill } from '@/components/landing/ContractPill';
import { FrameCap, HeroFrame, LandingMarkets, OcText, PoolSpark, PrivacyRows, RevealCard } from '@/components/landing/Islands';
import { LandingPortfolio } from '@/components/landing/Portfolio';
import { Av, DemoTag } from '@/components/ui';
import { I, Mark, XLogo } from '@/components/icons';
import { Nav } from '@/components/Nav';
import { COPY, LANDING, METRICS, ONCHAIN, P, SOCIAL } from '@/lib/copy';

/** The TSLA pool's demo APR (config seed), shown only where protocol metrics are shown at all. */
const TSLA_APR = POOLS.find((p) => p.symbol === 'TSLA')?.aprEst ?? null;

export default function Landing() {
  return (
    <>
      <Nav variant="landing" />
      <main className="landing">
        <section className="hero">
          <div className="wrap">
            <Link className="pill" href="/app/trade/TSLA">
              <span className="badge acc">{COPY.heroBadge}</span>
              <span className="pt">{COPY.heroPill}</span>
              <span>
                <I.chev />
              </span>
            </Link>
            <h1>Trade stocks onchain, privately.</h1>
            <p className="lead">{LANDING.lead}</p>
            <div className="ctas">
              <Link className="btn btn-white btn-lg" href="/app/trade/TSLA">
                Start trading
              </Link>
              <a className="btn btn-dark btn-lg" href="#how">
                How it works
              </a>
            </div>
            <div className="ca-row">
              <ContractPill />
            </div>
          </div>
          <HeroFrame />
          <FrameCap />
        </section>

        <div className="wrap">
          <div className="stats4">
            <div>
              <b className="num">10</b>
              <small>{LANDING.statMarkets}</small>
            </div>
            <div>
              <b className="num">{P.maxLev}</b>
              <small>{LANDING.statLev}</small>
            </div>
            <div>
              <b className="num">0</b>
              <small>{LANDING.statAdmin}</small>
            </div>
            <div>
              <b className="num">~2s</b>
              <small>{LANDING.statProof}</small>
            </div>
          </div>

          <section className="sec" id="features">
            <span className="eyebrow">Product</span>
            <h2>Everything a trader needs. Nothing anyone else can see.</h2>
            <div className="bento">
              <RevealCard>
                <span className="badge hinttag">Hover to reveal</span>
                <h3>Private by default</h3>
                <p>{LANDING.privateText}</p>
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
                      <Av sym="TSLA" size="sm" />
                      <div>
                        <b>TSLA</b> <small>Long 2×</small>
                      </div>
                      <b className="v num up pvd">+$231.06</b>
                    </div>
                    <div className="mini-row">
                      <Av sym="NVDA" size="sm" />
                      <div>
                        <b>NVDA</b> <small>Spot</small>
                      </div>
                      <b className="v num pvd">$1,864.00</b>
                    </div>
                    <div className="mini-row">
                      <Av sym="AMZN" size="sm" />
                      <div>
                        <b>AMZN</b> <small>Short 3×</small>
                      </div>
                      <b className="v num down pvd">-$12.40</b>
                    </div>
                  </div>
                </div>
              </RevealCard>
              <div className="bc">
                <h3>{LANDING.longShortTitle}</h3>
                <p>{LANDING.longShortText}</p>
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
                <p>{LANDING.proofsText}</p>
                <div className="vis">
                  <div className="steps-mini">
                    {LANDING.stepsMini.map(([t, s]) => (
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
                <h3>{LANDING.freezeTitle}</h3>
                <p>{LANDING.freezeText}</p>
                <div className="vis">
                  <div style={{ display: 'flex', gap: 28 }}>
                    <div>
                      <div className="bignum">0</div>
                      <div className="bignote">{LANDING.freezeBigNote}</div>
                    </div>
                    <div>
                      <div className="bignum">{LANDING.exitBig}</div>
                      <div className="bignote">to exit on your own</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bc">
                <h3>Earn from every swap</h3>
                <p>{LANDING.earnText}</p>
                <div className="vis">
                  <div className="mini">
                    <div className="mini-h">
                      <span>TSLA / USDG pool</span>
                      <span className="badge up">{LANDING.poolBadge(METRICS.real ? TSLA_APR : null)}</span>
                    </div>
                    <PoolSpark />
                  </div>
                </div>
              </div>
              <div className="bc span3" id="developers">
                <div className="devgrid">
                  <div>
                    <h3>Built for builders</h3>
                    <p>{LANDING.buildersText}</p>
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
                        <span>{LANDING.relayEndpoint}</span>
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
                <p>{LANDING.stepShield}</p>
              </div>
              <div className="step">
                <small>Step 2</small>
                <h3>Prove</h3>
                <p>{LANDING.stepProve}</p>
              </div>
              <div className="step">
                <small>Step 3</small>
                <h3>Relay</h3>
                <p>{LANDING.stepRelay}</p>
              </div>
              <div className="step">
                <small>Step 4</small>
                <h3>Settle</h3>
                <p>{LANDING.stepSettle}</p>
              </div>
            </div>
          </section>

          <section className="sec" id="privacy">
            <span className="eyebrow">Privacy</span>
            <h2>Same trade. Two very different views.</h2>
            <p className="lead">{LANDING.privacyLead}</p>
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
                    <th className="r hide-sm">
                      Open interest
                      {METRICS.real ? <DemoTag /> : null}
                    </th>
                    <th className="r">
                      <span className="sr">Trade</span>
                    </th>
                  </tr>
                </thead>
                <LandingMarkets />
              </table>
            </div>
          </section>

          <LandingPortfolio />

          <section className="sec" id="faq">
            <div className="faqgrid">
              <div>
                <span className="eyebrow">FAQ</span>
                <h2>Questions, answered.</h2>
              </div>
              <div className="faq">
                <details open>
                  <summary>Is this real money?</summary>
                  <p>{COPY.faqMoney}</p>
                </details>
                <details>
                  <summary>Can I go long and short?</summary>
                  <p>{LANDING.faqLongShort}</p>
                </details>
                <details>
                  <summary>Who can see my trades?</summary>
                  <p>
                    <OcText sim={LANDING.faqWho} real={ONCHAIN.faqWho} />
                  </p>
                </details>
                <details>
                  <summary>Is it anonymous?</summary>
                  <p>{LANDING.faqAnon}</p>
                </details>
                <details>
                  <summary>Can I lose more than my margin?</summary>
                  <p>{LANDING.faqLoss}</p>
                </details>
                <details>
                  <summary>What if Velum goes offline?</summary>
                  <p>
                    <OcText sim={LANDING.faqOffline} real={ONCHAIN.faqOffline} />
                  </p>
                </details>
              </div>
            </div>
          </section>
        </div>

        <section className="cta">
          <h2>Your trades are nobody&apos;s business.</h2>
          <p>
            <OcText sim={COPY.ctaSub} real={ONCHAIN.ctaSub} />
          </p>
          <div className="ctas">
            <Link className="btn btn-white btn-lg" href="/app/trade/TSLA">
              Start trading
            </Link>
            <Link className="btn btn-dark btn-lg" href="/app/portfolio">
              Open portfolio
            </Link>
            <a className="btn btn-dark btn-lg follow-x" href={SOCIAL.x} target="_blank" rel="noopener noreferrer">
              <XLogo />
              Follow {SOCIAL.xHandle}
            </a>
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
            <p>
              <OcText sim={COPY.footer} real={ONCHAIN.footer} />
            </p>
            <ContractPill />
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
            <a className="foot-x" href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label={SOCIAL.xLabel}>
              <XLogo />X
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
