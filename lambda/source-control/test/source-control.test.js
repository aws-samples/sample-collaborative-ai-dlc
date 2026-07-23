import { describe, expect, it } from 'vitest';
import {
  bindingStatusForProject,
  executeSourceControlOperation,
  normalizeProviderSelections,
} from '../index.js';

describe('source-control project contract', () => {
  it('requires one authentication type per provider', () => {
    expect(
      normalizeProviderSelections({
        providers: {
          github: { authType: 'github-app' },
          gitlab: { authType: 'gitlab-oauth', confirmDelegation: true },
        },
      }),
    ).toEqual({
      github: { authType: 'github-app' },
      gitlab: { authType: 'gitlab-oauth', confirmDelegation: true },
    });
    expect(() =>
      normalizeProviderSelections({
        bindings: [
          { provider: 'github', authType: 'github-app' },
          { provider: 'github', authType: 'github-oauth' },
        ],
      }),
    ).toThrow(/only one github authentication type/);
  });

  it('reports every unbound project repository without credential details', () => {
    const status = bindingStatusForProject(
      [
        { provider: 'github', repo: 'Acme/API' },
        { provider: 'gitlab', repo: 'Acme/Web' },
      ],
      [
        {
          projectId: 'p1',
          provider: 'github',
          repo: 'acme/api',
          authType: 'github-oauth',
          credentialRef: 'oauth#github#u1',
          connectionUserId: 'u1',
          status: 'active',
          capabilities: { repositoryWrite: true },
        },
      ],
    );
    expect(status.ready).toBe(false);
    expect(status.repositories[0].status).toBe('active');
    expect(status.repositories[1].status).toBe('unbound');
    expect(JSON.stringify(status)).not.toContain('oauth#');
    expect(JSON.stringify(status)).not.toContain('u1');
  });

  it('leaves repository-free projects runnable', () => {
    expect(bindingStatusForProject([], [])).toEqual({ ready: true, repositories: [] });
  });

  it('rejects a repository operation outside the project before credential resolution', async () => {
    await expect(
      executeSourceControlOperation({
        projectId: 'p1',
        provider: 'github',
        repo: 'acme/private',
        operation: 'branches',
        repos: [{ provider: 'github', repo: 'acme/allowed' }],
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_PROJECT' });
  });
});
