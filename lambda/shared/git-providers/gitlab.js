// GitLab provider — encapsulates every GitLab.com-specific detail behind the
// uniform git-provider contract (see ./index.js for the contract docs).
//
// Pure of AWS SDK: the handler resolves the access token (and supplies an
// optional onRefresh callback that re-mints + persists a token on 401). This
// module only knows how to talk to GitLab once it has a token.

import { ProviderError } from './errors.js';

const API_BASE = 'https://gitlab.com/api/v4';

// ---------------------------------------------------------------------------
// Identity / git plumbing
// ---------------------------------------------------------------------------

const id = 'gitlab';
const displayName = 'GitLab';
const gitHost = 'gitlab.com';

// GitLab clone URLs authenticate with the oauth2:<token> scheme.
const buildCloneUrl = (repoId, token) => {
  const auth = token ? `oauth2:${token}@` : '';
  return `https://${auth}${gitHost}/${repoId}.git`;
};

// GitLab addresses projects by URL-encoded "group/project" path.
const encodeProject = (repoId) => {
  if (!repoId || typeof repoId !== 'string') {
    throw new ProviderError(400, 'Invalid project reference for GitLab');
  }
  return encodeURIComponent(repoId);
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
//   an expired GitLab token (persisting to SSM/DDB) and mutate ctx.token.
const glFetch = async (ctx, url, options = {}) => {
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
      console.error('[gitlab:glFetch] token refresh failed, returning original 401', {
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
  secretEnvName: 'GITLAB_OAUTH_SECRET_NAME',
  redirectUriEnvName: 'GITLAB_REDIRECT_URI',
  scopes: 'api read_user',
  requiredConnectionScopes: ['api'],

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    return `https://gitlab.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=${encodeURIComponent(oauth.scopes)}&state=${encodeURIComponent(
      state,
    )}`;
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
    const res = await fetchImpl('https://gitlab.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

  // GitLab access tokens expire; refresh exchanges the refresh token for a new
  // pair. Returns the same shape as exchangeCode so the handler can persist it.
  // NOTE: GitLab REQUIRES `redirect_uri` on the refresh_token grant and it must
  // match the one used in the original authorization request — omitting it makes
  // GitLab reject the refresh with `invalid_grant` ("...does not match the
  // redirection URI..."). See https://docs.gitlab.com/api/oauth2/.
  async refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken,
    redirectUri,
    fetchImpl = fetch,
  }) {
    const res = await fetchImpl('https://gitlab.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[gitlab:refresh] failed', {
        httpStatus: res.status,
        error: data.error,
        errorDescription: data.error_description,
        hasRedirectUri: Boolean(redirectUri),
      });
      throw new ProviderError(400, data.error_description || data.error);
    }
    console.log('[gitlab:refresh] ok', { expiresIn: data.expires_in });
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
  id: r.id,
  name: r.name,
  fullName: r.path_with_namespace,
  private: r.visibility !== 'public',
  defaultBranch: r.default_branch,
});

const listRepos = async (ctx) => {
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects?membership=true&min_access_level=30&per_page=100&order_by=last_activity_at`,
  );
  const repos = await res.json();
  if (!Array.isArray(repos)) {
    throw new ProviderError(400, repos.message || repos.error || 'Failed to fetch projects');
  }
  return repos.map(mapRepo);
};

const listBranches = async (ctx, repoId) => {
  const project = encodeProject(repoId);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/branches?per_page=100`,
  );
  if (res.status === 404) return [];
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error('[gitlab:listBranches] non-array response', {
      httpStatus: res.status,
      message: data && (data.message || data.error),
    });
    throw new ProviderError(400, data.message || 'Failed to fetch branches');
  }
  return data.map((b) => b.name);
};

// The project's real default branch. Needed because init-ws `git clone` checks
// out the repo's actual default HEAD regardless of the intent's configured
// `baseBranch`, so a project whose default is not `main` still clones — but an
// MR targeting `main` then fails. Returns null if the project can't be read.
const getDefaultBranch = async (ctx, repoId) => {
  const project = encodeProject(repoId);
  const res = await glFetch(ctx, `${API_BASE}/projects/${project}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.default_branch ?? null;
};

const getTree = async (ctx, repoId, branch = 'main') => {
  const project = encodeProject(repoId);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/tree?ref=${encodeURIComponent(
      branch,
    )}&recursive=true&per_page=100`,
  );
  const data = await res.json();
  if (data.message || data.error) {
    throw new ProviderError(400, data.message || data.error);
  }
  if (!Array.isArray(data)) throw new ProviderError(400, 'Failed to fetch tree');
  return data
    .filter((item) => item.type === 'blob')
    .map((item) => ({ path: item.path, sha: item.id, size: 0 }));
};

const getFileContents = async (ctx, repoId, filePath, branch = 'main') => {
  const project = encodeProject(repoId);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/files/${encodeURIComponent(
      filePath,
    )}?ref=${encodeURIComponent(branch)}`,
  );
  const data = await res.json();
  if (data.message || data.error) {
    throw new ProviderError(400, data.message || data.error);
  }
  return {
    path: data.file_path,
    sha: data.blob_id,
    size: data.size,
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
  };
};

// ---------------------------------------------------------------------------
// MR comments (notes + discussions)
// ---------------------------------------------------------------------------

const mapNote = (n) => ({
  id: n.id,
  type: 'issue',
  body: n.body,
  user: { login: n.author?.username, avatarUrl: n.author?.avatar_url },
  bot: Boolean(n.author?.bot),
  system: Boolean(n.system),
  path: null,
  line: null,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
  version: n.updated_at || n.created_at,
});

const listPaginated = async (ctx, url) => {
  const rows = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    const res = await glFetch(ctx, `${url}${separator}per_page=100&page=${page}`);
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

const listPRComments = async (ctx, repoId, mrIid) => {
  const project = encodeProject(repoId);
  const [notes, discussions] = await Promise.all([
    listPaginated(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}/notes`),
    listPaginated(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}/discussions`),
  ]);

  const inlineComments = [];
  if (Array.isArray(discussions)) {
    for (const discussion of discussions) {
      if (!Array.isArray(discussion.notes)) continue;
      for (const note of discussion.notes) {
        if (note.position) {
          inlineComments.push({
            id: note.id,
            type: 'review',
            body: note.body,
            user: { login: note.author?.username, avatarUrl: note.author?.avatar_url },
            bot: Boolean(note.author?.bot),
            system: Boolean(note.system),
            path: note.position?.new_path || note.position?.old_path || null,
            line: note.position?.new_line || note.position?.old_line || null,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
            version: note.updated_at || note.created_at,
          });
        }
      }
    }
  }

  const generalNotes = notes.filter((n) => !n.position).map(mapNote);

  return [...generalNotes, ...inlineComments].toSorted(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
};

const addPRComment = async (ctx, repoId, mrIid, { body, path, line }) => {
  const project = encodeProject(repoId);
  let result;
  if (path && line) {
    const mrRes = await glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}`);
    const mrData = await mrRes.json();
    const headSha = mrData.diff_refs?.head_sha;
    const baseSha = mrData.diff_refs?.base_sha;
    const startSha = mrData.diff_refs?.start_sha;
    if (!headSha) throw new ProviderError(400, 'Could not determine commit SHA');
    const discussionRes = await glFetch(
      ctx,
      `${API_BASE}/projects/${project}/merge_requests/${mrIid}/discussions`,
      {
        method: 'POST',
        body: JSON.stringify({
          body,
          position: {
            position_type: 'text',
            base_sha: baseSha,
            head_sha: headSha,
            start_sha: startSha,
            new_path: path,
            new_line: line,
          },
        }),
      },
    );
    result = await discussionRes.json();
    if (result.notes && result.notes.length > 0) result = result.notes[0];
  } else {
    const noteRes = await glFetch(
      ctx,
      `${API_BASE}/projects/${project}/merge_requests/${mrIid}/notes`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
    result = await noteRes.json();
  }
  if (result.message || result.error) {
    throw new ProviderError(400, result.message || result.error);
  }
  return {
    id: result.id,
    body: result.body,
    user: { login: result.author?.username, avatarUrl: result.author?.avatar_url },
    url: result.web_url || null,
    createdAt: result.created_at,
  };
};

// ---------------------------------------------------------------------------
// MR creation + construction-task-branch helpers (used by the v2 orchestrator)
// and MR-state / server-side merge.
//
// Construction task branches follow the same "<sprintBranch>--task-..." naming
// convention as GitHub; we list them via the branches API and check merge
// status with the compare API.
// ---------------------------------------------------------------------------

const constructionBranchPrefix = (branch) => `${branch}--task-`;

const listConstructionTaskBranches = async (ctx, repoId, branch) => {
  const project = encodeProject(repoId);
  const prefix = constructionBranchPrefix(branch);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/branches?search=${encodeURIComponent(
      prefix,
    )}&per_page=100`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to list construction task branches: ${errorText}`);
  }
  const branches = await res.json();
  if (!Array.isArray(branches)) return [];
  // GitLab's `search` matches substrings — keep only true prefix matches.
  return branches.map((b) => b.name).filter((name) => name.startsWith(prefix));
};

// GitLab compare with from=targetBranch, to=sourceBranch: a task branch is
// merged into the sprint branch when it adds no commits the sprint lacks.
const isBranchMergedInto = async (ctx, repoId, sourceBranch, targetBranch) => {
  const project = encodeProject(repoId);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/compare?from=${encodeURIComponent(
      targetBranch,
    )}&to=${encodeURIComponent(sourceBranch)}`,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to compare ${sourceBranch} against ${targetBranch}: ${errorText}`);
  }
  const comparison = await res.json();
  return Array.isArray(comparison.commits) && comparison.commits.length === 0;
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
  const project = encodeProject(repoId);
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
    const delRes = await glFetch(
      ctx,
      `${API_BASE}/projects/${project}/repository/branches/${encodeURIComponent(taskBranch)}`,
      { method: 'DELETE' },
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
  { sourceBranch, targetBranch = null, state = 'opened' },
) => {
  const project = encodeProject(repoId);
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(
      sourceBranch,
    )}&state=${state}&per_page=100`,
  );
  if (!res.ok) return null;
  const mrs = await res.json();
  return Array.isArray(mrs)
    ? (mrs.find(
        (mr) =>
          mr.source_branch === sourceBranch &&
          (targetBranch === null || mr.target_branch === targetBranch),
      ) ?? null)
    : null;
};

// Create a merge request. Enforces the unmerged-construction-task-branch guard
// for parity with GitHub. Returns { prUrl, prNumber } on success,
// { skipped, reason } for a no-change repo, { conflict, unmergedBranches } when
// task branches remain unmerged.
const createPullRequest = async (
  ctx,
  repoId,
  { branch, baseBranch, title, body, draft = false },
) => {
  const project = encodeProject(repoId);

  const unmergedBranches = await getUnmergedConstructionTaskBranches(ctx, repoId, branch);
  if (unmergedBranches.length) {
    return {
      conflict: true,
      error: `Cannot create MR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
      unmergedBranches,
    };
  }

  const resolvedBase = baseBranch || (await getDefaultBranch(ctx, repoId)) || 'main';
  const existing = await findPullRequest(ctx, repoId, {
    sourceBranch: branch,
    targetBranch: resolvedBase,
    state: 'opened',
  });
  if (existing) {
    return {
      prUrl: existing.web_url,
      prNumber: existing.iid,
      existing: true,
      ...(draft
        ? {
            providerId: existing.id,
            headSha: existing.sha ?? existing.diff_refs?.head_sha ?? null,
            targetSha: existing.diff_refs?.base_sha ?? null,
            draft: Boolean(existing.draft || /^draft:/i.test(existing.title ?? '')),
          }
        : {}),
    };
  }

  const postMr = (target) =>
    glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        title: draft && !/^draft:/i.test(title) ? `Draft: ${title}` : title,
        description: body,
        source_branch: branch,
        target_branch: target,
      }),
    });

  // No explicit base (project-wide legacy default, or a repo the caller left
  // unset in a per-repo baseBranches map) — resolve the project's REAL default
  // branch rather than assuming `main`.
  let res = await postMr(resolvedBase);

  if (!res.ok) {
    let errorText = await res.text();
    if (res.status === 409) {
      if (errorText.toLowerCase().includes('already exists')) {
        const open = await findPullRequest(ctx, repoId, {
          sourceBranch: branch,
          targetBranch: resolvedBase,
          state: 'opened',
        });
        if (open) {
          return {
            prUrl: open.web_url,
            prNumber: open.iid,
            existing: true,
            ...(draft
              ? {
                  providerId: open.id,
                  headSha: open.sha ?? open.diff_refs?.head_sha ?? null,
                  targetSha: open.diff_refs?.base_sha ?? null,
                  draft: Boolean(open.draft || /^draft:/i.test(open.title ?? '')),
                }
              : {}),
          };
        }
      }
      return { skipped: true, reason: 'no_changes' };
    }
    if (res.status === 422 || res.status === 400) {
      const text = (errorText || '').toLowerCase();
      // A missing SOURCE branch means the intent branch was never pushed —
      // that is a FAILURE (work may be stranded on the session workspace),
      // never a benign "no changes" skip (the 2026-07 conflation).
      if (text.includes('source branch') && text.includes('exist')) {
        return {
          failed: true,
          reason: 'head_missing',
          error: `Source branch "${branch}" does not exist on the remote — the intent branch was never pushed`,
        };
      }
      if (text.includes('no commits')) {
        return { skipped: true, reason: 'no_changes' };
      }
      // Target branch does not exist (e.g. a caller-supplied base was mistyped
      // or deleted since). Retry once against the project's real default
      // branch — the source branch was cut from that HEAD at clone time, so
      // it is a reasonable merge target.
      if (text.includes('target branch')) {
        const defaultBranch = await getDefaultBranch(ctx, repoId);
        if (defaultBranch && defaultBranch !== resolvedBase) {
          res = await postMr(defaultBranch);
          if (res.ok) {
            await cleanupConstructionTaskBranches(ctx, repoId, branch);
            const mr = await res.json();
            return {
              prUrl: mr.web_url,
              prNumber: mr.iid,
              retargetedBase: defaultBranch,
              ...(draft
                ? {
                    providerId: mr.id,
                    headSha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
                    targetSha: mr.diff_refs?.base_sha ?? null,
                    draft: Boolean(mr.draft || /^draft:/i.test(mr.title ?? '')),
                  }
                : {}),
            };
          }
          errorText = await res.text();
        }
      }
    }
    throw new Error(`Failed to create MR: ${res.status} ${errorText}`);
  }

  await cleanupConstructionTaskBranches(ctx, repoId, branch);
  const mr = await res.json();
  return {
    prUrl: mr.web_url,
    prNumber: mr.iid,
    ...(draft
      ? {
          providerId: mr.id,
          headSha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
          targetSha: mr.diff_refs?.base_sha ?? null,
          draft: Boolean(mr.draft || /^draft:/i.test(mr.title ?? '')),
        }
      : {}),
  };
};

// Compare base...head — the MR fan-in's pre-check that the intent branch
// exists and carries commits (see the GitHub provider's compareBranches for
// the incident rationale). GitLab's compare returns the commits `to` has that
// `from` lacks; an empty list means identical-or-behind — either way there is
// nothing to merge, which is all the caller needs to know.
// Returns { status: 'ahead'|'identical'|'missing_head'|'missing_base'|'unknown', aheadBy?, base }.
const compareBranches = async (ctx, repoId, { base, head }) => {
  const project = encodeProject(repoId);
  const resolvedBase = base || (await getDefaultBranch(ctx, repoId)) || 'main';
  const res = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/repository/compare?from=${encodeURIComponent(
      resolvedBase,
    )}&to=${encodeURIComponent(head)}`,
  );
  if (res.status === 404) {
    // Which side is missing? Probe the head branch.
    const headRes = await glFetch(
      ctx,
      `${API_BASE}/projects/${project}/repository/branches/${encodeURIComponent(head)}`,
    );
    if (headRes.status === 404) return { status: 'missing_head', base: resolvedBase };
    if (headRes.ok) return { status: 'missing_base', base: resolvedBase };
    return { status: 'unknown', base: resolvedBase, detail: `head probe ${headRes.status}` };
  }
  if (!res.ok) {
    return { status: 'unknown', base: resolvedBase, detail: `compare ${res.status}` };
  }
  const data = await res.json();
  const aheadBy = Array.isArray(data.commits) ? data.commits.length : 0;
  return { status: aheadBy > 0 ? 'ahead' : 'identical', aheadBy, base: resolvedBase };
};

// Get the live state of an MR ('open' | 'closed' | 'merged' | null).
const getPullRequestState = async (ctx, repoId, mrIid) => {
  const status = await getPullRequestStatus(ctx, repoId, mrIid);
  return status?.state ?? null;
};

const getPullRequestStatus = async (ctx, repoId, mrIid) => {
  const project = encodeProject(repoId);
  const res = await glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}`);
  if (!res.ok) return null;
  const mr = await res.json();
  return {
    providerId: mr.id,
    number: mr.iid,
    url: mr.web_url,
    sourceBranch: mr.source_branch ?? null,
    targetBranch: mr.target_branch ?? null,
    headSha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
    targetSha: mr.diff_refs?.base_sha ?? null,
    state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
    draft: Boolean(mr.draft || mr.work_in_progress || /^draft:/i.test(mr.title ?? '')),
    mergeable:
      mr.merge_status === 'can_be_merged' || mr.detailed_merge_status === 'mergeable'
        ? true
        : ['cannot_be_merged', 'conflict'].includes(mr.detailed_merge_status ?? mr.merge_status)
          ? false
          : null,
    mergeableState: mr.detailed_merge_status ?? mr.merge_status ?? null,
    mergedAt: mr.merged_at ?? null,
    closedAt: mr.closed_at ?? null,
    updatedAt: mr.updated_at ?? null,
    title: mr.title ?? '',
  };
};

const setPullRequestDraft = async (ctx, repoId, mrIid, draft) => {
  const project = encodeProject(repoId);
  const current = await getPullRequestStatus(ctx, repoId, mrIid);
  if (!current || current.state !== 'open') return current;
  if (current.draft === draft) return current;
  const plainTitle = String(current.title ?? '').replace(/^draft:\s*/i, '');
  const res = await glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}`, {
    method: 'PUT',
    body: JSON.stringify({ title: draft ? `Draft: ${plainTitle}` : plainTitle }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to change merge request draft');
  }
  return getPullRequestStatus(ctx, repoId, mrIid);
};

const reopenPullRequest = async (ctx, repoId, mrIid) => {
  const project = encodeProject(repoId);
  const res = await glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests/${mrIid}`, {
    method: 'PUT',
    body: JSON.stringify({ state_event: 'reopen' }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new ProviderError(res.status, data?.message || 'Failed to reopen merge request');
  }
  return getPullRequestStatus(ctx, repoId, mrIid);
};

const isCommitAncestor = async (ctx, repoId, ancestorSha, descendantRef) => {
  const project = encodeProject(repoId);
  for (let page = 1; page <= 100; page += 1) {
    const res = await glFetch(
      ctx,
      `${API_BASE}/projects/${project}/repository/commits/${encodeURIComponent(
        ancestorSha,
      )}/refs?type=branch&per_page=100&page=${page}`,
    );
    if (!res.ok) return false;
    const refs = await res.json();
    if (!Array.isArray(refs)) return false;
    if (refs.some((ref) => ref.type === 'branch' && ref.name === descendantRef)) return true;
    if (refs.length < 100) break;
  }
  return false;
};

// Server-side merge of a task branch into the sprint branch. GitLab has no
// "merge arbitrary branch" API like GitHub's /merges, so we open a transient MR
// and merge it. Returns 'merged' | 'conflict' | { error }.
const mergeBranch = async (ctx, repoId, { base, head, message }) => {
  const project = encodeProject(repoId);
  let createRes;
  try {
    createRes = await glFetch(ctx, `${API_BASE}/projects/${project}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        source_branch: head,
        target_branch: base,
        title: message || `Merge ${head} into ${base} (auto)`,
      }),
    });
  } catch (e) {
    return { error: e.message };
  }
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    if (createRes.status === 409) return 'merged';
    return { error: `GitLab create-MR returned ${createRes.status}: ${text.slice(0, 300)}` };
  }
  const mr = await createRes.json();
  const mergeRes = await glFetch(
    ctx,
    `${API_BASE}/projects/${project}/merge_requests/${mr.iid}/merge`,
    { method: 'PUT' },
  );
  if (mergeRes.ok) return 'merged';
  // Per the GitLab merge API, an un-mergeable MR surfaces as 405 (cannot be
  // merged), 409 (SHA mismatch), or 422 (branch cannot be merged — e.g. a real
  // conflict). Treat all of these as a conflict so the orchestrator handles it
  // as "auto-merge couldn't complete" rather than an infrastructure error.
  if ([405, 406, 409, 422].includes(mergeRes.status)) {
    return 'conflict';
  }
  const text = await mergeRes.text().catch(() => '');
  return { error: `GitLab merge returned ${mergeRes.status}: ${text.slice(0, 300)}` };
};

const apiBase = API_BASE;
export {
  id,
  displayName,
  gitHost,
  apiBase,
  buildCloneUrl,
  encodeProject,
  apiHeaders,
  glFetch,
  oauth,
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
  encodeProject,
  apiHeaders,
  glFetch,
  oauth,
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
