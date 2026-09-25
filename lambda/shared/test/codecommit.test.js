import { describe, it, expect } from 'vitest';
import {
  getProvider,
  getCapabilities,
  buildCloneUrl,
  gitHost,
  isKnownProvider,
  KNOWN_PROVIDERS,
  ProviderError,
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
  it('listRepos fans out ListRepositories into BatchGetRepositories', async () => {
    const client = makeClient({
      ListRepositories: { repositories: [{ repositoryName: REPO, repositoryId: 'id-1' }] },
      BatchGetRepositories: ({ repositoryNames }) => ({
        repositories: repositoryNames.map((repositoryName) => ({
          repositoryName,
          repositoryId: 'id-1',
          accountId: ACCOUNT,
          Arn: ARN,
          defaultBranch: 'main',
          cloneUrlHttp: `https://git-codecommit.${REGION}.amazonaws.com/v1/repos/${repositoryName}`,
        })),
      }),
    });
    const out = await cc.listRepos({ client, region: REGION });
    const repos = Array.isArray(out) ? out : (out.items ?? out.repos);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      name: REPO,
      fullName: ARN,
      defaultBranch: 'main',
      region: REGION,
      accountId: ACCOUNT,
      private: true,
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
    const found = await cc.findPullRequest({ client }, ARN, {
      sourceBranch: 'feature',
      targetBranch: 'main',
    });
    expect(found.pullRequestId).toBe('7');
    expect(client.calls[0]).toMatchObject({
      name: 'ListPullRequests',
      input: { repositoryName: REPO, pullRequestStatus: 'OPEN' },
    });
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
    const out = await cc.createPullRequest({ client }, ARN, {
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

  it('createPullRequest returns the existing open PR instead of a duplicate', async () => {
    const client = makeClient({
      ListBranches: { branches: ['main', 'feature'] },
      ListPullRequests: { pullRequestIds: ['7'] },
      GetPullRequest: { pullRequest: pr({ id: '7' }) },
    });
    const out = await cc.createPullRequest({ client }, ARN, {
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
    const out = await cc.createPullRequest({ client }, ARN, {
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
    const out = await cc.createPullRequest({ client }, ARN, {
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

  it('setPullRequestDraft is a no-op read (no draft concept) and reopen throws 409', async () => {
    const client = makeClient({
      GetPullRequest: { pullRequest: pr() },
      GetMergeOptions: { mergeOptions: [] },
      EvaluatePullRequestApprovalRules: { evaluation: { approved: true } },
    });
    const out = await cc.setPullRequestDraft({ client }, ARN, 7, true);
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
});
