// Shared shell-injection guards for repo identifiers and git refs.
//
// These values become git clone URLs and workspace directory paths (the v2
// agentcore checkout), so this is the authoritative injection gate. It lived in
// two copies (agents + projects lambdas) that had already drifted (one capped
// length, the other didn't); keeping a single definition here prevents a future
// hardening fix from being applied to one lambda but not the other.
//
// Consumed by:
//   - lambda/projects/index.js via '../shared/repo-validation.js' (esbuild bundles ../shared)

// Reject anything that could break out of a double-quoted shell string
// ("  `  $  \  whitespace). Freeform values (bare names, SSH URLs) still pass.
const SHELL_SAFE_REPO_PATTERN = /^[A-Za-z0-9._@:/-]+$/;

// Provider-returned repository paths may contain nested namespaces. Enforce
// filesystem-safe segments, leaving provider naming rules and lengths alone.
const REPO_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

// CodeCommit repositories are identified by ARN (there is no owner/name pair;
// region and account are part of the identity). Kept as a regex here rather
// than importing the provider module so this file stays a leaf. The name
// charset is CodeCommit's own (\w . -), a strict subset of REPO_PATH_PATTERN.
const CODECOMMIT_REPO_ARN_PATTERN =
  /^arn:(aws|aws-cn|aws-us-gov):codecommit:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([\w.-]{1,100})$/;

// Where a repository checks out under the workspace root, relative. Path-shaped
// ids (github/gitlab/bitbucket "owner/repo", nested groups) are used verbatim;
// a CodeCommit ARN maps to "<account>/<name>" so multi-repo layouts keep the
// same two-segment shape and a repository name can never collide with an
// owner directory from another provider.
const repoRelativePath = (value) => {
  if (typeof value !== 'string') return null;
  const arn = CODECOMMIT_REPO_ARN_PATTERN.exec(value);
  return arn ? `${arn[3]}/${arn[4]}` : value;
};

const isValidRepoPath = (value) => {
  const rel = repoRelativePath(value);
  return (
    typeof rel === 'string' &&
    REPO_PATH_PATTERN.test(rel) &&
    rel.split('/').every((segment) => segment !== '.' && segment !== '..')
  );
};

// Git refs: letters, digits, ., _, /, - only. No leading dash (arg injection),
// no ".." and no "@{" (git revision syntax).
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

// Shell-safe AND traversal-safe repo identifier. Rejects "..", which the raw
// pattern would otherwise allow (e.g. "../../foo"), keeping the value safe for
// both the clone URL and the "/workspace/${url}" directory interpolation.
const isSafeRepo = (v) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 200 &&
  SHELL_SAFE_REPO_PATTERN.test(v) &&
  !v.includes('..');

const isSafeRef = (v) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 200 &&
  GIT_REF_PATTERN.test(v) &&
  !v.startsWith('-') &&
  !v.includes('..') &&
  !v.includes('@{');

export {
  SHELL_SAFE_REPO_PATTERN,
  GIT_REF_PATTERN,
  CODECOMMIT_REPO_ARN_PATTERN,
  isSafeRepo,
  isSafeRef,
  isValidRepoPath,
  repoRelativePath,
};
export default {
  SHELL_SAFE_REPO_PATTERN,
  GIT_REF_PATTERN,
  CODECOMMIT_REPO_ARN_PATTERN,
  isSafeRepo,
  isSafeRef,
  isValidRepoPath,
  repoRelativePath,
};
