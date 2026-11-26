import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { createWorkflowSourceService } from '../workflow-source-service.js';
import { prepareWorkflowSourceBinding } from '../workflow-source-bindings.js';
import { gitConnectionIdentity } from '../git-connection-identity.js';

vi.mock('../source-control-credentials.js', () => ({
  verifyReadOnlySourceCredential: vi.fn(),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
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
  capabilities: { repositoryRead: true, repositoryWrite: false },
};
const stored = () =>
  prepareWorkflowSourceBinding({
    projectId: 'p1',
    provider: 'github',
    repository: 'acme/workflows',
    actorId: 'owner',
    verified,
  });
const request = () => ({
  projectId: 'p1',
  actorId: 'owner',
  selection: {
    provider: 'github',
    repository: 'Acme/Workflows',
    authType: 'github-oauth',
    confirmDelegation: true,
  },
  expectedRevision: null,
});

describe('legacy role-only workflow source domain compatibility (no graph identity protection)', () => {
  let getMembershipRole;
  let verifyCredential;
  let service;
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-bindings');
    getMembershipRole = vi.fn(async (_, actor) => (actor === 'owner' ? 'owner' : 'member'));
    verifyCredential = vi.fn().mockResolvedValue(verified);
    service = createWorkflowSourceService({ ddb, getMembershipRole, verifyCredential });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
  });

  it('configures an owner-verified source without attaching an application repository', async () => {
    const result = await service.configure(request());
    expect(result).toMatchObject({
      provider: 'github',
      repository: 'acme/workflows',
      authType: 'github-oauth',
      access: 'read',
      status: 'active',
    });
    expect(JSON.stringify(result)).not.toMatch(/credentialRef|connectionUserId|owner/);
    expect(verifyCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/workflows',
        userId: 'owner',
        confirmDelegation: true,
      }),
    );
    expect(getMembershipRole).toHaveBeenCalledTimes(2);
    for (const call of ddbMock.calls()) {
      expect(call.args[0].input.TableName).toBe('workflow-bindings');
    }
  });

  it.each(['member', null, 'unknown'])(
    'rejects configuring role %s before any credential work',
    async (role) => {
      getMembershipRole.mockResolvedValue(role);
      await expect(service.configure(request())).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_FORBIDDEN',
      });
      expect(verifyCredential).not.toHaveBeenCalled();
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it('accepts admins and binds their own identity, ignoring injected credentials', async () => {
    getMembershipRole.mockResolvedValue('admin');
    const payload = request();
    payload.selection = {
      ...payload.selection,
      userId: 'victim',
      token: 'injected',
      credentialRef: 'oauth#github#victim',
      purpose: 'application',
      capabilities: { repositoryWrite: true },
    };
    await service.configure(payload);
    expect(verifyCredential.mock.calls[0][0]).not.toHaveProperty('token');
    expect(verifyCredential.mock.calls[0][0]).not.toHaveProperty('credentialRef');
    expect(verifyCredential.mock.calls[0][0].userId).toBe('owner');
  });

  it('does not interpret a truthy string as delegation consent', async () => {
    const payload = request();
    payload.selection.confirmDelegation = 'true';
    await service.configure(payload);
    expect(verifyCredential.mock.calls[0][0].confirmDelegation).toBe(false);
  });

  it('rejects owner removal during provider verification before persisting', async () => {
    getMembershipRole.mockResolvedValueOnce('owner').mockResolvedValueOnce(null);
    await expect(service.configure(request())).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(verifyCredential).toHaveBeenCalledTimes(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('does not publish a binding when provider verification fails', async () => {
    verifyCredential.mockRejectedValue(new Error('verification failed'));
    await expect(service.configure(request())).rejects.toThrow('verification failed');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it.each([null, '56dc3193-f2d4-4a77-8173-7b00c5bcb01b'])(
    'rejects stale source revision %s before credentials',
    async (expectedRevision) => {
      ddbMock.on(GetCommand).resolves({ Item: stored() });
      await expect(service.configure({ ...request(), expectedRevision })).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_CONFLICT',
      });
      expect(verifyCredential).not.toHaveBeenCalled();
    },
  );

  it('allows explicitly re-verifying an invalidated binding while retaining a conditional write', async () => {
    const item = stored();
    ddbMock.on(GetCommand).resolves({ Item: { ...item, status: 'invalid' } });
    const result = await service.configure({ ...request(), expectedRevision: item.revision });
    expect(result.status).toBe('active');
    expect(result.revision).not.toBe(item.revision);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':expected': item.revision,
    });
  });

  it('lets current members see sources without credential references', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [stored()] });
    const result = await service.list({ projectId: 'p1', actorId: 'member' });
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/credentialRef|connectionUserId|owner/);
  });

  it('rejects nonmembers before source reads and member deletion before writes', async () => {
    getMembershipRole.mockResolvedValueOnce(null).mockResolvedValueOnce('member');
    await expect(service.list({ projectId: 'p1', actorId: 'stranger' })).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    await expect(
      service.remove({ projectId: 'p1', actorId: 'member', sourceId: 'bad' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('lets admins remove only the revision they viewed', async () => {
    const item = stored();
    await service.remove({
      projectId: 'p1',
      actorId: 'owner',
      sourceId: item.sourceId,
      expectedRevision: item.revision,
    });
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':expected': item.revision,
    });
  });

  it('does not resurrect a source created and deleted during another pending creation', async () => {
    let row;
    ddbMock.on(GetCommand).callsFake(async () => ({ Item: row && structuredClone(row) }));
    ddbMock.on(PutCommand).callsFake(async (input) => {
      const matches =
        input.ConditionExpression === 'attribute_not_exists(sourceId)'
          ? !row
          : row?.revision === input.ExpressionAttributeValues[':expected'];
      if (!matches) {
        throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
      }
      row = structuredClone(input.Item);
      return {};
    });
    const pendingVerification = Promise.withResolvers();
    const verificationStarted = Promise.withResolvers();
    verifyCredential.mockImplementationOnce(() => {
      verificationStarted.resolve();
      return pendingVerification.promise;
    });
    const pendingCreate = service.configure(request());
    await verificationStarted.promise;

    const concurrentCreate = await service.configure(request());
    await service.remove({
      projectId: 'p1',
      actorId: 'owner',
      sourceId: concurrentCreate.sourceId,
      expectedRevision: concurrentCreate.revision,
    });
    const tombstoneRevision = row.revision;
    pendingVerification.resolve(verified);
    await expect(pendingCreate).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_CONFLICT' });
    expect(row.status).toBe('deleted');
    expect(row.revision).toBe(tombstoneRevision);
    expect(row).not.toHaveProperty('credentialRef');

    // A later explicit configuration observes the tombstone and may reverify,
    // but its write must still be conditional on that observed generation.
    const reconfigured = await service.configure(request());
    expect(reconfigured.status).toBe('active');
    expect(row.revision).not.toBe(tombstoneRevision);
    expect(ddbMock.commandCalls(PutCommand).at(-1).args[0].input).toMatchObject({
      ConditionExpression: '#revision = :expected',
      ExpressionAttributeValues: { ':expected': tombstoneRevision },
    });
  });

  it('keeps credential-free deletion tombstones out of the member list', async () => {
    const item = stored();
    ddbMock.on(QueryCommand).resolves({
      Items: [{ sourceId: 'a'.repeat(64), status: 'deleted' }, item],
    });
    const result = await service.list({ projectId: 'p1', actorId: 'member' });
    expect(result.map((source) => source.sourceId)).toEqual([item.sourceId]);
  });

  it('requires membership of both the selecting member and the OAuth delegator', async () => {
    const item = stored();
    ddbMock.on(GetCommand).resolves({ Item: item });
    const sourceRequest = {
      projectId: 'p1',
      actorId: 'member',
      sourceId: item.sourceId,
      expectedRevision: item.revision,
    };
    expect(await service.getAuthorizedBinding(sourceRequest)).toEqual(item);
    expect(getMembershipRole.mock.calls).toEqual([
      ['p1', 'member'],
      ['p1', 'owner'],
    ]);
    getMembershipRole.mockResolvedValueOnce('member').mockResolvedValueOnce(null);
    await expect(service.getAuthorizedBinding(sourceRequest)).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    // Selection authorization must not itself resolve or expose a raw token.
    expect(verifyCredential).not.toHaveBeenCalled();
  });

  it('rejects an unexpected project identity even if a store returns it', async () => {
    const item = stored();
    ddbMock.on(GetCommand).resolves({ Item: { ...item, projectId: 'another-project' } });
    await expect(
      service.getAuthorizedBinding({
        projectId: 'p1',
        actorId: 'member',
        sourceId: item.sourceId,
        expectedRevision: item.revision,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_INVALID' });
  });
});

describe('workflow source authorization using existing graph lifecycle identities', () => {
  let row;
  let memberships;
  let getMembershipSnapshot;
  let verifyCredential;
  let service;

  const selection = (view, actorId = 'member') => ({
    projectId: 'p1',
    actorId,
    sourceId: view.sourceId,
    expectedRevision: view.revision,
  });
  const credentialFor = (authType) =>
    authType.endsWith('-oauth')
      ? verified
      : {
          purpose: 'workflow-source',
          authType,
          capabilities: { repositoryRead: true, repositoryWrite: false },
          ...(authType === 'github-app'
            ? { installationId: 12345, credentialRef: 'github-app#12345' }
            : {}),
        };
  const configure = (authType = 'github-oauth', expectedRevision = null) =>
    service.configure({
      ...request(),
      selection: { ...request().selection, authType },
      expectedRevision,
    });

  beforeEach(() => {
    row = undefined;
    ddbMock.reset();
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-bindings');
    memberships = new Map([
      ['owner', { role: 'owner', membershipId: 'owner-edge-1', projectIdentity: 'project-1' }],
      ['member', { role: 'member', membershipId: 'member-edge-1', projectIdentity: 'project-1' }],
    ]);
    // Return the same objects deliberately: the service must capture copies.
    getMembershipSnapshot = vi.fn(async (_project, actor) => memberships.get(actor) ?? null);
    verifyCredential = vi.fn(async ({ authType }) => credentialFor(authType));
    service = createWorkflowSourceService({ ddb, getMembershipSnapshot, verifyCredential });
    ddbMock.on(GetCommand).callsFake(async () => ({
      Item: row && structuredClone(row),
    }));
    ddbMock.on(QueryCommand).callsFake(async () => ({
      Items: row ? [structuredClone(row)] : [],
    }));
    ddbMock.on(PutCommand).callsFake(async (input) => {
      const matches =
        input.ConditionExpression === 'attribute_not_exists(sourceId)'
          ? !row
          : input.ConditionExpression === '#revision = :expected' &&
            row?.revision === input.ExpressionAttributeValues[':expected'];
      if (!matches) {
        throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
      }
      row = structuredClone(input.Item);
      return {};
    });
  });

  it('uses only trusted snapshots, ignoring caller and provider graph identity claims', async () => {
    verifyCredential.mockResolvedValue({
      ...verified,
      projectIdentity: 'provider-project',
      delegatorMembershipIdentity: 'provider-edge',
      authorization: { role: 'owner', membershipId: 'provider-edge', projectIdentity: 'fake' },
    });
    const view = await service.configure({
      ...request(),
      authorization: { role: 'owner', membershipId: 'caller-edge', projectIdentity: 'fake' },
      selection: {
        ...request().selection,
        projectIdentity: 'caller-project',
        delegatorMembershipIdentity: 'caller-edge',
        authorization: { role: 'owner', membershipId: 'caller-edge', projectIdentity: 'fake' },
      },
    });
    expect(row).toMatchObject({
      projectIdentity: 'project-1',
      delegatorMembershipIdentity: 'owner-edge-1',
      updatedBy: 'owner',
    });
    expect(JSON.stringify(view)).not.toMatch(
      /projectIdentity|membershipId|delegatorMembershipIdentity|project-1|owner-edge/,
    );
    expect(verifyCredential.mock.calls[0][0]).not.toHaveProperty('authorization');
    expect(verifyCredential.mock.calls[0][0]).not.toHaveProperty('projectIdentity');
    expect(getMembershipSnapshot.mock.calls).toEqual([
      ['p1', 'owner'],
      ['p1', 'owner'],
    ]);
  });

  it.each([
    null,
    'owner',
    { role: 'owner' },
    { role: 'owner', membershipId: '', projectIdentity: 'project-1' },
    { role: 'owner', membershipId: 'edge', projectIdentity: ' project-1 ' },
    { role: 'owner', membershipId: 'edge', projectIdentity: 'project-1', extra: true },
    { role: 'unknown', membershipId: 'edge', projectIdentity: 'project-1' },
  ])(
    'fails closed on missing or malformed production snapshots %# with no legacy fallback',
    async (snapshot) => {
      const getMembershipRole = vi.fn(async () => 'owner');
      getMembershipSnapshot.mockResolvedValue(snapshot);
      const production = createWorkflowSourceService({
        ddb,
        getMembershipRole,
        getMembershipSnapshot,
        verifyCredential,
      });
      await expect(production.configure(request())).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_FORBIDDEN',
      });
      expect(getMembershipRole).not.toHaveBeenCalled();
      expect(verifyCredential).not.toHaveBeenCalled();
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it('requires a callable snapshot port when explicitly configured', () => {
    expect(() =>
      createWorkflowSourceService({
        ddb,
        getMembershipSnapshot: null,
        getMembershipRole: async () => 'owner',
      }),
    ).toThrow('An authenticated membership lookup is required');
  });

  it('does not fall back to a legacy role after a failed snapshot lookup', async () => {
    const getMembershipRole = vi.fn(async () => 'owner');
    getMembershipSnapshot.mockRejectedValue(new Error('lookup unavailable'));
    const production = createWorkflowSourceService({
      ddb,
      getMembershipRole,
      getMembershipSnapshot,
      verifyCredential,
    });
    await expect(production.configure(request())).rejects.toThrow('lookup unavailable');
    expect(getMembershipRole).not.toHaveBeenCalled();
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('rejects an old OAuth delegation after the same owner is removed and readded with the same role', async () => {
    const view = await configure();
    expect(await service.getAuthorizedBinding(selection(view))).toEqual(row);
    memberships.delete('owner');
    await expect(service.getAuthorizedBinding(selection(view))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    memberships.set('owner', {
      role: 'owner',
      membershipId: 'owner-edge-2',
      projectIdentity: 'project-1',
    });
    await expect(service.getAuthorizedBinding(selection(view))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_INVALID',
    });
    expect(row.revision).toBe(view.revision);
    expect(row.delegatorMembershipIdentity).toBe('owner-edge-1');
  });

  it.each(['membershipId', 'projectIdentity'])(
    'rejects a pending configuration when %s changes during provider verification',
    async (field) => {
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      verifyCredential.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return verified;
      });
      const pending = configure();
      await started.promise;
      // Mutate the callback's reused object: the first snapshot must stay pinned.
      memberships.get('owner')[field] = 'replacement-identity';
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_INVALID' });
      expect(row).toBeUndefined();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    },
  );

  it.each(['removed', 'member'])(
    'requires the administrator role after provider verification (%s)',
    async (change) => {
      verifyCredential.mockImplementation(async () => {
        if (change === 'removed') memberships.delete('owner');
        else memberships.get('owner').role = 'member';
        return verified;
      });
      await expect(configure()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
      expect(row).toBeUndefined();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    },
  );

  it('allows an owner to become admin on the same edge while verification is pending', async () => {
    verifyCredential.mockImplementation(async () => {
      memberships.get('owner').role = 'admin';
      return verified;
    });
    const view = await configure();
    expect(view.status).toBe('active');
    expect(row.delegatorMembershipIdentity).toBe('owner-edge-1');
  });

  it.each(['github-oauth', 'public', 'github-app'])(
    'denies the old %s binding after project recreation, then accepts explicit reverification',
    async (authType) => {
      const first = await configure(authType);
      for (const membership of memberships.values()) membership.projectIdentity = 'project-2';
      memberships.get('owner').membershipId = 'owner-edge-2';
      await expect(service.getAuthorizedBinding(selection(first))).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_INVALID',
      });
      expect(await service.list({ projectId: 'p1', actorId: 'member' })).toEqual([
        { ...first, status: 'invalid' },
      ]);

      const second = await configure(authType, first.revision);
      expect(second.revision).not.toBe(first.revision);
      expect(row.projectIdentity).toBe('project-2');
      if (authType.endsWith('-oauth')) {
        expect(row.delegatorMembershipIdentity).toBe('owner-edge-2');
      } else {
        expect(row).not.toHaveProperty('delegatorMembershipIdentity');
      }
      expect(await service.getAuthorizedBinding(selection(second))).toEqual(row);
      await expect(service.getAuthorizedBinding(selection(first))).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_CONFLICT',
      });
      expect(ddbMock.commandCalls(PutCommand).at(-1).args[0].input).toMatchObject({
        ConditionExpression: '#revision = :expected',
        ExpressionAttributeValues: { ':expected': first.revision },
      });
      expect(
        JSON.stringify(await service.list({ projectId: 'p1', actorId: 'member' })),
      ).not.toMatch(
        /projectIdentity|membershipId|delegatorMembershipIdentity|project-2|owner-edge/,
      );
    },
  );

  it('accepts a fresh OAuth delegation after remove/readd only under a new binding revision', async () => {
    const first = await configure();
    memberships.get('owner').membershipId = 'owner-edge-2';
    const second = await configure('github-oauth', first.revision);
    expect(second.revision).not.toBe(first.revision);
    expect(row.delegatorMembershipIdentity).toBe('owner-edge-2');
    expect(await service.getAuthorizedBinding(selection(second))).toEqual(row);
  });

  it.each(['projectIdentity', 'delegatorMembershipIdentity'])(
    'requires explicit reverification of a legacy binding missing %s',
    async (field) => {
      const first = await configure();
      delete row[field];
      await expect(service.getAuthorizedBinding(selection(first))).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_INVALID',
      });
      expect(await service.list({ projectId: 'p1', actorId: 'member' })).toEqual([
        { ...first, status: 'invalid' },
      ]);
      const second = await configure('github-oauth', first.revision);
      expect(await service.getAuthorizedBinding(selection(second))).toEqual(row);
    },
  );

  it('allows the same OAuth delegator edge to remain a member after a role change', async () => {
    const view = await configure();
    memberships.get('owner').role = 'member';
    expect(await service.getAuthorizedBinding(selection(view))).toEqual(row);
  });

  it('checks the current selecting member and denies access before reading source storage', async () => {
    const view = await configure();
    const reads = ddbMock.commandCalls(GetCommand).length;
    memberships.delete('member');
    await expect(service.getAuthorizedBinding(selection(view))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    await expect(service.list({ projectId: 'p1', actorId: 'member' })).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(reads);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('requires the OAuth delegator snapshot to belong to the same actual project as the caller', async () => {
    const view = await configure();
    memberships.get('owner').projectIdentity = 'different-project';
    await expect(service.getAuthorizedBinding(selection(view))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_INVALID',
    });
  });

  it.each(['public', 'github-app'])(
    'keeps %s usable by members after the configuring user leaves',
    async (authType) => {
      const view = await configure(authType);
      memberships.delete('owner');
      getMembershipSnapshot.mockClear();
      expect(await service.getAuthorizedBinding(selection(view))).toEqual(row);
      expect(getMembershipSnapshot.mock.calls).toEqual([['p1', 'member']]);
      expect(row.projectIdentity).toBe('project-1');
      expect(row).not.toHaveProperty('delegatorMembershipIdentity');
    },
  );

  it('keeps revision CAS effective when a membership-valid configuration finishes late', async () => {
    const first = await configure();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    verifyCredential.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return verified;
    });
    const delayed = configure('github-oauth', first.revision);
    await started.promise;
    const winner = await configure('github-oauth', first.revision);
    release.resolve();
    await expect(delayed).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_CONFLICT' });
    expect(row.revision).toBe(winner.revision);
    expect(row.projectIdentity).toBe('project-1');
    expect(row.delegatorMembershipIdentity).toBe('owner-edge-1');
  });

  it('keeps member removal forbidden and permits administrator removal of the viewed revision', async () => {
    const view = await configure();
    await expect(service.remove(selection(view))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(row.status).toBe('active');
    await service.remove(selection(view, 'owner'));
    expect(row.status).toBe('deleted');
    expect(await service.list({ projectId: 'p1', actorId: 'member' })).toEqual([]);
  });
});
