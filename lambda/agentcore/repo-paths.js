import path from 'node:path';
import { isValidRepoPath, repoRelativePath } from '../shared/repo-validation.js';

// Use the same layout for checkout, recovery, and lane operations. Validate
// before path resolution so dot segments cannot collapse onto another checkout
// or the workspace root, which failed-clone cleanup may remove. A CodeCommit
// ARN checks out under <account>/<name>, keeping the owner/repo shape.
export const repoTargetDir = ({ url, workspaceDir, multi }) => {
  if (!isValidRepoPath(url)) throw new Error('Invalid repository path');
  return multi ? path.resolve(workspaceDir, repoRelativePath(url)) : path.resolve(workspaceDir);
};
