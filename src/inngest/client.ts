import { eventType, Inngest, staticSchema } from "inngest"
import { env } from "../config/env.js"
import { PullRequestDetails } from "../types/index.js"

type repoIngest = {
      repoId: string;
      owner: string;
      repo: string;
      installationId: number;
      ref?: string | undefined;
};

type repoPush = {
    repoId: string;
    owner: string;
    repo: string;
    installationId: number;
    ref: string;
    changedFiles: string[];
    removedFiles: string[];
}

export const prAnalyzed = eventType('github/pr.analyzed', {
    schema: staticSchema<PullRequestDetails>()
})

export const repoIngestionReq = eventType('github/repo.ingestion-requested', {
    schema: staticSchema<repoIngest>()
})

export const repoPushSync = eventType('github/repo.push-synced', {
    schema: staticSchema<repoPush>()
})

export const inngest = new Inngest({
    id: 'pr-pilot',
    ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {})
})