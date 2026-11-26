import { ProviderError } from './git-providers/errors.js';

// Self-managed repository IDs carry their host through existing bindings, intent
// snapshots, tracker keys and git commands. Unqualified paths retain SaaS identity.
export const parseGitlabRepo = (repo) => {
  if (typeof repo !== 'string' || !repo.startsWith('gitlab:'))
    return { instance: undefined, path: repo };
  const match = /^gitlab:([^/]+)\/(.+)$/.exec(repo);
  if (
    !match ||
    !validInstance(match[1]) ||
    !match[2].split('/').every(validSegment) ||
    !match[2].includes('/')
  ) {
    throw new ProviderError(400, 'Invalid self-managed GitLab repository');
  }
  return { instance: match[1], path: match[2] };
};

const validSegment = (part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..';
export const validInstance = (host) => {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::[1-9]\d{0,4})?$/.test(host)) return false;
  const [hostname, port] = host.split(':');
  return (
    hostname !== 'gitlab.com' &&
    hostname !== 'public' &&
    hostname.length <= 253 &&
    (!port || (Number(port) <= 65535 && Number(port) !== 443)) &&
    hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
};
