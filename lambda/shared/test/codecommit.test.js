import { describe, it, expect } from 'vitest';
import {
  getProvider,
  getCapabilities,
  buildCloneUrl,
  gitHost,
  isKnownProvider,
  KNOWN_PROVIDERS,
  ProviderError,
  DEFAULT_CAPABILITIES,
} from '../git-providers.js';

const cc = getProvider('codecommit');

const REGION = 'eu-west-3';
const ACCOUNT = '123456789012';
const REPO = 'demo-repo';
const ARN = `arn:aws:codecommit:${REGION}:${ACCOUNT}:${REPO}`;

// A minimal SDK client double: handlers keyed by command constructor name.
// `client.send(command)` dispatches on `command.constructor.name`, so the
// double never depends on the real SDK's wire format. A handler may be a
// value, a function of the command input, or an Error to throw (its `name`
// drives the provider's error classification exactly as the SDK's would).
const makeClient = (handlers) => {
  const calls = [];
  const client = {
    calls,
    send: async (command) => {
      const name = command.constructor.name.replace(/Command$/, '');
      calls.push({ name, input: command.input });
      if (!(name in handlers)) throw new Error(`Unexpected CodeCommit call: ${name}`);
      const handler = handlers[name];
      const out = typeof handler === 'function' ? handler(command.input, calls) : handler;
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return client;
};

const sdkError = (name) => Object.assign(new Error(name), { name });

// The STS session the platform's pull-request calls run under.
const SESSION_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/aidlc-codecommit-access/aidlc-bind`;
const withSession = (client) => ({ client, token: { assumedRoleArn: SESSION_ARN } });

const pr = ({
  id = '7',
  status = 'OPEN',
  source = 'feature',
  destination = 'main',
  isMerged = false,
  revisionId = 'rev-1',
} = {}) => ({
  pullRequestId: id,
  title: 'A change',
  pullRequestStatus: status,
  revisionId,
  lastActivityDate: new Date('2026-09-18T10:00:00Z'),
  pullRequestTargets: [
    {
      repositoryName: REPO,
      sourceReference: `refs/heads/${source}`,
      destinationReference: `refs/heads/${destination}`,
      sourceCommit: 'aaa111',
      destinationCommit: 'bbb222',
      mergeBase: 'ccc333',
      mergeMetadata: { isMerged },
    },
  ],
});

describe('codecommit provider: registry and identity', () => {
  it('is registered alongside the OAuth providers', () => {
    expect(KNOWN_PROVIDERS).toEqual(
      expect.arrayContaining(['github', 'gitlab', 'bitbucket', 'codecommit']),
    );
    expect(isKnownProvider('codecommit')).toBe(true);
    expect(cc.id).toBe('codecommit');
  });

  it('declares its contract gaps through capabilities', () => {
    expect(getCapabilities('codecommit')).toMatchObject({
      issues: false,
      draftPullRequests: false,
      reopenPullRequest: false,
      checkStatuses: false,
      approvalRules: true,
      events: 'polling',
    });
    // The OAuth providers keep their historical "everything supported" shape.
    expect(getCapabilities('github')).toMatchObject({ issues: true, events: 'webhook' });
    expect(getCapabilities('bitbucket')).toMatchObject({ issues: false, reopenPullRequest: false });
  });

  it('keeps a capabilities object only where it differs from the defaults', () => {
    // GitHub declares nothing: the registry fills in DEFAULT_CAPABILITIES.
    expect(getProvider('github').capabilities).toBeUndefined();
    expect(getCapabilities('github')).toEqual(DEFAULT_CAPABILITIES);
    // GitLab and Bitbucket are not copies of the defaults.
    expect(getCapabilities('gitlab')).toMatchObject({ approvalRules: true });
    expect(getCapabilities('bitbucket')).toMatchObject({ issues: false, reopenPullRequest: false });
  });

  it('exports the default commit author used by bindings and merges', () => {
    expect(cc.DEFAULT_AUTHOR_NAME).toBe('Collaborative AI-DLC');
    expect(cc.defaultAuthorEmail(ACCOUNT)).toBe(`aidlc-bot@${ACCOUNT}.invalid`);
  });

  it('resolves the regional git host from the repository ARN', () => {
    expect(cc.gitHost).toBeNull();
    expect(cc.gitHostFor(ARN)).toBe(`git-codecommit.${REGION}.amazonaws.com`);
    expect(gitHost('codecommit', ARN)).toBe(`git-codecommit.${REGION}.amazonaws.com`);
    expect(gitHost('github')).toBe('github.com');
  });

  it('builds a clean clone URL from the ARN and refuses to embed a credential', () => {
    expect(buildCloneUrl('codecommit', ARN, '')).toBe(
      `https://git-codecommit.${REGION}.amazonaws.com/v1/repos/${REPO}`,
    );
    // The engine injects credentials through GIT_ASKPASS (workspace.js and
    // git-engine.js always pass ''); a signed SigV4 credential must never be
    // serialised into a remote URL where it would land in .git/config.
    const credentialFixture = { username: 'AKIA%tok', password: '2026Zsig' }; // pragma: allowlist secret
    expect(() => cc.buildCloneUrl(ARN, credentialFixture)).toThrow(ProviderError);
  });

  it('rejects a repoId that is not a CodeCommit ARN', () => {
    expect(() => cc.splitOwnerRepo('owner/repo')).toThrow(ProviderError);
  });

  it('splitOwnerRepo exposes account and repository name', () => {
    expect(cc.splitOwnerRepo(ARN)).toMatchObject({ repo: REPO });
  });
});

describe('codecommit provider: repositories and branches', () => {
  it('listRepos builds ARNs from ListRepositories alone, one call per page', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `svc-${i}`);
    const client = makeClient({
      ListRepositories: { repositories: names.map((repositoryName) => ({ repositoryName })) },
      // No per-repository fan-out: the tenant role no longer needs this action.
      BatchGetRepositories: () => {
        throw new Error('BatchGetRepositories must not be called');
      },
    });
    const repos = await cc.listRepos({ client, region: REGION, accountId: ACCOUNT });
    expect(client.calls.map((c) => c.name)).toEqual(['ListRepositories']);
    expect(repos).toHaveLength(500);
    expect(repos[0]).toMatchObject({
      name: 'svc-0',
      fullName: `arn:aws:codecommit:${REGION}:${ACCOUNT}:svc-0`,
      region: REGION,
      accountId: ACCOUNT,
      private: true,
      defaultBranch: null,
    });
  });

  it('listRepos follows ListRepositories pages and derives the partition', async () => {
    const client = makeClient({
      ListRepositories: ({ nextToken }) =>
        nextToken
          ? { repositories: [{ repositoryName: 'b' }] }
          : { repositories: [{ repositoryName: 'a' }], nextToken: 'n1' },
    });
    const repos = await cc.listRepos({ client, region: 'cn-north-1', accountId: ACCOUNT });
    expect(repos.map((r) => r.fullName)).toEqual([
      `arn:aws-cn:codecommit:cn-north-1:${ACCOUNT}:a`,
      `arn:aws-cn:codecommit:cn-north-1:${ACCOUNT}:b`,
    ]);
  });

  it('listRepos surfaces a ListRepositories denial and requires the account id', async () => {
    const denied = makeClient({ ListRepositories: sdkError('AccessDeniedException') });
    await expect(
      cc.listRepos({ client: denied, region: REGION, accountId: ACCOUNT }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(cc.listRepos({ client: denied, region: REGION })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('listBranches follows pagination and returns [] on a missing repo', async () => {
    const client = makeClient({
      ListBranches: ({ nextToken }) =>
        nextToken ? { branches: ['b'] } : { branches: ['a'], nextToken: 'n1' },
    });
    expect(await cc.listBranches({ client }, ARN)).toEqual(['a', 'b']);

    const missing = makeClient({ ListBranches: sdkError('RepositoryDoesNotExistException') });
    expect(await cc.listBranches({ client: missing }, ARN)).toEqual([]);
  });

  it('getDefaultBranch reads repository metadata and tolerates failure', async () => {
    const client = makeClient({
      GetRepository: { repositoryMetadata: { repositoryName: REPO, defaultBranch: 'trunk' } },
    });
    expect(await cc.getDefaultBranch({ client }, ARN)).toBe('trunk');
    const denied = makeClient({ GetRepository: sdkError('AccessDeniedException') });
    expect(await cc.getDefaultBranch({ client: denied }, ARN)).toBeNull();
  });

  it('maps SDK exceptions onto the shared ProviderError status codes', async () => {
    const cases = [
      ['RepositoryDoesNotExistException', 404],
      ['AccessDeniedException', 403],
      ['ThrottlingException', 429],
      ['ManualMergeRequiredException', 409],
      ['FileTooLargeException', 413],
      ['SomethingUnexpected', 502],
    ];
    for (const [name, status] of cases) {
      const client = makeClient({ GetRepository: sdkError(name) });
      await expect(cc.getRepositoryAccess({ client }, ARN)).rejects.toMatchObject({ status });
    }
  });

  it('scopes a pull-request denial to the operation, not the repository', async () => {
    const prDenied = makeClient({ GetPullRequest: sdkError('AccessDeniedException') });
    const prError = await cc.getPullRequestStatus({ client: prDenied }, ARN, '7').catch((e) => e);
    expect(prError).toMatchObject({ status: 403, extra: { scope: 'operation' } });
    // A repository-level denial keeps the default scope.
    const repoDenied = makeClient({ GetRepository: sdkError('AccessDeniedException') });
    const repoError = await cc.getRepositoryAccess({ client: repoDenied }, ARN).catch((e) => e);
    expect(repoError.status).toBe(403);
    expect(repoError.extra.scope).toBeUndefined();
  });
});

describe('codecommit provider: pull request comments', () => {
  // The real API: repositoryName without the commit pair is rejected.
  const getComments = (pages) => (input) => {
    if (input.repositoryName && !(input.beforeCommitId && input.afterCommitId)) {
      return sdkError('CommitIdRequiredException');
    }
    return pages[input.nextToken ?? 'first'];
  };
  const comment = (id, extra = {}) => ({
    commentId: id,
    content: `body ${id}`,
    authorArn: 'arn:aws:iam::123456789012:user/reviewer',
    creationDate: new Date(`2026-09-18T10:0${id}:00Z`),
    ...extra,
  });

  it('lists every page and revision without a repositoryName filter', async () => {
    const client = makeClient({
      GetCommentsForPullRequest: getComments({
        first: {
          commentsForPullRequestData: [
            {
              repositoryName: REPO,
              beforeCommitId: 'base-1',
              afterCommitId: 'head-1',
              comments: [comment('1'), comment('2', { deleted: true, content: '' })],
            },
          ],
          nextToken: 'page-2',
        },
        'page-2': {
          commentsForPullRequestData: [
            {
              repositoryName: REPO,
              beforeCommitId: 'base-1',
              afterCommitId: 'head-2',
              location: { filePath: 'src/app.js', filePosition: 12 },
              comments: [comment('3', { inReplyTo: '1' })],
            },
            { repositoryName: 'another-repo', comments: [comment('4')] },
          ],
        },
      }),
    });
    const comments = await cc.listPRComments({ client }, ARN, '7');
    expect(client.calls.every((c) => c.input.repositoryName === undefined)).toBe(true);
    expect(client.calls).toHaveLength(2);
    // Deleted and foreign-repository comments are dropped; both revisions kept.
    expect(comments.map((c) => c.id)).toEqual(['1', '3']);
    expect(comments[1]).toMatchObject({
      type: 'review',
      path: 'src/app.js',
      line: 12,
      inReplyTo: '1',
    });
  });

  it('the double enforces the documented parameter rule', async () => {
    const client = makeClient({ GetCommentsForPullRequest: getComments({}) });
    const { GetCommentsForPullRequestCommand } = await import('@aws-sdk/client-codecommit');
    await expect(
      client.send(
        new GetCommentsForPullRequestCommand({ pullRequestId: '7', repositoryName: REPO }),
      ),
    ).rejects.toMatchObject({ name: 'CommitIdRequiredException' });
  });

  it('keeps a denial on the comments API scoped to the operation', async () => {
    const client = makeClient({ GetCommentsForPullRequest: sdkError('AccessDeniedException') });
    await expect(cc.listPRComments({ client }, ARN, '7')).rejects.toMatchObject({
      status: 403,
      extra: { scope: 'operation' },
    });
  });
});

describe('codecommit provider: issues are declared unsupported', () => {
  it('every issue method throws a ProviderError instead of a TypeError', async () => {
    const client = makeClient({});
    for (const fn of [
      'listIssues',
      'getIssue',
      'listIssueComments',
      'addIssueComment',
      'closeIssue',
    ]) {
      await expect(cc[fn]({ client }, ARN, 1, {})).rejects.toBeInstanceOf(ProviderError);
    }
  });
});

describe('codecommit provider: pull requests', () => {
  it('findPullRequest scans open PRs by source and destination branch', async () => {
    const client = makeClient({
      ListPullRequests: { pullRequestIds: ['5', '7'] },
      GetPullRequest: ({ pullRequestId }) => ({
        pullRequest: pr({ id: pullRequestId, source: pullRequestId === '7' ? 'feature' : 'other' }),
      }),
    });
    const found = await cc.findPullRequest(withSession(client), ARN, {
      sourceBranch: 'feature',
      targetBranch: 'main',
    });
    expect(found.pullRequestId).toBe('7');
    expect(client.calls[0]).toMatchObject({
      name: 'ListPullRequests',
      input: { repositoryName: REPO, pullRequestStatus: 'OPEN', authorArn: SESSION_ARN },
    });
  });

  it('findPullRequest refuses to list without the session identity', async () => {
    const client = makeClient({ ListPullRequests: { pullRequestIds: ['7'] } });
    await expect(
      cc.findPullRequest({ client }, ARN, { sourceBranch: 'feature', targetBranch: 'main' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(client.calls).toHaveLength(0);
  });

  it('findPullRequest scans every author-filtered page, with no lookup cap', async () => {
    // 301 platform PRs: the old 300-lookup cap returned null here.
    const ids = Array.from({ length: 301 }, (_, i) => String(i + 1));
    const client = makeClient({
      ListPullRequests: ({ nextToken }) =>
        nextToken
          ? { pullRequestIds: ids.slice(150) }
          : { pullRequestIds: ids.slice(0, 150), nextToken: 'p2' },
      GetPullRequest: ({ pullRequestId }) => ({
        pullRequest: pr({
          id: pullRequestId,
          source: pullRequestId === '301' ? 'feature' : 'other',
        }),
      }),
    });
    const found = await cc.findPullRequest(withSession(client), ARN, {
      sourceBranch: 'feature',
      targetBranch: 'main',
    });
    expect(found.pullRequestId).toBe('301');
  });

  it('findPullRequest fetches candidates in bounded parallel batches, first match wins', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
    const client = {
      calls: [],
      send: async (command) => {
        const name = command.constructor.name.replace(/Command$/, '');
        client.calls.push({ name, input: command.input });
        if (name === 'ListPullRequests') return { pullRequestIds: ids };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const id = command.input.pullRequestId;
        // Two matches: the earlier one in list order must win.
        return {
          pullRequest: pr({ id, source: id === '12' || id === '14' ? 'feature' : 'other' }),
        };
      },
    };
    const found = await cc.findPullRequest(withSession(client), ARN, {
      sourceBranch: 'feature',
      targetBranch: 'main',
    });
    expect(found.pullRequestId).toBe('12');
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
    // Stops at the batch holding the match: ids 21..25 are never fetched.
    expect(client.calls.filter((c) => c.name === 'GetPullRequest')).toHaveLength(20);
  });

  it('findPullRequest fails instead of returning null when pages remain', async () => {
    const client = makeClient({
      ListPullRequests: ({ nextToken }) => ({
        pullRequestIds: [`x-${nextToken ?? 0}`],
        nextToken: `${Number(nextToken ?? 0) + 1}`,
      }),
      GetPullRequest: ({ pullRequestId }) => ({
        pullRequest: pr({ id: pullRequestId, source: 'other' }),
      }),
    });
    await expect(
      cc.findPullRequest(withSession(client), ARN, {
        sourceBranch: 'feature',
        targetBranch: 'main',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'PR_LOOKUP_TRUNCATED' });
    expect(client.calls.some((c) => c.name === 'CreatePullRequest')).toBe(false);
  });

  it('createPullRequest returns {prUrl, prNumber} and reports the console URL', async () => {
    const client = makeClient({
      ListBranches: { branches: ['main', 'feature'] },
      GetRepository: { repositoryMetadata: { defaultBranch: 'main' } },
      ListPullRequests: { pullRequestIds: [] },
      GetMergeOptions: {
        mergeOptions: ['FAST_FORWARD_MERGE', 'THREE_WAY_MERGE'],
        baseCommitId: 'bbb222',
        sourceCommitId: 'aaa111',
        destinationCommitId: 'bbb222',
      },
      CreatePullRequest: ({ targets, title }) => {
        expect(targets[0]).toMatchObject({
          repositoryName: REPO,
          sourceReference: 'refs/heads/feature',
          destinationReference: 'refs/heads/main',
        });
        expect(title).toBe('Ship it');
        return { pullRequest: pr({ id: '42' }) };
      },
    });
    const out = await cc.createPullRequest(withSession(client), ARN, {
      branch: 'feature',
      baseBranch: 'main',
      title: 'Ship it',
      body: 'desc',
    });
    expect(out).toMatchObject({ prNumber: '42' });
    expect(out.prUrl).toContain(`codesuite/codecommit/repositories/${REPO}/pull-requests/42`);
    expect(out.prUrl).toContain(REGION);
    // Idempotency token must be sent so a retried Lambda cannot open a duplicate.
    const create = client.calls.find((c) => c.name === 'CreatePullRequest');
    expect(create.input.clientRequestToken).toBeTruthy();
  });

  describe('createPullRequest idempotency across a replaced pull request', () => {
    // CodeCommit's documented token semantics: a reused token with the same
    // parameters returns the ORIGINAL request's pull request; with different
    // parameters it fails with IdempotencyParameterMismatchException.
    const codecommitLike = () => {
      const byToken = new Map();
      const prs = new Map();
      let next = 1;
      const client = makeClient({
        ListBranches: { branches: ['main', 'feature'] },
        // Only open PRs are listed: a closed PR never satisfies "existing".
        ListPullRequests: () => ({
          pullRequestIds: [...prs.values()]
            .filter((p) => p.pullRequestStatus === 'OPEN')
            .map((p) => p.pullRequestId),
        }),
        GetPullRequest: ({ pullRequestId }) => ({ pullRequest: prs.get(pullRequestId) }),
        GetMergeOptions: {
          mergeOptions: ['THREE_WAY_MERGE'],
          baseCommitId: 'b',
          sourceCommitId: 'a',
          destinationCommitId: 'b',
        },
        CreatePullRequest: ({ clientRequestToken, title, description }) => {
          const params = JSON.stringify({ title, description });
          const prior = byToken.get(clientRequestToken);
          if (prior && prior.params !== params) {
            return sdkError('IdempotencyParameterMismatchException');
          }
          if (prior) return { pullRequest: prs.get(prior.id) };
          const created = pr({ id: String(next++) });
          prs.set(created.pullRequestId, created);
          byToken.set(clientRequestToken, { params, id: created.pullRequestId });
          return { pullRequest: created };
        },
      });
      const close = (id) => {
        prs.get(id).pullRequestStatus = 'CLOSED';
      };
      return { client, close };
    };
    const create = (client, attemptKey, title = 'Ship it') =>
      cc.createPullRequest(withSession(client), ARN, {
        branch: 'feature',
        baseBranch: 'main',
        title,
        body: 'desc',
        attemptKey,
      });

    it('opens a new PR when replacing a closed one, with unchanged metadata', async () => {
      const { client, close } = codecommitLike();
      expect((await create(client, 'exec-1:initial')).prNumber).toBe('1');
      close('1');
      expect((await create(client, 'exec-1:1')).prNumber).toBe('2');
    });

    it('opens a new PR when replacing a closed one, with changed metadata', async () => {
      const { client, close } = codecommitLike();
      expect((await create(client, 'exec-1:initial')).prNumber).toBe('1');
      close('1');
      expect((await create(client, 'exec-1:1', 'Ship it, take two')).prNumber).toBe('2');
    });

    it('a retry of the same attempt never opens a second PR', async () => {
      const { client } = codecommitLike();
      const first = await create(client, 'exec-1:initial');
      // The PR exists, so the retry finds it before any create.
      const again = await create(client, 'exec-1:initial');
      expect(again).toMatchObject({ existing: true, prNumber: first.prNumber });
      expect(client.calls.filter((c) => c.name === 'CreatePullRequest')).toHaveLength(1);
    });

    it('never reports a closed PR as opened when a caller reuses the key', async () => {
      // Defense in depth for a caller that does not allocate a new key per
      // attempt: CodeCommit replays the token onto the closed PR, and the
      // provider chains to a token bound to that PR instead of returning it.
      const { client, close } = codecommitLike();
      expect((await create(client, 'reused')).prNumber).toBe('1');
      close('1');
      expect((await create(client, 'reused')).prNumber).toBe('2');
      close('2');
      expect((await create(client, 'reused')).prNumber).toBe('3');
      // Converges: the open replacement is found, nothing new is created.
      const again = await create(client, 'reused');
      expect(again).toMatchObject({ existing: true, prNumber: '3' });
      expect(client.calls.filter((c) => c.name === 'CreatePullRequest')).toHaveLength(6);
    });

    it('reports a reused token with different parameters as a conflict', async () => {
      const { client, close } = codecommitLike();
      await create(client, 'same');
      close('1');
      await expect(create(client, 'same', 'different title')).rejects.toMatchObject({
        status: 409,
        extra: { exception: 'IdempotencyParameterMismatchException' },
      });
    });
  });

  it('createPullRequest returns the existing open PR instead of a duplicate', async () => {
    const client = makeClient({
      ListBranches: { branches: ['main', 'feature'] },
      ListPullRequests: { pullRequestIds: ['7'] },
      GetPullRequest: { pullRequest: pr({ id: '7' }) },
    });
    const out = await cc.createPullRequest(withSession(client), ARN, {
      branch: 'feature',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });
    expect(out).toMatchObject({ existing: true, prNumber: '7' });
    expect(client.calls.some((c) => c.name === 'CreatePullRequest')).toBe(false);
  });

  it('createPullRequest refuses a head branch that was never pushed', async () => {
    const client = makeClient({
      ListBranches: { branches: ['main'] },
      ListPullRequests: { pullRequestIds: [] },
      GetMergeOptions: sdkError('CommitDoesNotExistException'),
      GetBranch: ({ branchName }) =>
        branchName === 'main'
          ? { branch: { branchName: 'main', commitId: 'bbb222' } }
          : sdkError('BranchDoesNotExistException'),
    });
    const out = await cc.createPullRequest(withSession(client), ARN, {
      branch: 'never-pushed',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });
    expect(out).toMatchObject({ failed: true, reason: 'head_missing' });
  });

  it('createPullRequest skips when head brings nothing over base', async () => {
    const client = makeClient({
      ListBranches: { branches: ['main', 'feature'] },
      ListPullRequests: { pullRequestIds: [] },
      GetMergeOptions: {
        mergeOptions: ['FAST_FORWARD_MERGE'],
        baseCommitId: 'same',
        sourceCommitId: 'same',
        destinationCommitId: 'same',
      },
    });
    const out = await cc.createPullRequest(withSession(client), ARN, {
      branch: 'feature',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });
    expect(out).toEqual({ skipped: true, reason: 'no_changes' });
  });

  it('getPullRequestStatus normalises an open PR with approval-rule state', async () => {
    const client = makeClient({
      GetPullRequest: { pullRequest: pr({ id: '7' }) },
      GetMergeOptions: { mergeOptions: ['THREE_WAY_MERGE'] },
      EvaluatePullRequestApprovalRules: {
        evaluation: {
          approved: false,
          overridden: false,
          approvalRulesNotSatisfied: ['2-reviewers'],
        },
      },
    });
    const out = await cc.getPullRequestStatus({ client }, ARN, 7);
    expect(out).toMatchObject({
      number: '7',
      state: 'open',
      draft: false,
      sourceBranch: 'feature',
      targetBranch: 'main',
      headSha: 'aaa111',
      targetSha: 'bbb222',
      mergeable: true,
      mergeableState: 'clean',
      approval: { approved: false, rulesNotSatisfied: ['2-reviewers'] },
    });
  });

  it('getPullRequestStatus distinguishes merged from closed', async () => {
    const merged = makeClient({
      GetPullRequest: { pullRequest: pr({ status: 'CLOSED', isMerged: true }) },
    });
    expect(await cc.getPullRequestStatus({ client: merged }, ARN, 7)).toMatchObject({
      state: 'merged',
      mergedAt: expect.any(String),
    });
    const closed = makeClient({
      GetPullRequest: { pullRequest: pr({ status: 'CLOSED', isMerged: false }) },
    });
    expect(await cc.getPullRequestStatus({ client: closed }, ARN, 7)).toMatchObject({
      state: 'closed',
      mergedAt: null,
    });
  });

  it('getPullRequestStatus returns null for an unknown PR', async () => {
    const client = makeClient({ GetPullRequest: sdkError('PullRequestDoesNotExistException') });
    expect(await cc.getPullRequestStatus({ client }, ARN, 999)).toBeNull();
  });

  it('setPullRequestDraft refuses a draft, reads for ready, and reopen throws 409', async () => {
    const client = makeClient({
      GetPullRequest: { pullRequest: pr() },
      GetMergeOptions: { mergeOptions: [] },
      EvaluatePullRequestApprovalRules: { evaluation: { approved: true } },
    });
    // Returning an open PR as if it were now a draft would drop the safeguard.
    await expect(cc.setPullRequestDraft({ client }, ARN, 7, true)).rejects.toMatchObject({
      status: 409,
      extra: { capability: 'draftPullRequests', code: 'DRAFT_UNSUPPORTED' },
    });
    expect(client.calls).toHaveLength(0);
    const out = await cc.setPullRequestDraft({ client }, ARN, 7, false);
    expect(out).toMatchObject({ draft: false, mergeableState: 'dirty' });
    await expect(cc.reopenPullRequest({ client }, ARN, 7)).rejects.toMatchObject({ status: 409 });
  });
});

describe('codecommit provider: merges and comparisons', () => {
  it('compareBranches derives ahead/behind/identical from GetMergeOptions commits', async () => {
    const mk = (base, source, dest) =>
      makeClient({
        GetMergeOptions: {
          mergeOptions: ['THREE_WAY_MERGE'],
          baseCommitId: base,
          sourceCommitId: source,
          destinationCommitId: dest,
        },
      });
    expect(
      await cc.compareBranches({ client: mk('d', 's', 'd') }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({ status: 'ahead' });
    expect(
      await cc.compareBranches({ client: mk('s', 's', 'd') }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({ status: 'behind' });
    expect(
      await cc.compareBranches({ client: mk('x', 'x', 'x') }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({ status: 'identical' });
    expect(
      await cc.compareBranches({ client: mk('b', 's', 'd') }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({ status: 'diverged' });
  });

  it('compareBranches throws throttling, service and access failures instead of "unknown"', async () => {
    const failing = (name) => makeClient({ GetMergeOptions: sdkError(name) });
    const compare = (client) => cc.compareBranches({ client }, ARN, { base: 'main', head: 'f' });
    await expect(compare(failing('ThrottlingException'))).rejects.toMatchObject({ status: 429 });
    await expect(compare(failing('InternalFailure'))).rejects.toMatchObject({ status: 502 });
    const denied = compare(failing('AccessDeniedException'));
    await expect(denied).rejects.toMatchObject({ status: 403 });
    // GetMergeOptions is a repository action: its denial is not operation-scoped.
    await expect(denied).rejects.not.toMatchObject({ extra: { scope: 'operation' } });
  });

  it('compareBranches reports only documented impossible comparisons as "unknown"', async () => {
    for (const name of [
      'TipsDivergenceExceededException',
      'MaximumItemsToCompareExceededException',
      'MaximumFileContentToLoadExceededException',
    ]) {
      const client = makeClient({ GetMergeOptions: sdkError(name) });
      expect(await cc.compareBranches({ client }, ARN, { base: 'main', head: 'f' })).toMatchObject({
        status: 'unknown',
        detail: name,
      });
    }
    // A missing ref keeps its specific answer.
    const missing = makeClient({
      GetMergeOptions: sdkError('CommitDoesNotExistException'),
      GetBranch: sdkError('BranchDoesNotExistException'),
    });
    expect(
      await cc.compareBranches({ client: missing }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({ status: 'missing_head' });
  });

  it('mergeBranch returns "merged", "conflict", or a structured error', async () => {
    const ok = makeClient({ MergeBranchesByThreeWay: { commitId: 'm1' } });
    expect(await cc.mergeBranch({ client: ok }, ARN, { base: 'main', head: 'feature' })).toBe(
      'merged',
    );
    const merge = ok.calls[0];
    expect(merge.input).toMatchObject({
      repositoryName: REPO,
      sourceCommitSpecifier: 'feature',
      destinationCommitSpecifier: 'main',
      targetBranch: 'main',
    });
    expect(merge.input.email).toMatch(/@/);

    const conflict = makeClient({
      MergeBranchesByThreeWay: sdkError('ManualMergeRequiredException'),
    });
    expect(await cc.mergeBranch({ client: conflict }, ARN, { base: 'main', head: 'f' })).toBe(
      'conflict',
    );

    const denied = makeClient({ MergeBranchesByThreeWay: sdkError('AccessDeniedException') });
    expect(
      await cc.mergeBranch({ client: denied }, ARN, { base: 'main', head: 'f' }),
    ).toMatchObject({
      error: expect.stringContaining('AccessDeniedException'),
    });
  });

  it('mergeBranch retries once on a concurrent reference update', async () => {
    let attempts = 0;
    const client = makeClient({
      MergeBranchesByThreeWay: () => {
        attempts += 1;
        return attempts === 1 ? sdkError('ConcurrentReferenceUpdateException') : { commitId: 'm2' };
      },
    });
    expect(await cc.mergeBranch({ client }, ARN, { base: 'main', head: 'f' })).toBe('merged');
    expect(attempts).toBe(2);
  });

  it('mergeBranch honours the committer identity from ctx', async () => {
    const client = makeClient({ MergeBranchesByThreeWay: { commitId: 'm1' } });
    await cc.mergeBranch(
      { client, committerName: 'AI-DLC Bot', committerEmail: 'bot@example.com' },
      ARN,
      { base: 'main', head: 'f', message: 'custom' },
    );
    expect(client.calls[0].input).toMatchObject({
      authorName: 'AI-DLC Bot',
      email: 'bot@example.com',
      commitMessage: 'custom',
    });
  });

  it('getUnmergedConstructionTaskBranches lists task branches base does not contain', async () => {
    const client = makeClient({
      ListBranches: {
        branches: ['main', 'intent', 'intent--task-1', 'intent--task-2', 'other--task-9'],
      },
      GetMergeOptions: ({ sourceCommitSpecifier }) =>
        sourceCommitSpecifier === 'intent--task-1'
          ? {
              mergeOptions: ['FAST_FORWARD_MERGE'],
              baseCommitId: 's',
              sourceCommitId: 's',
              destinationCommitId: 'd',
            } // behind -> merged
          : {
              mergeOptions: ['THREE_WAY_MERGE'],
              baseCommitId: 'b',
              sourceCommitId: 's',
              destinationCommitId: 'd',
            }, // diverged -> unmerged
    });
    const out = await cc.getUnmergedConstructionTaskBranches({ client }, ARN, 'intent');
    expect(out).toEqual(['intent--task-2']);
  });

  // "Could not check" must never read as "not merged".
  const undecidable = () =>
    makeClient({
      ListBranches: { branches: ['main', 'intent', 'intent--task-1'] },
      GetMergeOptions: sdkError('TipsDivergenceExceededException'),
      DeleteBranch: {},
    });

  it('getUnmergedConstructionTaskBranches surfaces an undecidable merge status', async () => {
    const pending = cc.getUnmergedConstructionTaskBranches(
      { client: undecidable() },
      ARN,
      'intent',
    );
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'MERGE_STATUS_UNKNOWN' });
  });

  it('cleanupConstructionTaskBranches counts an undecidable branch as failed and keeps it', async () => {
    const client = undecidable();
    const out = await cc.cleanupConstructionTaskBranches({ client }, ARN, 'intent');
    expect(out).toEqual({ deleted: 0, failed: 1, skipped: 0 });
    expect(client.calls.some((call) => call.name === 'DeleteBranch')).toBe(false);
  });
});
