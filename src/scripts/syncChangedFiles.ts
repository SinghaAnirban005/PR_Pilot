import { generateEmbeddings } from "../services/embedding.js";
import {
  deleteChunksForFile,
  upsertCodeChunks,
} from "../services/vectorStore.js";
import { getInstallationOctokit } from "../services/github.js";
import { chunkArray, chunkFile, EMBEDDING_BATCH_SIZE, MAX_FILE_BYTES } from "../services/chunking.js";
import path from "node:path";
import type { CodeChunkInsert } from "../types/index.js";

export interface SyncChangedFilesOptions {
  repoId: string;
  owner: string;
  repo: string;
  installationId: number;
  ref: string;
  changedFiles: string[];
  removedFiles: string[];
}

export interface SyncChangedFilesResult {
  filesUpdated: number;
  filesRemoved: number;
  filesSkipped: number;
  chunksUpserted: number;
}

async function fetchFileContent(
  octokit: ReturnType<typeof getInstallationOctokit>,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref });

    if (Array.isArray(data) || data.type !== "file") return null;
    if (data.size > MAX_FILE_BYTES) return null;
    if (!data.content) return null;

    return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf-8");
  } catch (err) {
    console.warn(`error:`, err);
    return null;
  }
}

export async function syncChangedFiles(
  options: SyncChangedFilesOptions,
): Promise<SyncChangedFilesResult> {
  const { repoId, owner, repo, installationId, ref, changedFiles, removedFiles } = options;

  for (const filePath of removedFiles) {
    await deleteChunksForFile(repoId, filePath);
  }

  const octokit = getInstallationOctokit(installationId);
  const rawChunks: ReturnType<typeof chunkFile> = [];
  let filesSkipped = 0;

  for (const filePath of changedFiles) {
    const ext = path.extname(filePath);
    const source = await fetchFileContent(octokit, owner, repo, filePath, ref);

    if (source === null) {
      filesSkipped++;
      continue;
    }

    // clearing the file's previous chunks before re inserting content changed, so the old chunk hashes no longer apply
    await deleteChunksForFile(repoId, filePath);

    const fileChunks = chunkFile(filePath, source, ext);
    if (fileChunks.length === 0) {
      filesSkipped++;
      continue;
    }

    rawChunks.push(...fileChunks);
  }

  let chunksUpserted = 0;
  for (const batch of chunkArray(rawChunks, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await generateEmbeddings(batch.map((c) => c.content));

    const inserts: CodeChunkInsert[] = batch.map((chunk, i) => {
      const embedding = embeddings[i];
      if (!embedding) {
        throw new Error(`Missing embedding for chunk index ${i} in batch`);
      }
      return {
        repoId,
        filePath: chunk.filePath,
        content: chunk.content,
        embedding,
        metadata: chunk.metadata,
      };
    });

    chunksUpserted += await upsertCodeChunks(inserts);
  }

  const filesUpdated = new Set(rawChunks.map((c) => c.filePath)).size;

  return {
    filesUpdated,
    filesRemoved: removedFiles.length,
    filesSkipped,
    chunksUpserted,
  };
}