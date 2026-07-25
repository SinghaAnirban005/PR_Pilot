import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse, Lang } from "@ast-grep/napi";
import { generateEmbeddings } from "../services/embedding.js";
import { upsertCodeChunks } from "../services/vectorStore.js";
import { getInstallationOctokit } from "../services/github.js";
import type { CodeChunkInsert, CodeChunkMetadata } from "../types/index.js";

const execFileAsync = promisify(execFile);

// @ast-grep/napi's core package ships grammars for JS/TS/TSX/CSS/HTML
// only; other languages (Python, Go, Rust, Java, ...) would require
// registering a separate compiled custom-lang grammar. Rather than
// silently mis parsing those files we route them through a generic
// line window chunker (chunkByLines) so ingestion still covers
// polyglot repos just without symbol precise boundaries.
const EXTENSION_TO_AST_LANG: Record<string, Lang> = {
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
};

const SUPPORTED_EXTENSIONS = new Set([
  ...Object.keys(EXTENSION_TO_AST_LANG),
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
]);

const LINES_PER_CHUNK = 120;
const LINE_CHUNK_OVERLAP = 15;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "__pycache__",
]);

const MAX_CHUNK_CHARS = 4000;
const EMBEDDING_BATCH_SIZE = 32;

export interface IngestRepoOptions {
  repoId: string;
  owner: string;
  repo: string;
  installationId: number;
  ref?: string | undefined;
}

interface RawChunk {
  filePath: string;
  content: string;
  metadata: CodeChunkMetadata;
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

function chunkFileWithAst(filePath: string, source: string, lang: Lang): RawChunk[] {
  const chunks: RawChunk[] = [];

  try {
    const root = parse(lang, source).root();

    const CANDIDATE_KINDS = [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "arrow_function",
    ];

    const seenRanges = new Set<string>();

    for (const kind of CANDIDATE_KINDS) {
      const matches = root.findAll({ rule: { kind } });
      for (const node of matches) {
        const range = node.range();
        const key = `${range.start.index}-${range.end.index}`;
        if (seenRanges.has(key)) continue;
        seenRanges.add(key);

        const text = node.text();
        if (!text.trim()) continue;

        chunks.push({
          filePath,
          content: text.slice(0, MAX_CHUNK_CHARS),
          metadata: {
            language: lang.toString(),
            chunkType: kind.includes("class") ? "class" : "function",
            startLine: range.start.line + 1,
            endLine: range.end.line + 1,
          },
        });
      }
    }
  } catch (err) {
    console.warn(
      `AST parse failed for ${filePath} :`,
      err,
    );
  }

  if (chunks.length === 0 && source.trim()) {
    return chunkByLines(filePath, source, lang.toString());
  }

  return chunks;
}

/**
 * Generic fallback chunker for languages without a registered
 * ast grep grammar (Python, Go, Rust, Java, ...) and for AST parse
 * failures on supported grammars: splits the file into overlapping
 * fixed size line windows. The overlap keeps a function that straddles
 * a window boundary from losing all context in either chunk.
 */
function chunkByLines(filePath: string, source: string, languageLabel: string): RawChunk[] {
  const lines = source.split("\n");
  const chunks: RawChunk[] = [];
  const step = LINES_PER_CHUNK - LINE_CHUNK_OVERLAP;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + LINES_PER_CHUNK, lines.length);
    const content = lines.slice(start, end).join("\n").slice(0, MAX_CHUNK_CHARS);

    if (content.trim()) {
      chunks.push({
        filePath,
        content,
        metadata: {
          language: languageLabel,
          chunkType: "block",
          startLine: start + 1,
          endLine: end,
        },
      });
    }

    if (end >= lines.length) break;
  }

  return chunks;
}

async function collectChunks(repoDir: string): Promise<RawChunk[]> {
  const allChunks: RawChunk[] = [];

  for (const relPath of walkFiles(repoDir, repoDir)) {
    const ext = path.extname(relPath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const absPath = path.join(repoDir, relPath);
    const source = await readFile(absPath, "utf-8").catch(() => null);
    if (source === null || source.length === 0) continue;

    // Skip extremely large generated files.
    if (source.length > 500_000) continue;

    const astLang = EXTENSION_TO_AST_LANG[ext];
    const fileChunks = astLang
      ? chunkFileWithAst(relPath, source, astLang)
      : chunkByLines(relPath, source, ext.slice(1));

    allChunks.push(...fileChunks);
  }

  return allChunks;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Full ingestion pipeline for a repository: clone -> AST chunk ->
 * batch embed -> upsert into pgvector. Intended to be invoked from
 * the `ingest-repository` Inngest function, or directly via
 * `npm run ingest`.
 */
export async function ingestRepo(
  options: IngestRepoOptions,
): Promise<{ filesProcessed: number; chunksUpserted: number }> {
  console.log(`Starting ingestion for ${options.repoId}`);
  const repoDir = await cloneRepo(options);

  try {
    const rawChunks = await collectChunks(repoDir);

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
