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
    '%s retains a closed matching PR for normalized inspection',
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
            }
          : {
              iid: 7,
              web_url: 'https://example.test/pr/7',
              source_branch: 'intent',
              target_branch: 'develop',
              sha: 'sha',
              state: 'closed',
            };
      const fetchImpl = async (url) =>
        fetchResponse(
          url.includes('/7')
            ? raw
            : url.includes('pulls?') || url.includes('merge_requests?')
              ? [raw]
              : name === 'github'
                ? { object: { sha: 'sha' } }
                : { commit: { id: 'sha' } },
        );
      const result = await inspectDelivery(provider, { token: 'test', fetchImpl }, 'org/repo', {
        branch: 'intent',
        baseBranch: 'develop',
      });
      expect(result.pr).toMatchObject({
        number: 7,
        state: 'closed',
        sourceBranch: 'intent',
        targetBranch: 'develop',
      });
    },
  );
  it('Bitbucket explicitly checks terminal states and rejects incomplete negative lookup', async () => {
    const provider = getProvider('bitbucket');
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(decodeURIComponent(url));
      return fetchResponse(url.includes('/refs/') ? { target: { hash: 'sha' } } : { values: [] });
    };
    const result = await inspectDelivery(provider, { token: 'test', fetchImpl }, 'org/repo', {
      branch: 'intent',
      baseBranch: 'develop',
    });
    expect(result.pr).toBeNull();
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
  it('CodeCommit uses GetBranch and searches closed as well as open PRs without creating', async () => {
    const mock = mockClient(CodeCommitClient);
    try {
      mock.on(GetBranchCommand).resolves({ branch: { commitId: 'sha' } });
      mock.on(ListPullRequestsCommand).resolves({ pullRequestIds: ['7'] });
      mock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          pullRequestId: '7',
          pullRequestStatus: 'CLOSED',
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
      const result = await inspectDelivery(
        provider,
        {
          token: {
            assumedRoleArn: 'arn:aws:sts::123456789012:assumed-role/test/session',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          },
        },
        'arn:aws:codecommit:eu-west-1:123456789012:repo',
        { branch: 'intent', baseBranch: 'develop' },
      );
      expect(result.pr.state).toBe('closed');
      expect(
        mock.commandCalls(ListPullRequestsCommand)[0].args[0].input.pullRequestStatus,
      ).toBeUndefined();
      expect(mock.commandCalls(ListPullRequestsCommand)[0].args[0].input.authorArn).toBeUndefined();
    } finally {
      mock.restore();
    }
  });
});
