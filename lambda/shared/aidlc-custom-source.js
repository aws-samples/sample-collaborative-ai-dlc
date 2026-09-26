// Issue #482 follow-up: the identity rules for a CUSTOM AI-DLC source — a fork
// of aidlc-workflows that an operator wants to import for inspection.
//
// This module is deliberately tiny and dependency-free so both the fetcher
// (repo-fetch.js, which drags in tar-stream) and the profile registry
// (aidlc-compatibility-profiles.js, which must stay cheap to bundle) can share
// exactly one definition of "what is a legal GitHub owner/repo".
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

/**
 * Splits an `owner/name` slug into its validated halves. Exactly one slash is
 * allowed: a nested namespace is not a GitHub repository path and would break
 * the one-segment-per-level key layout.
 */
const parseRepositorySlug = (repository) => {
  const value = typeof repository === 'string' ? repository.trim() : '';
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
  return { owner, repo, repository: `${owner}/${repo}` };
};

export {
  CustomSourceError,
  GITHUB_OWNER_RE,
  GITHUB_REPO_RE,
  assertGithubOwner,
  assertGithubRepo,
  isGithubOwner,
  isGithubRepo,
  parseRepositorySlug,
};

export default {
  CustomSourceError,
  GITHUB_OWNER_RE,
  GITHUB_REPO_RE,
  assertGithubOwner,
  assertGithubRepo,
  isGithubOwner,
  isGithubRepo,
  parseRepositorySlug,
};
