import { ProviderError } from './errors.js';

const invoke = (ctx, repository, operation, args = {}) => {
  if (typeof ctx?.sourceControl !== 'function') {
    throw new ProviderError(503, 'Project source control is not configured');
  }
  return ctx.sourceControl({ repository, operation, args });
};

const listIssues = (ctx, repository, options = {}) =>
  invoke(ctx, repository, 'list-issues', options);

const getIssue = (ctx, repository, resourceId) =>
  invoke(ctx, repository, 'get-issue', { number: resourceId });

const getIssueDiscussion = (ctx, repository, resourceId) =>
  invoke(ctx, repository, 'list-issue-comments', { number: resourceId });

const addIssueComment = (ctx, repository, resourceId, body) =>
  invoke(ctx, repository, 'add-issue-comment', { number: resourceId, body });

const listExternalProjects = async () => {
  throw new ProviderError(
    501,
    'GitLab repository discovery lives at the personal /gitlab/repos endpoint',
  );
};

export const provider = {
  id: 'gitlab-issues',
  listExternalProjects,
  listIssues,
  getIssue,
  getIssueDiscussion,
  addIssueComment,
};
