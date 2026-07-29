import { inngest } from "./client.js";
import { getDiffGraphWorkflow } from "../graph/workflow.js";
import { prAnalyzed, repoIngestionReq, repoPushSync } from "./client.js";
import { type InngestFunction } from "inngest";

const analyzePullRequest = inngest.createFunction(
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

    // the repo is normally ingested proactively when the github app is installed. This check covers the gap where a PR
    // arrives before that async ingestion has finished.
    const alreadyIngested = await step.run("check-repo-ingested", async () => {
      const { hasIngestedRepo } = await import("../services/vectorStore.js");
      return hasIngestedRepo(prDetails.repoId);
    });

    if (!alreadyIngested) {
      await step.run("ingest-repo-on-demand", async () => {
        const { ingestRepo } = await import("../scripts/ingestRepo.js");
        return ingestRepo({
          repoId: prDetails.repoId,
          owner: prDetails.owner,
          repo: prDetails.repo,
          installationId: prDetails.installationId,
        });
      });
    }

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

const ingestRepository = inngest.createFunction(
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

const syncRepositoryOnPush = inngest.createFunction(
  {
    id: "sync-repository-on-push",
    name: "Sync Repository On Push",
    concurrency: { key: "event.data.repoId", limit: 1 },
    retries: 2,
    triggers: [repoPushSync]
  },
  async ({ event, step }) => {
    const { repoId, owner, repo, installationId, ref, changedFiles, removedFiles } = event.data;

    const result = await step.run("sync-changed-files", async () => {
      const { syncChangedFiles } = await import("../scripts/syncChangedFiles.js");
      return syncChangedFiles({ repoId, owner, repo, installationId, ref, changedFiles, removedFiles });
    });

    return { repoId, ref, ...result };
  },
);


export const functions: InngestFunction.Any[] = [analyzePullRequest, ingestRepository, syncRepositoryOnPush]