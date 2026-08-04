export type SourceType = "code" | "doc" | "adr" | "standard" | "requirement";

export interface CodeChunkMetadata {
  language?: string;
  symbolNames?: string[];
  chunkType?: "function" | "class" | "module" | "block" | "section";
  startLine?: number;
  endLine?: number;
  heading?: string;
  [key: string]: unknown;
}

export interface CodeChunkRecord {
  id: string;
  repoId: string;
  filePath: string;
  content: string;
  metadata: CodeChunkMetadata;
  sourceType: SourceType;
}

export interface CodeChunkInsert {
  repoId: string;
  filePath: string;
  content: string;
  embedding: number[];
  metadata: CodeChunkMetadata;
  sourceType: SourceType;
}

export interface RetrievedChunk extends CodeChunkRecord {
  /** Cosine distance from the query embedding; lower is more similar. */
  distance: number;
}

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



export interface ExtractedSymbol {
  name: string;
  filePath: string;
  kind: "function" | "class" | "method" | "variable" | "unknown";
}