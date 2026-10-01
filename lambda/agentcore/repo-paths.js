import path from 'node:path';
import {
  assertUniqueCheckoutPaths,
  isValidRepoPath,
  repoCheckoutPath,
} from '../shared/repo-validation.js';

// Use the same layout for checkout, recovery, lane operations and traceability.
// Validate before path resolution so dot segments cannot collapse onto another
// checkout or the workspace root, which failed-clone cleanup may remove. A
// CodeCommit ARN checks out under codecommit/<partition>/<region>/<account>/<name>.
export const repoTargetDir = ({ url, workspaceDir, multi }) => {
  if (!isValidRepoPath(url)) throw new Error('Invalid repository path');
  return multi ? path.resolve(workspaceDir, repoCheckoutPath(url)) : path.resolve(workspaceDir);
};

// Resolve every target of a batch, refusing the batch when two repositories
// would share (or nest) a directory. Callers run this before creating any
// directory or touching any remote.
export const repoTargetDirs = ({ repos, workspaceDir }) => {
  const urls = repos.map((repo) => (typeof repo === 'string' ? repo : repo?.url));
  const multi = repos.length > 1;
  if (multi) assertUniqueCheckoutPaths(urls);
  return repos.map((repo, index) => ({
    repo,
    url: urls[index],
    targetDir: repoTargetDir({ url: urls[index], workspaceDir, multi }),
  }));
};
