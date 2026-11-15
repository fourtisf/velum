-- Phase 3 indexer (apps/workers/src/onchain): checkpoint, block hashes for reorg rewinds, token decimals and
-- the projections of the contract events (positions, trades, maker offers, spot pools, vault transfers,
-- funding, per-account activity). Additive only: ChainEvent gains three nullable columns, nothing existing
-- changes. Amounts are DECIMAL(78,0): uint256/int256 base units, exact.

-- CreateEnum
CREATE TYPE "PerpPositionStatus" AS ENUM ('open', 'closed', 'liquidated', 'forced_exit');

-- AlterTable
ALTER TABLE "ChainEvent" ADD COLUMN     "address" TEXT,
ADD COLUMN     "at" TIMESTAMP(3),
ADD COLUMN     "chainId" INTEGER;

-- CreateTable
CREATE TABLE "IndexerCheckpoint" (
    "chainId" INTEGER NOT NULL,
    "deployment" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCheckpoint_pkey" PRIMARY KEY ("chainId","deployment")
);

-- CreateTable
CREATE TABLE "IndexedBlock" (
    "chainId" INTEGER NOT NULL,
    "number" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "IndexedBlock_pkey" PRIMARY KEY ("chainId","number")
);

-- CreateTable
CREATE TABLE "OnchainToken" (
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,

    CONSTRAINT "OnchainToken_pkey" PRIMARY KEY ("chainId","address")
);

-- CreateTable
CREATE TABLE "PerpPosition" (
    "chainId" INTEGER NOT NULL,
    "perps" TEXT NOT NULL,
    "positionId" BIGINT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT,
    "taker" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "isLong" BOOLEAN NOT NULL,
    "qty" DECIMAL(78,0) NOT NULL,
    "entry" DECIMAL(78,0) NOT NULL,
    "takerMargin" DECIMAL(78,0) NOT NULL,
    "makerMargin" DECIMAL(78,0) NOT NULL,
    "size" DECIMAL(78,0),
    "offerId" BIGINT,
    "status" "PerpPositionStatus" NOT NULL,
    "openedBlock" BIGINT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "openTx" TEXT NOT NULL,
    "closedBlock" BIGINT,
    "closedAt" TIMESTAMP(3),
    "closeTx" TEXT,
    "closePrice" DECIMAL(78,0),
    "exitPrice" DECIMAL(78,0),
    "takerPnl" DECIMAL(78,0),
    "takerFunding" DECIMAL(78,0),
    "fee" DECIMAL(78,0),
    "takerOut" DECIMAL(78,0),
    "makerOut" DECIMAL(78,0),
    "liquidator" TEXT,
    "liquidatedSide" TEXT,
    "liquidationPrice" DECIMAL(78,0),
    "penalty" DECIMAL(78,0),
    "reward" DECIMAL(78,0),
    "shortfall" DECIMAL(78,0),
    "exitRequester" TEXT,
    "exitRequestedAt" TIMESTAMP(3),
    "exitSettleAfter" TIMESTAMP(3),
    "exitAtEntry" BOOLEAN,
    "lastBlock" BIGINT NOT NULL,
    "lastLogIndex" INTEGER NOT NULL,

    CONSTRAINT "PerpPosition_pkey" PRIMARY KEY ("chainId","perps","positionId")
);

-- CreateTable
CREATE TABLE "PerpTrade" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "perps" TEXT NOT NULL,
    "positionId" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT,
    "taker" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "isLong" BOOLEAN NOT NULL,
    "qty" DECIMAL(78,0) NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "notional" DECIMAL(78,0) NOT NULL,
    "fee" DECIMAL(78,0) NOT NULL,
    "offerId" BIGINT,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerpTrade_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "MakerOffer" (
    "chainId" INTEGER NOT NULL,
    "book" TEXT NOT NULL,
    "offerId" BIGINT NOT NULL,
    "maker" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT,
    "backingPosted" DECIMAL(78,0) NOT NULL,
    "backing" DECIMAL(78,0) NOT NULL,
    "largestFill" DECIMAL(78,0) NOT NULL,
    "openSpreadBps" INTEGER NOT NULL,
    "closeSpreadBps" INTEGER NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "fills" INTEGER NOT NULL DEFAULT 0,
    "returned" DECIMAL(78,0),
    "postedBlock" BIGINT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "postTx" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "lastLogIndex" INTEGER NOT NULL,

    CONSTRAINT "MakerOffer_pkey" PRIMARY KEY ("chainId","book","offerId")
);

-- CreateTable
CREATE TABLE "SpotPoolState" (
    "chainId" INTEGER NOT NULL,
    "pools" TEXT NOT NULL,
    "stock" TEXT NOT NULL,
    "symbol" TEXT,
    "stockReserve" DECIMAL(78,0) NOT NULL,
    "usdgReserve" DECIMAL(78,0) NOT NULL,
    "totalShares" DECIMAL(78,0) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "lastLogIndex" INTEGER NOT NULL,

    CONSTRAINT "SpotPoolState_pkey" PRIMARY KEY ("chainId","pools","stock")
);

-- CreateTable
CREATE TABLE "SpotSwap" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "pools" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" DECIMAL(78,0) NOT NULL,
    "amountOut" DECIMAL(78,0) NOT NULL,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotSwap_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "SpotLiquidity" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "pools" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "stock" TEXT NOT NULL,
    "stockAmount" DECIMAL(78,0) NOT NULL,
    "usdgAmount" DECIMAL(78,0) NOT NULL,
    "shares" DECIMAL(78,0) NOT NULL,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotLiquidity_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "VaultTransfer" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "vault" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultTransfer_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "FundingPoint" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "perps" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "symbol" TEXT,
    "rate" DECIMAL(78,0) NOT NULL,
    "index" DECIMAL(78,0) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "block" BIGINT NOT NULL,

    CONSTRAINT "FundingPoint_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateTable
CREATE TABLE "AccountActivity" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "account" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "market" TEXT,
    "symbol" TEXT,
    "positionId" BIGINT,
    "data" JSONB NOT NULL,
    "block" BIGINT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountActivity_pkey" PRIMARY KEY ("chainId","txHash","logIndex","account")
);

-- CreateIndex
CREATE INDEX "PerpPosition_chainId_taker_idx" ON "PerpPosition"("chainId", "taker");

-- CreateIndex
CREATE INDEX "PerpPosition_chainId_maker_idx" ON "PerpPosition"("chainId", "maker");

-- CreateIndex
CREATE INDEX "PerpPosition_chainId_perps_status_idx" ON "PerpPosition"("chainId", "perps", "status");

-- CreateIndex
CREATE INDEX "PerpTrade_chainId_perps_positionId_idx" ON "PerpTrade"("chainId", "perps", "positionId");

-- CreateIndex
CREATE INDEX "PerpTrade_chainId_market_block_idx" ON "PerpTrade"("chainId", "market", "block");

-- CreateIndex
CREATE INDEX "MakerOffer_chainId_maker_idx" ON "MakerOffer"("chainId", "maker");

-- CreateIndex
CREATE INDEX "MakerOffer_chainId_market_active_idx" ON "MakerOffer"("chainId", "market", "active");

-- CreateIndex
CREATE INDEX "SpotSwap_chainId_account_idx" ON "SpotSwap"("chainId", "account");

-- CreateIndex
CREATE INDEX "SpotLiquidity_chainId_account_idx" ON "SpotLiquidity"("chainId", "account");

-- CreateIndex
CREATE INDEX "VaultTransfer_chainId_from_idx" ON "VaultTransfer"("chainId", "from");

-- CreateIndex
CREATE INDEX "VaultTransfer_chainId_to_idx" ON "VaultTransfer"("chainId", "to");

-- CreateIndex
CREATE INDEX "FundingPoint_chainId_perps_market_timestamp_idx" ON "FundingPoint"("chainId", "perps", "market", "timestamp");

-- CreateIndex
CREATE INDEX "AccountActivity_chainId_account_block_logIndex_idx" ON "AccountActivity"("chainId", "account", "block", "logIndex");

-- CreateIndex
CREATE INDEX "ChainEvent_chainId_block_idx" ON "ChainEvent"("chainId", "block");

-- CreateIndex
CREATE INDEX "ChainEvent_chainId_address_kind_idx" ON "ChainEvent"("chainId", "address", "kind");
