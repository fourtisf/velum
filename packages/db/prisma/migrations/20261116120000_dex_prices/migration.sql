-- On-chain DEX prices, display only (packages/config/src/dex.ts): decoded swaps of the configured pools, their
-- candles and the indexer checkpoint. Separate from Candle and PriceTick, so nothing tradable reads them.

-- CreateTable
CREATE TABLE "DexTrade" (
    "pool" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "notional" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "DexTrade_pkey" PRIMARY KEY ("pool","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "DexCandle" (
    "symbol" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "t" TIMESTAMP(3) NOT NULL,
    "o" DECIMAL(38,18) NOT NULL,
    "h" DECIMAL(38,18) NOT NULL,
    "l" DECIMAL(38,18) NOT NULL,
    "c" DECIMAL(38,18) NOT NULL,
    "trades" INTEGER NOT NULL,
    "pool" TEXT NOT NULL,

    CONSTRAINT "DexCandle_pkey" PRIMARY KEY ("symbol","tf","t")
);

-- CreateTable
CREATE TABLE "DexCheckpoint" (
    "key" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DexCheckpoint_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "DexTrade_symbol_at_idx" ON "DexTrade"("symbol", "at");

-- CreateIndex
CREATE INDEX "DexTrade_pool_block_logIndex_idx" ON "DexTrade"("pool", "block", "logIndex");

-- CreateIndex
CREATE INDEX "DexTrade_at_idx" ON "DexTrade"("at");

