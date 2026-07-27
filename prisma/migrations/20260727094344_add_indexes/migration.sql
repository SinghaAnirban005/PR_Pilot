/*
  Warnings:

  - A unique constraint covering the columns `[repoId,filePath,contentHash]` on the table `CodeChunk` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE INDEX "idx_code_chunks_repo_id" ON "CodeChunk"("repoId");

-- CreateIndex
CREATE INDEX "idx_code_chunks_repo_file" ON "CodeChunk"("repoId", "filePath");

-- CreateIndex
CREATE INDEX "idx_code_chunks_metadata" ON "CodeChunk" USING GIN ("metadata" jsonb_path_ops);

-- CreateIndex
CREATE UNIQUE INDEX "CodeChunk_repoId_filePath_contentHash_key" ON "CodeChunk"("repoId", "filePath", "contentHash");

-- CreateIndex
CREATE INDEX "idx_pr_review_runs_repo_pr" ON "PrReviewRun"("repoId", "prNumber");
