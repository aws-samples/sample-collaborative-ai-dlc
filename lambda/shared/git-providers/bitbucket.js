// Bitbucket provider — encapsulates every Bitbucket Cloud-specific detail behind the
// uniform git-provider contract (see ../git-providers.js for the contract docs).
//
// Pure of AWS SDK: the handler resolves the access token (and supplies an
// optional onRefresh callback that re-mints + persists a token on 401). This
// module only knows how to talk to Bitbucket once it has a token.

import { ProviderError } from './errors.js';

const API_BASE = 'https://api.bitbucket.org/2.0';

// ---------------------------------------------------------------------------
// Identity / git plumbing
// ---------------------------------------------------------------------------

const id = 'bitbucket';
const displayName = 'Bitbucket';
const gitHost = 'bitbucket.org';

// Bitbucket clone URLs authenticate with the x-token-auth:<token> scheme.
const buildCloneUrl = (repoId, token) => {
  const auth = token ? `x-token-auth:${token}@` : '';
  return `https://${auth}${gitHost}/${repoId}.git`;
};

// Bitbucket addresses repositories by "workspace/repo_slug" path.
// Validate each part against safe character set to prevent path/query injection.
const splitWorkspaceRepo = (repoId) => {
  if (!repoId || typeof repoId !== 'string') {
    throw new ProviderError(400, 'Invalid repository reference for Bitbucket');
  }
  const parts = repoId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(400, `Invalid repoId "${repoId}": expected "workspace/repo_slug"`);
  }
  // Validate each part against safe character set to prevent injection
  const safePattern = /^[A-Za-z0-9._-]+$/;
  if (!safePattern.test(parts[0]) || !safePattern.test(parts[1])) {
    throw new ProviderError(
      400,
      `Invalid repoId "${repoId}": workspace and repo_slug must contain only alphanumeric characters, dots, underscores, and hyphens`,
    );
  }
  // Defense-in-depth: the charset above already excludes "/", but a segment of
  // "." or ".." would still pass it — reject any dot-only / traversal segment
  // so a crafted repoId can never resolve to a parent path when interpolated.
  if (['.', '..'].includes(parts[0]) || ['.', '..'].includes(parts[1])) {
    throw new ProviderError(400, `Invalid repoId "${repoId}": path traversal segment rejected`);
  }
  return { workspace: parts[0], repoSlug: parts[1] };
};

// ---------------------------------------------------------------------------
// HTTP — with optional 401 token-refresh retry
// ---------------------------------------------------------------------------

const apiHeaders = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  ...extra,
});

// ctx = { token, fetchImpl?, onRefresh? }
//   onRefresh: async () => newAccessToken  — supplied by the handler to refresh
//   an expired Bitbucket token (persisting to SSM/DDB) and mutate ctx.token.
const bbFetch = async (ctx, url, options = {}) => {
  const doFetch = ctx.fetchImpl || fetch;
  const withAuth = (token) => ({
    ...options,
    headers: { ...apiHeaders(token), ...options.headers },
  });
  const res = await doFetch(url, withAuth(ctx.token));
  if (res.status === 401 && typeof ctx.onRefresh === 'function') {
    try {
      const newToken = await ctx.onRefresh();
      ctx.token = newToken;
      return doFetch(url, withAuth(newToken));
    } catch (e) {
      console.error('[bitbucket:bbFetch] token refresh failed, returning original 401', {
        url,
        error: e && e.message ? e.message : String(e),
      });
      return res;
    }
  }
  return res;
};

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const oauth = {
  secretEnvName: 'BITBUCKET_OAUTH_SECRET_NAME',
  redirectUriEnvName: 'BITBUCKET_REDIRECT_URI',
  scopes: 'account email repository repository:write pullrequest pullrequest:write',
  requiredConnectionScopes: ['account', 'email', 'repository', 'pullrequest'],

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    return `https://bitbucket.org/site/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=${encodeURIComponent(oauth.scopes)}&state=${encodeURIComponent(
      state,
    )}`;
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
    const res = await fetchImpl('https://bitbucket.org/site/oauth2/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await res.json();
    if (data.error) {
      throw new ProviderError(400, data.error_description || data.error);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      scope: data.scope,
      expiresIn: data.expires_in,
    };
  },

  // Bitbucket access tokens expire; refresh exchanges the refresh token for a new
  // pair. Returns the same shape as exchangeCode so the handler can persist it.
  async refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
    const res = await fetchImpl('https://bitbucket.org/site/oauth2/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[bitbucket:refresh] failed', {
        httpStatus: res.status,
        error: data.error,
        errorDescription: data.error_description,
      });
      throw new ProviderError(400, data.error_description || data.error);
    }
    console.log('[bitbucket:refresh] ok', { expiresIn: data.expires_in });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      scope: data.scope,
      expiresIn: data.expires_in,
    };
  },
};

// ---------------------------------------------------------------------------
// Identity / repository access
// ---------------------------------------------------------------------------

const getAuthenticatedUser = async (ctx) => {
  const res = await bbFetch(ctx, `${API_BASE}/user`);
  const data = await res.json().catch(() => ({}));
  const login = data.nickname || data.username || data.account_id;
  if (!res.ok || !login) {
    throw new ProviderError(res.status || 400, data.error?.message || 'Failed to fetch user');
  }
  return {
    login,
    authorName: data.display_name || login,
    authorEmail: data.email || `${login}@users.noreply.bitbucket.org`,
  };
};

const getRepositoryAccess = async (ctx, repoId) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const query = `repository.full_name="${workspace}/${repoSlug}"`;
  const res = await bbFetch(
    ctx,
    `${API_BASE}/user/permissions/repositories?q=${encodeURIComponent(query)}&pagelen=1`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(
      res.status || 400,
      data.error?.message || 'Failed to access repository permissions',
    );
  }
  const permission = data.values?.[0]?.permission;
  const repository = data.values?.[0]?.repository;
  if (!permission || !repository) {
    throw new ProviderError(404, 'Repository is not accessible to the connected Bitbucket user');
  }
  const canWrite = ['write', 'admin', 'owner'].includes(permission);
  return {
    defaultBranch: repository.mainbranch?.name ?? null,
    private: Boolean(repository.is_private),
    permission,
    canRead: ['read', 'write', 'admin', 'owner'].includes(permission),
    canWrite,
  };
};

// ---------------------------------------------------------------------------
// Repo browse
// ---------------------------------------------------------------------------

const mapRepo = (r) => ({
  id: r.uuid,
  name: r.name,
  fullName: r.full_name,
  private: Boolean(r.is_private),
  defaultBranch: r.mainbranch?.name || 'main',
});

// Cross-workspace repository listing. First get user's workspaces, then list repos per workspace.
// Handle 401/403/410 with clear error for repo-scoped tokens that can't enumerate workspaces.
const listRepos = async (ctx) => {
  // First, get user workspaces
  const workspacesRes = await bbFetch(ctx, `${API_BASE}/user/workspaces?pagelen=100`);
  if (!workspacesRes.ok) {
    if ([401, 403, 410].includes(workspacesRes.status)) {
      throw new ProviderError(
        workspacesRes.status,
        'Repository-scoped tokens cannot enumerate workspaces. Please use an account-scoped token to list repositories across workspaces.',
      );
    }
    const data = await workspacesRes.json().catch(() => ({}));
    throw new ProviderError(
      workspacesRes.status,
      data.error?.message || 'Failed to fetch workspaces',
    );
  }

  const workspacesData = await workspacesRes.json();
  if (!Array.isArray(workspacesData.values)) {
    throw new ProviderError(400, 'Failed to fetch workspaces');
  }

  // Aggregate repositories from all workspaces
  const allRepos = [];
  for (const workspace of workspacesData.values) {
    try {
      // GET /2.0/user/workspaces returns membership objects that nest the
      // workspace under a `.workspace` sub-object (slug lives at
      // item.workspace.slug), NOT at the top level. Read the nested slug but
      // fall back to the top-level one so we also work against the plain
      // /2.0/workspaces shape (slug at top level).
      const workspaceSlug = workspace.workspace?.slug || workspace.slug;
      if (!workspaceSlug) continue;

      const reposRes = await bbFetch(
        ctx,
        `${API_BASE}/repositories/${workspaceSlug}?role=member&pagelen=100`,
      );
      if (reposRes.ok) {
        const reposData = await reposRes.json();
        if (Array.isArray(reposData.values)) {
          allRepos.push(...reposData.values.map(mapRepo));
        }
      }
    } catch (err) {
      // Auth/permission failures are not "this one workspace is flaky" — they
      // signal the token is bad and every subsequent call will fail too, so
      // surface them instead of silently returning a partial/empty repo list.
      if (err instanceof ProviderError && [401, 403].includes(err.status)) {
        throw err;
      }
      // Otherwise continue: one workspace failing shouldn't drop the rest.
      console.warn(
        `[bitbucket:listRepos] Failed to fetch repos for workspace ${workspace.slug}:`,
        err.message,
      );
    }
  }

  return allRepos;
};

const listBranches = async (ctx, repoId) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/refs/branches?pagelen=100`,
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error('[bitbucket:listBranches] error response', {
      httpStatus: res.status,
      message: data.error?.message,
    });
    throw new ProviderError(res.status, data.error?.message || 'Failed to fetch branches');
  }
  const data = await res.json();
  if (!Array.isArray(data.values)) return [];
  return data.values.map((b) => b.name);
};

// The repository's real default branch.
const getDefaultBranch = async (ctx, repoId) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(ctx, `${API_BASE}/repositories/${workspace}/${repoSlug}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.mainbranch?.name ?? null;
};

// List directory contents WITHOUT ?format=meta (which returns single dir object, not entries).
// Guard against empty bodies / 404 → "Unexpected end of JSON input".
const getTree = async (ctx, repoId, branch = 'main') => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  // Bitbucket's src listing is non-recursive by default; max_depth makes it
  // walk subdirectories (breadth-first) so we return the FULL tree, not just
  // the top level. Results are paginated via an absolute `next` URL.
  const files = [];
  let url = `${API_BASE}/repositories/${workspace}/${repoSlug}/src/${encodeURIComponent(
    branch,
  )}/?pagelen=100&max_depth=100`;

  while (url) {
    const res = await bbFetch(ctx, url);
    if (!res.ok) {
      if (res.status === 404) {
        throw new ProviderError(404, 'Branch or repository not found');
      }
      const text = await res.text().catch(() => '');
      if (!text.trim()) {
        throw new ProviderError(res.status, 'Failed to fetch tree');
      }
      let message = 'Failed to fetch tree';
      try {
        message = JSON.parse(text).error?.message || message;
      } catch {
        throw new ProviderError(res.status, 'Unexpected end of JSON input');
      }
      throw new ProviderError(res.status, message);
    }

    const text = await res.text();
    if (!text.trim()) {
      throw new ProviderError(400, 'Empty response from Bitbucket API');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError(400, 'Unexpected end of JSON input');
    }
    if (!Array.isArray(data.values)) throw new ProviderError(400, 'Failed to fetch tree');

    for (const item of data.values) {
      // Bitbucket returns full repo-root-relative paths on every entry; only
      // commit_file entries are real files (commit_directory entries are the
      // traversed directories themselves).
      if (item.type === 'commit_file') {
        files.push({
          path: item.path,
          sha: item.commit?.hash || '',
          size: item.size || 0,
        });
      }
    }

    url = data.next || null;
  }

  return files;
};

const getFileContents = async (ctx, repoId, filePath, branch = 'main') => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/src/${encodeURIComponent(branch)}/${encodeURIComponent(filePath)}`,
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ProviderError(res.status, data.error?.message || 'Failed to fetch file contents');
  }
  const content = await res.text();
  return {
    path: filePath,
    sha: '', // Bitbucket doesn't provide SHA in this endpoint
    size: content.length,
    content,
  };
};

// ---------------------------------------------------------------------------
// PR comments
// ---------------------------------------------------------------------------

const mapComment = (c) => ({
  id: c.id,
  type: 'issue',
  body: c.content?.raw || '',
  user: {
    login: c.user?.username || c.user?.nickname || '',
    avatarUrl: c.user?.links?.avatar?.href || null,
  },
  bot: Boolean(c.user?.type === 'team'),
  system: false,
  path: null,
  line: null,
  createdAt: c.created_on,
  updatedAt: c.updated_on,
  version: c.updated_on || c.created_on,
});

const mapInlineComment = (c) => ({
  id: c.id,
  type: 'review',
  body: c.content?.raw || '',
  user: {
    login: c.user?.username || c.user?.nickname || '',
    avatarUrl: c.user?.links?.avatar?.href || null,
  },
  bot: Boolean(c.user?.type === 'team'),
  system: false,
  path: c.inline?.path || null,
  line: c.inline?.to || null,
  createdAt: c.created_on,
  updatedAt: c.updated_on,
  version: c.updated_on || c.created_on,
});

const listPaginated = async (ctx, url) => {
  const rows = [];
  let nextUrl = url;

  while (nextUrl && rows.length < 10000) {
    // Safety limit
    const res = await bbFetch(ctx, nextUrl);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ProviderError(res.status, data?.error?.message || 'Failed to list comments');
    }
    const data = await res.json();
    if (!Array.isArray(data.values)) break;
    rows.push(...data.values);
    nextUrl = data.next || null;
  }
  return rows;
};

const listPRComments = async (ctx, repoId, prId) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const [generalComments, inlineComments] = await Promise.all([
    listPaginated(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments?pagelen=100`,
    ),
    listPaginated(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments?pagelen=100&q=inline!=null`,
    ),
  ]);

  const general = generalComments.filter((c) => !c.inline).map(mapComment);
  const inline = inlineComments.filter((c) => c.inline).map(mapInlineComment);

  return [...general, ...inline].toSorted(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
};

const addPRComment = async (ctx, repoId, prId, { body, path, line }) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  const commentPayload = { content: { raw: body } };

  // Add inline comment if path and line are specified
  if (path && line) {
    commentPayload.inline = {
      path,
      to: line,
    };
  }

  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`,
    {
      method: 'POST',
      body: JSON.stringify(commentPayload),
    },
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ProviderError(res.status, data.error?.message || 'Failed to add comment');
  }

  const result = await res.json();
  return {
    id: result.id,
    body: result.content?.raw || body,
    user: {
      login: result.user?.username || result.user?.nickname || '',
      avatarUrl: result.user?.links?.avatar?.href || null,
    },
    url: result.links?.html?.href || null,
    createdAt: result.created_on,
  };
};

// ---------------------------------------------------------------------------
// PR creation + construction-task-branch helpers (used by the v2 orchestrator)
// and PR-state / server-side merge.
//
// Construction task branches follow the same "<sprintBranch>--task-..." naming
// convention as GitHub; we list them via the branches API and check merge
// status with the commits API.
// ---------------------------------------------------------------------------

const constructionBranchPrefix = (branch) => `${branch}--task-`;

const listConstructionTaskBranches = async (ctx, repoId, branch) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const prefix = constructionBranchPrefix(branch);

  // Bitbucket doesn't have a direct search, so we get all branches and filter
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/refs/branches?pagelen=100`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to list construction task branches: ${errorText}`);
  }
  const data = await res.json();
  if (!Array.isArray(data.values)) return [];

  return data.values.map((b) => b.name).filter((name) => name.startsWith(prefix));
};

const isBranchMergedInto = async (ctx, repoId, sourceBranch, targetBranch) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  // Use commits API with exclude parameter to check if source has commits not in target
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/commits/${encodeURIComponent(sourceBranch)}?exclude=${encodeURIComponent(targetBranch)}&pagelen=1`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to compare ${sourceBranch} against ${targetBranch}: ${errorText}`);
  }
  const data = await res.json();

  // If there are no commits in source that aren't in target, it's merged
  return !Array.isArray(data.values) || data.values.length === 0;
};

// Real ancestor check — page through GET /commits/{descendantRef} until we find ancestorSha
const isCommitAncestor = async (ctx, repoId, ancestorSha, descendantRef) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  let nextUrl = `${API_BASE}/repositories/${workspace}/${repoSlug}/commits/${encodeURIComponent(descendantRef)}?pagelen=100`;

  while (nextUrl) {
    const res = await bbFetch(ctx, nextUrl);
    if (!res.ok) return false;

    const data = await res.json();
    if (!Array.isArray(data.values)) return false;

    // Check if ancestorSha is in this page of commits
    for (const commit of data.values) {
      if (commit.hash === ancestorSha) {
        return true;
      }
    }

    // Move to next page
    nextUrl = data.next || null;
  }

  return false;
};

const getUnmergedConstructionTaskBranches = async (ctx, repoId, branch) => {
  const taskBranches = await listConstructionTaskBranches(ctx, repoId, branch);
  const unmerged = [];
  for (const taskBranch of taskBranches) {
    const merged = await isBranchMergedInto(ctx, repoId, taskBranch, branch);
    if (!merged) unmerged.push(taskBranch);
  }
  return unmerged;
};

const cleanupConstructionTaskBranches = async (ctx, repoId, branch) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  let taskBranches;
  try {
    taskBranches = await listConstructionTaskBranches(ctx, repoId, branch);
  } catch (err) {
    console.error(err.message);
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
      console.error(err.message);
      continue;
    }
    if (!merged) {
      skipped += 1;
      console.error(`Skipping unmerged construction task branch ${taskBranch}`);
      continue;
    }

    const delRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repoSlug}/refs/branches/${encodeURIComponent(taskBranch)}`,
      {
        method: 'DELETE',
      },
    );
    if (delRes.ok || delRes.status === 204) {
      deleted += 1;
    } else {
      failed += 1;
      const errorText = await delRes.text().catch(() => '');
      console.error(`Failed to delete construction task branch ${taskBranch}:`, errorText);
    }
  }

  if (deleted || failed || skipped) {
    console.log(
      `Construction task branch cleanup complete: deleted=${deleted}, failed=${failed}, skipped=${skipped}`,
    );
  }
  return { deleted, failed, skipped };
};

const findPullRequest = async (
  ctx,
  repoId,
  { sourceBranch, targetBranch = null, state = 'OPEN' },
) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  const stateFilter = state === 'OPEN' ? 'OPEN' : state;
  let query = `source.branch.name="${sourceBranch}" AND state="${stateFilter}"`;
  if (targetBranch) {
    query += ` AND destination.branch.name="${targetBranch}"`;
  }

  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests?q=${encodeURIComponent(query)}&pagelen=100`,
  );
  if (!res.ok) return null;

  const data = await res.json();
  return Array.isArray(data.values) && data.values.length > 0 ? data.values[0] : null;
};

const createPullRequest = async (
  ctx,
  repoId,
  { branch, baseBranch, title, body, draft = false },
) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  const unmergedBranches = await getUnmergedConstructionTaskBranches(ctx, repoId, branch);
  if (unmergedBranches.length) {
    return {
      conflict: true,
      error: `Cannot create PR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
      unmergedBranches,
    };
  }

  const resolvedBase = baseBranch || (await getDefaultBranch(ctx, repoId)) || 'main';
  const existing = await findPullRequest(ctx, repoId, {
    sourceBranch: branch,
    targetBranch: resolvedBase,
    state: 'OPEN',
  });

  if (existing) {
    return {
      prUrl: existing.links?.html?.href,
      prNumber: existing.id,
      existing: true,
      ...(draft
        ? {
            providerId: existing.id,
            headSha: existing.source?.commit?.hash ?? null,
            targetSha: existing.destination?.commit?.hash ?? null,
            draft: Boolean(existing.title?.toLowerCase().startsWith('draft:')),
          }
        : {}),
    };
  }

  const prPayload = {
    title: draft && !title.toLowerCase().startsWith('draft:') ? `Draft: ${title}` : title,
    description: body,
    source: { branch: { name: branch } },
    destination: { branch: { name: resolvedBase } },
  };

  const res = await bbFetch(ctx, `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests`, {
    method: 'POST',
    body: JSON.stringify(prPayload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const errorText = data.error?.message || 'Unknown error';

    if (res.status === 400) {
      const text = errorText.toLowerCase();
      if (text.includes('no commits') || text.includes('no changes')) {
        return { skipped: true, reason: 'no_changes' };
      }
      if (text.includes('source branch') && text.includes('not exist')) {
        return {
          failed: true,
          reason: 'head_missing',
          error: `Source branch "${branch}" does not exist on the remote — the intent branch was never pushed`,
        };
      }
    }

    if (res.status === 409) {
      // Check for existing PR
      const open = await findPullRequest(ctx, repoId, {
        sourceBranch: branch,
        targetBranch: resolvedBase,
        state: 'OPEN',
      });
      if (open) {
        return {
          prUrl: open.links?.html?.href,
          prNumber: open.id,
          existing: true,
        };
      }
      return { skipped: true, reason: 'no_changes' };
    }

    throw new Error(`Failed to create PR: ${res.status} ${errorText}`);
  }

  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  const pr = await res.json();
  return {
    prUrl: pr.links?.html?.href,
    prNumber: pr.id,
    ...(draft
      ? {
          providerId: pr.id,
          headSha: pr.source?.commit?.hash ?? null,
          targetSha: pr.destination?.commit?.hash ?? null,
          draft: Boolean(pr.title?.toLowerCase().startsWith('draft:')),
        }
      : {}),
  };
};

const compareBranches = async (ctx, repoId, { base, head }) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const resolvedBase = base || (await getDefaultBranch(ctx, repoId)) || 'main';

  // Check if head branch exists
  const headRes = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/refs/branches/${encodeURIComponent(head)}`,
  );
  if (headRes.status === 404) {
    return { status: 'missing_head', base: resolvedBase };
  }
  if (!headRes.ok) {
    return { status: 'unknown', base: resolvedBase, detail: `head probe ${headRes.status}` };
  }

  // Compare commits
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/commits/${encodeURIComponent(head)}?exclude=${encodeURIComponent(resolvedBase)}&pagelen=100`,
  );
  if (res.status === 404) {
    return { status: 'missing_base', base: resolvedBase };
  }
  if (!res.ok) {
    return { status: 'unknown', base: resolvedBase, detail: `compare ${res.status}` };
  }

  const data = await res.json();
  const aheadBy = Array.isArray(data.values) ? data.values.length : 0;
  return { status: aheadBy > 0 ? 'ahead' : 'identical', aheadBy, base: resolvedBase };
};

const getPullRequestState = async (ctx, repoId, prId) => {
  const status = await getPullRequestStatus(ctx, repoId, prId);
  return status?.state ?? null;
};

const getPullRequestStatus = async (ctx, repoId, prId) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
  );
  if (!res.ok) return null;

  const pr = await res.json();
  const state = pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed';

  return {
    providerId: pr.id,
    number: pr.id,
    url: pr.links?.html?.href,
    sourceBranch: pr.source?.branch?.name ?? null,
    targetBranch: pr.destination?.branch?.name ?? null,
    headSha: pr.source?.commit?.hash ?? null,
    targetSha: pr.destination?.commit?.hash ?? null,
    state,
    draft: Boolean(pr.title?.toLowerCase().startsWith('draft:')),
    mergeable: null, // Bitbucket doesn't expose this directly
    mergeableState: null,
    mergedAt: pr.state === 'MERGED' ? pr.updated_on : null,
    closedAt: pr.state === 'DECLINED' ? pr.updated_on : null,
    updatedAt: pr.updated_on ?? null,
    title: pr.title ?? '',
  };
};

const setPullRequestDraft = async (ctx, repoId, prId, draft) => {
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);
  const current = await getPullRequestStatus(ctx, repoId, prId);
  if (!current || current.state !== 'open') return current;
  if (current.draft === draft) return current;

  const plainTitle = String(current.title ?? '').replace(/^draft:\s*/i, '');
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ title: draft ? `Draft: ${plainTitle}` : plainTitle }),
    },
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ProviderError(
      res.status,
      data?.error?.message || 'Failed to change pull request draft',
    );
  }

  return getPullRequestStatus(ctx, repoId, prId);
};

const reopenPullRequest = async (_ctx, _repoId, _prId) => {
  // Bitbucket doesn't have a direct reopen API, would need to create a new PR
  throw new ProviderError(400, 'Reopening pull requests is not supported by Bitbucket API');
};

const mergeBranch = async (ctx, repoId, { base, head, message }) => {
  // Bitbucket doesn't have a direct merge API like GitHub
  // We would need to create and immediately merge a PR
  const { workspace, repoSlug } = splitWorkspaceRepo(repoId);

  try {
    // Create a temporary PR
    const prRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: message || `Merge ${head} into ${base} (auto)`,
          source: { branch: { name: head } },
          destination: { branch: { name: base } },
        }),
      },
    );

    if (!prRes.ok) {
      const text = await prRes.text().catch(() => '');
      if (prRes.status === 400 && text.toLowerCase().includes('no changes')) {
        return 'merged'; // Already merged
      }
      return { error: `Bitbucket create-PR returned ${prRes.status}: ${text.slice(0, 300)}` };
    }

    const pr = await prRes.json();

    // Merge the PR
    const mergeRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repoSlug}/pullrequests/${pr.id}/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'merge' }),
      },
    );

    if (mergeRes.ok) return 'merged';

    // Handle merge conflicts
    if ([400, 409, 422].includes(mergeRes.status)) {
      return 'conflict';
    }

    const text = await mergeRes.text().catch(() => '');
    return { error: `Bitbucket merge returned ${mergeRes.status}: ${text.slice(0, 300)}` };
  } catch (e) {
    return { error: e.message };
  }
};

const apiBase = API_BASE;
export {
  id,
  displayName,
  gitHost,
  apiBase,
  buildCloneUrl,
  splitWorkspaceRepo,
  apiHeaders,
  bbFetch,
  oauth,
  getAuthenticatedUser,
  getRepositoryAccess,
  mapRepo,
  listRepos,
  listBranches,
  getDefaultBranch,
  getTree,
  getFileContents,
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
  splitWorkspaceRepo,
  apiHeaders,
  bbFetch,
  oauth,
  getAuthenticatedUser,
  getRepositoryAccess,
  mapRepo,
  listRepos,
  listBranches,
  getDefaultBranch,
  getTree,
  getFileContents,
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
