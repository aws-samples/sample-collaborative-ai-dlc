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
  scopes: 'repo read:user',

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
// PR comments
// ---------------------------------------------------------------------------

const mapReviewComment = (c) => ({
  id: c.id,
  type: 'review',
  body: c.body,
  user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
  path: c.path || null,
  line: c.line || c.original_line || null,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const mapIssueComment = (c) => ({
  id: c.id,
  type: 'issue',
  body: c.body,
  user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
  path: null,
  line: null,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const listPRComments = async (ctx, repoId, prNumber) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const [reviewRes, issueRes] = await Promise.all([
    ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments`),
    ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`),
  ]);
  const reviewComments = await reviewRes.json();
  const issueComments = await issueRes.json();
  return [
    ...(Array.isArray(reviewComments) ? reviewComments.map(mapReviewComment) : []),
    ...(Array.isArray(issueComments) ? issueComments.map(mapIssueComment) : []),
  ].toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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

// Find an existing PR for a branch. Tries the owner-qualified head filter first,
// then falls back to listing PRs and matching on head.ref (fork/org mismatch).
const findPRByBranch = async (ctx, repoId, branch, state) => {
  const { owner, repo } = splitOwnerRepo(repoId);
  const headRes = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=${state}`,
  );
  if (headRes.ok) {
    const headPrs = await headRes.json();
    if (headPrs.length > 0) return headPrs[0];
  }
  const listRes = await ghFetch(
    ctx,
    `${API_BASE}/repos/${owner}/${repo}/pulls?state=${state}&per_page=100`,
  );
  if (listRes.ok) {
    const prs = await listRes.json();
    const match = prs.find((p) => p.head?.ref === branch);
    if (match) return match;
  }
  return null;
};

// Create a PR. Enforces the unmerged-construction-task-branch guard. Returns
// { prUrl, prNumber } on success, { skipped, reason } for a no-change repo,
// { unmergedBranches } (409-equivalent) when task branches remain unmerged.
const createPullRequest = async (ctx, repoId, { branch, baseBranch, title, body }) => {
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
      body: JSON.stringify({ title, body, head: branch, base }),
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
      const openPr = await findPRByBranch(ctx, repoId, branch, 'open');
      if (openPr) {
        await cleanupConstructionTaskBranches(ctx, repoId, branch);
        return { prUrl: openPr.html_url, prNumber: openPr.number, existing: true };
      }
      const anyPr = await findPRByBranch(ctx, repoId, branch, 'all');
      if (anyPr) {
        await cleanupConstructionTaskBranches(ctx, repoId, branch);
        return { prUrl: anyPr.html_url, prNumber: anyPr.number, existing: true };
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
            return { prUrl: pr.html_url, prNumber: pr.number, retargetedBase: defaultBranch };
          }
          errorText = await res.text();
        }
      }
    }
    throw new Error(`Failed to create PR: ${res.status} ${errorText}`); // nosemgrep: tainted-sql-string
  }

  const pr = await res.json();
  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  return { prUrl: pr.html_url, prNumber: pr.number };
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
  const { owner, repo } = splitOwnerRepo(repoId);
  const res = await ghFetch(ctx, `${API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (!res.ok) return null;
  const pr = await res.json();
  if (pr.state === 'open') return 'open';
  return pr.merged_at ? 'merged' : 'closed';
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
  getTree,
  getFileContents,
  listPRComments,
  addPRComment,
  getUnmergedConstructionTaskBranches,
  cleanupConstructionTaskBranches,
  createPullRequest,
  compareBranches,
  getPullRequestState,
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
  getTree,
  getFileContents,
  listPRComments,
  addPRComment,
  getUnmergedConstructionTaskBranches,
  cleanupConstructionTaskBranches,
  createPullRequest,
  compareBranches,
  getPullRequestState,
  mergeBranch,
  constructionBranchPrefix,
};
