// Exercise the actual IAM-only source-control response boundary and GitHub
// adapter. Only repository/credential reads and the HTTP transport are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createFakeHost } from '../../v2-orchestrator/test/fixtures/fake-pr-hosts.js';

const chain = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'toList') return async () => [{ provider: 'github', repo: 'owner/api' }];
        return chain;
      },
    },
  );
vi.mock('gremlin', () => ({
  default: {
    process: {
      AnonymousTraversalSource: { traversal: () => ({ withRemote: chain }) },
      statics: chain(),
    },
    driver: {
      DriverRemoteConnection: class {
        async close() {}
      },
    },
  },
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({}),
}));
vi.mock('gremlin-aws-sigv4/lib/utils.js', () => ({
  getUrlAndHeaders: () => ({ url: 'wss://neptune.invalid/gremlin', headers: {} }),
}));
vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: async () => ({ token: 'test' }),
  verifyBindingCredential: vi.fn(),
}));
const { handler } = await import('../index.js');

describe('delivery create outcome across the source-control boundary', () => {
  beforeEach(() => {
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({
      Item: {
        projectId: 'project',
        provider: 'github',
        repo: 'owner/api',
        authType: 'github-oauth',
        status: 'active',
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const event = {
    action: 'operate',
    projectId: 'project',
    provider: 'github',
    repo: 'owner/api',
    operation: 'create-pr',
    args: {
      branch: 'intent/feature',
      baseBranch: 'develop',
      expectedHeadSha: 'head1',
      title: 'Deliver intent',
      body: 'Delivery',
      allowRetarget: false,
    },
  };

  it('preserves a definite GitHub HTTP 422 refusal code and subsequently publishes', async () => {
    const host = createFakeHost('github');
    host.add({ state: 'closed', body: 'Older unmarked PR' });
    let reject = true;
    vi.stubGlobal('fetch', (url, options = {}) =>
      reject && options.method === 'POST' && new URL(url).pathname.endsWith('/pulls')
        ? new Response(
            JSON.stringify({
              message: 'Validation Failed',
              errors: [{ resource: 'PullRequest', field: 'title', code: 'invalid' }],
            }),
            { status: 422 },
          )
        : host.ctx.fetchImpl(url, options),
    );
    expect(await handler(event)).toEqual({ ok: false, code: 'PR_CREATE_REJECTED' });
    expect(host.creates).toBe(0);
    reject = false;
    expect(await handler(event)).toMatchObject({ ok: true, result: { prNumber: 2 } });
    expect(host.creates).toBe(1);
  });

  it.each(['server response', 'unclassified exception', 'lost response'])(
    'keeps an unknown outcome for %s',
    async (failure) => {
      const host = createFakeHost('github');
      if (failure === 'lost response') host.loseResponses = 1;
      vi.stubGlobal('fetch', (url, options = {}) => {
        if (options.method === 'POST' && new URL(url).pathname.endsWith('/pulls')) {
          if (failure === 'server response')
            return new Response('422 Validation Failed', { status: 503 });
          if (failure === 'unclassified exception')
            throw Object.assign(new Error('422 Validation Failed'), { status: 422 });
        }
        return host.ctx.fetchImpl(url, options);
      });
      expect(await handler(event)).toEqual({ ok: false, code: 'SOURCE_CONTROL_OPERATION_FAILED' });
      expect(host.prs).toHaveLength(failure === 'lost response' ? 1 : 0);
    },
  );
});
