import express, { type NextFunction, type Request, type Response ,type Express } from "express";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { serve as serveInngest } from "inngest/express";
import { env } from "./config/env.js";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/engine.js";
import { getInstallationOctokit } from "./services/github.js";
import { shouldDropEvent } from "./services/webhookFilter.js";
import { isIngestableFile } from "./services/chunking.js";
import type { PullRequestDetails } from "./types/index.js";

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET });

async function hydratePullRequestDetails(params: {
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  author: string;
  installationId: number;
}): Promise<{ details: PullRequestDetails; changedFilePaths: string[] }> {
  const octokit = getInstallationOctokit(params.installationId);

  const [filesResponse, diffResponse] = await Promise.all([
    octokit.pulls.listFiles({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: 100,
    }),
    octokit.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      mediaType: { format: "diff" },
    }),
  ]);

  const changedFilePaths = filesResponse.data.map((f) => f.filename);
  const diff = diffResponse.data as unknown as string;

  return {
    details: {
      repoId: `${params.owner}/${params.repo}`,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      branch: params.branch,
      baseBranch: params.baseBranch,
      author: params.author,
      installationId: params.installationId,
      diff,
    },
    changedFilePaths,
  };
}

webhooks.on(["pull_request.opened", "pull_request.synchronize"], async ({ payload }) => {
  const installationId = payload.installation?.id;
  if (!installationId) {
    console.warn("pull_request event missing installation id, skipping");
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const author = payload.pull_request.user?.login;

  if (!author) {
    console.warn(`PR #${prNumber} on ${owner}/${repo} has no author, skipping`);
    return;
  }

  try {
    const { details, changedFilePaths } = await hydratePullRequestDetails({
      owner,
      repo,
      prNumber,
      branch: payload.pull_request.head.ref,
      baseBranch: payload.pull_request.base.ref,
      author,
      installationId,
    });

    if (shouldDropEvent(changedFilePaths)) {
      console.log(
        `[webhook] Dropping PR #${prNumber} on ${owner}/${repo}: no code-relevant file changes`,
      );
      return;
    }

    await inngest.send({
      name: "github/pr.analyzed",
      data: details,
    });

    console.log(`[webhook] Dispatched github/pr.analyzed for ${owner}/${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[webhook] Failed to process PR #${prNumber} on ${owner}/${repo}:`, err);
  }
});

webhooks.onError((err) => {
  console.error("[webhook] Signature verification or handler error:", err.message);
});

async function dispatchIngestionForRepos(
  installationId: number,
  repos: Array<{ owner: string; repo: string }>,
): Promise<void> {
  await Promise.all(
    repos.map(({ owner, repo }) =>
      inngest
        .send({
          name: "github/repo.ingestion-requested",
          data: {
            repoId: `${owner}/${repo}`,
            owner,
            repo,
            installationId,
          },
        })
        .then(() => console.log(`[webhook] Dispatched ingestion for ${owner}/${repo}`))
        .catch((err) =>
          console.error(`[webhook] Failed to dispatch ingestion for ${owner}/${repo}:`, err),
        ),
    ),
  );
}

webhooks.on("installation.created", async ({ payload }) => {
  const installationId = payload.installation.id;
  const account = payload.installation.account;
  const owner = account && "login" in account ? account.login : undefined;
  const repos = payload.repositories ?? [];

  if (!owner || repos.length === 0) {
    console.warn(
      `[webhook] installation.created for installation ${installationId} had no repositories to ingest`,
    );
    return;
  }

  console.log(
    `[webhook] App installed on ${owner} (${repos.length} repo(s)), triggering ingestion`,
  );

  await dispatchIngestionForRepos(
    installationId,
    repos.map((r) => ({ owner: r.full_name.split("/")[0] ?? owner, repo: r.name })),
  );
});

webhooks.on("installation_repositories.added", async ({ payload }) => {
  const installationId = payload.installation.id;
  const addedRepos = payload.repositories_added ?? [];

  if (addedRepos.length === 0) return;

  console.log(
    `[webhook] ${addedRepos.length} repo(s) added to installation ${installationId}, triggering ingestion`,
  );

  await dispatchIngestionForRepos(
    installationId,
    addedRepos.map((r) => {
      const [owner, repo] = r.full_name.split("/");
      return { owner: owner ?? "", repo: repo ?? r.name };
    }),
  );
});

webhooks.on("push", async ({ payload }) => {
  const installationId = payload.installation?.id;
  if (!installationId) return;

  const defaultBranch = payload.repository.default_branch;
  const pushedBranch = payload.ref.replace("refs/heads/", "");
  if (pushedBranch !== defaultBranch) return;

  if (payload.deleted) return;

  const owner = payload.repository.owner?.login ?? payload.repository.owner?.name;
  const repo = payload.repository.name;
  if (!owner) return;

  const added = new Set<string>();
  const modified = new Set<string>();
  const removed = new Set<string>();

  for (const commit of payload.commits ?? []) {
    for (const f of commit.added ?? []) added.add(f);
    for (const f of commit.modified ?? []) modified.add(f);
    for (const f of commit.removed ?? []) removed.add(f);
  }

  for (const f of removed) {
    added.delete(f);
    modified.delete(f);
  }

  const changedFiles = [...new Set([...added, ...modified])].filter(isIngestableFile);
  const removedFiles = [...removed].filter(isIngestableFile);

  if (changedFiles.length === 0 && removedFiles.length === 0) {
    console.log(`Push to ${owner}/${repo}#${pushedBranch}: no code-relevant changes`);
    return;
  }

  console.log(
    `Push to ${owner}/${repo}#${pushedBranch}: ${changedFiles.length} changed, ${removedFiles.length} removed, dispatching sync`,
  );

  await inngest
    .send({
      name: "github/repo.push-synced",
      data: {
        repoId: `${owner}/${repo}`,
        owner,
        repo,
        installationId,
        ref: payload.after,
        changedFiles,
        removedFiles,
      },
    })
    .catch((err) => console.error(`Failed to dispatch push sync for ${owner}/${repo}:`, err));
});

const app: Express = express();

app.use(createNodeMiddleware(webhooks, { path: "/api/github/webhooks" }));

app.use(express.json());

app.use(
  "/api/inngest",
  serveInngest({
    client: inngest,
    functions,
  }),
);

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "diffgraph" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(env.PORT, () => {
  console.log(`   DiffGraph server listening on port ${env.PORT}`);
  console.log(`   Webhook endpoint: POST /api/github/webhooks`);
  console.log(`   Inngest endpoint: /api/inngest`);
});

export { app };
