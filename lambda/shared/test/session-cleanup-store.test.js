import { describe, expect, it, vi } from 'vitest';
import { createSessionCleanupStore } from '../session-cleanup-store.js';

describe('session cleanup store', () => {
  it('persists the provider/session identity into the shared GSI1 partition', async () => {
    const sends = [];
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        sends.push(command);
        if (command.constructor.name === 'QueryCommand') return { Items: [] };
        return {};
      }),
    };
    const store = createSessionCleanupStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-01-01T00:00:00.000Z',
    });

    const item = await store.enqueue({
      sessionId: 'managed-environment-r-1-session',
      capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
      source: 'environment-validation',
      reason: 'internal error',
      context: { environmentId: 'x86-build', revisionId: 'r-1' },
    });
    expect(item).toMatchObject({
      pk: 'SESSION_CLEANUP#managed-environment-r-1-session',
      sk: 'LOOKUP',
      GSI1PK: 'SESSION_CLEANUP',
      GSI1SK: '2026-01-01T00:00:00.000Z#managed-environment-r-1-session',
      sessionId: 'managed-environment-r-1-session',
      capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
      source: 'environment-validation',
      environmentId: 'x86-build',
      revisionId: 'r-1',
      attempts: 0,
    });
    expect(sends[0].input.TableName).toBe('registry');

    await store.listPending();
    const query = sends.find((command) => command.constructor.name === 'QueryCommand');
    expect(query.input.IndexName).toBe('GSI1');
    expect(query.input.ExpressionAttributeValues[':pk']).toBe('SESSION_CLEANUP');

    await store.recordAttempt('managed-environment-r-1-session', 'still failing');
    const update = sends.find((command) => command.constructor.name === 'UpdateCommand');
    expect(update.input.Key).toEqual({
      pk: 'SESSION_CLEANUP#managed-environment-r-1-session',
      sk: 'LOOKUP',
    });
    expect(update.input.ConditionExpression).toBe('attribute_exists(pk)');

    await store.remove('managed-environment-r-1-session');
    const deletion = sends.find((command) => command.constructor.name === 'DeleteCommand');
    expect(deletion.input.Key).toEqual({
      pk: 'SESSION_CLEANUP#managed-environment-r-1-session',
      sk: 'LOOKUP',
    });
  });

  it('refuses to queue a record without the session or provider identity', async () => {
    const ddb = { send: vi.fn() };
    const store = createSessionCleanupStore({ ddb, tableName: 'registry' });
    expect(await store.enqueue({ sessionId: 's-1' })).toBeNull();
    expect(await store.enqueue({ capacityProviderArn: 'arn:cp' })).toBeNull();
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('falls back to ENVIRONMENT_REGISTRY_TABLE when no table name is injected', async () => {
    const saved = process.env.ENVIRONMENT_REGISTRY_TABLE;
    process.env.ENVIRONMENT_REGISTRY_TABLE = 'from-env';
    try {
      const ddb = { send: vi.fn().mockResolvedValue({ Items: [] }) };
      await createSessionCleanupStore({ ddb }).listPending();
      expect(ddb.send.mock.calls[0][0].input.TableName).toBe('from-env');
    } finally {
      if (saved === undefined) delete process.env.ENVIRONMENT_REGISTRY_TABLE;
      else process.env.ENVIRONMENT_REGISTRY_TABLE = saved;
    }
  });
});
