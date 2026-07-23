CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "PrReviewStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "CodeChunk" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrReviewRun" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "status" "PrReviewStatus" NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "validationErrors" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ,

    CONSTRAINT "PrReviewRun_pkey" PRIMARY KEY ("id")
);
