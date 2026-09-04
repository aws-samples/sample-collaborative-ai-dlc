import { describe, it, expect } from 'vitest';
import { buildCodeItems } from './CodeSection';
import type { IntentDetail } from '@/services/intents';

const detailWith = (over: {
  repos?: string[];
  branch?: string | null;
  gitProvider?: string | null;
  pullRequests?: IntentDetail['pullRequests'];
  pushedRepos?: string[];
}): IntentDetail =>
  ({
    intent: {
      repos: over.repos ?? [],
      branch: over.branch ?? null,
      gitProvider: over.gitProvider ?? null,
    },
    pullRequests: over.pullRequests ?? [],
    events: (over.pushedRepos ?? []).map((slug, i) => ({
      eventId: `e${i}`,
      type: 'v2.git.pushed',
      summary: `pushed to ${slug}`,
      stageInstanceId: null,
      actor: null,
      timestamp: '2026-01-01T00:00:00Z',
    })),
  }) as unknown as IntentDetail;

describe('buildCodeItems', () => {
  it('hides repos that neither pushed nor have a PR', () => {
    const items = buildCodeItems(detailWith({ repos: ['owner/repo'], branch: 'feat/x' }));
    expect(items).toEqual([]);
  });

  it('includes a pushed repo as a bare branch (no PR fields)', () => {
    const items = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: 'github',
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: 'owner/repo',
      branch: 'feat/x',
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      branchUrl: 'https://github.com/owner/repo/tree/feat/x',
    });
  });

  it('promotes a repo with a PR, carrying number, url and base branch', () => {
    const items = buildCodeItems(
      detailWith({
        repos: ['https://github.com/owner/repo.git'],
        gitProvider: 'github',
        pullRequests: [
          {
            id: 'pr1',
            repository: 'owner/repo',
            prUrl: 'https://github.com/owner/repo/pull/9',
            prNumber: '9',
            branch: 'feat/x',
            baseBranch: 'main',
            createdAt: null,
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: 'owner/repo',
      branch: 'feat/x',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/9',
      prNumber: '9',
    });
  });

  it('builds a GitLab branch url and null url for an unknown provider', () => {
    const [gl] = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: 'gitlab',
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(gl.branchUrl).toBe('https://gitlab.com/owner/repo/-/tree/feat/x');

    const [unknown] = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: null,
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(unknown.branchUrl).toBeNull();
  });
});
