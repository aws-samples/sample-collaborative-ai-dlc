// GitHub provider — encapsulates every GitHub.com-specific detail behind the
// uniform git-provider contract (see ./index.js for the contract docs).
//
// Pure of AWS SDK: callers pass an already-resolved access token. OAuth-secret
// and SSM-token plumbing live in the handler/shared layers; this module only
// knows how to talk to GitHub once it has a token.

import { ProviderError } from './errors.js';

const API_BASE = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Identity / git plumbing
// ---------------------------------------------------------------------------

const id = 'github';
const displayName = 'GitHub';
const gitHost = 'github.com';

// Repo reference for GitHub is the canonical "owner/repo" fullName. The clone
// URL embeds the token via the x-access-token scheme.
const buildCloneUrl = (repoId, token) => {
  const auth = token ? `x-access-token:${token}@` : '';
  return `https://${auth}${gitHost}/${repoId}.git`;
};

const splitOwnerRepo = (repoId) => {
  if (!repoId || typeof repoId !== 'string') {
    throw new ProviderError(400, 'Invalid repository reference for GitHub');
  }
  const parts = repoId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(400, `Invalid gitRepo "${repoId}": expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const apiHeaders = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  ...extra,
});

// ctx = { token, fetchImpl }. GitHub has no token-refresh, so fetch is a thin
// wrapper that keeps the same signature as the GitLab provider's gitFetch.
const ghFetch = (ctx, url, options = {}) =>
  (ctx.fetchImpl || fetch)(url, {
    ...options,
    headers: { ...apiHeaders(ctx.token), ...options.headers },
  });

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const oauth = {
  secretEnvName: 'GITHUB_OAUTH_SECRET_NAME',
  redirectUriEnvName: 'GITHUB_REDIRECT_URI',
  scopes: 'repo workflow read:user',
  requiredConnectionScopes: ['repo', 'workflow', 'read:user'],

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    return `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&scope=${encodeURIComponent(oauth.scopes)}&state=${encodeURIComponent(state)}`;
  },

  async exchangeCode({ clientId, clientSecret, code, fetchImpl = fetch }) {
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const data = await res.json();
    if (data.error) {
      throw new ProviderError(400, data.error_description || data.error);
    }
    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope,
    };
  },
  // No refreshToken — GitHub OAuth App tokens do not expire.
};

// ---------------------------------------------------------------------------
// Authenticated user (commit attribution)
// ---------------------------------------------------------------------------

// The identity behind an OAuth token — used to attribute engine commits to the
// user ("on behalf of": author = user, committer = AI-DLC Engine). The OAuth
// scope (`read:user`) covers GET /user but NOT /user/emails, so when the user
// has no PUBLIC email we fall back to the GitHub noreply address
// (<id>+<login>@users.noreply.github.com) — which GitHub always links to the
// account and which respects "block pushes that expose my email".
const getAuthenticatedUser = async (ctx) => {
  const res = await ghFetch(ctx, `${API_BASE}/user`);
  const data = await res.json();
  if (!res.ok || !data?.login) {
    throw new ProviderError(res.status || 400, data?.message || 'Failed to fetch user');
  }
  return {
    login: data.login,
    authorName: data.name || data.login,
    authorEmail: data.email || `${data.id}+${data.login}@users.noreply.github.com`,
  };
};

// ---------------------------------------------------------------------------
// Repo browse
// ---------------------------------------------------------------------------

const mapRepo = (r) => ({
  id: r.id,
  name: r.name,
  fullName: r.full_name,
  private: r.private,
  defaultBranch: r.default_branch,
});

const listRepos = async (ctx) => {
  const res = await ghFetch(ctx, `${API_BASE}/user/repos?per_page=100&sort=updated`);
  const repos = await res.json();
  if (!Array.isArray(repos)) {
    throw new ProviderError(400, repos.message || 'Failed to fetch repos');
  }
  return repos.map(mapRepo);
};

// App-mode repo discovery: the repos the GitHub App installation can access
// (GET /installation/repositories — requires an installation token, not a
// user token). Replaces /user/repos in the picker when the platform auth mode
// is 'app': installation scoping IS the allowlist.
const listInstallationRepos = async (ctx) => {
  const repos = [];
  let page = 1;
  // Defensive page cap — an installation with >1000 repos gets truncated
  // rather than looping forever on a misbehaving mock/endpoint.
  while (page <= 10) {
    const res = await ghFetch(
      ctx,
      `${API_BASE}/installation/repositories?per_page=100&page=${page}`,
    );
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.repositories)) {
      throw new ProviderError(400, data.message || 'Failed to fetch installation repos');
    }
    repos.push(...data.repositories.map(mapRepo));
    if (data.repositories.length < 100) break;
    page += 1;
  }
  return repos;
};

const listBranches = async (ctx, repoId) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/branches?per_page=100`);
  if (res.status === 404) return [];
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new ProviderError(400, data.message || 'Failed to fetch branches');
  }
  return data.map((b) => b.name);
};

// The repo's real default branch (`main`, `master`, or whatever HEAD points at).
// Needed because init-ws `git clone` checks out the repo's actual default HEAD
// regardless of the intent's configured `baseBranch`, so a repo without a `main`
// branch still clones fine — but a PR targeting `base: 'main'` then 422s. Returns
// null if the repo can't be read (caller falls back to its configured base).
const getDefaultBranch = async (ctx, repoId) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.default_branch ?? null;
};

const getRepositoryAccess = async (ctx, repoId) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status || 400, data?.message || 'Failed to access repository');
  }
  return {
    defaultBranch: data.default_branch ?? null,
    private: Boolean(data.private),
    permissions: data.permissions ?? {},
    canRead: data.permissions?.pull !== false,
    canWrite: Boolean(data.permissions?.push || data.permissions?.admin),
  };
};

const getTree = async (ctx, repoId, branch = 'main') => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
  );
  const data = await res.json();
  if (data.message) throw new ProviderError(400, data.message);
  return (data.tree || [])
    .filter((item) => item.type === 'blob')
    .map((item) => ({ path: item.path, sha: item.sha, size: item.size }));
};

const getFileContents = async (ctx, repoId, filePath, branch = 'main') => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
  );
  const data = await res.json();
  if (data.message) throw new ProviderError(400, data.message);
  return {
    path: data.path,
    sha: data.sha,
    size: data.size,
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
  };
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

const mapIssue = (issue) => ({
  resourceId: String(issue.number),
  resourceUrl: issue.html_url,
  resourceType: 'issue',
  entityType: null,
  entityIconUrl: null,
  title: issue.title,
  body: issue.body ?? null,
  state: issue.state === 'closed' ? 'closed' : 'open',
  labels: Array.isArray(issue.labels)
    ? issue.labels.map((label) => ({ name: label.name, color: label.color }))
    : [],
  author: {
    handle: issue.user?.login || '',
    avatarUrl: issue.user?.avatar_url || '',
  },
  createdAt: issue.created_at,
  updatedAt: issue.updated_at,
});

const mapIssueDiscussionComment = (comment) => ({
  id: String(comment.id),
  author: {
    handle: comment.user?.login || '',
    avatarUrl: comment.user?.avatar_url || '',
  },
  body: comment.body ?? '',
  createdAt: comment.created_at,
  updatedAt: comment.updated_at,
});

const issuePageSize = (raw) => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 30;
};

const issuePageNumber = (raw) => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const linkRelations = (header) => {
  const relations = {};
  for (const part of String(header || '').split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) relations[match[2]] = match[1];
  }
  return relations;
};

const listIssues = async (ctx, repoId, options = {}) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const state = ['open', 'closed', 'all'].includes(options.state) ? options.state : 'open';
  const page = issuePageNumber(options.page);
  const perPage = issuePageSize(options.perPage);
  const query = String(options.q || '').trim();
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  let url;
  let search = false;
  if (query) {
    search = true;
    params.set('q', `repo:${owner}/${repo} state:${state} is:issue ${query}`);
    url = `${API_BASE}/search/issues?${params.toString()}`;
  } else {
    params.set('state', state);
    url = `${API_BASE}/repos/${owner}/${repo}/issues?${params.toString()}`;
  }
  const res = await ghFetch(ctx, url);
  if (res.status === 404) {
    return { items: [], page, perPage, hasNext: false, hasPrev: false, totalCount: null };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to fetch issues');
  }
  const rawItems = search ? data.items : data;
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .filter((issue) => !issue.pull_request)
    .map(mapIssue);
  const links = linkRelations(res.headers?.get?.('link'));
  return {
    items,
    page,
    perPage,
    hasNext: Boolean(links.next),
    hasPrev: Boolean(links.prev),
    totalCount: search && Number.isFinite(data.total_count) ? data.total_count : null,
  };
};

const getIssue = async (ctx, repoId, issueNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.pull_request) {
    throw new ProviderError(
      res.status || 404,
      data?.message || (data?.pull_request ? 'Not found' : 'Failed to fetch issue'),
    );
  }
  return mapIssue(data);
};

const listIssueComments = async (ctx, repoId, issueNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
  );
  if (res.status === 404) return [];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to fetch issue comments');
  }
  return Array.isArray(data) ? data.map(mapIssueDiscussionComment) : [];
};

const addIssueComment = async (ctx, repoId, issueNumber, body) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to add issue comment');
  }
  return mapIssueDiscussionComment(data);
};

// ---------------------------------------------------------------------------
// PR comments
// ---------------------------------------------------------------------------

const mapReviewComment = (c) => ({
  id: c.id,
  type: 'review',
  body: c.body,
  user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
  bot: c.user?.type === 'Bot' || String(c.user?.login ?? '').endsWith('[bot]'),
  system: false,
  path: c.path || null,
  line: c.line || c.original_line || null,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  version: c.updated_at || c.created_at,
});

const mapIssueComment = (c) => ({
  id: c.id,
  type: 'issue',
  body: c.body,
  user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
  bot: c.user?.type === 'Bot' || String(c.user?.login ?? '').endsWith('[bot]'),
  system: false,
  path: null,
  line: null,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  version: c.updated_at || c.created_at,
});

const listPaginated = async (ctx, url) => {
  const rows = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    const res = await ghFetch(ctx, `${url}${separator}per_page=100&page=${page}`);
    const data = await res.json();
    if (!res.ok) {
      throw new ProviderError(res.status || 400, data?.message || 'Failed to list comments');
    }
    if (!Array.isArray(data)) break;
    rows.push(...data);
    if (data.length < 100) break;
  }
  return rows;
};

const listPRComments = async (ctx, repoId, prNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const [reviewComments, issueComments] = await Promise.all([
    listPaginated(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments`),
    listPaginated(ctx, `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`),
  ]);
  return [...reviewComments.map(mapReviewComment), ...issueComments.map(mapIssueComment)].toSorted(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
};

const addPRComment = async (ctx, repoId, prNumber, { body, path, line, side }) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  let result;
  if (path && line) {
    const prRes = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`);
    const prData = await prRes.json();
    const commitId = prData.head?.sha;
    if (!commitId) throw new ProviderError(400, 'Could not determine commit SHA');
    const commentRes = await ghFetch(
      ctx,
      `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, commit_id: commitId, path, line, side: side || 'RIGHT' }),
      },
    );
    result = await commentRes.json();
  } else {
    const commentRes = await ghFetch(
      ctx,
      `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    result = await commentRes.json();
  }
  if (result.message) throw new ProviderError(400, result.message);
  return {
    id: result.id,
    body: result.body,
    user: { login: result.user?.login, avatarUrl: result.user?.avatar_url },
    url: result.html_url || null,
    createdAt: result.created_at,
  };
};

// ---------------------------------------------------------------------------
// PR creation + construction-task-branch helpers (used by the v2 orchestrator)
// and PR-state / server-side merge.
//
// These methods take a plain { token, fetchImpl? } ctx and operate via the
// GitHub REST API. The construction-task-branch guard is GitHub-specific (it
// relies on the git/matching-refs + compare endpoints).
// ---------------------------------------------------------------------------

const encodeRefPath = (ref) => ref.split('/').map(encodeURIComponent).join('/');

const constructionBranchPrefix = (branch) => `refs/heads/${branch}--task-`;

const branchNameFromRef = (refName) => refName.replace(/^refs\/heads\//, '');

const listConstructionTaskRefs = async (ctx, repoId, branch) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const refPrefix = constructionBranchPrefix(branch);
  const matchingRefsPath = encodeRefPath(`heads/${branch}--task-`);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/git/matching-refs/${matchingRefsPath}`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to list construction task branches: ${errorText}`);
  }
  const refs = await res.json();
  return refs.filter((ref) => ref?.ref?.startsWith(refPrefix));
};

const isBranchMergedInto = async (ctx, repoId, sourceBranch, targetBranch) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(
      sourceBranch,
    )}...${encodeURIComponent(targetBranch)}`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to compare ${sourceBranch} against ${targetBranch}: ${errorText}`);
  }
  const comparison = await res.json();
  return comparison.status === 'identical' || comparison.status === 'ahead';
};

const getUnmergedConstructionTaskBranches = async (ctx, repoId, branch) => {
  const refs = await listConstructionTaskRefs(ctx, repoId, branch);
  const unmerged = [];
  for (const ref of refs) {
    const taskBranch = branchNameFromRef(ref.ref);
    const merged = await isBranchMergedInto(ctx, repoId, taskBranch, branch);
    if (!merged) unmerged.push(taskBranch);
  }
  return unmerged;
};

const cleanupConstructionTaskBranches = async (ctx, repoId, branch) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  let refs;
  try {
    refs = await listConstructionTaskRefs(ctx, repoId, branch);
  } catch (err) {
    console.error(err.message);
    return { deleted: 0, failed: 1, skipped: 0 };
  }
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const ref of refs) {
    const refName = ref.ref;
    const taskBranch = branchNameFromRef(refName);
    let merged = false;
    try {
      merged = await isBranchMergedInto(ctx, repoId, taskBranch, branch);
    } catch (err) {
      failed += 1;
      console.error(err.message);
      continue;
    }
    if (!merged) {
      skipped += 1;
      console.error(`Skipping unmerged construction task branch ${taskBranch}`);
      continue;
    }
    const deletePath = encodeRefPath(refName.replace(/^refs\//, ''));
    const deleteRes = await ghFetch(
      ctx,
      `${API_BASE}/repos/${owner}/${repo}/git/refs/${deletePath}`,
      { method: 'DELETE' },
    );
    if (deleteRes.ok) {
      deleted += 1;
    } else {
      failed += 1;
      const errorText = await deleteRes.text();
      console.error(`Failed to delete construction task branch ${refName}:`, errorText);
    }
  }
  if (deleted || failed || skipped) {
    console.log(
      `Construction task branch cleanup complete: deleted=${deleted}, failed=${failed}, skipped=${skipped}`,
    );
  }
  return { deleted, failed, skipped };
};

// A 422 from POST /pulls is benign ONLY when the branches genuinely hold no
// commits between them (normal in multi-repo projects). "Head does not exist"
// used to be classified here too — that conflation masked the 2026-07 lost-work
// incident (a never-pushed intent branch reported as benign "no changes"), so
// missing-head is now its own NON-benign classification below.
const isNoChanges422 = (errorText) =>
  (errorText || '').toLowerCase().includes('no commits between');

// A 422 whose cause is a head branch that does not exist on the remote — the
// intent branch was never pushed. This is a FAILURE (work may be stranded on
// the session workspace), never a benign skip.
const isMissingHead422 = (errorText) => {
  const text = (errorText || '').toLowerCase();
  if (/head sha can't be blank|head ref.*(does not|doesn't) exist/.test(text)) return true;
  try {
    const errors = Array.isArray(JSON.parse(errorText)?.errors) ? JSON.parse(errorText).errors : [];
    return errors.some((e) => e?.field === 'head' && e?.code === 'invalid');
  } catch {
    return false;
  }
};

// A 422 with `field: base, code: invalid` means the base branch we asked to
// merge into does not exist in the repo (e.g. the repo's default is `master`, or
// some `ai-dlc/...` scaffold branch, and we defaulted to `main`). Distinct from
// the benign no-changes 422 — this one is recoverable by retargeting the PR at
// the repo's real default branch.
const isBaseInvalid422 = (errorText) => {
  try {
    const errors = Array.isArray(JSON.parse(errorText)?.errors) ? JSON.parse(errorText).errors : [];
    return errors.some((e) => e?.field === 'base' && e?.code === 'invalid');
  } catch {
    return false;
  }
};

// GitHub's REST `id` is a numeric database identifier, while GraphQL
// mutations require the opaque `node_id`. Keep the provider contract on the
// GraphQL-safe identity and retain `id` only for reduced test/API payloads.
const pullRequestProviderId = (pr) => pr?.node_id ?? pr?.id ?? null;

// Find an existing PR for a branch. Tries the owner-qualified head filter first,
// then falls back to listing PRs and matching on head.ref (fork/org mismatch).
const findPullRequest = async (
  ctx,
  repoId,
  { sourceBranch, targetBranch = null, state = 'open' },
) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const headRes = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(
      sourceBranch,
    )}&state=${state}&per_page=100`,
  );
  if (headRes.ok) {
    const headPrs = await headRes.json();
    const match = Array.isArray(headPrs)
      ? headPrs.find(
          (pr) =>
            pr.head?.ref === sourceBranch &&
            (targetBranch === null || pr.base?.ref === targetBranch),
        )
      : null;
    if (match) return match;
  }
  for (let page = 1; page <= 10; page += 1) {
    const listRes = await ghFetch(
      ctx,
      `${API_BASE}/repos/${owner}/${repo}/pulls?state=${state}&per_page=100&page=${page}`,
    );
    if (!listRes.ok) break;
    const prs = await listRes.json();
    const match = Array.isArray(prs)
      ? prs.find(
          (pr) =>
            pr.head?.ref === sourceBranch &&
            (targetBranch === null || pr.base?.ref === targetBranch),
        )
      : null;
    if (match) return match;
    if (!Array.isArray(prs) || prs.length < 100) break;
  }
  return null;
};

// Create a PR. Enforces the unmerged-construction-task-branch guard. Returns
// { prUrl, prNumber } on success, { skipped, reason } for a no-change repo,
// { unmergedBranches } (409-equivalent) when task branches remain unmerged.
const createPullRequest = async (
  ctx,
  repoId,
  { branch, baseBranch, title, body, draft = false },
) => {
  const { owner, repo } = splitOwnerRepo(repoId);

  const unmergedBranches = await getUnmergedConstructionTaskBranches(ctx, repoId, branch);
  if (unmergedBranches.length) {
    return {
      conflict: true,
      error: `Cannot create PR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
      unmergedBranches,
    };
  }

  const postPr = (base) =>
    ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, head: branch, base, draft }),
    });

  // No explicit base (project-wide legacy default, or a repo the caller left
  // unset in a per-repo baseBranches map) — resolve the repo's REAL default
  // branch rather than assuming `main` (a repo whose default is `master`/
  // `develop`/… must not 422 here just because the caller didn't specify one).
  const resolvedBase = baseBranch || (await getDefaultBranch(ctx, repoId)) || 'main';
  let res = await postPr(resolvedBase);

  if (!res.ok) {
    let errorText = await res.text();
    if (res.status === 422) {
      const openPr = await findPullRequest(ctx, repoId, {
        sourceBranch: branch,
        targetBranch: resolvedBase,
        state: 'open',
      });
      if (openPr) {
        await cleanupConstructionTaskBranches(ctx, repoId, branch);
        return {
          prUrl: openPr.html_url,
          prNumber: openPr.number,
          existing: true,
          ...(draft
            ? {
                providerId: pullRequestProviderId(openPr),
                headSha: openPr.head?.sha ?? null,
                targetSha: openPr.base?.sha ?? null,
                draft: Boolean(openPr.draft),
              }
            : {}),
        };
      }
      if (isNoChanges422(errorText)) {
        return { skipped: true, reason: 'no_changes' };
      }
      if (isMissingHead422(errorText)) {
        return {
          failed: true,
          reason: 'head_missing',
          error: `Head branch "${branch}" does not exist on the remote — the intent branch was never pushed`,
        };
      }
      // The base branch we asked for does not exist (e.g. a caller-supplied
      // base was mistyped or deleted since). Resolve the repo's real default
      // branch and retry once against it — the intent branch was cut from
      // that HEAD at clone time, so it is a reasonable merge target.
      if (isBaseInvalid422(errorText)) {
        const defaultBranch = await getDefaultBranch(ctx, repoId);
        if (defaultBranch && defaultBranch !== resolvedBase) {
          res = await postPr(defaultBranch);
          if (res.ok) {
            const pr = await res.json();
            await cleanupConstructionTaskBranches(ctx, repoId, branch);
            return {
              prUrl: pr.html_url,
              prNumber: pr.number,
              retargetedBase: defaultBranch,
              ...(draft
                ? {
                    providerId: pullRequestProviderId(pr),
                    headSha: pr.head?.sha ?? null,
                    targetSha: pr.base?.sha ?? null,
                    draft: Boolean(pr.draft),
                  }
                : {}),
            };
          }
          errorText = await res.text();
        }
      }
    }
    throw new Error(`Failed to create PR: ${res.status} ${errorText}`); // nosemgrep: tainted-sql-string
  }

  const pr = await res.json();
  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
    ...(draft
      ? {
          providerId: pullRequestProviderId(pr),
          headSha: pr.head?.sha ?? null,
          targetSha: pr.base?.sha ?? null,
          draft: Boolean(pr.draft),
        }
      : {}),
  };
};

// Compare base...head — the PR fan-in's pre-check that the intent branch
// actually exists and carries commits (the 2026-07 incident finished a run
// whose branch was identical to base and reported it as a benign skip).
// Returns { status, aheadBy?, base }:
//   'ahead' | 'diverged'  — head has commits base lacks (a PR is meaningful)
//   'identical'|'behind'  — head brings nothing (PR would 422 "no commits")
//   'missing_head'        — head branch does not exist on the remote
//   'missing_base'        — base branch does not exist
//   'unknown'             — comparison unavailable (caller falls through to
//                           the POST /pulls behavior; never blocks on this)
const compareBranches = async (ctx, repoId, { base, head }) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const resolvedBase = base || (await getDefaultBranch(ctx, repoId)) || 'main';
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/compare/${resolvedBase}...${head}`,
  );
  if (res.status === 404) {
    // Which side is missing? Probe the head ref (slashes are legal in the
    // git/ref path). A readable head means the BASE side caused the 404.
    const headRes = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${head}`);
    if (headRes.status === 404) return { status: 'missing_head', base: resolvedBase };
    if (headRes.ok) return { status: 'missing_base', base: resolvedBase };
    return { status: 'unknown', base: resolvedBase, detail: `head probe ${headRes.status}` };
  }
  if (!res.ok) {
    return { status: 'unknown', base: resolvedBase, detail: `compare ${res.status}` };
  }
  const data = await res.json();
  const known = ['ahead', 'behind', 'identical', 'diverged'];
  return {
    status: known.includes(data.status) ? data.status : 'unknown',
    aheadBy: data.ahead_by ?? 0,
    base: resolvedBase,
  };
};

// Get the live state of a PR ('open' | 'closed' | 'merged' | null if not found).
const getPullRequestState = async (ctx, repoId, prNumber) => {
  const status = await getPullRequestStatus(ctx, repoId, prNumber);
  return status?.state ?? null;
};

const getPullRequestStatus = async (ctx, repoId, prNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (!res.ok) return null;
  const pr = await res.json();
  return {
    providerId: pullRequestProviderId(pr),
    number: pr.number,
    url: pr.html_url,
    sourceBranch: pr.head?.ref ?? null,
    targetBranch: pr.base?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    targetSha: pr.base?.sha ?? null,
    state: pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed',
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at ?? null,
    updatedAt: pr.updated_at ?? null,
  };
};

const setPullRequestDraft = async (ctx, repoId, prNumber, draft) => {
  splitOwnerRepo(repoId);
  const current = await getPullRequestStatus(ctx, repoId, prNumber);
  if (!current || current.state !== 'open') return current;
  if (current.draft === draft) return current;
  const operation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
  const mutation = `mutation($id:ID!){${operation}(input:{pullRequestId:$id}){pullRequest{id}}}`;
  const res = await ghFetch(ctx, `${API_BASE}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { id: current.providerId } }),
  });
  const data = await res.json();
  if (!res.ok || data?.errors?.length) {
    throw new ProviderError(
      res.status || 400,
      data?.errors?.[0]?.message ||
        (draft ? 'Failed to convert PR to draft' : 'Failed to mark PR ready'),
    );
  }
  return getPullRequestStatus(ctx, repoId, prNumber);
};

const reopenPullRequest = async (ctx, repoId, prNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'open' }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to reopen pull request');
  }
  return getPullRequestStatus(ctx, repoId, prNumber);
};

const isCommitAncestor = async (ctx, repoId, ancestorSha, descendantRef) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(
      ancestorSha,
    )}...${encodeURIComponent(descendantRef)}`,
  );
  if (!res.ok) return false;
  const data = await res.json();
  return data.status === 'ahead' || data.status === 'identical';
};

// Server-side merge of a task branch into the sprint branch (used to reconcile
// unmerged task branches in non-primary repos). Returns 'merged' | 'conflict'
// | { error }.
const mergeBranch = async (ctx, repoId, { base, head, message }) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  let res;
  try {
    res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base,
        head,
        commit_message: message || `Merge ${head} into ${base} (auto)`,
      }),
    });
  } catch (e) {
    return { error: e.message };
  }
  if (res.status === 201 || res.status === 204) return 'merged';
  if (res.status === 409) return 'conflict';
  const text = await res.text().catch(() => '');
  return { error: `GitHub merges API returned ${res.status}: ${text.slice(0, 300)}` };
};

const apiBase = API_BASE;
export {
  id,
  displayName,
  gitHost,
  apiBase,
  buildCloneUrl,
  splitOwnerRepo,
  apiHeaders,
  ghFetch,
  oauth,
  getAuthenticatedUser,
  mapRepo,
  listRepos,
  listInstallationRepos,
  listBranches,
  getDefaultBranch,
  getRepositoryAccess,
  getTree,
  getFileContents,
  listIssues,
  getIssue,
  listIssueComments,
  addIssueComment,
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
  apiBase,
  buildCloneUrl,
  splitOwnerRepo,
  apiHeaders,
  ghFetch,
  oauth,
  getAuthenticatedUser,
  mapRepo,
  listRepos,
  listInstallationRepos,
  listBranches,
  getDefaultBranch,
  getRepositoryAccess,
  getTree,
  getFileContents,
  listIssues,
  getIssue,
  listIssueComments,
  addIssueComment,
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
