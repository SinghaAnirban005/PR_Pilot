import { prisma } from "../lib/client.js"
import { Prisma } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import type { CodeChunkInsert, RetrievedChunk } from "../types/index.js";

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

export async function upsertCodeChunks(chunks: CodeChunkInsert[]): Promise<number> {
  if (chunks.length === 0) return 0;

  try {
    const insertedCount = await prisma.$transaction(async (tx) => {
      let count = 0;

      for (const chunk of chunks) {
        const vectorLiteral = toVectorLiteral(chunk.embedding);
        const metadataJson = JSON.stringify(chunk.metadata ?? {});

        const rowCount = await tx.$executeRaw`
          INSERT INTO CodeChunk (id, repo_id, file_path, content, embedding, metadata)
          VALUES (
            gen_random_uuid(),
            ${chunk.repoId},
            ${chunk.filePath},
            ${chunk.content},
            ${vectorLiteral}::vector,
            ${metadataJson}::jsonb
          )
          ON CONFLICT ON CONSTRAINT uq_code_chunks_repo_file_hash
          DO UPDATE SET
            embedding = EXCLUDED.embedding,
            metadata = EXCLUDED.metadata,
            updated_at = now()
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
}

export async function searchSimilarChunks(
  options: VectorSearchOptions,
): Promise<RetrievedChunk[]> {
  const { repoId, queryEmbedding, filePathPrefix } = options;
  const topK = options.topK ?? env.VECTOR_TOP_K;
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  // Dynamic filter fragment using Prisma.sql to prevent SQL injection
  const pathFilter = filePathPrefix
    ? Prisma.sql`AND file_path LIKE ${filePathPrefix + "%"}`
    : Prisma.empty;

  try {
    const results = await prisma.$queryRaw<RetrievedChunk[]>`
      SELECT
        id,
        repo_id AS "repoId",
        file_path AS "filePath",
        content,
        metadata,
        embedding <=> ${vectorLiteral}::vector AS distance
      FROM CodeChunk
      WHERE repo_id = ${repoId}
      ${pathFilter}
      ORDER BY embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${topK}
    `;

    return results;
  } catch (err) {
    throw new VectorStoreError("Vector similarity search failed", err);
  }
}

export async function deleteChunksForFile(repoId: string, filePath: string): Promise<void> {
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

export async function closeVectorStore(): Promise<void> {
  await prisma.$disconnect();
}