import { beforeEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  getGitConnection,
  putGitConnection,
  deleteGitConnection,
} from '../git-connection-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEW_TABLE = 'git-provider-connections';
const LEGACY_TABLE = 'git-connections';
const USER = 'user-1';

beforeEach(() => {
  ddbMock.reset();
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', NEW_TABLE);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', LEGACY_TABLE);
});

describe('getGitConnection', () => {
  it('returns the row from the new table without touching the legacy table', async () => {
    const row = {
      userId: USER,
      providerInstance: 'github#public',
      provider: 'github',
      parameterName: '/p/e/git-token/user-1/github',
    };
    ddbMock
      .on(GetCommand, {
        TableName: NEW_TABLE,
        Key: { userId: USER, providerInstance: 'github#public' },
      })
      .resolves({ Item: row });

    const result = await getGitConnection(ddb, USER, 'github');

    expect(result).toEqual(row);
    // No legacy read, no migration write.
    const legacyReads = ddbMock
      .commandCalls(GetCommand)
      .filter((c) => c.args[0].input.TableName === LEGACY_TABLE);
    expect(legacyReads).toHaveLength(0);
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
  });

  it('migrate-on-read: moves a matching legacy row into the new table and deletes the legacy row', async () => {
    const legacy = { userId: USER, provider: 'github', parameterName: '/p/e/git-token/user-1' };
    ddbMock.on(GetCommand, { TableName: NEW_TABLE }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({ Item: legacy });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const result = await getGitConnection(ddb, USER, 'github');

    const expected = {
      ...legacy,
      userId: USER,
      providerInstance: 'github#public',
      provider: 'github',
    };
    expect(result).toEqual(expected);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: NEW_TABLE,
      Item: expected,
    });
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: LEGACY_TABLE,
      Key: { userId: USER },
    });
  });

  it('treats a legacy row without an explicit provider as github', async () => {
    const legacy = { userId: USER, parameterName: '/p/e/git-token/user-1' };
    ddbMock.on(GetCommand, { TableName: NEW_TABLE }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({ Item: legacy });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const result = await getGitConnection(ddb, USER, 'github');

    expect(result.provider).toBe('github');
    expect(result.providerInstance).toBe('github#public');
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
  });

  it('does not satisfy a gitlab request from a legacy github row, and never migrates it', async () => {
    const legacy = { userId: USER, provider: 'github', parameterName: '/p/e/git-token/user-1' };
    ddbMock.on(GetCommand, { TableName: NEW_TABLE }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({ Item: legacy });

    const result = await getGitConnection(ddb, USER, 'gitlab');

    expect(result).toBeNull();
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
  });

  it('returns null when neither table has the connection', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await getGitConnection(ddb, USER, 'github');
    expect(result).toBeNull();
  });

  it('still returns the legacy data when the migration write fails (best-effort)', async () => {
    const legacy = { userId: USER, provider: 'github', parameterName: '/p/e/git-token/user-1' };
    ddbMock.on(GetCommand, { TableName: NEW_TABLE }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({ Item: legacy });
    ddbMock.on(PutCommand).rejects(new Error('AccessDenied'));

    const result = await getGitConnection(ddb, USER, 'github');

    expect(result).toEqual({
      ...legacy,
      userId: USER,
      providerInstance: 'github#public',
      provider: 'github',
    });
    // Put failed, so the legacy row must NOT be deleted.
    expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
  });

  it('returns null for missing userId or provider', async () => {
    expect(await getGitConnection(ddb, '', 'github')).toBeNull();
    expect(await getGitConnection(ddb, USER, '')).toBeNull();
  });
});

describe('putGitConnection', () => {
  it('writes to the new table only, stamping the composite providerInstance key', async () => {
    ddbMock.on(PutCommand).resolves({});
    const item = {
      userId: USER,
      provider: 'gitlab',
      parameterName: '/p/e/git-token/user-1/gitlab',
    };

    await putGitConnection(ddb, item);

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: NEW_TABLE,
      Item: { ...item, providerInstance: 'gitlab#public' },
    });
    const legacyWrites = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === LEGACY_TABLE);
    expect(legacyWrites).toHaveLength(0);
  });

  it('throws when the item lacks userId or provider', async () => {
    await expect(putGitConnection(ddb, { userId: USER })).rejects.toThrow();
    await expect(putGitConnection(ddb, { provider: 'github' })).rejects.toThrow();
  });
});

describe('deleteGitConnection', () => {
  it('deletes from BOTH tables when the legacy row matches the provider', async () => {
    // Legacy row is a GitHub connection; disconnecting GitHub should remove both.
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({
      Item: { userId: USER, provider: 'github', parameterName: '/p/dev/git-token/user-1' },
    });
    ddbMock.on(DeleteCommand).resolves({});

    await deleteGitConnection(ddb, USER, 'github');

    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: NEW_TABLE,
      Key: { userId: USER, providerInstance: 'github#public' },
    });
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: LEGACY_TABLE,
      Key: { userId: USER },
    });
  });

  it('preserves an unmigrated legacy GitHub row when disconnecting a different provider (GitLab)', async () => {
    // User has a new-table GitLab row + an unmigrated legacy GitHub row.
    // Disconnecting GitLab must NOT delete the legacy GitHub connection.
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({
      Item: { userId: USER, provider: 'github', parameterName: '/p/dev/git-token/user-1' },
    });
    ddbMock.on(DeleteCommand).resolves({});

    await deleteGitConnection(ddb, USER, 'gitlab');

    // The new-table GitLab row is deleted...
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: NEW_TABLE,
      Key: { userId: USER, providerInstance: 'gitlab#public' },
    });
    // ...but the legacy GitHub row is left intact (no delete against LEGACY_TABLE).
    const legacyDeletes = ddbMock
      .commandCalls(DeleteCommand)
      .filter((c) => c.args[0].input.TableName === LEGACY_TABLE);
    expect(legacyDeletes).toHaveLength(0);
  });

  it('deletes the legacy row when it has no provider attribute (defaults to github)', async () => {
    // Pre-provider legacy rows lack `provider` and are treated as github.
    ddbMock.on(GetCommand, { TableName: LEGACY_TABLE }).resolves({
      Item: { userId: USER, parameterName: '/p/dev/git-token/user-1' },
    });
    ddbMock.on(DeleteCommand).resolves({});

    await deleteGitConnection(ddb, USER, 'github');

    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: LEGACY_TABLE,
      Key: { userId: USER },
    });
  });

  it('no-ops for missing userId or provider', async () => {
    await deleteGitConnection(ddb, '', 'github');
    expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
  });
});
