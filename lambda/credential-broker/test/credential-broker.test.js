import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeCredentialRequest,
  executionIncludesRepository,
} from '../index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

describe('credential broker authorization', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  });

  it('requires the repository and provider to be on the execution snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['Acme/API', { url: 'group/web', provider: 'gitlab' }],
    };
    expect(executionIncludesRepository(meta, 'github', 'acme/api')).toBe(true);
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
    expect(executionIncludesRepository(meta, 'github', 'acme/other')).toBe(false);
  });

  it('supports the explicit per-repository provider snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['group/web'],
      repoProviders: { 'group/web': 'gitlab' },
    };
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
  });

  it('only permits credentials while an execution can perform repository work', () => {
    expect([...CREDENTIAL_ACTIVE_EXECUTION_STATUSES]).toEqual(['CREATED', 'RUNNING']);
    for (const status of ['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED']) {
      expect(CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(status)).toBe(false);
    }
  });

  it.each(['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED'])(
    'denies credential resolution for terminal/inactive status %s',
    async (status) => {
      ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
        Item: {
          projectId: 'p1',
          status,
          repos: ['acme/api'],
          gitProvider: 'github',
        },
      });
      await expect(
        authorizeCredentialRequest(
          {
            executionId: 'e1',
            projectId: 'p1',
            provider: 'github',
            repository: 'acme/api',
          },
          { ddbClient: ddb },
        ),
      ).rejects.toMatchObject({ code: 'EXECUTION_NOT_ACTIVE' });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    },
  );

  it('denies a repository that was not snapshotted onto the execution', async () => {
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
      Item: {
        projectId: 'p1',
        status: 'RUNNING',
        repos: ['acme/allowed'],
        gitProvider: 'github',
      },
    });
    await expect(
      authorizeCredentialRequest(
        {
          executionId: 'e1',
          projectId: 'p1',
          provider: 'github',
          repository: 'acme/other',
        },
        { ddbClient: ddb },
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });
});
