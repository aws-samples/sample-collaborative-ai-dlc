import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentConnectionRepository } from '../agent-connection-repository.js';
import { createAgentAuthChangeService } from '../agent-auth-changes.js';
import { resolvePolicyBindings, connectionBinding } from '../agent-binding-selection.js';
import { normalizeConnection } from '../agent-auth-catalog.js';
import { cleanup, createAuthTable, ddb, requireDynamoDbLocal } from './helpers/auth-table.js';

beforeAll(requireDynamoDbLocal);
afterAll(cleanup);

describe('reviewed IAM activation on the foundation', () => {
  const iam = (id, projectId) =>
    normalizeConnection({
      id,
      revision: 1,
      mode: 'iam',
      backend: 'bedrock',
      mechanism: 'assume-role',
      source: projectId ? 'space' : 'platform',
      projectId,
      configuration: {
        roleArn: `arn:aws:iam::222222222222:role/${id}`,
        region: 'eu-west-1',
        externalId: 'external-fixture',
      },
    });
  it('atomically activates a platform connection, selects a space override, and restores inheritance', async () => {
    const repository = createAgentConnectionRepository({ ddb, tableName: await createAuthTable() });
    await repository.initializeInventory();
    const service = createAgentAuthChangeService({ repository });
    const platform = iam('iam-platform');
    const space = iam('iam-space', 'p1');
    const review = await service.preview(
      { kind: 'connection-create', select: true, connection: platform },
      'admin',
    );
    expect(await repository.getConnection(platform.id)).toBeNull();
    expect((await repository.getPolicy()).mode).toBe('keys');
    await service.apply(review.id, 'admin');
    expect(await repository.getConnection(platform.id, 1)).toMatchObject(platform);
    expect((await repository.getPolicy()).defaultConnectionId).toBe(platform.id);
    const keys = {
      bedrock: { provider: 'bedrock', source: 'user', userId: 'u1' },
      kiro: { provider: 'kiro', source: 'user', userId: 'u1' },
    };
    const resolve = () =>
      resolvePolicyBindings({
        repository,
        projectId: 'p1',
        userId: 'u1',
        resolveLegacy: async () => ({ ...keys }),
      });
    expect(await resolve()).toEqual({ bedrock: connectionBinding(platform, 1), kiro: keys.kiro });
    const spaceReview = await service.preview(
      { kind: 'connection-create', select: true, connection: space },
      'admin',
    );
    await service.apply(spaceReview.id, 'admin');
    expect((await resolve()).bedrock).toEqual(connectionBinding(space, 1));
    const inherit = await service.preview(
      { kind: 'space-selection', source: 'space', projectId: 'p1', connectionId: null },
      'admin',
    );
    await service.apply(inherit.id, 'admin');
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 1));
    expect(await repository.getConnection(space.id, 1)).toMatchObject(space);
    await service.apply(inherit.id, 'admin');
    expect((await repository.getPolicy()).revision).toBe(1);
    expect((await repository.getScopeState({ source: 'space', projectId: 'p1' })).revision).toBe(2);
  });
  it('rejects a stale IAM activation without leaving a connection or changing selection', async () => {
    const repository = createAgentConnectionRepository({ ddb, tableName: await createAuthTable() });
    await repository.initializeInventory();
    const service = createAgentAuthChangeService({ repository });
    const connection = iam('iam-stale');
    const review = await service.preview(
      { kind: 'connection-create', select: true, connection },
      'admin',
    );
    await repository.claimSelection(0);
    await expect(service.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect(await repository.getConnection(connection.id)).toBeNull();
    expect((await repository.getPolicy()).mode).toBe('keys');
  });
});
