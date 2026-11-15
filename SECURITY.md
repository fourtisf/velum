# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull
request or discussion for a security problem.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports
within a few working days and will keep you updated until the issue is fixed.

## Scope

- Velum runs on Robinhood Chain **testnet**; on mainnet it is read-only (real wallet connection and
  public balances, live prices, simulated trades). No Velum contract is deployed on mainnet before an
  external audit. Testnet tokens have no value.
- In scope: this repository (web app, API, workers, contracts, deploy scripts).
- Out of scope: Robinhood Chain itself, third-party wallets and services, and anything that needs
  access you were not given. Do not test against other people's funds or data, and do not run
  denial-of-service or load tests against the live site.

## Bounty

There is no bug bounty yet; one is planned before mainnet (Phase 5).
