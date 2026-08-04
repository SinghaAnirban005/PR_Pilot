/*
  Warnings:

  - The primary key for the `CodeChunk` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `CodeChunk` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `PrReviewRun` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `PrReviewRun` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('code', 'doc', 'adr', 'standard', 'requirement');

-- AlterTable
ALTER TABLE "CodeChunk" DROP CONSTRAINT "CodeChunk_pkey",
ADD COLUMN     "sourceType" "SourceType" NOT NULL DEFAULT 'code',
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "PrReviewRun" DROP CONSTRAINT "PrReviewRun_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD CONSTRAINT "PrReviewRun_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "idx_code_chunks_repo_source_type" ON "CodeChunk"("repoId", "sourceType");
