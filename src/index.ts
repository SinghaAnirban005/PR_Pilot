import express, { Request, Response, Express } from "express"
import { env } from "./config/env.js"
import { createNodeMiddleware, Webhooks } from "@octokit/webhooks"
import { serve as serveInngest } from "inngest/express"; 
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/engine.js";
import { shouldDropEvent } from "./services/webhookFilter.js";
import { PullRequestDetails } from "./types/index.js";
import { getInstallationOctokit } from "./services/github.js";

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })

const app: Express = express()

app.use(createNodeMiddleware(webhooks, {path: '/api/github/webhooks'}))
app.use(express.json())

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

webhooks.onError((err: unknown) => {
    console.error('webhook error : ', err)
})

app.use('/api/v1/inngest', () => {
    serveInngest({
        client: inngest,
        functions: functions
    })
})

app.get('/api/v1/health', (req: Request, res: Response) => {
    return res.status(200).json({
        status: 'ok'
    })
})

app.use((err:unknown, req: Request, res: Response) => {
    console.error("unhandled error ", err)
    res.status(500).json({
        message: 'internal server err'
    })
})

app.listen(env.PORT, () => {
    console.log('Server is live')
})

export { app }