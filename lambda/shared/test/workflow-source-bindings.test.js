import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  deleteWorkflowSourceBinding,
  getWorkflowSourceBinding,
  listWorkflowSourceBindings,
  prepareWorkflowSourceBinding,
  requireWorkflowSourceRevision,
  saveWorkflowSourceBinding,
  workflowSourceIdentity,
  workflowSourceView,
} from '../workflow-source-bindings.js';
import { gitConnectionIdentity } from '../git-connection-identity.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const firstRevision = 'f6d92474-ed64-4d1c-947d-9e9a2ee1fc49';
const secondRevision = '66c8b583-f137-485f-bc16-7285e0d03e55';
const verified = {
  purpose: 'workflow-source',
  authType: 'github-oauth',
  credentialRef: 'oauth#github#owner',
  connectionUserId: 'owner',
  connectionCreatedAt: '2026-09-18T10:00:00.000Z',
  connectionIdentity: gitConnectionIdentity({
    provider: 'github',
    userId: 'owner',
    parameterName: '/test/dev/git-token/owner/github',
    createdAt: '2026-09-18T10:00:00.000Z',
  }),
  capabilities: { repositoryRead: true, repositoryWrite: false, contents: 'read' },
};
const input = () => ({
  projectId: 'p1',
  provider: 'github',
  repository: 'Acme/Workflows',
  actorId: 'owner',
  revision: firstRevision,
  verified: { ...verified },
});
const authorization = () => ({
  role: 'owner',
  membershipId: 'neptune-owner-edge',
  projectIdentity: 'neptune-project-vertex',
});

describe('separate workflow source bindings', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'application-bindings');
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-bindings');
  });

  it.each(['github', 'gitlab', 'bitbucket'])('canonicalizes %s identities', (provider) => {
    const a = workflowSourceIdentity(provider, 'Acme/Workflows');
    expect(a).toEqual(workflowSourceIdentity(provider, 'acme/workflows'));
    expect(a.sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(a.repository).toBe('acme/workflows');
  });

  it('supports GitLab subgroups without mixing provider identities', () => {
    expect(workflowSourceIdentity('gitlab', 'Group/Sub/Repo').repository).toBe('group/sub/repo');
    expect(workflowSourceIdentity('github', 'acme/workflows').sourceId).not.toBe(
      workflowSourceIdentity('bitbucket', 'acme/workflows').sourceId,
    );
  });

  it.each([
    ['github', 'https://user:token@github.com/acme/workflows'],
    ['github', 'acme/sub/workflows'],
    ['bitbucket', 'acme/sub/workflows'],
    ['gitlab', 'group/../repo'],
    ['gitlab', 'group//repo'],
    ['gitlab', 'group/./repo'],
    ['github', 'acme/repo\nsecret'],
    ['github', 'acme/repo?token=secret'],
    ['github', 'acme\\repo'],
    ['github', 'a/'.repeat(600)],
    ['unknown', 'acme/repo'],
  ])('rejects unsafe source %s %s', (provider, repository) => {
    expect(() => workflowSourceIdentity(provider, repository)).toThrow();
  });

  it('persists a whitelist and exposes no credential or delegation fields', () => {
    const item = prepareWorkflowSourceBinding({
      ...input(),
      token: 'caller-secret',
      parameterName: '/caller/path',
      verified: {
        ...verified,
        token: 'provider-secret',
        parameterName: '/provider/path',
        actorEmail: 'private@example.com',
        capabilities: { ...verified.capabilities, issues: 'write' },
      },
    });
    expect(item.capabilities).toEqual({
      repositoryRead: true,
      repositoryWrite: false,
      contents: 'read',
    });
    expect(item).toMatchObject({
      purpose: 'workflow-source',
      repository: 'acme/workflows',
      repo: 'acme/workflows',
      connectionCreatedAt: verified.connectionCreatedAt,
      connectionIdentity: verified.connectionIdentity,
    });
    expect(JSON.stringify(item)).not.toMatch(/secret|parameterName|private@example/);
    const view = workflowSourceView(item);
    expect(view.access).toBe('read');
    expect(JSON.stringify(view)).not.toMatch(
      /credentialRef|connectionUserId|connectionIdentity|CreatedAt|owner/,
    );
  });

  it.each([
    { purpose: undefined },
    { purpose: 'application' },
    { connectionUserId: 'someone-else' },
    { credentialRef: 'oauth#github#someone-else' },
    { connectionCreatedAt: undefined },
    { connectionCreatedAt: '2026-09-18' },
    { connectionIdentity: undefined },
    { connectionIdentity: null },
    { connectionIdentity: '/provider/path' },
    { connectionIdentity: 'A'.repeat(64) },
    { connectionIdentity: `${'a'.repeat(64)}\n` },
    { capabilities: { repositoryRead: true, repositoryWrite: true } },
    { capabilities: { repositoryWrite: false } },
    { authType: 'gitlab-oauth' },
  ])('refuses unverified or mismatched authority: %j', (override) => {
    expect(() =>
      prepareWorkflowSourceBinding({ ...input(), verified: { ...verified, ...override } }),
    ).toThrow();
  });

  it('accepts a repository-scoped GitHub App reference without user credentials', () => {
    const item = prepareWorkflowSourceBinding({
      ...input(),
      verified: {
        ...verified,
        authType: 'github-app',
        installationId: 12345,
        credentialRef: 'github-app#12345',
      },
    });
    expect(item.installationId).toBe('12345');
    expect(item).not.toHaveProperty('connectionUserId');
    expect(item).not.toHaveProperty('connectionCreatedAt');
    expect(item).not.toHaveProperty('connectionIdentity');
  });

  it('persists graph pins only from the trusted authorization argument and hides them in the view', () => {
    const item = prepareWorkflowSourceBinding({
      ...input(),
      authorization: authorization(),
      projectIdentity: 'client-project',
      delegatorMembershipIdentity: 'client-edge',
      verified: {
        ...verified,
        projectIdentity: 'provider-project',
        delegatorMembershipIdentity: 'provider-edge',
        authorization: { ...authorization(), projectIdentity: 'provider-authorization' },
      },
    });
    expect(item).toMatchObject({
      projectIdentity: 'neptune-project-vertex',
      delegatorMembershipIdentity: 'neptune-owner-edge',
    });
    expect(item).not.toHaveProperty('authorization');
    expect(JSON.stringify(workflowSourceView(item))).not.toMatch(
      /projectIdentity|membershipId|delegatorMembershipIdentity|neptune-/,
    );
  });

  it.each(['public', 'github-app'])(
    'pins the project but no user delegation for %s authentication',
    (authType) => {
      const item = prepareWorkflowSourceBinding({
        ...input(),
        authorization: { ...authorization(), role: 'admin' },
        verified: {
          purpose: 'workflow-source',
          authType,
          capabilities: { repositoryRead: true, repositoryWrite: false },
          ...(authType === 'github-app'
            ? { installationId: 12345, credentialRef: 'github-app#12345' }
            : {}),
        },
      });
      expect(item.projectIdentity).toBe('neptune-project-vertex');
      expect(item).not.toHaveProperty('delegatorMembershipIdentity');
      expect(item).not.toHaveProperty('membershipId');
    },
  );

  it.each([
    null,
    {},
    { ...authorization(), role: 'member' },
    { ...authorization(), role: 'OWNER' },
    { ...authorization(), membershipId: undefined },
    { ...authorization(), membershipId: '' },
    { ...authorization(), membershipId: ' edge ' },
    { ...authorization(), membershipId: 'edge\nsecret' },
    { ...authorization(), membershipId: 42 },
    { ...authorization(), membershipId: 'e'.repeat(513) },
    { ...authorization(), projectIdentity: null },
    { ...authorization(), projectIdentity: '\x7f' },
    { ...authorization(), projectIdentity: 'p'.repeat(513) },
    { ...authorization(), actorId: 'injected' },
    Object.assign(Object.create({ role: 'owner' }), {
      membershipId: 'edge',
      projectIdentity: 'vertex',
    }),
  ])('rejects a malformed trusted authorization snapshot %#', (snapshot) => {
    expect(() => prepareWorkflowSourceBinding({ ...input(), authorization: snapshot })).toThrow(
      'A current administrator membership snapshot is required',
    );
  });

  it('leaves legacy offline fixtures explicitly without graph identity instead of trusting injected pins', () => {
    const item = prepareWorkflowSourceBinding({
      ...input(),
      projectIdentity: 'client-project',
      delegatorMembershipIdentity: 'client-edge',
      verified: {
        ...verified,
        projectIdentity: 'provider-project',
        delegatorMembershipIdentity: 'provider-edge',
      },
    });
    expect(item).not.toHaveProperty('projectIdentity');
    expect(item).not.toHaveProperty('delegatorMembershipIdentity');
  });

  it('uses only the separate table for consistent project reads', async () => {
    const item = prepareWorkflowSourceBinding(input());
    ddbMock.on(GetCommand).resolves({ Item: item });
    expect(await getWorkflowSourceBinding(ddb, 'p1', item.sourceId)).toEqual(item);
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input).toEqual({
      TableName: 'workflow-bindings',
      Key: { projectId: 'p1', sourceId: item.sourceId },
      ConsistentRead: true,
    });
  });

  it('paginates project reads without using the application table', async () => {
    const key = { projectId: 'p1', sourceId: 'a'.repeat(64) };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ sourceId: 'a' }], LastEvaluatedKey: key })
      .resolvesOnce({ Items: [{ sourceId: 'b' }] });
    expect(await listWorkflowSourceBindings(ddb, 'p1')).toEqual([
      { sourceId: 'a' },
      { sourceId: 'b' },
    ]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[1].args[0].input).toMatchObject({
      TableName: 'workflow-bindings',
      ConsistentRead: true,
      ExclusiveStartKey: key,
      ExpressionAttributeValues: { ':project': 'p1' },
    });
  });

  it('refuses to fall back to application bindings when its table is absent', async () => {
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', '');
    await expect(listWorkflowSourceBindings(ddb, 'p1')).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_UNAVAILABLE',
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('conditionally creates, updates and deletes without unconditional writes', async () => {
    ddbMock.on(PutCommand).resolves({});
    const first = await saveWorkflowSourceBinding(ddb, input(), { expectedRevision: null });
    await saveWorkflowSourceBinding(
      ddb,
      { ...input(), revision: secondRevision },
      { expectedRevision: first.revision },
    );
    await deleteWorkflowSourceBinding(ddb, 'p1', first.sourceId, {
      expectedRevision: secondRevision,
      actorId: 'owner',
    });
    const writes = ddbMock.commandCalls(PutCommand);
    expect(writes[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(sourceId)');
    expect(writes[1].args[0].input).toMatchObject({
      ConditionExpression: '#revision = :expected',
      ExpressionAttributeValues: { ':expected': firstRevision },
      Item: { revision: secondRevision },
    });
    expect(writes[2].args[0].input).toMatchObject({
      TableName: 'workflow-bindings',
      ConditionExpression: '#revision = :expected',
      ExpressionAttributeValues: { ':expected': secondRevision },
      Item: { status: 'deleted', updatedBy: 'owner' },
    });
    expect(writes[2].args[0].input.Item).not.toHaveProperty('credentialRef');
    expect(writes[2].args[0].input.Item).not.toHaveProperty('connectionUserId');
    expect(writes[2].args[0].input.Item.revision).not.toBe(secondRevision);
  });

  it('requires callers to distinguish creation from an update', async () => {
    await expect(saveWorkflowSourceBinding(ddb, input())).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_INVALID',
    });
    const item = prepareWorkflowSourceBinding(input());
    await expect(deleteWorkflowSourceBinding(ddb, 'p1', item.sourceId)).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_INVALID',
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each(['save', 'delete'])(
    'turns a concurrent %s conflict into a safe retry signal',
    async (op) => {
      const error = Object.assign(new Error('DynamoDB internal detail'), {
        name: 'ConditionalCheckFailedException',
      });
      ddbMock.on(PutCommand).rejects(error);
      const request =
        op === 'save'
          ? saveWorkflowSourceBinding(ddb, input(), { expectedRevision: null })
          : deleteWorkflowSourceBinding(
              ddb,
              'p1',
              workflowSourceIdentity('github', 'acme/workflows').sourceId,
              { expectedRevision: firstRevision, actorId: 'owner' },
            );
      await expect(request).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_CONFLICT',
        message: 'Workflow source changed; reload before retrying',
      });
    },
  );

  it('never authorizes invalidated, replaced, or foreign-purpose records', () => {
    const item = prepareWorkflowSourceBinding(input());
    expect(() => requireWorkflowSourceRevision(item, firstRevision)).not.toThrow();
    expect(() => requireWorkflowSourceRevision(item, secondRevision)).toThrow(/changed/);
    for (const override of [
      { status: 'invalid' },
      { purpose: 'application' },
      { access: 'write' },
      { capabilities: { repositoryRead: true, repositoryWrite: true } },
    ]) {
      expect(() =>
        requireWorkflowSourceRevision({ ...item, ...override }, firstRevision),
      ).toThrow();
    }
  });
});
