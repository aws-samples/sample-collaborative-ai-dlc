import { describe, expect, it } from 'vitest';
import { extractPrs, type SprintGraph } from './sprintGraph';

const prNode = (over: Record<string, unknown>) => ({
  id: over.id ?? 'pr-1',
  type: 'PullRequest',
  label: 'PR',
  pr_url: 'https://github.com/owner/repo/pull/1',
  pr_number: '1',
  repository: 'owner/repo',
  branch: 'feat/x',
  base_branch: 'main',
  pr_state: 'open',
  ...over,
});

const graph = (nodes: Record<string, unknown>[]): SprintGraph => ({
  nodes: nodes as SprintGraph['nodes'],
  edges: [],
});

describe('extractPrs', () => {
  it('returns an empty array when there are no PullRequest nodes', () => {
    expect(extractPrs(graph([{ id: 't1', type: 'Task', label: 'task' }]))).toEqual([]);
  });

  it('maps snake_case PR node fields to PrInfo', () => {
    const [pr] = extractPrs(graph([prNode({})]));
    expect(pr).toEqual({
      id: 'pr-1',
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: '1',
      repository: 'owner/repo',
      branch: 'feat/x',
      baseBranch: 'main',
      state: 'open',
    });
  });

  it('collects one PR per repo and sorts by repository', () => {
    const prs = extractPrs(
      graph([
        prNode({ id: 'b', repository: 'owner/ui', pr_number: '2' }),
        prNode({ id: 'a', repository: 'owner/infra', pr_number: '3' }),
      ]),
    );
    expect(prs.map((p) => p.repository)).toEqual(['owner/infra', 'owner/ui']);
  });

  it('drops superseded (stale, non-merged) and url-less PRs', () => {
    const prs = extractPrs(
      graph([
        prNode({ id: 'live', repository: 'owner/ui' }),
        prNode({ id: 'stale', repository: 'owner/old', stale: true }),
        prNode({ id: 'staleStr', repository: 'owner/old2', stale: 'true' }),
        prNode({ id: 'empty', repository: 'owner/nourl', pr_url: '' }),
      ]),
    );
    expect(prs.map((p) => p.id)).toEqual(['live']);
  });

  it('keeps merged PRs even though the backend marks them stale', () => {
    // The backend sets stale=true *and* pr_state='merged' when a PR is merged on
    // GitHub. Merged PRs should still surface on the review page (violet dot), so
    // only superseded stale PRs are dropped.
    const prs = extractPrs(
      graph([
        prNode({ id: 'live', repository: 'owner/ui' }),
        prNode({ id: 'merged', repository: 'owner/api', stale: true, pr_state: 'merged' }),
        prNode({ id: 'superseded', repository: 'owner/old', stale: true, pr_state: 'open' }),
      ]),
    );
    expect(prs.map((p) => p.id)).toEqual(['merged', 'live']);
  });

  it('defaults baseBranch to main when missing', () => {
    const [pr] = extractPrs(graph([prNode({ base_branch: undefined })]));
    expect(pr.baseBranch).toBe('main');
  });

  it('keeps both PRs when two repos share the same PR number', () => {
    const prs = extractPrs(
      graph([
        prNode({ id: 'ui', repository: 'owner/ui', pr_number: '5' }),
        prNode({ id: 'infra', repository: 'owner/infra', pr_number: '5' }),
      ]),
    );
    expect(prs).toHaveLength(2);
    expect(new Set(prs.map((p) => p.id)).size).toBe(2);
  });

  it('tolerates a missing repository field without throwing', () => {
    const [pr] = extractPrs(graph([prNode({ repository: undefined })]));
    expect(pr.repository).toBe('');
  });

  it('falls back to empty state when pr_state is missing', () => {
    // Documents the fallback: open PRs created before pr_state was persisted (or
    // any PR missing the property) map to state '' so the UI renders the
    // "unknown" (grey) dot rather than throwing.
    const [pr] = extractPrs(graph([prNode({ pr_state: undefined })]));
    expect(pr.state).toBe('');
  });
});
