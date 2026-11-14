# Prompt to paste into Claude Code

Open this folder in Claude Code, then paste the block below as your first message.

---

```
You are the lead engineer for Velum. Read CLAUDE.md first, then every file in docs/ in
order, then read prototype/index.html end to end (CSS tokens and the <script> state,
calc functions and view functions).

Goal for this session:
1. Phase 1 — Give me the exact commands to put prototype/index.html live on my Hostinger
   VPS with HTTPS using deploy/phase1-static.sh. Ask me for DOMAIN and EMAIL.
2. Phase 2 — Set up the pnpm monorepo described in docs/02-architecture.md and port the
   prototype to Next.js 14 pixel-faithfully (all routes in CLAUDE.md §3), with wagmi/viem
   on Robinhood Chain testnet, the Fastify API from docs/03-api.md (health, markets,
   candles, pools, stats, quote), the price + candles workers, Prisma on PostgreSQL,
   Redis, and DEMO_MODE trading that matches the prototype's flows and receipts.

Rules: keep the stack in CLAUDE.md, keep every number in CLAUDE.md §5, verify chain
constants in packages/config/robinhood-testnet.json against official docs before using
them, write original code (no copying other protocols), never handle user keys on the
server. Work in small commits, run lint/typecheck/build before each, and tell me when
Phase 2 is ready to deploy with deploy/deploy.sh. Do not start Phase 3 without my go-ahead.
```
