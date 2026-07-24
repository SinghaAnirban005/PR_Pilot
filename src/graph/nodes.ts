import { Octokit } from "@octokit/rest";
import { env } from "../config/env.js";
import { getInstallationOctokit } from "../services/github.js";
import { generateEmbedding } from "../services/embedding.js";
import { searchSimilarChunks } from "../services/vectorStore.js";
import { extractModifiedSymbols, buildRetrievalQuery } from "../services/diffParser.js";
import { completeChat, stripJsonFences, LlmError } from "../services/llm.js";
import { PRReviewSchema, PR_REVIEW_JSON_INSTRUCTIONS, formatZodErrors } from "./schema.js";
import type { AgentState } from "./state.js";