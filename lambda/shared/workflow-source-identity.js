// Pure repository identity contract shared by source binding and native input owners.
import { createHash } from 'node:crypto';

export class WorkflowSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowSourceError';
    this.code = code;
  }
}

const invalid = (message) => {
  throw new WorkflowSourceError('WORKFLOW_SOURCE_INVALID', message);
};
const boundedString = (value, max = 256) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');

export const workflowSourceIdentity = (provider, repository) => {
  if (!['github', 'gitlab', 'bitbucket'].includes(provider)) {
    invalid('Unsupported workflow source provider');
  }
  if (!boundedString(repository, 512)) invalid('Invalid workflow source repository');
  const parts = repository.split('/');
  if (
    parts.length < 2 ||
    (provider !== 'gitlab' && parts.length !== 2) ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  ) {
    invalid('Use a repository identity without a URL or credentials');
  }
  const canonical = repository.toLowerCase();
  return Object.freeze({
    provider,
    repository: canonical,
    sourceId: createHash('sha256').update(`${provider}\n${canonical}`).digest('hex'),
  });
};
