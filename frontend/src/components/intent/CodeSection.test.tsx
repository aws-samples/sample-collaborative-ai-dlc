import { describe, it, expect } from 'vitest';
import { buildCodeItems, buildUnitBranchItems } from './CodeSection';
import type { IntentDetail, IntentUnit } from '@/services/intents';
import { gitBranchWebUrl } from '@/services/gitProvider';

const detailWith = (over: {
  repos?: string[];
  branch?: string | null;
  gitProvider?: string | null;
  repoProviders?: Record<string, string> | null;
  pullRequests?: IntentDetail['pullRequests'];
  pushedRepos?: string[];
  units?: IntentUnit[];
  unitPrs?: IntentDetail['unitPrs'];
}): IntentDetail =>
  ({
    intent: {
      repos: over.repos ?? [],
      branch: over.branch ?? null,
      gitProvider: over.gitProvider ?? null,
      repoProviders: over.repoProviders ?? null,
    },
    pullRequests: over.pullRequests ?? [],
    units: over.units ?? [],
    unitPrs: over.unitPrs ?? [],
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

  it('uses the configured repository host for every supported provider', () => {
    expect(
      gitBranchWebUrl('github', 'https://github.example.com/acme/api.git', 'unit/auth fix'),
    ).toBe('https://github.example.com/acme/api/tree/unit/auth%20fix');
    expect(gitBranchWebUrl('gitlab', 'git@gitlab.example.com:acme/api.git', 'unit/auth')).toBe(
      'https://gitlab.example.com/acme/api/-/tree/unit/auth',
    );
    expect(gitBranchWebUrl('bitbucket', 'https://bitbucket.org/acme/api.git', 'unit/auth')).toBe(
      'https://bitbucket.org/acme/api/src/unit/auth',
    );
  });

  it('links a CodeCommit branch to its regional console page', () => {
    const arn = 'arn:aws:codecommit:eu-west-2:123456789012:app';
    const [cc] = buildCodeItems(
      detailWith({
        repos: [arn],
        branch: 'aidlc/feat',
        gitProvider: 'codecommit',
        pushedRepos: [arn],
      }),
    );
    expect(cc.branchUrl).toBe(
      'https://eu-west-2.console.aws.amazon.com/codesuite/codecommit/repositories/app/browse/refs/heads/aidlc/feat/--/?region=eu-west-2',
    );
  });
});

describe('buildUnitBranchItems', () => {
  const unit = (slug: string, branch: string | null, sectionIndex = 1): IntentUnit =>
    ({
      sectionIndex,
      slug,
      branch,
      dependsOn: [],
      state: 'MERGED',
      batchIndex: 0,
      startedAt: null,
      mergedAt: null,
      failureReason: null,
      blockedOn: null,
      updatedAt: null,
    }) as IntentUnit;

  it('creates one unit entry with links to that unit branch in every repository', () => {
    const [item] = buildUnitBranchItems(
      detailWith({
        repos: ['acme/api', 'https://gitlab.com/acme/web.git', 'acme/worker'],
        gitProvider: 'github',
        repoProviders: { 'acme/web': 'gitlab', 'acme/worker': 'bitbucket' },
        units: [unit('auth', 'aidlc/i1--s1-unit-auth')],
        unitPrs: [
          {
            sectionIndex: 1,
            unitSlug: 'auth',
            repository: 'acme/web',
            provider: 'gitlab',
            providerId: '42',
            number: 7,
            url: 'https://gitlab.com/acme/web/-/merge_requests/7',
            sourceBranch: 'aidlc/i1--s1-unit-auth',
            targetBranch: 'aidlc/i1',
            headSha: null,
            readyHeadSha: null,
            targetSha: null,
            state: 'DRAFT',
            mergeable: null,
            commentCount: 0,
            repositoryOutcome: null,
            createdAt: null,
            updatedAt: null,
            mergedAt: null,
            closedAt: null,
          },
        ],
      }),
    );

    expect(item).toMatchObject({
      sectionIndex: 1,
      unitSlug: 'auth',
      branch: 'aidlc/i1--s1-unit-auth',
      targets: [
        {
          repo: 'acme/api',
          url: 'https://github.com/acme/api/tree/aidlc/i1--s1-unit-auth',
        },
        {
          repo: 'acme/web',
          provider: 'gitlab',
          url: 'https://gitlab.com/acme/web/-/tree/aidlc/i1--s1-unit-auth',
          prUrl: 'https://gitlab.com/acme/web/-/merge_requests/7',
          prNumber: 7,
        },
        {
          repo: 'acme/worker',
          url: 'https://bitbucket.org/acme/worker/src/aidlc/i1--s1-unit-auth',
        },
      ],
    });
  });

  it('keeps a unit entry when its branch link cannot be built', () => {
    const [item] = buildUnitBranchItems(
      detailWith({
        repos: ['acme/api'],
        gitProvider: null,
        units: [unit('auth', 'aidlc/i1--s1-unit-auth')],
      }),
    );

    expect(item.targets).toEqual([
      { repo: 'acme/api', provider: null, url: null, prUrl: null, prNumber: null },
    ]);
  });
});
