import { HfInference } from "@huggingface/inference";
import { env } from "../config/env.js";

const hf = new HfInference(env.HF_TOKEN)

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;
const MAX_BATCH_SIZE = 32;

export class EmbeddingServiceError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingServiceError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const maybe = err as { status?: unknown; httpResponse?: { status?: unknown } };
  if (typeof maybe.status === "number") return maybe.status;
  if (typeof maybe.httpResponse?.status === "number") return maybe.httpResponse.status;
  return undefined;
}

async function embedBatchWithRetry(inputs: string[]): Promise<number[][]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await hf.featureExtraction({
        model: env.HF_EMBEDDING_MODEL,
        inputs,
      });

      return normalizeEmbeddingResult(result, inputs.length);
    } catch (err) {
      lastError = err;
      const status = extractStatus(err);

      if (!isRetryableStatus(status) || attempt === MAX_RETRIES) {
        throw new EmbeddingServiceError(
          `Embedding request failed${status ? ` with status ${status}` : ""} after ${attempt + 1} attempt(s)`,
          err,
        );
      }

      const backoff = BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_DELAY_MS;
      const delay = backoff + jitter;

      console.warn(
        `[embedding] retryable error (status=${status ?? "unknown"}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
    }
  }

  throw new EmbeddingServiceError("Embedding request failed", lastError);
}

function meanPool(tokenVectors: number[][]): number[] {
  const firstVector = tokenVectors[0];
  if (!firstVector) {
    throw new EmbeddingServiceError("Cannot mean-pool an empty token vector list");
  }
  const dims = firstVector.length;
  const sums = new Array<number>(dims).fill(0);

  for (const tokenVec of tokenVectors) {
    for (let d = 0; d < dims; d++) {
      sums[d] = (sums[d] ?? 0) + (tokenVec[d] ?? 0);
    }
  }

  return sums.map((s) => s / tokenVectors.length);
}

function normalizeEmbeddingResult(result: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(result)) {
    throw new EmbeddingServiceError("Unexpected embedding response shape (not an array)");
  }

  // Case 1: already number[][]
  if (result.length > 0 && Array.isArray(result[0]) && typeof result[0][0] === "number") {
    const vectors = result as number[][];
    if (vectors.length !== expectedCount) {
      throw new EmbeddingServiceError(
        `Embedding count mismatch: expected ${expectedCount}, got ${vectors.length}`,
      );
    }
    return vectors;
  }

  // Case 2: single flat vector (only valid when expectedCount === 1)
  if (typeof result[0] === "number") {
    if (expectedCount !== 1) {
      throw new EmbeddingServiceError("Received a single flat vector for a multi-input batch");
    }
    return [result as number[]];
  }

  // Case 3: token level embeddings [batch][tokens][dims] -> mean pool per item
  if (
    result.length > 0 &&
    Array.isArray(result[0]) &&
    Array.isArray((result[0] as unknown[])[0])
  ) {
    const pooled = (result as number[][][]).map(meanPool);
    if (pooled.length !== expectedCount) {
      throw new EmbeddingServiceError(
        `Embedding count mismatch after pooling: expected ${expectedCount}, got ${pooled.length}`,
      );
    }
    return pooled as number[][];
  }

  throw new EmbeddingServiceError("Unrecognized embedding response shape");
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batches = chunkArray(texts, MAX_BATCH_SIZE);
  const results: number[][] = [];

  for (const batch of batches) {
    const vectors = await embedBatchWithRetry(batch);
    results.push(...vectors);
  }

  return results;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [vector] = await generateEmbeddings([text]);
  if (!vector) {
    throw new EmbeddingServiceError("Embedding generation returned no vector");
  }
  return vector;
}