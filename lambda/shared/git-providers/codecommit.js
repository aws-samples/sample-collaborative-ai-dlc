// AWS CodeCommit provider — the uniform git-provider contract (documented in
// ../git-providers.js) implemented over the CodeCommit JSON-RPC API through the
// AWS SDK instead of `fetch` + bearer token.
//
// Four structural differences from github/gitlab/bitbucket shape this module:
//
//  1. There is no global host. Every CodeCommit endpoint is regional, so the
//     `gitHost` constant is null and callers resolve the host per repository
//     with `gitHostFor(repoId)`.
//  2. There is no owner/name pair. A repository is identified by its ARN
//     (see ./codecommit-repo.js), which carries partition, region, account and
//     name — everything a client and a clone URL need.
//  3. There is no token. `ctx.token` is a short-lived STS triple minted by the
//     credential broker (see ../codecommit-role.js) and used as SDK
//     credentials; the git remote itself is always credential-free (the
//     signature travels out of band, see ./codecommit-credential.js).
//  4. Parts of the contract have no CodeCommit equivalent at all: issues,
//     draft pull requests, reopening a closed pull request, CI check statuses.
//     Those throw ProviderError(501/409) instead of pretending, and the
//     exported `capabilities` map lets a caller branch before it calls.
//
// ctx = { token: { accessKeyId, secretAccessKey, sessionToken },
//         region?,            // only needed by listRepos (no repo ARN yet)
//         client?,            // injected CodeCommitClient (tests)
//         committerName?, committerEmail? }  // server-side merge attribution

import { createHash } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  BatchGetRepositoriesCommand,
  CodeCommitClient,
  CreatePullRequestCommand,
  DeleteBranchCommand,
  EvaluatePullRequestApprovalRulesCommand,
  GetBranchCommand,
  GetCommentsForPullRequestCommand,
  GetFileCommand,
  GetFolderCommand,
  GetMergeOptionsCommand,
  GetPullRequestCommand,
  GetRepositoryCommand,
  ListBranchesCommand,
  ListPullRequestsCommand,
  ListRepositoriesCommand,
  MergeBranchesByThreeWayCommand,
  PostCommentForPullRequestCommand,
  PostCommentReplyCommand,
} from '@aws-sdk/client-codecommit';
import { ProviderError } from './errors.js';
import { parseCodeCommitRepo } from './codecommit-repo.js';
import { codeCommitCloneUrl, codeCommitGitHost } from './codecommit-credential.js';

const logger = new Logger({
  persistentKeys: { component: 'git-provider', module: 'codecommit' },
});

// ---------------------------------------------------------------------------
// Identity / git plumbing
// ---------------------------------------------------------------------------

const id = 'codecommit';
const displayName = 'AWS CodeCommit';

// Deliberately null: CodeCommit has one git endpoint PER REGION
// (git-codecommit.<region>.amazonaws.com), so there is no single host constant
// to hand out. Callers that need a host must go through gitHostFor(repoId).
const gitHost = null;
// Likewise for the API endpoint — codecommit.<region>.amazonaws.com. The SDK
// resolves it from the client's region, so nothing here builds a URL.
const apiBase = null;

const parseRepo = (repoId) => {
  try {
    return parseCodeCommitRepo(repoId);
  } catch {
    throw new ProviderError(
      400,
      `Invalid gitRepo "${String(repoId)}": expected a CodeCommit repository ARN`,
    );
  }
};

const gitHostFor = (repoId) => codeCommitGitHost(parseRepo(repoId).region);

const apiBaseFor = (repoId) => {
  const { region, partition } = parseRepo(repoId);
  return `https://codecommit.${region}.${partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
};

// A CodeCommit remote NEVER carries credentials. Authentication is an HTTP
// Basic pair whose password is a per-repository SigV4 signature, produced by
// ./codecommit-credential.js and handed to git out of band. Accepting a token
// here would either be silently ignored or write a credential into a remote
// URL (and from there into .git/config), so a truthy token is a caller bug.
const buildCloneUrl = (repoId, token) => {
  const { region, repositoryName } = parseRepo(repoId);
  if (token) {
    throw new ProviderError(
      400,
      'CodeCommit clone URLs cannot embed a credential; sign the request instead',
      { capability: 'tokenizedCloneUrl' },
    );
  }
  return codeCommitCloneUrl(region, repositoryName);
};

// CodeCommit has a flat namespace per (partition, region, account), so the
// nearest thing to an "owner" is the account that owns the repository.
const splitOwnerRepo = (repoId) => {
  const { accountId, repositoryName, region, arn } = parseRepo(repoId);
  return { owner: accountId, repo: repositoryName, region, arn };
};

const consoleDomain = (region) =>
  region.startsWith('cn-') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';

// CodeCommit's API returns no web URL for a pull request, so the console URL is
// composed from the coordinates we already hold.
const pullRequestUrl = ({ region, repositoryName, pullRequestId }) =>
  `https://${region}.${consoleDomain(region)}/codesuite/codecommit/repositories/${repositoryName}/pull-requests/${pullRequestId}?region=${region}`;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// One client per call site. `ctx.client` short-circuits construction (tests and
// callers that already hold a configured client); otherwise the region comes
// from the repository ARN, falling back to ctx.region for the repo-less
// discovery call.
const clientFor = (ctx, repoId = null) => {
  if (ctx?.client) return ctx.client;
  const region = repoId ? parseRepo(repoId).region : ctx?.region;
  if (!region) {
    throw new ProviderError(400, 'CodeCommit requires a region (from the repository ARN or ctx)');
  }
  return new CodeCommitClient({ region, ...(ctx?.token ? { credentials: ctx.token } : {}) });
};

const retryAfterSeconds = (error) => {
  const headers = error?.$response?.headers ?? {};
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

// SDK exception -> ProviderError. The exception NAME is carried through (it is
// a stable, documented enum) but the SDK's message text never is: it can quote
// caller input, repository paths or ARNs, and this error is surfaced to API
// consumers.
const mapError = (error, action) => {
  if (error instanceof ProviderError) return error;
  const exception = error?.name || 'UnknownError';
  const extra = { action, exception };
  const message = `CodeCommit ${action} failed: ${exception}`;
  if (exception.endsWith('DoesNotExistException')) return new ProviderError(404, message, extra);
  if (/AccessDenied|Unauthorized/.test(exception)) return new ProviderError(403, message, extra);
  if (/Throttl|TooManyRequests|RequestLimitExceeded/.test(exception)) {
    return new ProviderError(429, message, { ...extra, retryAfter: retryAfterSeconds(error) });
  }
  if (exception === 'ManualMergeRequiredException') return new ProviderError(409, message, extra);
  if (/FileTooLarge|FolderContentSizeLimitExceeded/.test(exception)) {
    return new ProviderError(413, message, extra);
  }
  return new ProviderError(502, message, extra);
};

const call = async (client, command, action) => {
  try {
    return await client.send(command);
  } catch (error) {
    throw mapError(error, action);
  }
};

// Swallow one expected status (mirrors the `if (res.status === 404) return []`
// shape the fetch-based providers use).
const callOr = async (client, command, action, status, fallback) => {
  try {
    return await call(client, command, action);
  } catch (error) {
    if (error instanceof ProviderError && error.status === status) return fallback;
    throw error;
  }
};

const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const HEADS = 'refs/heads/';
const shortRef = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');
const sameRef = (a, b) => Boolean(a) && Boolean(b) && shortRef(a) === shortRef(b);

// ---------------------------------------------------------------------------
// OAuth / authenticated user
// ---------------------------------------------------------------------------

// No `oauth` export by design: CodeCommit access is IAM, brokered by
// ../codecommit-role.js (auth type `codecommit-role`). There is also no
// getAuthenticatedUser: none of CodeCommit's actions returns the caller's
// identity, so the committer is CONFIGURED on the binding rather than
// discovered (see source-control-credentials.js).

// ---------------------------------------------------------------------------
// Repo browse
// ---------------------------------------------------------------------------

const regionOfArn = (arn) => {
  try {
    return parseCodeCommitRepo(arn).region;
  } catch {
    return null;
  }
};

// RepositoryMetadata -> the github-shaped GitRepo. `fullName` is the ARN
// because that IS the platform's repoId for CodeCommit; `private` is always
// true (CodeCommit has no public repositories).
const mapRepo = (r) => ({
  id: r?.repositoryId ?? r?.Arn ?? null,
  name: r?.repositoryName ?? null,
  fullName: r?.Arn ?? null,
  private: true,
  defaultBranch: r?.defaultBranch ?? null,
  arn: r?.Arn ?? null,
  accountId: r?.accountId ?? null,
  region: r?.Arn ? regionOfArn(r.Arn) : null,
  cloneUrl: r?.cloneUrlHttp ?? null,
});

const LIST_REPO_PAGES = 20;
// BatchGetRepositories accepts at most 25 names per call.
const BATCH_GET_SIZE = 25;

// Repository discovery is per (region, account): ListRepositories returns only
// {repositoryId, repositoryName}, so the default branch and ARN each caller
// needs come from a BatchGetRepositories fan-out.
const listRepos = async (ctx) => {
  const client = clientFor(ctx);
  const names = [];
  let nextToken;
  for (let page = 0; page < LIST_REPO_PAGES; page += 1) {
    const res = await call(client, new ListRepositoriesCommand({ nextToken }), 'ListRepositories');
    for (const repo of res.repositories ?? []) {
      if (repo?.repositoryName) names.push(repo.repositoryName);
    }
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  const repos = [];
  for (let i = 0; i < names.length; i += BATCH_GET_SIZE) {
    const res = await call(
      client,
      new BatchGetRepositoriesCommand({ repositoryNames: names.slice(i, i + BATCH_GET_SIZE) }),
      'BatchGetRepositories',
    );
    repos.push(...(res.repositories ?? []).map(mapRepo));
  }
  return repos;
};

const LIST_BRANCH_PAGES = 50;

// ListBranches returns names only — which is exactly the contract's shape, so
// no per-branch GetBranch fan-out is needed here.
const listBranches = async (ctx, repoId) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const names = [];
  let nextToken;
  for (let page = 0; page < LIST_BRANCH_PAGES; page += 1) {
    const res = await callOr(
      client,
      new ListBranchesCommand({ repositoryName, nextToken }),
      'ListBranches',
      404,
      null,
    );
    if (!res) return [];
    names.push(...(res.branches ?? []));
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return names;
};

const getRepositoryMetadata = async (ctx, repoId) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const res = await call(client, new GetRepositoryCommand({ repositoryName }), 'GetRepository');
  return res.repositoryMetadata ?? null;
};

// `defaultBranch` is absent on a repository with no commits yet, so null here
// means "unknown or empty" and the caller falls back to its configured base.
const getDefaultBranch = async (ctx, repoId) => {
  try {
    const metadata = await getRepositoryMetadata(ctx, repoId);
    return metadata?.defaultBranch ?? null;
  } catch {
    return null;
  }
};

// CodeCommit exposes no permissions object anywhere in its API, so read/write
// authority cannot be interrogated — it is decided by the IAM session policy
// the broker attached when it minted `ctx.token` (see ../codecommit-role.js).
// A successful GetRepository proves read; write is reported optimistically and
// surfaces as a push/merge failure if the tenant role lacks GitPush.
const getRepositoryAccess = async (ctx, repoId) => {
  const metadata = await getRepositoryMetadata(ctx, repoId);
  if (!metadata) throw new ProviderError(404, 'CodeCommit repository not found');
  return {
    defaultBranch: metadata.defaultBranch ?? null,
    private: true,
    permissions: {},
    canRead: true,
    canWrite: true,
  };
};

// GetFolder is neither recursive nor paginated, so a full tree is a
// breadth-first walk of one call per folder. Both caps below are defensive: 20
// directory levels is CodeCommit's own path limit, and 500 folders bounds the
// call count on a pathological repository. Hitting either sets a non-enumerable
// `truncated` flag on the returned array (so the JSON shape stays a plain list).
const TREE_MAX_FOLDERS = 500;
const TREE_MAX_DEPTH = 20;

const getTree = async (ctx, repoId, branch = 'main') => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const files = [];
  const queue = [{ folderPath: '/', depth: 0 }];
  let folders = 0;
  let truncated = false;

  while (queue.length) {
    if (folders >= TREE_MAX_FOLDERS) {
      truncated = true;
      break;
    }
    const { folderPath, depth } = queue.shift();
    folders += 1;
    const res = await call(
      client,
      new GetFolderCommand({ repositoryName, commitSpecifier: branch, folderPath }),
      'GetFolder',
    );
    for (const file of res.files ?? []) {
      // GetFolder carries no file size; callers treat null as "unknown".
      files.push({ path: file.absolutePath, sha: file.blobId ?? '', size: null });
    }
    for (const folder of res.subFolders ?? []) {
      if (depth + 1 > TREE_MAX_DEPTH) {
        truncated = true;
        continue;
      }
      queue.push({ folderPath: folder.absolutePath, depth: depth + 1 });
    }
    // Submodules and symbolic links are not blobs; the fetch-based providers
    // filter them out too.
  }

  if (truncated) {
    logger.warn('CodeCommit tree walk truncated', { repositoryName, branch, folders });
  }
  Object.defineProperty(files, 'truncated', { value: truncated, enumerable: false });
  return files;
};

const getFileContents = async (ctx, repoId, filePath, branch = 'main') => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const res = await call(
    client,
    new GetFileCommand({ repositoryName, commitSpecifier: branch, filePath }),
    'GetFile',
  );
  return {
    path: res.filePath ?? filePath,
    sha: res.blobId ?? null,
    size: Number(res.fileSize ?? 0),
    content: Buffer.from(res.fileContent ?? []).toString('utf-8'),
  };
};

// ---------------------------------------------------------------------------
// Issues — not a CodeCommit concept
// ---------------------------------------------------------------------------

// CodeCommit has no issue tracker: none of its actions creates, reads or closes
// one. These throw 501 rather than being absent so a caller that reaches them
// gets a classified error instead of a TypeError; `capabilities.issues` is the
// cheap check to make first.
const noIssueTracker = () => {
  throw new ProviderError(501, 'CodeCommit has no issue tracker', { capability: 'issues' });
};

const listIssues = async () => noIssueTracker();
const getIssue = async () => noIssueTracker();
const listIssueComments = async () => noIssueTracker();
const addIssueComment = async () => noIssueTracker();
const closeIssue = async () => noIssueTracker();

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

const prTarget = (pr) => pr?.pullRequestTargets?.[0] ?? {};

const getPullRequestRaw = async (ctx, repoId, prNumber) => {
  const client = clientFor(ctx, repoId);
  const res = await callOr(
    client,
    new GetPullRequestCommand({ pullRequestId: String(prNumber) }),
    'GetPullRequest',
    404,
    null,
  );
  return res?.pullRequest ?? null;
};

const LIST_PR_PAGES = 10;
// findPullRequest is O(open pull requests): ListPullRequests has no
// source-branch filter and returns bare ids, so each candidate costs one
// GetPullRequest. The cap keeps a repository at CodeCommit's 1,000-open-PR
// quota from turning one lookup into 1,000 calls.
const FIND_PR_MAX_LOOKUPS = 300;

const prStatusFilter = (state) => {
  if (state === 'closed') return 'CLOSED';
  if (state === 'all') return undefined;
  return 'OPEN';
};

const findPullRequest = async (
  ctx,
  repoId,
  { sourceBranch, targetBranch = null, state = 'open' },
) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const pullRequestStatus = prStatusFilter(state);
  let nextToken;
  let lookups = 0;

  for (let page = 0; page < LIST_PR_PAGES; page += 1) {
    const res = await callOr(
      client,
      new ListPullRequestsCommand({ repositoryName, pullRequestStatus, nextToken }),
      'ListPullRequests',
      404,
      null,
    );
    if (!res) return null;
    for (const pullRequestId of res.pullRequestIds ?? []) {
      if (lookups >= FIND_PR_MAX_LOOKUPS) {
        logger.warn('CodeCommit pull-request scan truncated', { repositoryName, lookups });
        return null;
      }
      lookups += 1;
      const pr = await getPullRequestRaw(ctx, repoId, pullRequestId);
      const target = prTarget(pr);
      if (
        sameRef(target.sourceReference, sourceBranch) &&
        (targetBranch === null || sameRef(target.destinationReference, targetBranch))
      ) {
        return pr;
      }
    }
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return null;
};

// Merge options for a ref pair. Returns null when CodeCommit cannot compare
// them (missing ref, tips too far apart) so callers can degrade instead of
// failing a whole operation on a comparison.
const mergeOptionsFor = async (ctx, repoId, { source, destination }) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  return call(
    client,
    new GetMergeOptionsCommand({
      repositoryName,
      sourceCommitSpecifier: source,
      destinationCommitSpecifier: destination,
    }),
    'GetMergeOptions',
  );
};

const branchExists = async (ctx, repoId, branch) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const res = await callOr(
    client,
    new GetBranchCommand({ repositoryName, branchName: shortRef(branch) }),
    'GetBranch',
    404,
    null,
  );
  return Boolean(res?.branch);
};

// Compare base...head. `aheadBy` is always null: CodeCommit has no action that
// counts commits between two refs (GetDifferences counts changed FILES), and
// GetCommitsFromMergeBase is an IAM permission rather than a callable action.
const compareBranches = async (ctx, repoId, { base, head }) => {
  const resolvedBase = base || (await getDefaultBranch(ctx, repoId)) || 'main';
  let options;
  try {
    options = await mergeOptionsFor(ctx, repoId, { source: head, destination: resolvedBase });
  } catch (error) {
    const exception = error?.extra?.exception ?? 'UnknownError';
    if (error instanceof ProviderError && error.status === 404) {
      if (!(await branchExists(ctx, repoId, head))) {
        return { status: 'missing_head', base: resolvedBase };
      }
      if (!(await branchExists(ctx, repoId, resolvedBase))) {
        return { status: 'missing_base', base: resolvedBase };
      }
    }
    return { status: 'unknown', base: resolvedBase, detail: exception };
  }

  const { baseCommitId, sourceCommitId, destinationCommitId } = options;
  let status = 'diverged';
  if (sourceCommitId && sourceCommitId === destinationCommitId) {
    status = 'identical';
  } else if (baseCommitId && baseCommitId === destinationCommitId) {
    // The merge base IS the destination tip: head carries commits base lacks.
    status = 'ahead';
  } else if (baseCommitId && baseCommitId === sourceCommitId) {
    status = 'behind';
  }
  return { status, aheadBy: null, base: resolvedBase };
};

// `ancestorSha` must be a commit id: the merge base is compared by SHA, so a
// ref name never matches. Any failure is reported as "not an ancestor", the
// same conservative answer the fetch-based providers give on a failed compare.
const isCommitAncestor = async (ctx, repoId, ancestorSha, descendantRef) => {
  try {
    const options = await mergeOptionsFor(ctx, repoId, {
      source: descendantRef,
      destination: ancestorSha,
    });
    return Boolean(options?.baseCommitId) && options.baseCommitId === ancestorSha;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Construction-task branches
// ---------------------------------------------------------------------------

const constructionBranchPrefix = (branch) => `${HEADS}${branch}--task-`;

const listConstructionTaskBranches = async (ctx, repoId, branch) => {
  const prefix = `${branch}--task-`;
  const branches = await listBranches(ctx, repoId);
  return branches.filter((name) => name.startsWith(prefix));
};

const isBranchMergedInto = async (ctx, repoId, sourceBranch, targetBranch) => {
  const { status } = await compareBranches(ctx, repoId, { base: targetBranch, head: sourceBranch });
  // The source brings nothing the target lacks -> it is contained in target.
  return status === 'identical' || status === 'behind';
};

const getUnmergedConstructionTaskBranches = async (ctx, repoId, branch) => {
  const taskBranches = await listConstructionTaskBranches(ctx, repoId, branch);
  const unmerged = [];
  for (const taskBranch of taskBranches) {
    if (!(await isBranchMergedInto(ctx, repoId, taskBranch, branch))) unmerged.push(taskBranch);
  }
  return unmerged;
};

const cleanupConstructionTaskBranches = async (ctx, repoId, branch) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  let taskBranches;
  try {
    taskBranches = await listConstructionTaskBranches(ctx, repoId, branch);
  } catch (err) {
    logger.error('Failed to list construction task branches', err);
    return { deleted: 0, failed: 1, skipped: 0 };
  }
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const taskBranch of taskBranches) {
    let merged = false;
    try {
      merged = await isBranchMergedInto(ctx, repoId, taskBranch, branch);
    } catch (err) {
      failed += 1;
      logger.error('Failed to check merge status of construction task branch', err);
      continue;
    }
    if (!merged) {
      skipped += 1;
      logger.error('Skipping unmerged construction task branch', { taskBranch });
      continue;
    }
    try {
      await call(
        client,
        new DeleteBranchCommand({ repositoryName, branchName: taskBranch }),
        'DeleteBranch',
      );
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.error('Failed to delete construction task branch', { taskBranch, err });
    }
  }
  if (deleted || failed || skipped) {
    logger.info('Construction task branch cleanup complete', { deleted, failed, skipped });
  }
  return { deleted, failed, skipped };
};

// ---------------------------------------------------------------------------
// PR creation
// ---------------------------------------------------------------------------

// Deterministic idempotency token: a retry of the same (repo, head, base)
// create does not open a second pull request. CodeCommit caps the token at 64
// characters.
const clientRequestTokenFor = (arn, head, base) =>
  `aidlc-${createHash('sha256').update(`${arn}\n${head}\n${base}`).digest('hex').slice(0, 40)}`;

const prSummary = (pr, { region, repositoryName }, extraFields = {}) => ({
  prUrl: pullRequestUrl({ region, repositoryName, pullRequestId: pr.pullRequestId }),
  prNumber: pr.pullRequestId,
  ...extraFields,
});

const draftFields = (pr) => {
  const target = prTarget(pr);
  return {
    providerId: pr.pullRequestId,
    headSha: target.sourceCommit ?? null,
    targetSha: target.destinationCommit ?? null,
    // CodeCommit has no draft concept; a created PR is always ready for review.
    draft: false,
  };
};

// Create a pull request. Mirrors the github return contract:
//   { prUrl, prNumber }                       created
//   { prUrl, prNumber, existing: true }       an open PR already covers it
//   { prUrl, prNumber, retargetedBase }       base was missing, retried on HEAD
//   { skipped: true, reason: 'no_changes' }   head brings nothing
//   { failed: true, reason: 'head_missing' }  the branch was never pushed
//   { conflict: true, unmergedBranches }      construction guard tripped
// `draft` is accepted and ignored beyond echoing draft:false — see capabilities.
const createPullRequest = async (
  ctx,
  repoId,
  { branch, baseBranch, title, body, draft = false },
) => {
  const { arn, region, repositoryName } = parseRepo(repoId);
  const coordinates = { region, repositoryName };
  const client = clientFor(ctx, repoId);

  const unmergedBranches = await getUnmergedConstructionTaskBranches(ctx, repoId, branch);
  if (unmergedBranches.length) {
    return {
      conflict: true,
      error: `Cannot create PR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
      unmergedBranches,
    };
  }

  let resolvedBase = baseBranch || (await getDefaultBranch(ctx, repoId)) || 'main';
  let retargetedBase = null;

  const existing = await findPullRequest(ctx, repoId, {
    sourceBranch: branch,
    targetBranch: resolvedBase,
    state: 'open',
  });
  if (existing) {
    await cleanupConstructionTaskBranches(ctx, repoId, branch);
    return prSummary(existing, coordinates, {
      existing: true,
      ...(draft ? draftFields(existing) : {}),
    });
  }

  // CodeCommit reports "nothing to merge" and "no such ref" as exceptions
  // rather than a structured error, so the branch comparison happens up front:
  // it distinguishes a benign no-change repo from a never-pushed branch, which
  // must never be reported as benign.
  const comparison = await compareBranches(ctx, repoId, { base: resolvedBase, head: branch });
  if (comparison.status === 'missing_head') {
    return {
      failed: true,
      reason: 'head_missing',
      error: `Head branch "${branch}" does not exist on the remote — the intent branch was never pushed`,
    };
  }
  if (comparison.status === 'missing_base') {
    const defaultBranch = await getDefaultBranch(ctx, repoId);
    if (!defaultBranch || defaultBranch === resolvedBase) {
      return {
        failed: true,
        reason: 'base_missing',
        error: `Base branch "${resolvedBase}" does not exist in the repository`,
      };
    }
    resolvedBase = defaultBranch;
    retargetedBase = defaultBranch;
  } else if (comparison.status === 'identical' || comparison.status === 'behind') {
    return { skipped: true, reason: 'no_changes' };
  }

  const res = await call(
    client,
    new CreatePullRequestCommand({
      title,
      description: body,
      clientRequestToken: clientRequestTokenFor(arn ?? repoId, branch, resolvedBase),
      targets: [
        {
          repositoryName,
          sourceReference: `${HEADS}${shortRef(branch)}`,
          destinationReference: `${HEADS}${shortRef(resolvedBase)}`,
        },
      ],
    }),
    'CreatePullRequest',
  );
  const pr = res.pullRequest;
  if (!pr?.pullRequestId) {
    throw new ProviderError(502, 'CodeCommit CreatePullRequest returned no pull request');
  }

  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  return prSummary(pr, coordinates, {
    ...(retargetedBase ? { retargetedBase } : {}),
    ...(draft ? draftFields(pr) : {}),
  });
};

// ---------------------------------------------------------------------------
// PR state
// ---------------------------------------------------------------------------

// CodeCommit has no commit-status or check-run action at all, so "is CI green"
// is unanswerable here (capabilities.checkStatuses === false). The nearest
// server-side gate is approval rules, which this reports separately.
const approvalStateFor = async (ctx, repoId, { pullRequestId, revisionId }) => {
  if (!revisionId) return null;
  const client = clientFor(ctx, repoId);
  try {
    const res = await call(
      client,
      new EvaluatePullRequestApprovalRulesCommand({ pullRequestId, revisionId }),
      'EvaluatePullRequestApprovalRules',
    );
    const evaluation = res.evaluation ?? {};
    return {
      approved: Boolean(evaluation.approved),
      overridden: Boolean(evaluation.overridden),
      rulesSatisfied: evaluation.approvalRulesSatisfied ?? [],
      rulesNotSatisfied: evaluation.approvalRulesNotSatisfied ?? [],
    };
  } catch (err) {
    // A stale revisionId (RevisionNotCurrentException) must not fail a status
    // read — the caller re-reads with the fresh revision.
    logger.warn('CodeCommit approval-rule evaluation unavailable', {
      pullRequestId,
      exception: err?.extra?.exception ?? null,
    });
    return null;
  }
};

const getPullRequestStatus = async (ctx, repoId, prNumber) => {
  const { region, repositoryName } = parseRepo(repoId);
  const pr = await getPullRequestRaw(ctx, repoId, prNumber);
  if (!pr) return null;
  const target = prTarget(pr);
  const open = pr.pullRequestStatus === 'OPEN';
  const merged = Boolean(target.mergeMetadata?.isMerged);
  const activity = iso(pr.lastActivityDate);

  // mergeable is not a field on a CodeCommit pull request; it is derived from
  // whether any merge strategy would currently succeed. Only asked for an open
  // PR — a closed one cannot be merged and the extra call would be wasted.
  let mergeable = null;
  let mergeableState = null;
  if (open) {
    try {
      const options = await mergeOptionsFor(ctx, repoId, {
        source: target.sourceReference,
        destination: target.destinationReference,
      });
      mergeable = (options?.mergeOptions?.length ?? 0) > 0;
      mergeableState = mergeable ? 'clean' : 'dirty';
    } catch {
      mergeable = null;
      mergeableState = 'unknown';
    }
  }

  return {
    providerId: pr.pullRequestId,
    number: pr.pullRequestId,
    url: pullRequestUrl({ region, repositoryName, pullRequestId: pr.pullRequestId }),
    sourceBranch: shortRef(target.sourceReference) || null,
    targetBranch: shortRef(target.destinationReference) || null,
    headSha: target.sourceCommit ?? null,
    targetSha: target.destinationCommit ?? null,
    state: open ? 'open' : merged ? 'merged' : 'closed',
    // Always false: CodeCommit has no draft pull requests.
    draft: false,
    mergeable,
    mergeableState,
    // CodeCommit records no merge/close timestamp of its own; lastActivityDate
    // is the closest thing the API exposes.
    mergedAt: !open && merged ? activity : null,
    closedAt: !open ? activity : null,
    updatedAt: activity,
    title: pr.title ?? '',
    revisionId: pr.revisionId ?? null,
    mergeBase: target.mergeBase ?? null,
    approval: open
      ? await approvalStateFor(ctx, repoId, {
          pullRequestId: pr.pullRequestId,
          revisionId: pr.revisionId,
        })
      : null,
  };
};

const getPullRequestState = async (ctx, repoId, prNumber) => {
  const status = await getPullRequestStatus(ctx, repoId, prNumber);
  return status?.state ?? null;
};

// No-op: CodeCommit has no draft pull requests, so there is no state to change
// and nothing to fail on. Returns the current status so a caller that flips a
// draft flag optimistically still gets a usable status back.
const setPullRequestDraft = async (ctx, repoId, prNumber, _draft) =>
  getPullRequestStatus(ctx, repoId, prNumber);

// UpdatePullRequestStatus documents the only legal transitions as OPEN->OPEN,
// OPEN->CLOSED and CLOSED->CLOSED: closed is terminal, so reopening is not
// merely unimplemented but impossible.
const reopenPullRequest = async () => {
  throw new ProviderError(
    409,
    'CodeCommit pull requests cannot be reopened; open a new pull request',
    { capability: 'reopenPullRequest' },
  );
};

// ---------------------------------------------------------------------------
// PR comments
// ---------------------------------------------------------------------------

// GetCommentsForPullRequest groups comments by the revision pair and location
// they were left against, so `group` supplies the path/line a github review
// comment carries on the comment itself.
const mapComment = (comment, group) => {
  const filePath = group?.location?.filePath ?? null;
  const position = group?.location?.filePosition;
  return {
    id: comment.commentId,
    type: filePath ? 'review' : 'issue',
    body: comment.content ?? '',
    // CodeCommit identifies an author by IAM ARN and has no avatar concept.
    user: { login: comment.authorArn ?? '', avatarUrl: null },
    bot: false,
    system: false,
    path: filePath,
    line: position == null ? null : Number(position),
    createdAt: iso(comment.creationDate),
    updatedAt: iso(comment.lastModifiedDate),
    version: iso(comment.lastModifiedDate) ?? iso(comment.creationDate),
    inReplyTo: comment.inReplyTo ?? null,
  };
};

const COMMENT_PAGES = 20;
// GetCommentsForPullRequest caps maxResults at 500.
const COMMENT_PAGE_SIZE = 500;

const listPRComments = async (ctx, repoId, prNumber) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const comments = [];
  let nextToken;
  for (let page = 0; page < COMMENT_PAGES; page += 1) {
    const res = await callOr(
      client,
      new GetCommentsForPullRequestCommand({
        pullRequestId: String(prNumber),
        repositoryName,
        maxResults: COMMENT_PAGE_SIZE,
        nextToken,
      }),
      'GetCommentsForPullRequest',
      404,
      null,
    );
    if (!res) return [];
    for (const group of res.commentsForPullRequestData ?? []) {
      for (const comment of group.comments ?? []) {
        // A deleted comment keeps its id but loses its content; surfacing it as
        // empty feedback would be noise.
        if (comment?.deleted) continue;
        comments.push(mapComment(comment, group));
      }
    }
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return comments.toSorted(
    (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
  );
};

// PostCommentForPullRequest REQUIRES the revision pair (beforeCommitId /
// afterCommitId), which only GetPullRequest can supply — hence two calls.
// `inReplyTo` routes to PostCommentReply instead, which threads onto an
// existing comment and needs no location.
const addPRComment = async (ctx, repoId, prNumber, { body, path, line, side, inReplyTo } = {}) => {
  const { repositoryName } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);

  if (inReplyTo) {
    const reply = await call(
      client,
      new PostCommentReplyCommand({ inReplyTo, content: body }),
      'PostCommentReply',
    );
    const comment = reply.comment ?? {};
    return {
      id: comment.commentId ?? null,
      body: comment.content ?? body,
      user: { login: comment.authorArn ?? '', avatarUrl: null },
      url: null,
      createdAt: iso(comment.creationDate),
    };
  }

  const pr = await getPullRequestRaw(ctx, repoId, prNumber);
  if (!pr) throw new ProviderError(404, 'CodeCommit pull request not found');
  const target = prTarget(pr);
  const beforeCommitId = target.destinationCommit;
  const afterCommitId = target.sourceCommit;
  if (!beforeCommitId || !afterCommitId) {
    throw new ProviderError(400, 'Could not determine the pull request revision commits');
  }

  const res = await call(
    client,
    new PostCommentForPullRequestCommand({
      pullRequestId: String(prNumber),
      repositoryName,
      beforeCommitId,
      afterCommitId,
      content: body,
      // Omitting `location` posts a general (non-file) comment.
      ...(path && line
        ? {
            location: {
              filePath: path,
              filePosition: Number(line),
              relativeFileVersion: side === 'LEFT' ? 'BEFORE' : 'AFTER',
            },
          }
        : {}),
    }),
    'PostCommentForPullRequest',
  );
  const comment = res.comment ?? {};
  return {
    id: comment.commentId ?? null,
    body: comment.content ?? body,
    user: { login: comment.authorArn ?? '', avatarUrl: null },
    url: null,
    createdAt: iso(comment.creationDate),
  };
};

// ---------------------------------------------------------------------------
// Server-side merge
// ---------------------------------------------------------------------------

const DEFAULT_AUTHOR_NAME = 'Collaborative AI-DLC';
const defaultAuthorEmail = (accountId) => `aidlc-bot@${accountId || 'codecommit'}.invalid`;

// Merge a task branch into the sprint branch. Returns 'merged' | 'conflict' |
// { error }, like the other providers.
//
// Two CodeCommit specifics: the commit author cannot be discovered (no identity
// action), so it is configured on ctx or defaulted; and the branches API is not
// the pull-request API — MergeBranchesByThreeWay moves the ref but leaves any
// open PR OPEN, which matches the other providers' merge-a-branch semantics.
const mergeBranch = async (ctx, repoId, { base, head, message }) => {
  const { repositoryName, accountId } = parseRepo(repoId);
  const client = clientFor(ctx, repoId);
  const command = new MergeBranchesByThreeWayCommand({
    repositoryName,
    sourceCommitSpecifier: shortRef(head),
    destinationCommitSpecifier: shortRef(base),
    targetBranch: shortRef(base),
    commitMessage: message || `Merge ${head} into ${base} (auto)`,
    authorName: ctx?.committerName || DEFAULT_AUTHOR_NAME,
    email: ctx?.committerEmail || defaultAuthorEmail(accountId),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await call(client, command, 'MergeBranchesByThreeWay');
      return 'merged';
    } catch (error) {
      const exception = error?.extra?.exception ?? error?.name ?? 'UnknownError';
      if (exception === 'ManualMergeRequiredException') return 'conflict';
      // Someone else moved the destination ref between read and write; one
      // retry is enough to distinguish a race from a persistent failure.
      if (exception === 'ConcurrentReferenceUpdateException' && attempt === 0) {
        logger.warn('Retrying CodeCommit merge after concurrent reference update', {
          repositoryName,
          base,
          head,
        });
        continue;
      }
      return { error: `CodeCommit MergeBranchesByThreeWay failed: ${exception}` };
    }
  }
  return { error: 'CodeCommit MergeBranchesByThreeWay failed: ConcurrentReferenceUpdateException' };
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

// Declared contract gaps, so a caller can branch BEFORE it calls a method that
// can only throw. `events: 'eventbridge'` says change notification arrives as
// in-account EventBridge events (source `aws.codecommit`), not an HTTP webhook.
const capabilities = Object.freeze({
  issues: false,
  draftPullRequests: false,
  reopenPullRequest: false,
  checkStatuses: false,
  approvalRules: true,
  events: 'eventbridge',
});

export {
  id,
  displayName,
  gitHost,
  gitHostFor,
  apiBase,
  apiBaseFor,
  buildCloneUrl,
  splitOwnerRepo,
  pullRequestUrl,
  capabilities,
  mapRepo,
  listRepos,
  listBranches,
  getDefaultBranch,
  getRepositoryAccess,
  getTree,
  getFileContents,
  listIssues,
  getIssue,
  listIssueComments,
  addIssueComment,
  closeIssue,
  listPRComments,
  addPRComment,
  getUnmergedConstructionTaskBranches,
  cleanupConstructionTaskBranches,
  findPullRequest,
  createPullRequest,
  compareBranches,
  getPullRequestState,
  getPullRequestStatus,
  setPullRequestDraft,
  reopenPullRequest,
  isCommitAncestor,
  mergeBranch,
  constructionBranchPrefix,
};
export default {
  id,
  displayName,
  gitHost,
  gitHostFor,
  apiBase,
  apiBaseFor,
  buildCloneUrl,
  splitOwnerRepo,
  pullRequestUrl,
  capabilities,
  mapRepo,
  listRepos,
  listBranches,
  getDefaultBranch,
  getRepositoryAccess,
  getTree,
  getFileContents,
  listIssues,
  getIssue,
  listIssueComments,
  addIssueComment,
  closeIssue,
  listPRComments,
  addPRComment,
  getUnmergedConstructionTaskBranches,
  cleanupConstructionTaskBranches,
  findPullRequest,
  createPullRequest,
  compareBranches,
  getPullRequestState,
  getPullRequestStatus,
  setPullRequestDraft,
  reopenPullRequest,
  isCommitAncestor,
  mergeBranch,
  constructionBranchPrefix,
};
