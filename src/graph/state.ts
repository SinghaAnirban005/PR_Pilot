import { Annotation } from "@langchain/langgraph";
import type { PRReview } from "./schema.js";
import { RetrievedChunk, PullRequestDetails, ExtractedSymbol } from "../types/index.js";

function replace<T>(current: T, update: T): T {
    return update
}

export const AgentStateAnnotation = Annotation.Root({
  prDetails: Annotation<PullRequestDetails>({
    reducer: replace,
    default: () => ({
      repoId: "",
      owner: "",
      repo: "",
      prNumber: 0,
      branch: "",
      baseBranch: "",
      author: "",
      installationId: 0,
      diff: "",
    }),
  }),

  extractedSymbols: Annotation<ExtractedSymbol[]>({
    reducer: replace,
    default: () => [],
  }),

  retrievedContext: Annotation<RetrievedChunk[]>({
    reducer: replace,
    default: () => [],
  }),

  analysisDraft: Annotation<string | null>({
    reducer: replace,
    default: () => null,
  }),

  validatedReview: Annotation<PRReview | null>({
    reducer: replace,
    default: () => null,
  }),

  validationErrors: Annotation<string[]>({
    reducer: replace,
    default: () => [],
  }),

  retryCount: Annotation<number>({
    reducer: replace,
    default: () => 0,
  }),

  isApproved: Annotation<boolean>({
    reducer: replace,
    default: () => false,
  }),

  fallbackTriggered: Annotation<boolean>({
    reducer: replace,
    default: () => false,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State