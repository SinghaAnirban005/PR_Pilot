import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { env } from "../config/env.js";

export const getInstallationOctokit = (installationId: number): Octokit => {
    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_PRIVATE_KEY,
            installationId
        },
        userAgent: "pr-pilot/0.1.0",
        request: {
            retries: 2
        }
    })
}