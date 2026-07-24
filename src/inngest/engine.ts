import { inngest } from "./client.js";
import { prAnalyzed, repoIngestionReq } from "./client.js";

export const analyzePullRequest = inngest.createFunction(
  {
    id: "analyze-pull-request",
    name: "Analyze Pull Request",
    concurrency: {
      key: "event.data.repoId",
      limit: 3,
    },
    retries: 2,
    triggers: [prAnalyzed]
  },
  async ({ event, step }) => {
    const prDetails = event.data;

    const result = await step.run("Analyze PR with DiffGraph", async () => {
      const workflow = getDiffGraphWorkflow();

      const finalState = await workflow.invoke({
        prDetails,
      });

      return {
        isApproved: finalState.isApproved,
        fallbackTriggered: finalState.fallbackTriggered,
        retryCount: finalState.retryCount,
      };
    });

    return {
      repoId: prDetails.repoId,
      prNumber: prDetails.prNumber,
      ...result,
    };
  }
);


export const ingestRepository = inngest.createFunction(
    {
        id: 'ingest-repository',
        name: 'Ingest Repository',
        concurrency: {
            key: 'event.data.repoId',
            limit: 1
        },
        retries: 1,
        triggers: [repoIngestionReq]
    },
    async({ event, step }) => {
        const { repoId, owner, repo, installationId, ref } = event.data;

        await step.run("ingest-repo", async () => {
        const { ingestRepo } = await import("../scripts/ingestRepo.js");
        return ingestRepo({ repoId, owner, repo, installationId, ref });
    });

        return { repoId, status: "ingested" };
    }
)

export const functions = [analyzePullRequest, ingestRepository]