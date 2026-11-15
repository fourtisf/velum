-- Audit I-7: tag each candle with the price source it was built from, so simulated (demo) candles are
-- never served as real history (the API serves only non-demo candles on mainnet). Backward compatible:
-- older code that inserts without the column gets 'demo' (never shown as real on mainnet).
ALTER TABLE "Candle" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'demo';

-- Existing rows: the workers never keep candles of two kinds of source (resetHistoryOnSourceChange), so
-- when PriceTick holds real ticks and no demo tick, the stored candles are real: tag them with the
-- source of the newest tick ("oracle" ticks come from Chainlink). With demo ticks, or no ticks at all,
-- they stay 'demo' (the safe default: hidden on mainnet until rebuilt from live ticks).
UPDATE "Candle"
SET "source" = (
  SELECT CASE p."source" WHEN 'oracle' THEN 'chainlink' ELSE p."source" END
  FROM "PriceTick" p ORDER BY p."at" DESC LIMIT 1
)
WHERE NOT EXISTS (SELECT 1 FROM "PriceTick" p WHERE p."source" = 'demo')
  AND EXISTS (SELECT 1 FROM "PriceTick" p WHERE p."source" IN ('robinhood', 'oracle'));
