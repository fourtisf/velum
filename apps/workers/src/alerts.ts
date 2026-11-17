/**
 * velum-alerts: the Telegram bot of Velum's perps alerts (src/alerts/core.ts). Runs only when TELEGRAM_BOT_TOKEN is set
 * (deploy/ecosystem.config.cjs). Long-polls Telegram for commands, and checks every linked wallet on Hyperliquid's
 * public info API within a fixed weight budget. It holds no key but the bot token, never signs anything and reads only
 * public data.
 */
import { parseRedisUrl } from '@velum/config';
import { HL_API, HL_DEX } from '@velum/config/src/hyperliquid';
import { Redis } from 'ioredis';
import { CODE_KEY, OFFSET_KEY, STATE_KEY, SUBS_KEY, checkWallet, handleMessage, roundMs, type AlertStore, type HlReader, type Sub, type WalletState } from './alerts/core';
import { createLogger } from './lib/log';

const log = createLogger();
const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
if (!/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(token)) {
  log.error('TELEGRAM_BOT_TOKEN is missing or malformed (from @BotFather); velum-alerts stops');
  process.exit(1);
}
const redisUrl = parseRedisUrl(process.env.REDIS_URL ?? '');
if (!redisUrl.ok) {
  log.error('REDIS_URL is invalid; velum-alerts stops', { err: redisUrl.error });
  process.exit(1);
}
const redis = new Redis({ ...redisUrl.options, maxRetriesPerRequest: 3, connectTimeout: 5000 });
redis.on('error', (err) => log.warn('redis error', { err: err.message }));

const TG = `https://api.telegram.org/bot${token}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

const store: AlertStore = {
  takeCode: async (code) => (await redis.getdel(CODE_KEY(code))) ?? null,
  getSub: async (chatId) => {
    const v = await redis.hget(SUBS_KEY, String(chatId));
    return v ? (JSON.parse(v) as Sub) : null;
  },
  setSub: async (chatId, sub) => {
    if (sub && sub.wallets.length) await redis.hset(SUBS_KEY, String(chatId), JSON.stringify(sub));
    else await redis.hdel(SUBS_KEY, String(chatId));
  },
  allSubs: async () => new Map(Object.entries(await redis.hgetall(SUBS_KEY)).map(([k, v]) => [Number(k), JSON.parse(v) as Sub])),
  getState: async (addr) => {
    const v = await redis.get(STATE_KEY(addr));
    return v ? (JSON.parse(v) as WalletState) : null;
  },
  setState: async (addr, s) => {
    await redis.set(STATE_KEY(addr), JSON.stringify(s), 'EX', 30 * 86_400);
  },
};

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${HL_API}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`info ${String(body.type)} ${r.status}`);
  return (await r.json()) as T;
}

const hl: HlReader = {
  positions: async (user) => {
    const st = await info<{ assetPositions?: Array<{ position: { coin: string; szi: string; positionValue: string; liquidationPx: string | null } }> }>({ type: 'clearinghouseState', user, dex: HL_DEX });
    return (st.assetPositions ?? []).map((a) => a.position);
  },
  fills: (user, from) => info({ type: 'userFillsByTime', user, startTime: from + 1, aggregateByTime: true }),
  ledger: (user, from) => info({ type: 'userNonFundingLedgerUpdates', user, startTime: from + 1 }),
};

async function send(chatId: number, text: string) {
  const r = await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
  if (r.status === 403) {
    // The user blocked the bot: forget the chat.
    await store.setSub(chatId, null);
    return;
  }
  if (!r.ok) log.warn('telegram send failed', { status: r.status });
}

async function pollCommands() {
  while (!stopping) {
    try {
      const offset = Number((await redis.get(OFFSET_KEY)) ?? 0);
      const r = await fetch(`${TG}/getUpdates?timeout=25&offset=${offset}&allowed_updates=%5B%22message%22%5D`, { signal: AbortSignal.timeout(35_000) });
      const j = (await r.json()) as { ok?: boolean; result?: Array<{ update_id: number; message?: { chat?: { id?: number; type?: string }; text?: string } }> };
      for (const u of j.result ?? []) {
        await redis.set(OFFSET_KEY, String(u.update_id + 1));
        const chat = u.message?.chat;
        if (!chat?.id || chat.type !== 'private' || typeof u.message?.text !== 'string') continue;
        const reply = await handleMessage(store, chat.id, u.message.text);
        await send(reply.chatId, reply.text);
      }
    } catch (e) {
      log.warn('telegram poll failed', { err: (e as Error).message });
      await sleep(5000);
    }
  }
}

async function checkLoop() {
  while (!stopping) {
    const started = Date.now();
    let wallets = 0;
    try {
      const subs = await store.allSubs();
      const byWallet = new Map<string, number[]>();
      for (const [chat, sub] of subs) for (const w of sub.wallets) byWallet.set(w, [...(byWallet.get(w) ?? []), chat]);
      wallets = byWallet.size;
      const gap = wallets ? roundMs(wallets) / wallets : 0;
      for (const [w, chats] of byWallet) {
        if (stopping) break;
        const t = Date.now();
        try {
          const msgs = await checkWallet(store, hl, w, Date.now());
          for (const m of msgs) for (const c of chats) await send(c, m);
        } catch (e) {
          log.warn('wallet check failed', { err: (e as Error).message });
        }
        await sleep(Math.max(0, gap - (Date.now() - t)));
      }
    } catch (e) {
      log.warn('alerts round failed', { err: (e as Error).message });
    }
    log.debug('alerts round', { wallets, ms: Date.now() - started });
    await sleep(Math.max(5_000, 60_000 - (Date.now() - started)));
  }
}

for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref();
    void redis.quit();
  });

log.info('velum-alerts started');
void pollCommands();
void checkLoop();
