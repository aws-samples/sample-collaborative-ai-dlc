import path from 'node:path';
import { isValidRepoPath } from '../shared/repo-validation.js';

// Use the same layout for checkout, recovery, and lane operations. Validate
// before path resolution so dot segments cannot collapse onto another checkout
// or the workspace root, which failed-clone cleanup may remove.
export const repoTargetDir = ({ url, workspaceDir, multi }) => {
  if (!isValidRepoPath(url)) throw new Error('Invalid repository path');
  return multi ? path.resolve(workspaceDir, url) : path.resolve(workspaceDir);
};

// Git reports changed paths RELATIVE TO THE REPO it ran in, but the sensor
// runner globs paths relative to the WORKSPACE root. In multi-repo mode those
// two spaces differ by the repo directory, so a `fire_on: write` sensor matching
// `**/*.ts` would silently match nothing. Project a repo-relative path into the
// workspace space using the same layout `repoTargetDir` produces.
export const workspaceRelativePath = ({ repo, file, multi }) => {
  if (typeof file !== 'string' || file === '') return null;
  if (!multi) return file;
  if (!isValidRepoPath(repo)) return null;
  return `${repo}/${file}`;
};
