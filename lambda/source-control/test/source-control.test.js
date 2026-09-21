import { describe, expect, it } from 'vitest';
import {
  SOURCE_CONTROL_OPERATIONS,
  bindingStatusForProject,
  executeSourceControlOperation,
  isSupportedProvider,
  normalizeProviderSelections,
  validateProjectBindings,
} from '../index.js';

const CODECOMMIT_REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';
const CODECOMMIT_ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const CODECOMMIT_BINDING = {
  projectId: 'p1',
  provider: 'codecommit',
  repo: CODECOMMIT_REPO,
  authType: 'codecommit-role',
  credentialRef: `codecommit-role#${CODECOMMIT_ROLE}`,
  roleArn: CODECOMMIT_ROLE,
  externalId: 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e',
  status: 'active',
  capabilities: { repositoryWrite: true },
};

const incompleteSts = () => {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command);
      return { Credentials: {} };
    },
  };
};

const ddbWithBinding = {
  send: async (command) =>
    command.constructor.name === 'QueryCommand'
      ? { Items: [CODECOMMIT_BINDING] }
      : { Item: CODECOMMIT_BINDING },
};

describe('source-control project contract', () => {
  it('classifies tracker closure as a project-bound write operation', () => {
    expect(SOURCE_CONTROL_OPERATIONS['close-issue']).toBe('write');
  });

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

  it('accepts every provider the binding contract knows', () => {
    expect(isSupportedProvider('github')).toBe(true);
    expect(isSupportedProvider('gitlab')).toBe(true);
    expect(isSupportedProvider('bitbucket')).toBe(true);
    expect(isSupportedProvider('codecommit')).toBe(true);
    expect(isSupportedProvider('subversion')).toBe(false);
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

  it('passes STS into live CodeCommit project validation', async () => {
    const stsClient = incompleteSts();
    const result = await validateProjectBindings({
      projectId: 'p1',
      repos: [{ provider: 'codecommit', repo: CODECOMMIT_REPO }],
      ddbClient: ddbWithBinding,
      ssmClient: {},
      secretsClient: {},
      stsClient,
    });
    expect(stsClient.calls).toHaveLength(1);
    expect(result.repositories[0].code).toBe('ROLE_ASSUMPTION_FAILED');
  });

  it('passes STS into CodeCommit runtime operations', async () => {
    const stsClient = incompleteSts();
    await expect(
      executeSourceControlOperation({
        projectId: 'p1',
        provider: 'codecommit',
        repo: CODECOMMIT_REPO,
        operation: 'branches',
        repos: [{ provider: 'codecommit', repo: CODECOMMIT_REPO }],
        ddbClient: ddbWithBinding,
        ssmClient: {},
        secretsClient: {},
        stsClient,
      }),
    ).rejects.toMatchObject({ code: 'ROLE_ASSUMPTION_FAILED' });
    expect(stsClient.calls).toHaveLength(1);
  });
});
