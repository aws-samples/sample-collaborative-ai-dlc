import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { makeDdb, createV2Table, deleteV2Table } from './helpers/v2-table.js';
import { accountCredentialInvocation } from '../invocation-accounting.js';
import { createCredentialSession } from '../credential-session.js';
import { createAgentConnectionRepository } from '../../shared/agent-connection-repository.js';
import { createAgentAuthChangeService } from '../../shared/agent-auth-changes.js';

const tableName = `invocation-auth-${randomUUID()}`;
const { client, doc: ddb } = makeDdb();
beforeAll(async () => createV2Table(client, tableName));
afterAll(async () => {
  await deleteV2Table(client, tableName);
  client.destroy();
});
const binding = { provider: 'bedrock', source: 'space' };

describe('invocation activity evidence', () => {
  it('does not invalidate a review for an unauthenticated capability probe', async () => {
    const send = vi.fn();
    await accountCredentialInvocation({
      ddb: { send },
      tableName,
      session: {},
      payload: { command: 'capabilities' },
      bindings: [],
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('invalidates reviewed inventory when authenticated work starts and accounts until its final release', async () => {
    const repository = createAgentConnectionRepository({ ddb, tableName, base: '/test' });
    const changes = createAgentAuthChangeService({ repository });
    const review = await changes.preview(
      { kind: 'policy', mode: 'keys', defaultConnectionId: 'legacy-platform-bedrock' },
      'admin',
    );
    const session = createCredentialSession();
    const releaseJob = session.retain();
    await accountCredentialInvocation({
      ddb,
      tableName,
      session,
      payload: { command: 'compose-plan-start', executionId: 'ledger-e1', projectId: 'p1' },
      bindings: [binding],
    });
    await expect(changes.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    const records = await repository.scanInventory();
    const invocation = records.find((row) => row.type === 'AgentInvocation');
    expect(invocation).toMatchObject({
      projectId: 'p1',
      executionId: 'ledger-e1',
      state: 'ACTIVE',
      credentialBinding: binding,
    });
    await session.release();
    const read = async () =>
      (
        await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: invocation.pk, sk: invocation.sk },
            ConsistentRead: true,
          }),
        )
      ).Item;
    expect((await read()).state).toBe('ACTIVE');
    await releaseJob();
    expect(await read()).toMatchObject({ state: 'FINISHED', agentAuthTtl: expect.any(Number) });
  });
  it('finishes evidence if the credential expires while accounting is being installed', async () => {
    await expect(
      accountCredentialInvocation({
        ddb,
        tableName,
        session: {
          own: () => {
            throw new Error('credential expired');
          },
        },
        payload: { command: 'run-stage', executionId: 'expired-e1', projectId: 'p1' },
        bindings: [binding],
      }),
    ).rejects.toThrow('credential expired');
    const { Items } = await ddb.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    );
    expect(Items.find((row) => row.executionId === 'expired-e1').state).toBe('FINISHED');
  });
});
