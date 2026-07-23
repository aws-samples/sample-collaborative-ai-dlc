import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  appCredentialRef,
  bindingKeyFor,
  canonicalRepo,
  getBinding,
  invalidateBindingsByCredentialRef,
  oauthCredentialRef,
  replaceProjectBindings,
  sanitizeBinding,
} from '../source-control-bindings.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

describe('source-control bindings', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  });

  it('canonicalizes repository URLs and builds opaque credential references', () => {
    expect(canonicalRepo('github', 'https://github.com/Acme/API.git')).toBe('acme/api');
    expect(bindingKeyFor('gitlab', 'Group/Sub/Repo')).toBe('gitlab#group/sub/repo');
    expect(bindingKeyFor('bitbucket', 'Workspace/Repo.git')).toBe('bitbucket#workspace/repo');
    expect(oauthCredentialRef('github', 'user-1')).toBe('oauth#github#user-1');
    expect(appCredentialRef('1234')).toBe('github-app#1234');
  });

  it('looks up a project-scoped repository binding consistently', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { projectId: 'p1', status: 'active' } });
    expect(await getBinding(ddb, 'p1', 'github', 'Acme/API')).toMatchObject({
      projectId: 'p1',
    });
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input).toMatchObject({
      TableName: 'bindings',
      Key: { projectId: 'p1', bindingKey: 'github#acme/api' },
      ConsistentRead: true,
    });
  });

  it('atomically replaces all bindings and deletes stale repositories', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { projectId: 'p1', bindingKey: 'github#acme/old' },
        { projectId: 'p1', bindingKey: 'github#acme/api' },
      ],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const saved = await replaceProjectBindings(
      ddb,
      'p1',
      [
        {
          provider: 'github',
          repo: 'Acme/API',
          authType: 'github-oauth',
          credentialRef: oauthCredentialRef('github', 'u1'),
          connectionUserId: 'u1',
          capabilities: { contents: 'write' },
        },
      ],
      { actor: 'u1', now: '2026-07-20T10:00:00.000Z' },
    );

    expect(saved[0]).not.toHaveProperty('parameterName');
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(tx).toHaveLength(2);
    expect(tx[0].Put.Item).toMatchObject({
      projectId: 'p1',
      bindingKey: 'github#acme/api',
      credentialBindingKey: 'p1#github#acme/api',
      status: 'active',
    });
    expect(tx[1].Delete.Key).toEqual({
      projectId: 'p1',
      bindingKey: 'github#acme/old',
    });
  });

  it('invalidates every binding that depends on a disconnected credential', async () => {
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [
        { projectId: 'p1', bindingKey: 'github#acme/a' },
        { projectId: 'p2', bindingKey: 'github#acme/b' },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    expect(
      await invalidateBindingsByCredentialRef(
        ddb,
        oauthCredentialRef('github', 'u1'),
        'oauth_disconnected',
        { actor: 'u1', now: '2026-07-20T10:00:00.000Z' },
      ),
    ).toBe(2);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).not.toHaveProperty(
      'credentialRef',
    );
  });

  it('never exposes credential references or user ids in member views', () => {
    const binding = {
      provider: 'github',
      repo: 'acme/api',
      authType: 'github-oauth',
      credentialRef: 'oauth#github#secret-user-id',
      connectionUserId: 'secret-user-id',
      connectionDisplayName: 'Owner',
      status: 'active',
      capabilities: { contents: 'write' },
    };
    const member = sanitizeBinding(binding);
    expect(JSON.stringify(member)).not.toContain('secret-user-id');
    expect(member).not.toHaveProperty('credentialRef');
    expect(sanitizeBinding(binding, { privileged: true }).delegatedBy).toBe('Owner');
  });
});
