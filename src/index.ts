import express, { Request, Response, Express } from "express"
import { env } from "./config/env.js"
import { createNodeMiddleware, Webhooks } from "@octokit/webhooks"
import { serve as serveInngest } from "inngest/express"; 
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/engine.js";
import { shouldDropEvent, isNonCodeFile } from "./services/webhookFilter.js";
import { PullRequestDetails } from "./types/index.js";
import { getInstallationOctokit } from "./services/github.js";

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })

const app: Express = express()

app.use(createNodeMiddleware(webhooks, {path: '/api/github/webhooks'}))
app.use(express.json())

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
        .then(() => console.log(`Dispatched ingestion for ${owner}/${repo}`))
        .catch((err) =>
          console.error(`Failed to dispatch ingestion for ${owner}/${repo}:`, err),
        ),
    ),
  );
}

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
    const installationId = payload.installation?.id
    if(!installationId){
        console.warn('pull request event missing installation id')
        return 
    }

    const owner = payload.repository.owner.login
    const repo  = payload.repository.name
    const prNumber = payload.pull_request.number
    const author = payload.pull_request.user?.login

    if(!author){
        return
    }

    try {
        const { details, changedFilePaths } = await hydratePullRequestDetails({
            owner,
            repo,
            prNumber,
            branch: payload.pull_request.head.ref,
            baseBranch: payload.pull_request.base.ref,
            author,
            installationId
        })

        if(shouldDropEvent(changedFilePaths)){
            return
        }

        await inngest.send({
            name: "github/pr.analyzed",
            data: details,
        });
    } catch (error) {
        console.error('failed to process pr ', error)   
    }
})

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

  const changedFiles = [...new Set([...added, ...modified])].filter((f) => !isNonCodeFile(f));
  const removedFiles = [...removed].filter((f) => !isNonCodeFile(f));

  if (changedFiles.length === 0 && removedFiles.length === 0) {
    return;
  }

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

webhooks.onError((err: unknown) => {
    console.error('webhook error : ', err)
})

webhooks.on("installation.created", async ({ payload }) => {
  const installationId = payload.installation.id;
  const account = payload.installation.account;
  const owner = account && "login" in account ? account.login : undefined;
  const repos = payload.repositories ?? [];

  if (!owner || repos.length === 0) {
    return;
  }

  await dispatchIngestionForRepos(
    installationId,
    repos.map((r) => ({ owner: r.full_name.split("/")[0] ?? owner, repo: r.name })),
  );
});

webhooks.on("installation_repositories.added", async ({ payload }) => {
  const installationId = payload.installation.id;
  const addedRepos = payload.repositories_added ?? [];

  if (addedRepos.length === 0) return;

  await dispatchIngestionForRepos(
    installationId,
    addedRepos.map((r) => {
      const [owner, repo] = r.full_name.split("/");
      return { owner: owner ?? "", repo: repo ?? r.name };
    }),
  );
});

app.use('/api/inngest', serveInngest({
  client: inngest,
  functions: functions
}));

app.get('/api/health', (req: Request, res: Response) => {
    return res.status(200).json({
        status: 'ok'
    })
})

// app.use((err:unknown, req: Request, res: Response) => {
//     console.error("unhandled error ", err)
//     return res.status(500).json({
//         message: 'internal server err'
//     })
// })

app.listen(env.PORT, () => {
    console.log('Server is live')
})

export { app }