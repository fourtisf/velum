# Velum

Private spot and perps for tokenized stocks on Robinhood Chain (testnet).

> Status: approved UI prototype + full build brief. Production build happens in phases.
> Claude Code: start with `CLAUDE.md`.

## What's in this repo

| Path | What it is |
|---|---|
| `CLAUDE.md` | Master brief for Claude Code: rules, stack, routes, phases |
| `prototype/index.html` | Approved UI. Open it in a browser, it runs offline with demo data |
| `design/tokens.css` | Colors, type, radii, spacing pulled from the prototype |
| `docs/` | Product spec, architecture, API, contracts + privacy, deploy, roadmap |
| `packages/db/prisma/schema.prisma` | Starting database schema |
| `packages/config/robinhood-testnet.json` | Chain ID, explorer, faucets, token addresses |
| `deploy/` | Nginx, PM2, deploy scripts |
| `.env.example` | Every environment variable the apps read |

## Quick start: put the prototype live (Phase 1)

On a fresh Hostinger VPS (Ubuntu 22.04+), with your domain's A record pointing at it:

```bash
git clone <this-repo> /opt/velum && cd /opt/velum
sudo DOMAIN=velum.example EMAIL=you@example.com bash deploy/phase1-static.sh
```

That installs Nginx, copies the prototype to `/var/www/velum`, and issues an SSL cert.

## Full stack (Phase 2+)

```
apps/web      Next.js 14   :3000
apps/api      Fastify      :4000
apps/workers  BullMQ jobs  (no port)
PostgreSQL    :5432
Redis         :6379
```

See `docs/05-deploy-vps.md` for the complete server setup and `deploy/deploy.sh` for releases.

## Stack

Next.js 14 · Fastify · Prisma · PostgreSQL · Redis · wagmi/viem · Foundry · Noir · PM2 · Nginx

## Disclaimer

An independent project on Robinhood Chain, not affiliated with Robinhood. Testnet only.
Test tokens have no value. Contracts are not audited.
