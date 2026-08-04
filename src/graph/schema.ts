import { z } from "zod";

export const InlineCommentSchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["info", "suggestion", "warning", "critical"]),
  comment: z.string().min(1).max(2000),
  citedSource: z.string().max(300).optional(),
});

export const PRReviewSchema = z.object({
  summary: z.string().min(1).max(4000),
  overallRisk: z.enum(["low", "medium", "high"]),
  inlineComments: z.array(InlineCommentSchema).max(50),
  approvalRecommendation: z.enum(["approve", "request_changes", "comment_only"]),
});

export type PRReview = z.infer<typeof PRReviewSchema>;
export type InlineComment = z.infer<typeof InlineCommentSchema>;

export const PR_REVIEW_JSON_INSTRUCTIONS = `
Respond with ONLY a single JSON object (no markdown fences, no prose
before or after) matching exactly this shape:

{
  "summary": string,                         // 1-4000 chars, high-level PR summary
  "overallRisk": "low" | "medium" | "high",
  "inlineComments": [
    {
      "filePath": string,
      "line": number,                        // positive integer, line in the new file version
      "severity": "info" | "suggestion" | "warning" | "critical",
      "comment": string,                     // 1-2000 chars
      "citedSource": string                  // optional, <=300 chars. If this comment is
                                              // grounded in a retrieved doc, standard, ADR,
                                              // or existing code pattern, name it here (e.g.
                                              // "docs/ARCHITECTURE.md#repository-layer" or
                                              // "src/api/routes/users.ts, same pattern").
                                              // Omit if the comment is a general observation
                                              // not tied to a specific retrieved source.
    }
  ],                                          // 0-50 items
  "approvalRecommendation": "approve" | "request_changes" | "comment_only"
}

Prefer citing a specific retrieved source over a generic statement whenever
the provided context actually supports the comment — "this bypasses the
repository layer described in docs/ARCHITECTURE.md" is far more useful than
"this could be refactored."
`.trim();

export function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}