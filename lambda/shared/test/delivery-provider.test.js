import { describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CodeCommitClient,
  GetBranchCommand,
  ListPullRequestsCommand,
  GetPullRequestCommand,
} from '@aws-sdk/client-codecommit';
import { getProvider } from '../git-providers.js';
import { inspectDelivery } from '../delivery-provider.js';

const fetchResponse = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
  headers: { get: () => null },
});
describe('strict delivery provider reads', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    '%s never treats denied lookup as no existing PR',
    async (name) => {
      const provider = getProvider(name);
      await expect(
        inspectDelivery(
          provider,
          { token: 'test', fetchImpl: async () => fetchResponse({}, 403) },
          'org/repo',
          { branch: 'intent/feature', baseBranch: 'develop' },
        ),
      ).rejects.toThrow();
    },
  );
  it.each(['github', 'gitlab', 'bitbucket'])(
    '%s reads a branch SHA and distinguishes missing from unreadable',
    async (name) => {
      const provider = getProvider(name);
      const data = {
        github: { object: { sha: 'head-sha' } },
        gitlab: { commit: { id: 'head-sha' } },
        bitbucket: { target: { hash: 'head-sha' } },
      }[name];
      const fetchImpl = vi.fn(async () => fetchResponse(data));
      expect(
        await provider.getBranchHead({ token: 'test', fetchImpl }, 'org/repo', 'intent/feature'),
      ).toBe('head-sha');
      expect(fetchImpl.mock.calls[0][0]).toContain('intent%2Ffeature');
      expect(
        await provider.getBranchHead(
          { token: 'test', fetchImpl: async () => fetchResponse({}, 404) },
          'org/repo',
          'intent/feature',
        ),
      ).toBeNull();
      await expect(
        provider.getBranchHead(
          { token: 'test', fetchImpl: async () => fetchResponse({}, 500) },
          'org/repo',
          'intent/feature',
        ),
      ).rejects.toThrow();
    },
  );
  it.each(['github', 'gitlab'])(
    '%s drains strict lookup pages and refuses a truncated response',
    async (name) => {
      const provider = getProvider(name);
      let calls = 0;
      const fetchImpl = vi.fn(async () =>
        fetchResponse(
          ++calls === 1
            ? Array.from({ length: 100 }, () => ({
                head: { ref: 'other' },
                source_branch: 'other',
              }))
            : [],
        ),
      );
      expect(
        await provider.findPullRequest({ token: 'test', fetchImpl }, 'org/repo', {
          sourceBranch: 'intent',
          state: 'all',
          strict: true,
        }),
      ).toBeNull();
      expect(calls).toBe(2);
      await expect(
        provider.findPullRequest(
          {
            token: 'test',
            fetchImpl: async () => fetchResponse(Array.from({ length: 100 }, () => ({}))),
          },
          'org/repo',
          { sourceBranch: 'intent', state: 'all', strict: true },
        ),
      ).rejects.toThrow(/truncated/);
    },
  );
  it.each(['github', 'gitlab'])(
    '%s reconciles only open PRs unless this run requested creation before a closed one',
    async (name) => {
      const provider = getProvider(name);
      const raw =
        name === 'github'
          ? {
              number: 7,
              html_url: 'https://example.test/pr/7',
              head: { ref: 'intent', sha: 'sha' },
              base: { ref: 'develop' },
              state: 'closed',
              merged_at: null,
              created_at: '2026-10-01T12:00:00Z',
            }
          : {
              iid: 7,
              web_url: 'https://example.test/pr/7',
              source_branch: 'intent',
              target_branch: 'develop',
              sha: 'sha',
              state: 'closed',
              created_at: '2026-10-01T12:00:00Z',
            };
      const urls = [];
      const fetchImpl = async (url) => {
        urls.push(url);
        if (url.includes('/7')) return fetchResponse(raw);
        if (url.includes('pulls?') || url.includes('merge_requests?'))
          return fetchResponse(/state=(open|opened)&/.test(url) ? [] : [raw]);
        return fetchResponse(
          name === 'github' ? { object: { sha: 'sha' } } : { commit: { id: 'sha' } },
        );
      };
      const inspect = (createdAfter) =>
        inspectDelivery(provider, { token: 'test', fetchImpl }, 'org/repo', {
          branch: 'intent',
          baseBranch: 'develop',
          createdAfter,
        });
      // An earlier run's closed PR on the same intent branch is history.
      expect((await inspect(null)).pr).toBeNull();
      expect(urls.filter((u) => /pulls\?|merge_requests\?/.test(u))).toHaveLength(1);
      expect((await inspect('2026-10-02T12:00:00Z')).pr).toBeNull();
      // This run asked for creation, then the response was lost and the PR closed.
      expect((await inspect('2026-10-01T12:01:00Z')).pr).toMatchObject({
        number: 7,
        state: 'closed',
        sourceBranch: 'intent',
        targetBranch: 'develop',
        createdAt: expect.stringMatching(/^2026-10-01T12:00:00/),
      });
    },
  );
  it('Bitbucket checks terminal states only after a create request and rejects incomplete negative lookup', async () => {
    const provider = getProvider('bitbucket');
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(decodeURIComponent(url));
      return fetchResponse(url.includes('/refs/') ? { target: { hash: 'sha' } } : { values: [] });
    };
    const inspect = (createdAfter) =>
      inspectDelivery(provider, { token: 'test', fetchImpl }, 'org/repo', {
        branch: 'intent',
        baseBranch: 'develop',
        createdAfter,
      });
    expect((await inspect(null)).pr).toBeNull();
    expect(urls.filter((u) => u.includes('/pullrequests?'))).toHaveLength(1);
    expect(urls.join('\n')).toContain('state="OPEN"');
    urls.length = 0;
    expect((await inspect('2026-10-01T12:00:00Z')).pr).toBeNull();
    expect(urls.filter((u) => u.includes('/pullrequests?'))).toHaveLength(4);
    expect(urls.join('\n')).toContain('state="MERGED"');
    await expect(
      provider.findPullRequest(
        { token: 'test', fetchImpl: async () => fetchResponse({ values: [], next: 'next-page' }) },
        'org/repo',
        { sourceBranch: 'intent', strict: true },
      ),
    ).rejects.toThrow(/incomplete/);
  });
  it('CodeCommit uses GetBranch and searches closed PRs only after a create request', async () => {
    const mock = mockClient(CodeCommitClient);
    try {
      mock.on(GetBranchCommand).resolves({ branch: { commitId: 'sha' } });
      mock
        .on(ListPullRequestsCommand, { pullRequestStatus: 'OPEN' })
        .resolves({ pullRequestIds: [] })
        .on(ListPullRequestsCommand, { pullRequestStatus: undefined })
        .resolves({ pullRequestIds: ['7'] });
      mock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          pullRequestId: '7',
          pullRequestStatus: 'CLOSED',
          creationDate: new Date('2026-10-01T12:00:00Z'),
          pullRequestTargets: [
            {
              repositoryName: 'repo',
              sourceReference: 'refs/heads/intent',
              destinationReference: 'refs/heads/develop',
              sourceCommit: 'sha',
            },
          ],
        },
      });
      const provider = getProvider('codecommit');
      const inspect = (createdAfter) =>
        inspectDelivery(
          provider,
          {
            token: {
              assumedRoleArn: 'arn:aws:sts::123456789012:assumed-role/test/session',
              credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            },
          },
          'arn:aws:codecommit:eu-west-1:123456789012:repo',
          { branch: 'intent', baseBranch: 'develop', createdAfter },
        );
      expect((await inspect(null)).pr).toBeNull();
      const lookups = () =>
        mock.commandCalls(ListPullRequestsCommand).map((call) => call.args[0].input);
      expect(lookups()).toEqual([
        expect.objectContaining({ pullRequestStatus: 'OPEN', authorArn: undefined }),
      ]);
      const result = await inspect('2026-10-01T11:59:00Z');
      expect(result.pr).toMatchObject({ state: 'closed', createdAt: '2026-10-01T12:00:00.000Z' });
      expect(lookups().at(-1).pullRequestStatus).toBeUndefined();
      expect(lookups().at(-1).authorArn).toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});
