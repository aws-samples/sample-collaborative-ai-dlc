import { api } from './api';

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface SprintGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const sprintGraphService = {
  get: (sprintId: string) => api.get<SprintGraph>(`/sprints/${sprintId}/graph`),
};

export interface PrInfo {
  id: string;
  prUrl: string;
  prNumber: string;
  repository: string; // owner/repo
  branch: string;
  baseBranch: string;
  state: string; // open | closed | merged | ''
}

// Collect every PullRequest node from a sprint graph (multi-repo = one per repo).
// Superseded PRs (stale with no terminal state) are dropped, but merged PRs are kept
// so they still surface (with a "merged" state dot); result is sorted by repository
// for a stable tab order.
export function extractPrs(graph: SprintGraph): PrInfo[] {
  return graph.nodes
    .filter((n) => n.type === 'PullRequest')
    .map((n) => {
      const r = n as Record<string, unknown>;
      return {
        id: String(n.id),
        prUrl: String(r.pr_url ?? ''),
        prNumber: String(r.pr_number ?? ''),
        repository: String(r.repository ?? ''),
        branch: String(r.branch ?? ''),
        baseBranch: String(r.base_branch ?? 'main'),
        state: String(r.pr_state ?? ''),
        stale: r.stale === true || r.stale === 'true',
      };
    })
    .filter((p) => (!p.stale || p.state === 'merged') && p.prUrl)
    .map(({ stale: _stale, ...p }) => p)
    .toSorted((a, b) => a.repository.localeCompare(b.repository));
}
