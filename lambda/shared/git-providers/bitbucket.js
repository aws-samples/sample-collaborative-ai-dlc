'use strict';

// Bitbucket Cloud provider — encapsulates every Bitbucket.org-specific detail
// behind the uniform git-provider contract (see ./index.js for the contract docs).
//
// Pure of AWS SDK: callers pass an already-resolved access token. OAuth-secret
// and SSM-token plumbing live in the handler/shared layers; this module only
// knows how to talk to Bitbucket once it has a token.

const { ProviderError } = require('./errors');

const API_BASE = 'https://api.bitbucket.org/2.0';

// ---------------------------------------------------------------------------
// Identity / git plumbing
// ---------------------------------------------------------------------------

const id = 'bitbucket';
const displayName = 'Bitbucket';
const gitHost = 'bitbucket.org';

// Repo reference for Bitbucket is "workspace/repo_slug" (similar to GitHub).
// The clone URL embeds the token via the x-token-auth scheme.
const buildCloneUrl = (repoId, token) => {
  const auth = token ? `x-token-auth:${token}@` : '';
  return `https://${auth}${gitHost}/${repoId}.git`;
};

const splitWorkspaceRepo = (repoId) => {
  if (!repoId || typeof repoId !== 'string') {
    throw new ProviderError(400, 'Invalid repository reference for Bitbucket');
  }
  const parts = repoId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(400, `Invalid gitRepo "${repoId}": expected "workspace/repo_slug"`);
  }
  return { workspace: parts[0], repo_slug: parts[1] };
};

// ---------------------------------------------------------------------------
// HTTP — with optional 401 token-refresh retry
// ---------------------------------------------------------------------------

const apiHeaders = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
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
  scopes: 'account repositories repositories:write pullrequests pullrequests:write',

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

  // Bitbucket access tokens expire (~2h); refresh exchanges the refresh token
  // for a new pair. Returns the same shape as exchangeCode so the handler can
  // persist it. Similar to GitLab but uses form encoding.
  async refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken,
    redirectUri,
    fetchImpl = fetch,
  }) {
    const res = await fetchImpl('https://bitbucket.org/site/oauth2/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[bitbucket:refresh] failed', {
        httpStatus: res.status,
        error: data.error,
        errorDescription: data.error_description,
        hasRedirectUri: Boolean(redirectUri),
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
// Repo browse
// ---------------------------------------------------------------------------

const mapRepo = (r) => ({
  id: r.uuid,
  name: r.name,
  fullName: r.full_name,
  private: r.is_private,
  defaultBranch: r.mainbranch?.name || 'main',
});

// Bitbucket uses paginated responses with a 'next' field for continuation
const listRepos = async (ctx) => {
  let allRepos = [];
  let url = `${API_BASE}/repositories?role=member&pagelen=100`;

  while (url) {
    const res = await bbFetch(ctx, url);
    const data = await res.json();
    if (data.error || !Array.isArray(data.values)) {
      throw new ProviderError(400, data.error?.message || 'Failed to fetch repositories');
    }
    allRepos = allRepos.concat(data.values.map(mapRepo));
    url = data.next; // Bitbucket pagination uses 'next' field
  }

  return allRepos;
};

const listBranches = async (ctx, repoId) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/refs/branches?pagelen=100`,
  );
  if (res.status === 404) return [];
  const data = await res.json();
  if (data.error || !Array.isArray(data.values)) {
    console.error('[bitbucket:listBranches] non-array response', {
      httpStatus: res.status,
      message: data && (data.error?.message || data.error),
    });
    throw new ProviderError(400, data.error?.message || 'Failed to fetch branches');
  }
  return data.values.map((b) => b.name);
};

const getTree = async (ctx, repoId, branch = 'main') => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);

  // Bitbucket doesn't have a direct recursive tree endpoint, so we need to
  // recursively fetch directories. Start with the root.
  const files = [];

  const fetchDirectory = async (path = '') => {
    const url = path
      ? `${API_BASE}/repositories/${workspace}/${repo_slug}/src/${encodeURIComponent(branch)}/${encodeURIComponent(path)}/?format=meta&pagelen=100`
      : `${API_BASE}/repositories/${workspace}/${repo_slug}/src/${encodeURIComponent(branch)}/?format=meta&pagelen=100`;

    let pageUrl = url;
    while (pageUrl) {
      const res = await bbFetch(ctx, pageUrl);
      const data = await res.json();
      if (data.error) {
        throw new ProviderError(400, data.error.message || data.error);
      }
      if (!Array.isArray(data.values)) {
        throw new ProviderError(400, 'Failed to fetch tree');
      }

      for (const item of data.values) {
        if (item.type === 'commit_file') {
          files.push({
            path: item.path,
            sha: item.commit?.hash || '',
            size: item.size || 0,
          });
        } else if (item.type === 'commit_directory') {
          // Recursively fetch subdirectories
          await fetchDirectory(item.path);
        }
      }

      pageUrl = data.next;
    }
  };

  await fetchDirectory();
  return files;
};

const getFileContents = async (ctx, repoId, filePath, branch = 'main') => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/src/${encodeURIComponent(branch)}/${encodeURIComponent(filePath)}`,
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ProviderError(400, data.error?.message || 'Failed to fetch file contents');
  }

  const content = await res.text();

  // Get file metadata for sha and size
  const metaRes = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/src/${encodeURIComponent(branch)}/${encodeURIComponent(filePath)}?format=meta`,
  );
  const metaData = await metaRes.json();

  return {
    path: filePath,
    sha: metaData.commit?.hash || '',
    size: metaData.size || content.length,
    content,
  };
};

// ---------------------------------------------------------------------------
// PR comments
// ---------------------------------------------------------------------------

const mapPrComment = (c) => ({
  id: c.id,
  type: 'issue', // Bitbucket doesn't distinguish review vs issue comments like GitHub
  body: c.content?.raw || '',
  user: {
    login: c.user?.display_name || c.user?.nickname || c.user?.username,
    avatarUrl: c.user?.links?.avatar?.href,
  },
  path: null,
  line: null,
  createdAt: c.created_on,
  updatedAt: c.updated_on,
});

const listPRComments = async (ctx, repoId, prNumber) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/pullrequests/${prNumber}/comments?pagelen=100`,
  );

  if (!res.ok) {
    return []; // Return empty array if PR not found or no access
  }

  const data = await res.json();
  if (!Array.isArray(data.values)) {
    return [];
  }

  return data.values
    .map(mapPrComment)
    .toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
};

const addPRComment = async (ctx, repoId, prNumber, { body, path, line, _side }) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);

  // Bitbucket doesn't support inline comments via the simple comments API,
  // so we'll add a general comment regardless of path/line parameters
  const commentRes = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/pullrequests/${prNumber}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: {
          raw: path && line ? `**${path}:${line}**\n\n${body}` : body,
        },
      }),
    },
  );

  const result = await commentRes.json();
  if (result.error) throw new ProviderError(400, result.error.message || result.error);

  return {
    id: result.id,
    body: result.content?.raw || body,
    user: {
      login: result.user?.display_name || result.user?.nickname || result.user?.username,
      avatarUrl: result.user?.links?.avatar?.href,
    },
    url: result.links?.html?.href || null,
    createdAt: result.created_on,
  };
};

// ---------------------------------------------------------------------------
// PR creation + construction-task-branch helpers
//
// Bitbucket uses similar concepts to GitHub but with different endpoints.
// The construction-task-branch guard is adapted for Bitbucket API.
// ---------------------------------------------------------------------------

const constructionBranchPrefix = (branch) => `${branch}--task-`;

const listConstructionTaskRefs = async (ctx, repoId, branch) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
  const prefix = constructionBranchPrefix(branch);

  // Get all branches and filter for construction task branches
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/refs/branches?pagelen=100`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to list construction task branches: ${errorText}`);
  }

  const data = await res.json();
  if (!Array.isArray(data.values)) {
    throw new Error('Failed to list branches');
  }

  return data.values.filter((ref) => ref.name.startsWith(prefix));
};

const isBranchMergedInto = async (ctx, repoId, sourceBranch, targetBranch) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);

  // Bitbucket doesn't have a direct compare endpoint like GitHub,
  // so we'll check if the source branch's head commit exists in target branch's history
  try {
    const sourceRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repo_slug}/refs/branches/${encodeURIComponent(sourceBranch)}`,
    );
    const targetRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repo_slug}/refs/branches/${encodeURIComponent(targetBranch)}`,
    );

    if (!sourceRes.ok || !targetRes.ok) {
      return false; // If we can't get branch info, assume not merged
    }

    const sourceData = await sourceRes.json();
    const targetData = await targetRes.json();

    const sourceCommit = sourceData.target?.hash;
    const targetCommit = targetData.target?.hash;

    if (!sourceCommit || !targetCommit) {
      return false;
    }

    // If commits are the same, it's merged (or source is behind target)
    if (sourceCommit === targetCommit) {
      return true;
    }

    // For a more thorough check, we'd need to traverse the commit history,
    // but for simplicity, we'll assume branches with different HEADs are unmerged
    return false;
  } catch (err) {
    console.error(`Failed to compare ${sourceBranch} against ${targetBranch}:`, err.message);
    return false;
  }
};

const getUnmergedConstructionTaskBranches = async (ctx, repoId, branch) => {
  const refs = await listConstructionTaskRefs(ctx, repoId, branch);
  const unmerged = [];
  for (const ref of refs) {
    const taskBranch = ref.name;
    const merged = await isBranchMergedInto(ctx, repoId, taskBranch, branch);
    if (!merged) unmerged.push(taskBranch);
  }
  return unmerged;
};

const cleanupConstructionTaskBranches = async (ctx, repoId, branch) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
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
    const taskBranch = ref.name;
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

    const deleteRes = await bbFetch(
      ctx,
      `${API_BASE}/repositories/${workspace}/${repo_slug}/refs/branches/${encodeURIComponent(taskBranch)}`,
      { method: 'DELETE' },
    );
    if (deleteRes.ok) {
      deleted += 1;
    } else {
      failed += 1;
      const errorText = await deleteRes.text();
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

// Find an existing PR for a branch
const findPRByBranch = async (ctx, repoId, branch, state) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);

  // Bitbucket uses different state values: OPEN, MERGED, DECLINED, SUPERSEDED
  const bbState = state === 'open' ? 'OPEN' : state === 'all' ? undefined : 'OPEN';
  const stateParam = bbState ? `&state=${bbState}` : '';

  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/pullrequests?pagelen=100${stateParam}`,
  );

  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data.values)) {
      const match = data.values.find((p) => p.source?.branch?.name === branch);
      if (match) return match;
    }
  }
  return null;
};

// Create a PR. Enforces the unmerged-construction-task-branch guard.
const createPullRequest = async (ctx, repoId, { branch, baseBranch, title, body }) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);

  const unmergedBranches = await getUnmergedConstructionTaskBranches(ctx, repoId, branch);
  if (unmergedBranches.length) {
    return {
      conflict: true,
      error: `Cannot create PR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
      unmergedBranches,
    };
  }

  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/pullrequests`,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: body,
        source: {
          branch: {
            name: branch,
          },
        },
        destination: {
          branch: {
            name: baseBranch || 'main',
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const errorText = errorData.error?.message || `HTTP ${res.status}`;

    if (res.status === 400) {
      // Check for existing PR
      const openPr = await findPRByBranch(ctx, repoId, branch, 'open');
      if (openPr) {
        await cleanupConstructionTaskBranches(ctx, repoId, branch);
        return {
          prUrl: openPr.links?.html?.href,
          prNumber: openPr.id,
          existing: true,
        };
      }
      const anyPr = await findPRByBranch(ctx, repoId, branch, 'all');
      if (anyPr) {
        await cleanupConstructionTaskBranches(ctx, repoId, branch);
        return {
          prUrl: anyPr.links?.html?.href,
          prNumber: anyPr.id,
          existing: true,
        };
      }

      // Check for no changes (common error messages)
      if (
        errorText.toLowerCase().includes('no changes') ||
        errorText.toLowerCase().includes('nothing to merge') ||
        errorText.toLowerCase().includes('no commits')
      ) {
        return { skipped: true, reason: 'no_changes' };
      }
    }
    throw new Error(`Failed to create PR: ${res.status} ${errorText}`);
  }

  const pr = await res.json();
  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  return {
    prUrl: pr.links?.html?.href,
    prNumber: pr.id,
  };
};

// Get the live state of a PR
const getPullRequestState = async (ctx, repoId, prNumber) => {
  const { workspace, repo_slug } = splitWorkspaceRepo(repoId);
  const res = await bbFetch(
    ctx,
    `${API_BASE}/repositories/${workspace}/${repo_slug}/pullrequests/${prNumber}`,
  );
  if (!res.ok) return null;
  const pr = await res.json();

  // Bitbucket states: OPEN, MERGED, DECLINED, SUPERSEDED
  if (pr.state === 'OPEN') return 'open';
  if (pr.state === 'MERGED') return 'merged';
  return 'closed'; // DECLINED or SUPERSEDED
};

// Server-side merge of a task branch (Bitbucket doesn't have a direct merge API like GitHub)
const mergeBranch = async (_ctx, _repoId, { base: _base, head: _head, message: _message }) => {
  // Bitbucket doesn't have a direct merge API endpoint like GitHub's /merges
  // For now, return an error suggesting manual merge or PR creation
  return {
    error: 'Bitbucket does not support server-side merge via API. Please create a PR instead.',
  };
};

module.exports = {
  id,
  displayName,
  gitHost,
  apiBase: API_BASE,
  buildCloneUrl,
  splitWorkspaceRepo,
  apiHeaders,
  bbFetch,
  oauth,
  mapRepo,
  listRepos,
  listBranches,
  getTree,
  getFileContents,
  listPRComments,
  addPRComment,
  getUnmergedConstructionTaskBranches,
  cleanupConstructionTaskBranches,
  createPullRequest,
  getPullRequestState,
  mergeBranch,
  constructionBranchPrefix,
};
