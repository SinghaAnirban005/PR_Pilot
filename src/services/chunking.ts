import { parse, Lang } from "@ast-grep/napi";
import type { CodeChunkMetadata } from "../types/index.js";

export interface RawChunk {
  filePath: string;
  content: string;
  metadata: CodeChunkMetadata;
}

export const EXTENSION_TO_AST_LANG: Record<string, Lang> = {
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
};

// Extensions eligible for ingestion at all
export const SUPPORTED_EXTENSIONS = new Set([
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

const MAX_CHUNK_CHARS = 4000;
const LINES_PER_CHUNK = 120;
const LINE_CHUNK_OVERLAP = 15;

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
      `AST parse failed`, err);
  }

  if (chunks.length === 0 && source.trim()) {
    return chunkByLines(filePath, source, lang.toString());
  }

  return chunks;
}

/**
 * Generic fallback chunker for languages without a registered
 * ast-grep grammar (Python, Go, Rust, Java, ...)
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

export function chunkFile(filePath: string, source: string, ext: string): RawChunk[] {
  if (!SUPPORTED_EXTENSIONS.has(ext)) return [];

  const astLang = EXTENSION_TO_AST_LANG[ext];
  return astLang
    ? chunkFileWithAst(filePath, source, astLang)
    : chunkByLines(filePath, source, ext.slice(1));
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const EMBEDDING_BATCH_SIZE = 32;
export const MAX_FILE_BYTES = 500_000;