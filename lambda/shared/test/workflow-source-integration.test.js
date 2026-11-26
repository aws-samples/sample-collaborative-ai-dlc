import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createWorkflowSourceService } from '../workflow-source-service.js';
import { resolveReadOnlySourceCredential } from '../source-control-credentials.js';
import { gitConnectionIdentity } from '../git-connection-identity.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const membership = (actorId) => ({
  role: actorId === 'owner' ? 'owner' : 'member',
  membershipId: `${actorId}-edge-1`,
  projectIdentity: 'project-vertex-1',
});
const acceptConditionalWrite = (current, input) => {
  const matches =
    input.ConditionExpression === 'attribute_not_exists(sourceId)'
      ? !current
      : input.ConditionExpression === '#revision = :expected' &&
        current?.revision === input.ExpressionAttributeValues[':expected'];
  if (!matches) {
    throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
  }
  return structuredClone(input.Item);
};

describe('workflow source service with membership snapshots and the real credential adapter', () => {
  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-bindings');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'application-bindings');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'connections');
    vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'verifies and selects a private %s source without exposing its token or granting writes',
    async (provider) => {
      let binding;
      const connection = {
        userId: 'owner',
        provider,
        createdAt: '2026-09-18T08:00:00.000Z',
        generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739',
        parameterName: `/test/dev/git-token/owner/${provider}-039d1c06-8e25-4a24-a31e-6bdb6b55f739`,
        // Read access is proved live without requiring application write scopes.
        scope: '',
      };
      ddbMock.on(GetCommand, { TableName: 'connections' }).resolves({ Item: connection });
      ddbMock
        .on(GetCommand, { TableName: 'workflow-bindings' })
        .callsFake(async () => ({ Item: binding }));
      ddbMock.on(PutCommand, { TableName: 'workflow-bindings' }).callsFake(async (input) => {
        binding = acceptConditionalWrite(binding, input);
        return {};
      });
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify({
            accessToken: 'private-provider-token',
            expiresAt: Date.now() + 3_600_000,
          }),
        },
      });
      const fetchMock = vi.fn(async () =>
        Response.json(
          provider === 'bitbucket' ? { values: [{ name: 'main' }] } : [{ name: 'main' }],
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const memberships = new Map([
        ['owner', membership('owner')],
        ['member', membership('member')],
      ]);
      const service = createWorkflowSourceService({
        ddb,
        ssm,
        getMembershipSnapshot: async (_, actorId) => memberships.get(actorId) ?? null,
      });
      const view = await service.configure({
        projectId: 'p1',
        actorId: 'owner',
        selection: {
          provider,
          repository: 'acme/workflows',
          authType: `${provider}-oauth`,
          confirmDelegation: true,
        },
        expectedRevision: null,
      });
      expect(view).toMatchObject({ provider, status: 'active', access: 'read' });
      expect(binding).toMatchObject({
        purpose: 'workflow-source',
        projectIdentity: 'project-vertex-1',
        delegatorMembershipIdentity: 'owner-edge-1',
        connectionCreatedAt: connection.createdAt,
        connectionIdentity: gitConnectionIdentity(connection),
        capabilities: { repositoryRead: true, repositoryWrite: false, contents: 'read' },
      });
      expect(JSON.stringify(view)).not.toMatch(
        /private-provider-token|credentialRef|connectionUserId|connectionIdentity|projectIdentity|delegatorMembershipIdentity/,
      );
      expect(JSON.stringify(binding)).not.toMatch(/private-provider-token|parameterName/);

      const authorized = await service.getAuthorizedBinding({
        projectId: 'p1',
        actorId: 'member',
        sourceId: view.sourceId,
        expectedRevision: view.revision,
      });
      const credential = await resolveReadOnlySourceCredential({ ddb, ssm, binding: authorized });
      expect(credential).toMatchObject({
        purpose: 'workflow-source',
        token: 'private-provider-token',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, options] of fetchMock.mock.calls) {
        expect(options.method).toBe('GET');
        expect(options.redirect).toBe('error');
      }
      expect(
        ddbMock.calls().some((call) => call.args[0].input.TableName === 'application-bindings'),
      ).toBe(false);

      // The existing global connection remains valid, but a new membership edge
      // cannot inherit the removed owner's workflow-source delegation.
      memberships.set('owner', { ...membership('owner'), membershipId: 'owner-edge-2' });
      const tokenReads = ssmMock.commandCalls(GetParameterCommand).length;
      await expect(
        service.getAuthorizedBinding({
          projectId: 'p1',
          actorId: 'member',
          sourceId: view.sourceId,
          expectedRevision: view.revision,
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_INVALID' });
      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(tokenReads);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    ['github', 'gitlab', 'bitbucket'].flatMap((provider) =>
      ['parameterName', 'generation'].map((changedField) => ({ provider, changedField })),
    ),
  )(
    'rejects a same-timestamp $provider reconnect with changed $changedField',
    async ({ provider, changedField }) => {
      let binding;
      let connection = {
        userId: 'owner',
        provider,
        providerInstance: `${provider}#public`,
        createdAt: '2026-09-18T08:00:00.000Z',
        generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739',
        parameterName: `/test/dev/git-token/owner/${provider}-039d1c06-8e25-4a24-a31e-6bdb6b55f739`,
        scope: '',
      };
      ddbMock
        .on(GetCommand, { TableName: 'connections' })
        .callsFake(async () => ({ Item: { ...connection } }));
      ddbMock
        .on(GetCommand, { TableName: 'workflow-bindings' })
        .callsFake(async () => ({ Item: binding }));
      ddbMock.on(PutCommand, { TableName: 'workflow-bindings' }).callsFake(async (input) => {
        binding = acceptConditionalWrite(binding, input);
        return {};
      });
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: JSON.stringify({ accessToken: 'old-connection-token' }) },
      });
      const fetchMock = vi.fn(async () =>
        Response.json(provider === 'bitbucket' ? { values: [] } : []),
      );
      vi.stubGlobal('fetch', fetchMock);
      const service = createWorkflowSourceService({
        ddb,
        ssm,
        getMembershipSnapshot: async (_, actorId) => membership(actorId),
      });
      const configured = await service.configure({
        projectId: 'p1',
        actorId: 'owner',
        selection: {
          provider,
          repository: 'acme/workflows',
          authType: `${provider}-oauth`,
          confirmDelegation: true,
        },
        expectedRevision: null,
      });
      const pinnedIdentity = binding.connectionIdentity;
      connection = {
        ...connection,
        [changedField]:
          changedField === 'parameterName'
            ? `/test/dev/git-token/owner/${provider}-5c7c48ee-f9d0-46e5-b033-c66a9bf8b59d`
            : '5c7c48ee-f9d0-46e5-b033-c66a9bf8b59d',
      };
      expect(binding.connectionCreatedAt).toBe(connection.createdAt);
      expect(pinnedIdentity).not.toBe(gitConnectionIdentity(connection));
      const authorized = await service.getAuthorizedBinding({
        projectId: 'p1',
        actorId: 'owner',
        sourceId: configured.sourceId,
        expectedRevision: configured.revision,
      });
      const tokenReads = ssmMock.commandCalls(GetParameterCommand).length;
      await expect(
        resolveReadOnlySourceCredential({ ddb, ssm, binding: authorized }),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(tokenReads);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Fresh explicit consent may bind the new incarnation; the old binding
      // cannot silently inherit it.
      await service.configure({
        projectId: 'p1',
        actorId: 'owner',
        selection: {
          provider,
          repository: 'acme/workflows',
          authType: `${provider}-oauth`,
          confirmDelegation: true,
        },
        expectedRevision: configured.revision,
      });
      expect(binding.connectionIdentity).toBe(gitConnectionIdentity(connection));
      expect(binding.connectionIdentity).not.toBe(pinnedIdentity);
    },
  );
});
