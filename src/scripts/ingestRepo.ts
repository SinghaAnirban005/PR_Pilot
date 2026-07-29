import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateEmbeddings } from "../services/embedding.js";
import { deleteChunksForRepo, upsertCodeChunks } from "../services/vectorStore.js";
import { getInstallationOctokit } from "../services/github.js";
import {
  chunkArray,
  chunkFile,
  EMBEDDING_BATCH_SIZE,
  MAX_FILE_BYTES,
  SUPPORTED_EXTENSIONS,
  type RawChunk,
} from "../services/chunking.js";
import type { CodeChunkInsert } from "../types/index.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "__pycache__",
]);

export interface IngestRepoOptions {
  repoId: string;
  owner: string;
  repo: string;
  installationId: number;
  ref?: string | undefined;
}
function* walkFiles(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walkFiles(fullPath, root);
    } else {
      yield path.relative(root, fullPath);
    }
  }
}

async function cloneRepo(options: IngestRepoOptions): Promise<string> {
  const octokit = getInstallationOctokit(options.installationId);
  const { token } = (await octokit.auth({ type: "installation" })) as { token: string };

  const tmpDir = await mkdtemp(path.join(tmpdir(), "diffgraph-"));
  const cloneUrl = `https://x-access-token:${token}@github.com/${options.owner}/${options.repo}.git`;

  const args = ["clone", "--depth", "1"];
  if (options.ref) {
    args.push("--branch", options.ref);
  }
  args.push(cloneUrl, tmpDir);

  await execFileAsync("git", args);
  return tmpDir;
}

async function collectChunks(repoDir: string): Promise<RawChunk[]> {
  const allChunks: RawChunk[] = [];

  for (const relPath of walkFiles(repoDir, repoDir)) {
    const ext = path.extname(relPath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const absPath = path.join(repoDir, relPath);
    const source = await readFile(absPath, "utf-8").catch(() => null);
    if (source === null || source.length === 0) continue;

    if (source.length > MAX_FILE_BYTES) continue;

    allChunks.push(...chunkFile(relPath, source, ext));
  }

  return allChunks;
}

export async function ingestRepo(
  options: IngestRepoOptions,
): Promise<{ filesProcessed: number; chunksUpserted: number }> {
  console.log(`[ingestRepo] Starting full ingestion for ${options.repoId}`);
  const repoDir = await cloneRepo(options);

  try {
    const rawChunks = await collectChunks(repoDir);
    // clearing the repo's existing chunks first so renamed/deleted files don't linger as orphans.
    await deleteChunksForRepo(options.repoId);

    let totalUpserted = 0;
    for (const batch of chunkArray(rawChunks, EMBEDDING_BATCH_SIZE)) {
      const embeddings = await generateEmbeddings(batch.map((c) => c.content));

      const inserts: CodeChunkInsert[] = batch.map((chunk, i) => {
        const embedding = embeddings[i];
        if (!embedding) {
          throw new Error(`Missing embedding for chunk index ${i} in batch`);
        }
        return {
          repoId: options.repoId,
          filePath: chunk.filePath,
          content: chunk.content,
          embedding,
          metadata: chunk.metadata,
        };
      });

      totalUpserted += await upsertCodeChunks(inserts);
    }

    const filesProcessed = new Set(rawChunks.map((c) => c.filePath)).size;

    return { filesProcessed, chunksUpserted: totalUpserted };
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

// Allow direct CLI invocation: `npm run ingest -- owner repo installationId [ref]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [owner, repo, installationIdRaw, ref] = process.argv.slice(2);
  if (!owner || !repo || !installationIdRaw) {
    console.error("Usage: npm run ingest -- <owner> <repo> <installationId> [ref]");
    process.exit(1);
  }

  ingestRepo({
    repoId: `${owner}/${repo}`,
    owner,
    repo,
    installationId: Number(installationIdRaw),
    ref,
  })
    .then((result) => {
      console.log("Ingestion result:", result);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Ingestion failed:", err);
      process.exit(1);
    });
}