-- Audit F-1, F-4. Follow-up to 20261115000000_candle_source, which is left as it is (it may have been
-- applied somewhere): Candle.source becomes nullable with no default, and NULL means "unknown".
--
-- Why: with DEFAULT 'demo', a release that predates the column (the previous release keeps running while
-- a new one builds and migrates, and deploy.sh switches back to it when the new one fails its checks)
-- stored its real candles as 'demo', and the next start of a newer release took them as evidence of a
-- switch from simulated to real prices and deleted all candle history. And the backfill of
-- 20261115000000 tagged every candle with the source of the newest tick, which tags demo-seeded candles
-- (stored without ticks) as real.
--
-- So every existing tag is reset to NULL: a 'demo' tag may be such a default and a real tag may come from
-- that backfill; here neither can be told from a genuine one. Nothing is deleted. On every start the
-- workers tag the NULL candles whose stored ticks prove their source (retagUnknownCandles in
-- apps/workers/src/bootstrap.ts); the others stay NULL: kept, never served as real history on mainnet,
-- never taken as evidence of a source change. Releases older than the column keep inserting without it,
-- and their rows are NULL from now on.
ALTER TABLE "Candle" ALTER COLUMN "source" DROP NOT NULL;
ALTER TABLE "Candle" ALTER COLUMN "source" DROP DEFAULT;
UPDATE "Candle" SET "source" = NULL WHERE "source" IS NOT NULL;
