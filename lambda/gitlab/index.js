import { buildResponse } from '../shared/response.js';
import { createGitHandler } from '../shared/git-handler.js';
import gitlabProvider from '../shared/git-providers/gitlab.js';

// Route-shape descriptors for the GitLab URL layout. GitLab project paths are
// namespaced (group/project, often group/subgroup/project). Encoded slashes in
// an API Gateway REST path segment are fragile, so the project reference
// travels as a `?project=<fullName>` QUERY STRING rather than a path segment.
// The provider re-encodes it into the GitLab API path per call.
//
// `routes.*` receive (path, query) and return the repoId (the decoded project
// fullName) — or, for comments, { repoId, prRef }. mrIid stays a path segment
// because it is numeric and therefore slash-free.
const projectFromQuery = (query) => {
  const project = query?.project;
  return project ? decodeURIComponent(project) : null;
};

const routes = {
  branches: (path, query) => (path.endsWith('/projects/branches') ? projectFromQuery(query) : null),
  tree: (path, query) => (path.endsWith('/projects/tree') ? projectFromQuery(query) : null),
  contents: (path, query) => (path.endsWith('/projects/contents') ? projectFromQuery(query) : null),
  comments: (path, query) => {
    if (!path.includes('/merge_requests/') || !path.endsWith('/notes')) return null;
    const m = path.match(/\/merge_requests\/(\d+)\/notes$/);
    const repoId = projectFromQuery(query);
    return m && repoId ? { repoId, prRef: m[1] } : null;
  },
};

export const handler = async (event) => {
  const query = event.queryStringParameters ?? {};
  let instance;
  try {
    if (event.path?.endsWith('/callback') && query.code && query.state) {
      // This unverified routing hint only selects a registered secret. The
      // shared handler verifies the signature and instance before exchange.
      const [state, signature] = decodeURIComponent(query.state).split('.');
      if (!/^[a-f0-9]{64}$/.test(signature ?? '')) throw new Error('Invalid OAuth state');
      instance = JSON.parse(Buffer.from(state, 'base64').toString()).instance;
    } else {
      instance = query.instance ?? gitlabProvider.instanceFor(projectFromQuery(query));
    }
    if (instance !== undefined) gitlabProvider.oauth.secretNameFor(instance);
  } catch {
    return buildResponse(event)(400, {
      error: 'Invalid OAuth state or unregistered GitLab instance',
    });
  }
  return createGitHandler(gitlabProvider, routes, instance)(event);
};
