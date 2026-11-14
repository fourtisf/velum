-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('live', 'coming_soon', 'close_only');

-- CreateEnum
CREATE TYPE "RelayStatus" AS ENUM ('queued', 'submitted', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "priceFeed" TEXT,
    "status" "MarketStatus" NOT NULL DEFAULT 'coming_soon',
    "maxLeverage" INTEGER NOT NULL DEFAULT 5,
    "takerFeeBps" INTEGER NOT NULL DEFAULT 6,
    "openInterestCap" DECIMAL(38,6) NOT NULL DEFAULT 100000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceTick" (
    "id" BIGSERIAL NOT NULL,
    "marketId" TEXT NOT NULL,
    "price" DECIMAL(38,12) NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceTick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "marketId" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "t" TIMESTAMP(3) NOT NULL,
    "o" DECIMAL(38,12) NOT NULL,
    "h" DECIMAL(38,12) NOT NULL,
    "l" DECIMAL(38,12) NOT NULL,
    "c" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("marketId","tf","t")
);

-- CreateTable
CREATE TABLE "FundingEpoch" (
    "id" BIGSERIAL NOT NULL,
    "marketId" TEXT NOT NULL,
    "rate" DECIMAL(38,18) NOT NULL,
    "index" DECIMAL(78,18) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "address" TEXT,
    "feeBps" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolHourly" (
    "poolId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "sizeRounded" DECIMAL(38,2) NOT NULL,
    "aprEst" DECIMAL(10,4) NOT NULL,
    "fills" INTEGER NOT NULL,
    "makers" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PoolHourly_pkey" PRIMARY KEY ("poolId","hour")
);

-- CreateTable
CREATE TABLE "NoteRecord" (
    "leaf" INTEGER NOT NULL,
    "commitment" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "ephemeralKey" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteRecord_pkey" PRIMARY KEY ("leaf")
);

-- CreateTable
CREATE TABLE "Nullifier" (
    "value" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "block" BIGINT NOT NULL,

    CONSTRAINT "Nullifier_pkey" PRIMARY KEY ("value")
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "market" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "block" BIGINT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelayJob" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "proof" BYTEA NOT NULL,
    "publicInputs" JSONB NOT NULL,
    "fee" DECIMAL(38,6) NOT NULL,
    "status" "RelayStatus" NOT NULL DEFAULT 'queued',
    "txHash" TEXT,
    "block" BIGINT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelayJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_symbol_key" ON "Market"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Market_tokenAddress_key" ON "Market"("tokenAddress");

-- CreateIndex
CREATE INDEX "PriceTick_marketId_at_idx" ON "PriceTick"("marketId", "at");

-- CreateIndex
CREATE INDEX "FundingEpoch_marketId_at_idx" ON "FundingEpoch"("marketId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Pool_marketId_key" ON "Pool"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "Pool_address_key" ON "Pool"("address");

-- CreateIndex
CREATE UNIQUE INDEX "NoteRecord_commitment_key" ON "NoteRecord"("commitment");

-- CreateIndex
CREATE INDEX "NoteRecord_block_idx" ON "NoteRecord"("block");

-- CreateIndex
CREATE INDEX "ChainEvent_kind_block_idx" ON "ChainEvent"("kind", "block");

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_txHash_logIndex_key" ON "ChainEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "RelayJob_status_createdAt_idx" ON "RelayJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PriceTick" ADD CONSTRAINT "PriceTick_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingEpoch" ADD CONSTRAINT "FundingEpoch_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pool" ADD CONSTRAINT "Pool_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoolHourly" ADD CONSTRAINT "PoolHourly_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

