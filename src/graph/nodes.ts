import { Octokit } from "@octokit/rest";
import { env } from "../config/env.js";
import { getInstallationOctokit } from "../services/github.js";
import { generateEmbedding } from "../services/embedding.js";
import { searchSimilarChunks } from "../services/vectorStore.js";
import { extractModifiedSymbols, buildRetrievalQuery } from "../services/diffParser.js";
import { completeChat, stripJsonFences, LlmError } from "../services/llm.js";
import { PRReviewSchema, PR_REVIEW_JSON_INSTRUCTIONS, formatZodErrors } from "./schema.js";
import type { AgentState } from "./state.js";

// Node 1
export async function extractDiffNode(
    state: AgentState
): Promise<Partial<AgentState>>{
    const symbols = extractModifiedSymbols(state.prDetails.diff)

    return {
        extractedSymbols: symbols
    }
}

// Node 2
export async function vectorRetrievalNode(
    state: AgentState
): Promise<Partial<AgentState>> {
    const retrievalQuery = buildRetrievalQuery(state.prDetails.diff);

    try {
    const queryEmbedding = await generateEmbedding(retrievalQuery);
    const chunks = await searchSimilarChunks({
      repoId: state.prDetails.repoId,
      queryEmbedding,
      topK: env.VECTOR_TOP_K,
    });

    return { retrievedContext: chunks };
  } catch (err) {
    console.error("Retrieval failed :", err);
    return { retrievedContext: [] };
  }
}

function buildSystemPrompt(): string {
  return [
    "You are an expert senior software engineer performing a pull request code review.",
    "You are thorough, precise, and only flag genuine issues (bugs, security risks, design concerns, missed edge cases).",
    "You are given the PR diff and relevant existing code context retrieved from the repository.",
    PR_REVIEW_JSON_INSTRUCTIONS,
  ].join("\n\n");
}

function buildUserPrompt(state: AgentState): string {
  const { prDetails, retrievedContext, validationErrors, retryCount } = state;

  const contextBlock = retrievedContext.length
    ? retrievedContext
        .map(
          (chunk) =>
            `--- ${chunk.filePath} (similarity distance: ${chunk.distance.toFixed(4)}) ---\n${chunk.content}`,
        )
        .join("\n\n")
    : "(no additional context retrieved)";

  const sections = [
    `PR #${prDetails.prNumber} by ${prDetails.author} on ${prDetails.repoId} (${prDetails.branch} -> ${prDetails.baseBranch})`,
    `## Diff\n${prDetails.diff}`,
    `## Retrieved repository context\n${contextBlock}`,
  ];

  if (retryCount > 0 && validationErrors.length > 0) {
    sections.push(
      [
        `## Previous attempt failed validation (attempt ${retryCount}/${env.MAX_LLM_RETRIES})`,
        "Your prior response did not conform to the required schema. Fix these issues:",
        ...validationErrors.map((e) => `- ${e}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}


// Node 3
export async function llmReasoningNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  try {
    const content = await completeChat({
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(state) },
      ],
      temperature: 0.1,
      jsonMode: true,
    });

    return { analysisDraft: content };
  } catch (err) {
    const message = err instanceof LlmError ? err.message : String(err);
    console.error("LLM call failed:", message);
    return {
      analysisDraft: null,
      validationErrors: [`LLM call failed: ${message}`],
    };
  }
}

// Node 4
export async function outputValidationNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  if(!state.analysisDraft){
    return {
      isApproved: false,
      retryCount: state.retryCount + 1,
      validationErrors: state.validationErrors.length
        ? state.validationErrors
        : ["No analysis draft was produced by the LLM"],
    }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(stripJsonFences(state.analysisDraft))
  } catch (error) {
    console.error('JSON parse failed ', error)
    return {
      isApproved: false,
      retryCount: state.retryCount + 1,
      validationErrors: [`Response was not valid JSON: ${(error as Error).message}`],
    };
  }

  const result = PRReviewSchema.safeParse(parsedJson)
  if (!result.success) {
    const errors = formatZodErrors(result.error);
    console.warn(`Schema validation failed:`, errors);
    return {
      isApproved: false,
      retryCount: state.retryCount + 1,
      validationErrors: errors,
    };
  }

  return {
    isApproved: true,
    validatedReview: result.data,
    validationErrors: [],
  };
}

// Node 5(a)
export async function postReviewNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  const review = state.validatedReview

  if(!review){
    throw new Error('postReviewNode invoked without a validated review in state')
  }

  const octokit = getInstallationOctokit(state.prDetails.installationId)
  const { owner, repo, prNumber, diff } = state.prDetails;

  const latestCommitSha = await resolveHeadCommitSha(octokit, owner, repo, prNumber);
  const riskEmoji: Record<string, string> = { low: "🟢", medium: "🟡", high: "🔴" };

  const summaryBody = [
    `### 🤖 CommitBear Review — ${riskEmoji[review.overallRisk]} ${review.overallRisk.toUpperCase()} risk`,
    "",
    review.summary,
    "",
    `**Recommendation:** \`${review.approvalRecommendation}\``,
  ].join("\n");

  const comments = review.inlineComments
    .filter((c) => diffTouchesLine(diff, c.filePath, c.line))
    .map((c) => ({
      path: c.filePath,
      line: c.line,
      side: "RIGHT" as const,
      body: `**[${c.severity.toUpperCase()}]** ${c.comment}`,
    }));

  
  const event = mapRecommendationToEvent(review.approvalRecommendation);
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: latestCommitSha,
    body: summaryBody,
    event,
    comments,
  });

  return {};
}

// Node 5(b)
export async function fallbackNode(state: AgentState): Promise<Partial<AgentState>> {
  const octokit = getInstallationOctokit(state.prDetails.installationId);
  const { owner, repo, prNumber } = state.prDetails;

  const body = [
    "### ⚠️ CommitBear Review — automated analysis failed",
    "",
    `CommitBear attempted ${state.retryCount} time(s) but could not produce a valid structured review for this PR.`,
    "",
    "<details><summary>Last validation errors</summary>",
    "",
    "```",
    state.validationErrors.join("\n") || "(no error detail available)",
    "```",
    "</details>",
  ].join("\n");

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  return { fallbackTriggered: true };
}

async function resolveHeadCommitSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return data.head.sha;
}

function mapRecommendationToEvent(
  rec: "approve" | "request_changes" | "comment_only",
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  switch (rec) {
    case "approve":
      return "APPROVE";
    case "request_changes":
      return "REQUEST_CHANGES";
    case "comment_only":
      return "COMMENT";
  }
}

function diffTouchesLine(diff: string, filePath: string, line: number): boolean {
  return diff.includes(filePath) && line > 0;
}