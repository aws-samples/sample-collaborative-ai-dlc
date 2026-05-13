import { api } from './api';

export interface GitHubIssueLabel {
  name: string;
  color: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  htmlUrl: string;
  labels: GitHubIssueLabel[];
  user: { login: string; avatarUrl: string };
  createdAt: string;
  updatedAt: string;
}

export const githubIssuesService = {
  list: (owner: string, repo: string, state: 'open' | 'closed' = 'open', q?: string) => {
    const params = new URLSearchParams({ state });
    if (q) params.set('q', q);
    return api.get<GitHubIssue[]>(`/github/repos/${owner}/${repo}/issues?${params.toString()}`);
  },
  get: (owner: string, repo: string, number: number) =>
    api.get<GitHubIssue>(`/github/repos/${owner}/${repo}/issues/${number}`),
};
