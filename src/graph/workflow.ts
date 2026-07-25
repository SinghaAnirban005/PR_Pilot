import { StateGraph, START, END } from "@langchain/langgraph";
import { env } from "../config/env.js";
import { AgentStateAnnotation, type AgentState } from "./state.js"

import {
  extractDiffNode,
  vectorRetrievalNode,
  llmReasoningNode,
  outputValidationNode,
  postReviewNode,
  fallbackNode,
} from "./nodes.js";

const NODE_NAMES = {
  extractDiff: "ExtractDiffNode",
  vectorRetrieval: "VectorRetrievalNode",
  llmReasoning: "LLMReasoningNode",
  outputValidation: "OutputValidationNode",
  postReview: "PostReviewNode",
  fallback: "FallbackNode",
} as const

function routeAfterValidation(
    state: AgentState
): typeof NODE_NAMES.postReview | typeof NODE_NAMES.llmReasoning | typeof NODE_NAMES.fallback {
    if(state.isApproved){
        return NODE_NAMES.postReview
    }

    if(state.retryCount < env.MAX_LLM_RETRIES){
        return NODE_NAMES.llmReasoning
    }

    return NODE_NAMES.fallback
}

export function buildDiffGraphWorkflow() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode(NODE_NAMES.extractDiff, extractDiffNode)
    .addNode(NODE_NAMES.vectorRetrieval, vectorRetrievalNode)
    .addNode(NODE_NAMES.llmReasoning, llmReasoningNode)
    .addNode(NODE_NAMES.outputValidation, outputValidationNode)
    .addNode(NODE_NAMES.postReview, postReviewNode)
    .addNode(NODE_NAMES.fallback, fallbackNode)

    .addEdge(START, NODE_NAMES.extractDiff)
    .addEdge(NODE_NAMES.extractDiff, NODE_NAMES.vectorRetrieval)
    .addEdge(NODE_NAMES.vectorRetrieval, NODE_NAMES.llmReasoning)
    .addEdge(NODE_NAMES.llmReasoning, NODE_NAMES.outputValidation)

    .addConditionalEdges(NODE_NAMES.outputValidation, routeAfterValidation, {
      [NODE_NAMES.postReview]: NODE_NAMES.postReview,
      [NODE_NAMES.llmReasoning]: NODE_NAMES.llmReasoning,
      [NODE_NAMES.fallback]: NODE_NAMES.fallback,
    })

    .addEdge(NODE_NAMES.postReview, END)
    .addEdge(NODE_NAMES.fallback, END);

  return graph.compile();
}

export type DiffGraphWorkflow = ReturnType<typeof buildDiffGraphWorkflow>;

let cachedWorkflow: DiffGraphWorkflow | null = null;

export function getDiffGraphWorkflow(): DiffGraphWorkflow {
  if (!cachedWorkflow) {
    cachedWorkflow = buildDiffGraphWorkflow();
  }
  return cachedWorkflow;
}