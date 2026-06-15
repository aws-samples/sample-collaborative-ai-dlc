import { describe, expect, it, vi } from 'vitest';

import { createPrsForRepos, missingRepos } from '../mcp-server-graph/create-repo-prs.js';

const parseOwnerRepo = (s) => {
  const parts = s.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository identifier "${s}": expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
};

const prOk = (n) => ({ statusCode: 200, prUrl: `https://github.com/o/r/pull/${n}`, prNumber: n });

describe('createPrsForRepos', () => {
  it('creates one PR per repo when every create-pr call succeeds', async () => {
    let n = 0;
    const invokeCreatePr = vi.fn(async () => prOk(++n));
    const mergeFn = vi.fn();

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/api' }, { url: 'o/ui' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn,
    });

    expect(prResults.map((p) => p.repository)).toEqual(['o/api', 'o/ui']);
    expect(failedRepos).toEqual([]);
    expect(mergeFn).not.toHaveBeenCalled();
  });

  it('merges unmerged task branches on 409 then retries create-pr once', async () => {
    const calls = [];
    const invokeCreatePr = vi.fn(async (url) => {
      calls.push(url);
      return calls.length === 1
        ? { statusCode: 409, unmergedBranches: ['sprint--task-a'] }
        : prOk(7);
    });
    const mergeFn = vi.fn(async () => ({ merged: ['sprint--task-a'], conflicts: [], errors: [] }));

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/ui' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn,
    });

    expect(mergeFn).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'ui',
      sprintBranch: 'sprint',
      unmergedBranches: ['sprint--task-a'],
      gitToken: 't',
    });
    expect(invokeCreatePr).toHaveBeenCalledTimes(2);
    expect(prResults).toHaveLength(1);
    expect(failedRepos).toEqual([]);
  });

  it('records a merge conflict in failedRepos without retrying, and continues with other repos', async () => {
    const invokeCreatePr = vi.fn(async (url) =>
      url === 'o/ui' ? { statusCode: 409, unmergedBranches: ['sprint--task-x'] } : prOk(3),
    );
    const mergeFn = vi.fn(async () => ({
      merged: [],
      conflicts: ['sprint--task-x'],
      errors: [],
    }));

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/ui' }, { url: 'o/api' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn,
    });

    expect(prResults.map((p) => p.repository)).toEqual(['o/api']);
    expect(failedRepos).toEqual([
      {
        repository: 'o/ui',
        error: 'Unmerged construction task branches could not be auto-merged',
        conflicts: ['sprint--task-x'],
        mergeErrors: [],
      },
    ]);
    expect(invokeCreatePr).toHaveBeenCalledTimes(2);
  });

  it('records a second 409 (new task branch appeared) with its unmergedBranches', async () => {
    const invokeCreatePr = vi.fn(async () => ({
      statusCode: 409,
      error: 'unmerged branches',
      unmergedBranches: ['sprint--task-late'],
    }));
    const mergeFn = vi.fn(async () => ({
      merged: ['sprint--task-late'],
      conflicts: [],
      errors: [],
    }));

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/ui' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn,
    });

    expect(prResults).toEqual([]);
    expect(failedRepos).toHaveLength(1);
    expect(failedRepos[0].unmergedBranches).toEqual(['sprint--task-late']);
    expect(invokeCreatePr).toHaveBeenCalledTimes(2);
  });

  it('isolates a malformed repo URL error to that repo without aborting the loop', async () => {
    const invokeCreatePr = vi.fn(async (url) => {
      parseOwnerRepo(url);
      return url === 'o/bad' ? { statusCode: 409, unmergedBranches: ['b'] } : prOk(1);
    });

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'https://github.com/o/bad' }, { url: 'o/good' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn: vi.fn(),
    });

    expect(prResults.map((p) => p.repository)).toEqual(['o/good']);
    expect(failedRepos).toHaveLength(1);
    expect(failedRepos[0].repository).toBe('https://github.com/o/bad');
    expect(failedRepos[0].error).toContain('expected "owner/repo"');
  });

  it('contains a thrown create-pr invocation error per repo', async () => {
    const invokeCreatePr = vi.fn(async (url) => {
      if (url === 'o/down') throw new Error('Lambda timed out');
      return prOk(2);
    });

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/down' }, { url: 'o/up' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn: vi.fn(),
    });

    expect(prResults.map((p) => p.repository)).toEqual(['o/up']);
    expect(failedRepos).toEqual([{ repository: 'o/down', error: 'Lambda timed out' }]);
  });

  it('records non-409 create-pr failures with the lambda error message', async () => {
    const invokeCreatePr = vi.fn(async () => ({ statusCode: 500, error: 'boom' }));

    const { prResults, failedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/ui' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn: vi.fn(),
    });

    expect(prResults).toEqual([]);
    expect(failedRepos).toEqual([{ repository: 'o/ui', error: 'boom' }]);
  });

  it('buckets a repo with no changes into skippedRepos and continues with the others', async () => {
    const skipped = { statusCode: 200, skipped: true, reason: 'no_changes' };
    const invokeCreatePr = vi.fn(async (url) => (url === 'o/untouched' ? skipped : prOk(4)));
    const mergeFn = vi.fn();

    const { prResults, failedRepos, skippedRepos } = await createPrsForRepos({
      repos: [{ url: 'o/api' }, { url: 'o/untouched' }, { url: 'o/ui' }],
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn,
    });

    expect(prResults.map((p) => p.repository)).toEqual(['o/api', 'o/ui']);
    expect(skippedRepos).toEqual([{ repository: 'o/untouched', reason: 'no_changes' }]);
    expect(failedRepos).toEqual([]);
    expect(mergeFn).not.toHaveBeenCalled();
  });

  it('re-skips a previously skipped repo on a reconciliation re-run without failing', async () => {
    // Second trigger_pr_creation call: missingRepos lists the skipped repo as
    // uncovered, so it is re-processed alone — it must converge to skipped
    // again, never to failedRepos (which would page a human every run).
    const invokeCreatePr = vi.fn(async () => ({
      statusCode: 200,
      skipped: true,
      reason: 'no_changes',
    }));

    const { prResults, failedRepos, skippedRepos } = await createPrsForRepos({
      repos: missingRepos([{ url: 'o/api' }, { url: 'o/untouched' }], [{ repository: 'o/api' }]),
      sprintBranch: 'sprint',
      gitToken: 't',
      invokeCreatePr,
      parseOwnerRepo,
      mergeFn: vi.fn(),
    });

    expect(invokeCreatePr).toHaveBeenCalledTimes(1);
    expect(prResults).toEqual([]);
    expect(failedRepos).toEqual([]);
    expect(skippedRepos).toEqual([{ repository: 'o/untouched', reason: 'no_changes' }]);
  });
});

describe('missingRepos', () => {
  const gitRepos = [{ url: 'o/api' }, { url: 'o/ui' }, { url: 'o/infra' }];

  it('returns repos with no live PR in the existing group', () => {
    const prs = [{ repository: 'o/api' }];
    expect(missingRepos(gitRepos, prs).map((r) => r.url)).toEqual(['o/ui', 'o/infra']);
  });

  it('returns nothing when every configured repo is covered', () => {
    const prs = [{ repository: 'o/api' }, { repository: 'o/ui' }, { repository: 'o/infra' }];
    expect(missingRepos(gitRepos, prs)).toEqual([]);
  });

  it('returns every repo when the group has no PRs (orphaned group)', () => {
    expect(missingRepos(gitRepos, []).map((r) => r.url)).toEqual(['o/api', 'o/ui', 'o/infra']);
    expect(missingRepos(gitRepos, undefined).map((r) => r.url)).toEqual([
      'o/api',
      'o/ui',
      'o/infra',
    ]);
  });

  it('ignores group PRs for repos no longer configured on the project', () => {
    const prs = [{ repository: 'o/api' }, { repository: 'o/removed' }];
    expect(missingRepos(gitRepos, prs).map((r) => r.url)).toEqual(['o/ui', 'o/infra']);
  });
});
