import { ExtractedSymbol } from "../types/index.js";

interface DiffFileSection {
  filePath: string;
  addedLines: string[];
}

const FILE_HEADER_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ .* @@/;

const SYMBOL_PATTERNS: RegExp[] = [
  // TypeScript / JavaScript
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
  /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:public|private|protected|static|async)?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/,
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?.*=>/,
  // Python
  /\bdef\s+([A-Za-z_]\w*)\s*\(/,
  /\bclass\s+([A-Za-z_]\w*)\s*[:(]/,
  // Go
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  // Java / Kotlin
  /\b(?:public|private|protected)\s+(?:static\s+)?[\w<>[\]]+\s+([A-Za-z_]\w*)\s*\(/,
  // Rust
  /\bfn\s+([A-Za-z_]\w*)\s*\(/,
];

function inferKind(line: string): ExtractedSymbol["kind"] {
  if (/\bclass\b/.test(line)) return "class";
  if (/\b(function|def|func|fn)\b/.test(line)) return "function";
  if (/\bconst\b.*=>/.test(line)) return "function";
  if (/\(.*\)\s*[:{]/.test(line)) return "method";
  return "unknown";
}

function splitIntoFileSections(diff: string): DiffFileSection[] {
  const lines = diff.split("\n");
  const sections: DiffFileSection[] = [];
  let current: DiffFileSection | null = null;
  let inHunk = false;

  for (const line of lines) {
    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch?.[1]) {
      if (current) sections.push(current);
      current = { filePath: fileMatch[1], addedLines: [] };
      inHunk = false;
      continue;
    }

    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true;
      continue;
    }

    if (current && inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    }
  }

  if (current) sections.push(current);
  return sections;
}

export function extractModifiedSymbols(diff: string): ExtractedSymbol[] {
  const sections = splitIntoFileSections(diff);
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    for (const line of section.addedLines) {
      for (const pattern of SYMBOL_PATTERNS) {
        const match = pattern.exec(line);
        const name = match?.[1];
        if (!name) continue;

        const key = `${section.filePath}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        symbols.push({
          name,
          filePath: section.filePath,
          kind: inferKind(line),
        });
        break;
      }
    }
  }

  return symbols;
}

export function extractModifiedFilePaths(diff: string): string[] {
  return splitIntoFileSections(diff).map((s) => s.filePath);
}

export function buildRetrievalQuery(diff: string): string {
  const symbols = extractModifiedSymbols(diff);
  const files = extractModifiedFilePaths(diff);

  const symbolNames = [...new Set(symbols.map((s) => s.name))];
  return [`Files changed: ${files.join(", ")}`, `Symbols changed: ${symbolNames.join(", ")}`].join(
    "\n",
  );
}