import { api } from './api';

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubStatus {
  connected: boolean;
  provider?: string;
}

export interface GitHubFile {
  path: string;
  sha: string;
  size: number;
}

export interface GitHubFileContent {
  path: string;
  sha: string;
  size: number;
  content: string;
}

export interface PRComment {
  id: number;
  type: 'review' | 'issue';
  body: string;
  user: { login: string; avatarUrl: string };
  path: string | null;
  line: number | null;
  createdAt: string;
  updatedAt: string;
}

export const githubService = {
  getAuthUrl: () => api.get<{ url: string }>('/github/auth'),
  getStatus: () => api.get<GitHubStatus>('/github/status'),
  listRepos: () => api.get<GitHubRepo[]>('/github/repos'),
  listBranches: (owner: string, repo: string) => api.get<{ branches: string[] }>(`/github/repos/${owner}/${repo}/branches`),
  disconnect: () => api.delete('/github/disconnect'),
  getRepoTree: (owner: string, repo: string, branch?: string) => 
    api.get<{ tree: GitHubFile[] }>(`/github/repos/${owner}/${repo}/tree${branch ? `?branch=${branch}` : ''}`),
  getFileContents: (owner: string, repo: string, path: string, branch?: string) =>
    api.get<GitHubFileContent>(`/github/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path)}${branch ? `&branch=${branch}` : ''}`),
  getPRComments: (owner: string, repo: string, prNumber: number) =>
    api.get<{ comments: PRComment[] }>(`/github/repos/${owner}/${repo}/pulls/${prNumber}/comments`),
  addPRComment: (owner: string, repo: string, prNumber: number, comment: { body: string; path?: string; line?: number; side?: string }) =>
    api.post<{ id: number; body: string; createdAt: string }>(`/github/repos/${owner}/${repo}/pulls/${prNumber}/comments`, comment),
};
