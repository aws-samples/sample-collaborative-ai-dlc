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
    '%s drains every listing page and refuses a truncated listing',
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
        await provider.listPullRequests({ token: 'test', fetchImpl }, 'org/repo', {
          sourceBranch: 'intent',
        }),
      ).toEqual([]);
      expect(calls).toBe(2);
      expect(fetchImpl.mock.calls[0][0]).toContain('state=all');
      await expect(
        provider.listPullRequests(
          {
            token: 'test',
            fetchImpl: async () => fetchResponse(Array.from({ length: 100 }, () => ({}))),
          },
          'org/repo',
          { sourceBranch: 'intent' },
        ),
      ).rejects.toThrow(/truncated/);
    },
  );
  it.each(['github', 'gitlab'])(
    '%s inspection returns every PR on the branch with its markers, never its description',
    async (name) => {
      const own = 'aidlc-delivery-' + 'a'.repeat(32);
      const other = 'aidlc-delivery-' + 'b'.repeat(32);
      const rows =
        name === 'github'
          ? [
              ['closed', null, `old <!-- aidlc-delivery: ${other} -->`],
              ['closed', '2026-10-01T00:00:00Z', 'merged by hand'],
              ['closed', null, `mine <!-- aidlc-delivery: ${own} -->`],
            ].map(([state, mergedAt, body], index) => ({
              number: index + 1,
              html_url: `https://example.test/pr/${index + 1}`,
              head: { ref: 'intent', sha: 'sha' },
              base: { ref: 'develop' },
              state,
              merged_at: mergedAt,
              body,
            }))
          : [
              ['closed', `old <!-- aidlc-delivery: ${other} -->`],
              ['merged', 'merged by hand'],
              ['closed', `mine <!-- aidlc-delivery: ${own} -->`],
            ].map(([state, description], index) => ({
              iid: index + 1,
              web_url: `https://example.test/pr/${index + 1}`,
              source_branch: 'intent',
              target_branch: 'develop',
              sha: 'sha',
              state,
              description,
            }));
      const fetchImpl = async (url) =>
        fetchResponse(
          url.includes('pulls?') || url.includes('merge_requests?')
            ? rows
            : name === 'github'
              ? { object: { sha: 'sha' } }
              : { commit: { id: 'sha' } },
        );
      const result = await inspectDelivery(
        getProvider(name),
        { token: 'test', fetchImpl },
        'org/repo',
        {
          branch: 'intent',
          baseBranch: 'develop',
        },
      );
      expect(result.pullRequests).toEqual([
        expect.objectContaining({ number: 1, state: 'closed', markers: [other] }),
        expect.objectContaining({ number: 2, state: 'merged', markers: [] }),
        expect.objectContaining({ number: 3, state: 'closed', markers: [own] }),
      ]);
      expect(JSON.stringify(result)).not.toMatch(/mine|old|by hand/);
    },
  );
  it('Bitbucket lists every state on every page and refuses a foreign or truncated page link', async () => {
    const urls = [];
    const pr = (id, state) => ({
      id,
      links: { html: { href: `https://bitbucket.example/pr/${id}` } },
      state,
      source: { branch: { name: 'intent' }, commit: { hash: 'sha' } },
      destination: { branch: { name: 'develop' } },
      description: id === 2 ? '<!-- aidlc-delivery: aidlc-delivery-' + 'c'.repeat(32) + ' -->' : '',
    });
    const fetchImpl = async (url) => {
      urls.push(decodeURIComponent(url));
      if (url.includes('/refs/')) return fetchResponse({ target: { hash: 'sha' } });
      return fetchResponse(
        url.includes('page=2')
          ? { values: [pr(2, 'DECLINED')] }
          : {
              values: [pr(1, 'MERGED')],
              next: 'https://api.bitbucket.org/2.0/repositories/org/repo/pullrequests?page=2',
            },
      );
    };
    const result = await inspectDelivery(
      getProvider('bitbucket'),
      { token: 'test', fetchImpl },
      'org/repo',
      { branch: 'intent', baseBranch: 'develop' },
    );
    expect(result.pullRequests.map((p) => [p.number, p.state, p.markers.length])).toEqual([
      [1, 'merged', 0],
      [2, 'closed', 1],
    ]);
    const listing = urls.find((u) => u.includes('/pullrequests?q='));
    for (const state of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
      expect(listing).toContain(`state="${state}"`);
    expect(listing).toContain('fields=+values.description');
    await expect(
      getProvider('bitbucket').listPullRequests(
        {
          token: 'test',
          fetchImpl: async () =>
            fetchResponse({ values: [], next: 'https://elsewhere.example/steal-token' }),
        },
        'org/repo',
        { sourceBranch: 'intent' },
      ),
    ).rejects.toThrow(/page link/);
    await expect(
      getProvider('bitbucket').listPullRequests(
        {
          token: 'test',
          fetchImpl: async (url) =>
            fetchResponse({ values: [], next: `${url.split('&page=')[0]}&page=9` }),
        },
        'org/repo',
        { sourceBranch: 'intent' },
      ),
    ).rejects.toThrow(/truncated/);
  });
  it('CodeCommit lists every status on every page without an author filter', async () => {
    const mock = mockClient(CodeCommitClient);
    try {
      mock.on(GetBranchCommand).resolves({ branch: { commitId: 'sha' } });
      mock
        .on(ListPullRequestsCommand, { nextToken: undefined })
        .resolves({ pullRequestIds: ['7', '8'], nextToken: 'page-2' })
        .on(ListPullRequestsCommand, { nextToken: 'page-2' })
        .resolves({ pullRequestIds: ['9'] });
      const raw = (id, status, source, description = '') => ({
        pullRequest: {
          pullRequestId: id,
          pullRequestStatus: status,
          description,
          pullRequestTargets: [
            {
              repositoryName: 'repo',
              sourceReference: `refs/heads/${source}`,
              destinationReference: 'refs/heads/develop',
              sourceCommit: 'sha',
              mergeMetadata: { isMerged: id === '7' },
            },
          ],
        },
      });
      mock
        .on(GetPullRequestCommand, { pullRequestId: '7' })
        .resolves(raw('7', 'CLOSED', 'intent'))
        .on(GetPullRequestCommand, { pullRequestId: '8' })
        .resolves(raw('8', 'OPEN', 'other'))
        .on(GetPullRequestCommand, { pullRequestId: '9' })
        .resolves(raw('9', 'CLOSED', 'intent', 'aidlc-delivery-' + 'd'.repeat(32)));
      const result = await inspectDelivery(
        getProvider('codecommit'),
        {
          token: {
            assumedRoleArn: 'arn:aws:sts::123456789012:assumed-role/test/session',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          },
        },
        'arn:aws:codecommit:eu-west-1:123456789012:repo',
        { branch: 'intent', baseBranch: 'develop' },
      );
      expect(result.pullRequests.map((p) => [p.number, p.state, p.markers.length])).toEqual([
        ['7', 'merged', 0],
        ['9', 'closed', 1],
      ]);
      for (const call of mock.commandCalls(ListPullRequestsCommand)) {
        expect(call.args[0].input.pullRequestStatus).toBeUndefined();
        expect(call.args[0].input.authorArn).toBeUndefined();
      }
    } finally {
      mock.restore();
    }
  });
});
