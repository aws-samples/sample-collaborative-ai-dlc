import { describe, expect, it } from 'vitest';
import { missingScopes, parseScopes } from '../source-control-credentials.js';

describe('source-control credential validation', () => {
  it('normalizes comma and whitespace separated OAuth scopes', () => {
    expect([...parseScopes('repo, workflow read:user')]).toEqual(['repo', 'workflow', 'read:user']);
  });

  it('requires the complete GitHub private-repository scope set', () => {
    expect(missingScopes({ scope: 'workflow read:user' }, 'github')).toEqual(['repo']);
    expect(missingScopes({ scope: 'repo workflow read:user' }, 'github')).toEqual([]);
  });

  it('requires GitLab api and read_user scopes', () => {
    expect(missingScopes({ scope: 'api' }, 'gitlab')).toEqual(['read_user']);
    expect(missingScopes({ scope: 'api read_user' }, 'gitlab')).toEqual([]);
  });
});
