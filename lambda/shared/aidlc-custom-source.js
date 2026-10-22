// Issue #482 follow-up: the identity rules for a CUSTOM AI-DLC source — a fork
// of aidlc-workflows that an operator wants to import for inspection.
//
// This module is deliberately tiny and dependency-free so both the fetcher
// (repo-fetch.js, which drags in tar-stream) and the profile registry
// (aidlc-compatibility-profiles.js, which must stay cheap to bundle) can share
// exactly one definition of "what is a legal GitHub owner/repo" (or GitLab
// project path).
//
// Everything here is fail-closed: a name that does not match the strict GitHub
// grammar is rejected rather than escaped, because the value ends up in a URL
// path AND in an immutable S3 key prefix. A traversal segment (`.`, `..`) or a
// slash inside either half would let one release's bytes land on another's
// prefix, so those are refused outright.

// GitHub logins: 1-39 chars, alphanumeric or single hyphens, no leading or
// trailing hyphen.
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// GitHub repository names: 1-100 chars from [A-Za-z0-9._-]. `.` and `..` are
// legal characters but not legal whole names.
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

class CustomSourceError extends Error {
  constructor(code, message, { details = null } = {}) {
    super(message);
    this.name = 'CustomSourceError';
    this.code = code;
    this.details = details;
  }
}

const isGithubOwner = (value) => typeof value === 'string' && GITHUB_OWNER_RE.test(value);

const isGithubRepo = (value) =>
  typeof value === 'string' &&
  GITHUB_REPO_RE.test(value) &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('..');

const assertGithubOwner = (owner) => {
  if (!isGithubOwner(owner)) {
    throw new CustomSourceError(
      'custom_source_owner_invalid',
      `aidlc-custom-source: "${String(owner)}" is not a valid GitHub owner`,
      { details: { owner: String(owner ?? '') } },
    );
  }
  return owner;
};

const assertGithubRepo = (repo) => {
  if (!isGithubRepo(repo)) {
    throw new CustomSourceError(
      'custom_source_repo_invalid',
      `aidlc-custom-source: "${String(repo)}" is not a valid GitHub repository name`,
      { details: { repo: String(repo ?? '') } },
    );
  }
  return repo;
};

// A GitLab source is written `gitlab:<namespace>/<project>`, where the
// namespace may be nested (`group/subgroup/project`). It is fetched from the
// deployment's configured GitLab instance (gitlab.com by default) through the
// project archive API, optionally with a read token, so a fork can stay in a
// private repository. The prefix keeps every existing GitHub slug unchanged.
const GITLAB_PREFIX = 'gitlab:';
// GitLab path segments: letters, digits, `_`, `-` and `.`; they cannot start
// with `-` or `.`, nor end with `.git` or `.atom`. `.`, `..` and any `..` are
// refused, as for GitHub names.
const GITLAB_SEGMENT_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$/;
// GitLab nests at most 20 subgroups under a top-level group, plus the project.
const GITLAB_MAX_SEGMENTS = 22;
const GITLAB_MAX_PATH_LENGTH = 255;

const isGitlabSegment = (value) =>
  typeof value === 'string' &&
  GITLAB_SEGMENT_RE.test(value) &&
  !value.includes('..') &&
  !/\.(git|atom)$/i.test(value);

const isGitlabProjectPath = (value) => {
  if (typeof value !== 'string' || value.length > GITLAB_MAX_PATH_LENGTH) return false;
  const segments = value.split('/');
  return (
    segments.length >= 2 &&
    segments.length <= GITLAB_MAX_SEGMENTS &&
    segments.every(isGitlabSegment)
  );
};

const parseGitlabRepository = (value) => {
  const path = value.slice(GITLAB_PREFIX.length);
  if (!isGitlabProjectPath(path)) {
    throw new CustomSourceError(
      'custom_source_repository_invalid',
      `aidlc-custom-source: "${value}" is not a valid GitLab project ("gitlab:<namespace>/<project>")`,
      { details: { repository: value } },
    );
  }
  return {
    provider: 'gitlab',
    path,
    repository: `${GITLAB_PREFIX}${path}`,
    // One key segment per level, as for GitHub: the whole project path is
    // percent-encoded into ONE segment under `gitlab/`. A GitHub repository
    // name cannot contain `%`, so no GitHub `gitlab/<name>` prefix can collide.
    keySegments: ['gitlab', encodeURIComponent(path)],
  };
};

/**
 * Parses a custom source repository. `owner/name` is a GitHub repository:
 * exactly one slash, because a nested namespace is not a GitHub repository path
 * and would break the one-segment-per-level key layout.
 * `gitlab:<namespace>/<project>` is a GitLab project on the configured instance.
 *
 * Returns `{ provider, repository, keySegments }` plus `owner`/`repo` for
 * GitHub or `path` for GitLab. `repository` is the canonical identity.
 */
const parseRepositorySlug = (repository) => {
  const value = typeof repository === 'string' ? repository.trim() : '';
  if (value.startsWith(GITLAB_PREFIX)) return parseGitlabRepository(value);
  const parts = value.split('/');
  if (parts.length !== 2) {
    throw new CustomSourceError(
      'custom_source_repository_invalid',
      `aidlc-custom-source: repository must be "owner/name", got "${String(repository)}"`,
      { details: { repository: value } },
    );
  }
  const [owner, repo] = parts;
  assertGithubOwner(owner);
  assertGithubRepo(repo);
  return {
    provider: 'github',
    owner,
    repo,
    repository: `${owner}/${repo}`,
    keySegments: [owner, repo],
  };
};

export {
  CustomSourceError,
  GITHUB_OWNER_RE,
  GITHUB_REPO_RE,
  GITLAB_PREFIX,
  assertGithubOwner,
  assertGithubRepo,
  isGithubOwner,
  isGithubRepo,
  isGitlabProjectPath,
  parseRepositorySlug,
};

export default {
  CustomSourceError,
  GITHUB_OWNER_RE,
  GITHUB_REPO_RE,
  GITLAB_PREFIX,
  assertGithubOwner,
  assertGithubRepo,
  isGithubOwner,
  isGithubRepo,
  isGitlabProjectPath,
  parseRepositorySlug,
};
