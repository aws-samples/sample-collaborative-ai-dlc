import { createGitHandler } from '../shared/git-handler.js';
import bitbucketProvider from '../shared/git-providers/bitbucket.js';

// Route-shape descriptors for the Bitbucket URL layout. Bitbucket uses
// "workspace/repo_slug" references similar to GitHub's "owner/repo" pattern,
// so we can use path segments directly (unlike GitLab which uses query strings
// due to nested groups).
const routes = {
  branches: (path) => {
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/branches$/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  tree: (path) => {
    if (!path.includes('/tree')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/tree/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  contents: (path) => {
    if (!path.includes('/contents')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/contents/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  comments: (path) => {
    if (!path.includes('/pullrequests/') || !path.endsWith('/comments')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/pullrequests\/(\d+)\/comments/);
    return m ? { repoId: `${m[1]}/${m[2]}`, prRef: m[3] } : null;
  },
};

export const handler = createGitHandler(bitbucketProvider, routes);
