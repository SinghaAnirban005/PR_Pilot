import { prisma } from "../lib/client.js"
import { Prisma } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import type { CodeChunkInsert, RetrievedChunk, SourceType } from "../types/index.js";
import { createHash } from "crypto";

export class VectorStoreError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VectorStoreError";
  }
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function upsertCodeChunks(
  chunks: CodeChunkInsert[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  try {
    const insertedCount = await prisma.$transaction(async (tx) => {
      let count = 0;

      for (const chunk of chunks) {
        const vectorLiteral = toVectorLiteral(chunk.embedding);
        const metadataJson = JSON.stringify(chunk.metadata ?? {});
        const contentHash = createHash("sha256").update(chunk.content).digest("hex");

        const rowCount = await tx.$executeRaw`
          INSERT INTO "CodeChunk" (
            "id", 
            "repoId", 
            "filePath", 
            "content",
            "embedding", 
            "contentHash",  
            "metadata", 
            "sourceType",
            "updatedAt"
          )
          VALUES (
            gen_random_uuid(),
            ${chunk.repoId},
            ${chunk.filePath},
            ${chunk.content},
            ${vectorLiteral}::vector,
             ${contentHash},
            ${metadataJson}::jsonb,
            ${chunk.sourceType},
            now()
          )
          ON CONFLICT ("repoId", "filePath", "contentHash")
          DO UPDATE SET
            "embedding" = EXCLUDED."embedding",
            "metadata" = EXCLUDED."metadata",
            "sourceType" = EXCLUDED."sourceType",
            "updatedAt" = now()
        `;

        count += rowCount;
      }

      return count;
    });

    return insertedCount;
  } catch (err) {
    throw new VectorStoreError("Failed to upsert code chunks", err);
  }
}

export interface VectorSearchOptions {
  repoId: string;
  queryEmbedding: number[];
  topK?: number;
  /** Optional file path prefix filter, e.g. to scope search to a subdirectory. */
  filePathPrefix?: string;
  /** Optional source-type filter, e.g. to search only within 'doc' chunks. */
  sourceTypes?: SourceType[];
}

export async function searchSimilarChunks(
  options: VectorSearchOptions,
): Promise<RetrievedChunk[]> {
  const { repoId, queryEmbedding, filePathPrefix, sourceTypes } = options;
  const topK = options.topK ?? env.VECTOR_TOP_K;
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  const pathFilter = filePathPrefix
    ? Prisma.sql`AND "filePath" LIKE ${filePathPrefix + "%"}`
    : Prisma.empty;

  const sourceTypeFilter =
    sourceTypes && sourceTypes.length > 0
      ? Prisma.sql`AND "sourceType" = ANY(${sourceTypes}::text[])`
      : Prisma.empty;

  try {
    const results = await prisma.$queryRaw<RetrievedChunk[]>`
      SELECT
        "id",
        "repoId",
        "filePath",
        "content",
        "metadata",
        "sourceType",
        "embedding" <=> ${vectorLiteral}::vector AS distance
      FROM "CodeChunk"
      WHERE "repoId" = ${repoId}
      ${pathFilter}
      ${sourceTypeFilter}
      ORDER BY "embedding" <=> ${vectorLiteral}::vector ASC
      LIMIT ${topK}
    `;

    return results;
  } catch (err) {
    throw new VectorStoreError("Vector similarity search failed", err);
  }
}

export interface CategorizedSearchOptions {
  repoId: string;
  queryEmbedding: number[];
  /** Map of source type -> how many chunks to retrieve for that category. */
  topKByCategory: Partial<Record<SourceType, number>>;
}

export async function searchSimilarChunksByCategory(
  options: CategorizedSearchOptions,
): Promise<RetrievedChunk[]> {
  const { repoId, queryEmbedding, topKByCategory } = options;

  const entries = Object.entries(topKByCategory).filter(
    (entry): entry is [SourceType, number] => (entry[1] ?? 0) > 0,
  );

  const resultsPerCategory = await Promise.all(
    entries.map(([sourceType, topK]) =>
      searchSimilarChunks({
        repoId,
        queryEmbedding,
        topK,
        sourceTypes: [sourceType],
      }),
    ),
  );

  return resultsPerCategory.flat();
}

export async function deleteChunksForFile(
  repoId: string,
  filePath: string,
): Promise<void> {
  try {
    await prisma.codeChunk.deleteMany({
      where: {
        repoId,
        filePath,
      },
    });
  } catch (err) {
    throw new VectorStoreError("Failed to delete chunks for file", err);
  }
}

export async function deleteChunksForRepo(repoId: string): Promise<number> {
  try {
    const result = await prisma.codeChunk.deleteMany({
      where: {
        repoId,
      },
    });
    return result.count;
  } catch (err) {
    throw new VectorStoreError("Failed to delete chunks for repo", err);
  }
}

export async function hasIngestedRepo(repoId: string): Promise<boolean> {
  try {
    const chunk = await prisma.codeChunk.findFirst({
      where: {
        repoId,
      },
      select: {
        id: true,
      },
    });
    return chunk !== null;
  } catch (err) {
    throw new VectorStoreError("Failed to check repo ingestion status", err);
  }
}

export async function closeVectorStore(): Promise<void> {
  await prisma.$disconnect();
}