import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { getProvider, KNOWN_PROVIDERS, ProviderError } from '../providers/index.js';
import { provider as githubIssuesProvider, __resetCache } from '../providers/github-issues.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

const TABLE = 'test-git-connections';
const PARAM_NAME = '/aidlc/dev/git-token/user-1';
const TOKEN = 'gho_testtoken';

const makeHeaders = (init = {}) => {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
};

const okResponse = (body, headers = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: makeHeaders(headers),
});

const issueFixture = (overrides = {}) => ({
  number: 42,
  title: 'Add login flow',
  body: 'We need login.',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/issues/42',
  labels: [{ name: 'enhancement', color: 'a2eeef' }],
  user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
  ...overrides,
});

describe('getProvider (factory)', () => {
  it('exposes "github-issues" in KNOWN_PROVIDERS', () => {
    expect(KNOWN_PROVIDERS).toContain('github-issues');
  });

  it('returns the github-issues provider for ("github-issues", "public")', () => {
    const p = getProvider('github-issues', 'public');
    expect(p).toBe(githubIssuesProvider);
    expect(p.id).toBe('github-issues');
  });

  it('returns the provider when instance is omitted (factory ignores undefined instance)', () => {
    const p = getProvider('github-issues');
    expect(p).toBe(githubIssuesProvider);
  });

  it('throws ProviderError(400) for an unknown provider id', () => {
    expect.assertions(3);
    try {
      getProvider('unknown-provider', 'cloud');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/unknown-provider/);
    }
  });

  it('throws ProviderError(400) for a known provider with an unknown instance', () => {
    expect.assertions(3);
    try {
      getProvider('github-issues', 'enterprise');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/enterprise/);
    }
  });

  it('exposes the uniform provider shape (listIssues/getIssue/getIssueDiscussion/listExternalProjects)', () => {
    const p = getProvider('github-issues', 'public');
    expect(typeof p.listIssues).toBe('function');
    expect(typeof p.getIssue).toBe('function');
    expect(typeof p.getIssueDiscussion).toBe('function');
    expect(typeof p.listExternalProjects).toBe('function');
  });
});

describe('github-issues provider — direct calls', () => {
  let fetchMock;

  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    __resetCache();
    vi.stubEnv('GIT_CONNECTIONS_TABLE', TABLE);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    ddbMock.on(GetCommand, { TableName: TABLE }).resolves({
      Item: { userId: 'user-1', parameterName: PARAM_NAME },
    });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessToken: TOKEN }) },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // aws-sdk-client-mock intercepts at the client-class level, so any
  // DocumentClient / SSMClient instance the test passes will hit the same mock.
  const ctx = () => ({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ssm: new SSMClient({}),
    userId: 'user-1',
  });

  describe('splitOwnerRepo (via listIssues)', () => {
    it('rejects an empty externalProjectKey with 400', async () => {
      await expect(githubIssuesProvider.listIssues(ctx(), '', {})).rejects.toMatchObject({
        status: 400,
      });
    });

    it('rejects a non-"owner/repo" externalProjectKey with 400', async () => {
      await expect(githubIssuesProvider.listIssues(ctx(), 'just-a-name', {})).rejects.toMatchObject(
        { status: 400 },
      );
    });

    it('rejects "owner/" with 400', async () => {
      await expect(githubIssuesProvider.listIssues(ctx(), 'owner/', {})).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('listIssues — normalized DTO mapping', () => {
    it('maps GitHub issue fields onto TrackerIssue (resourceId is a string)', async () => {
      fetchMock.mockResolvedValueOnce(okResponse([issueFixture()]));
      const page = await githubIssuesProvider.listIssues(ctx(), 'acme/widgets', {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        resourceId: '42',
        resourceUrl: 'https://github.com/acme/widgets/issues/42',
        resourceType: 'issue',
        title: 'Add login flow',
        state: 'open',
        author: { handle: 'octocat', avatarUrl: 'https://example.com/a.png' },
        labels: [{ name: 'enhancement', color: 'a2eeef' }],
      });
      // resourceId is always a string regardless of the upstream numeric type.
      expect(typeof page.items[0].resourceId).toBe('string');
    });

    it('coerces non-"closed" state values to "open" (defensive normalization)', async () => {
      fetchMock.mockResolvedValueOnce(okResponse([issueFixture({ state: 'unexpected' })]));
      const page = await githubIssuesProvider.listIssues(ctx(), 'acme/widgets', {});
      expect(page.items[0].state).toBe('open');
    });
  });

  describe('listExternalProjects (Phase 3 placeholder)', () => {
    it('throws ProviderError(501) — not implemented in Phase 2', async () => {
      await expect(githubIssuesProvider.listExternalProjects(ctx(), {})).rejects.toMatchObject({
        status: 501,
      });
    });
  });

  describe('Token resolution failures bubble up as code: NOT_CONNECTED', () => {
    it('throws when there is no git-connections row', async () => {
      ddbMock.on(GetCommand, { TableName: TABLE }).resolves({});
      await expect(
        githubIssuesProvider.listIssues(ctx(), 'acme/widgets', {}),
      ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when the SSM parameter name is malformed', async () => {
      ddbMock
        .on(GetCommand, { TableName: TABLE })
        .resolves({ Item: { userId: 'user-1', parameterName: '../../etc/passwd' } });
      await expect(
        githubIssuesProvider.listIssues(ctx(), 'acme/widgets', {}),
      ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
