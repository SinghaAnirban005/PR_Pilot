export type PullRequestDetails = {
  repoId: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  author: string;
  installationId: number;
  diff: string;
}

export interface CodeChunkMetadata {
  language?: string;
  symbolNames?: string[];
  chunkType?: "function" | "class" | "module" | "block";
  startLine?: number;
  endLine?: number;
  [key: string]: unknown;
}

export interface ExtractedSymbol {
  name: string;
  filePath: string;
  kind: "function" | "class" | "method" | "variable" | "unknown";
}

export interface CodeChunkRecord {
  id: string;
  repoId: string;
  filePath: string;
  content: string;
  metadata: CodeChunkMetadata;
}

export interface RetrievedChunk extends CodeChunkRecord {
  /** Cosine distance from the query embedding; lower is more similar. */
  distance: number;
}

export interface CodeChunkInsert {
  repoId: string;
  filePath: string;
  content: string;
  embedding: number[];
  metadata: CodeChunkMetadata;
}