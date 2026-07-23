export type PullRequestDetails = {
  repoId: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  author: string;
  installationId: number;
  diff: string;
}