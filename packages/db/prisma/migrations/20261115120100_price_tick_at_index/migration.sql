-- Audit F-8: the hourly prune deletes PriceTick rows by age alone ("at" < cutoff). The only index led
-- with "marketId", so each prune scanned the whole table.
CREATE INDEX "PriceTick_at_idx" ON "PriceTick"("at");
