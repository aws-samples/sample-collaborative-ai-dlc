import { createGitHandler } from '../shared/git-handler.js';
import githubProvider from '../shared/git-providers/github.js';

// Route-shape descriptors: how to recognise repo-scoped routes and extract the
// repoId ("owner/repo") from the GitHub URL layout. All provider-agnostic
// plumbing lives in shared/git-handler.js.
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
    if (!path.includes('/pulls/') || !path.endsWith('/comments')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments/);
    return m ? { repoId: `${m[1]}/${m[2]}`, prRef: m[3] } : null;
  },
};

export const handler = createGitHandler(githubProvider, routes);
