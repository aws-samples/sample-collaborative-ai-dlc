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

export { SHELL_SAFE_REPO_PATTERN, GIT_REF_PATTERN, isSafeRepo, isSafeRef };
export default { SHELL_SAFE_REPO_PATTERN, GIT_REF_PATTERN, isSafeRepo, isSafeRef };
