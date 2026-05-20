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

export interface GitHubIssuesPage {
  items: GitHubIssue[];
  page: number;
  perPage: number;
  hasNext: boolean;
  hasPrev: boolean;
  totalCount: number | null;
}

export interface GitHubIssueComment {
  id: number;
  user: { login: string; avatarUrl: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  page: GitHubIssuesPage;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (
  owner: string,
  repo: string,
  state: 'open' | 'closed',
  q: string | undefined,
  page: number,
  perPage: number,
) => `${owner}/${repo}|${state}|${q ?? ''}|${page}|${perPage}`;

const cacheGet = (key: string): GitHubIssuesPage | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.page;
};

const cacheSet = (key: string, page: GitHubIssuesPage) => {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, page });
};

export const githubIssuesService = {
  async list(
    owner: string,
    repo: string,
    state: 'open' | 'closed' = 'open',
    q?: string,
    page = 1,
    perPage = 30,
  ): Promise<GitHubIssuesPage> {
    const key = cacheKey(owner, repo, state, q, page, perPage);
    const hit = cacheGet(key);
    if (hit) return hit;

    const params = new URLSearchParams({ state, page: String(page), perPage: String(perPage) });
    if (q) params.set('q', q);
    const result = await api.get<GitHubIssuesPage>(
      `/github/repos/${owner}/${repo}/issues?${params.toString()}`,
    );
    cacheSet(key, result);
    return result;
  },

  invalidate(owner: string, repo: string) {
    const prefix = `${owner}/${repo}|`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  },

  get: (owner: string, repo: string, number: number) =>
    api.get<GitHubIssue>(`/github/repos/${owner}/${repo}/issues/${number}`),

  listComments: (owner: string, repo: string, number: number) =>
    api.get<GitHubIssueComment[]>(`/github/repos/${owner}/${repo}/issues/${number}/comments`),
};
