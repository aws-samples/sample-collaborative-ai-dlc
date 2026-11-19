import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { makeDdb, createV2Table, deleteV2Table } from '../../agentcore/test/helpers/v2-table.js';
import { accountCredentialInvocation } from '../../agentcore/invocation-accounting.js';
import { prepareCredentialInvocation } from '../../agentcore/invocation-context.js';
import { createCredentialSession } from '../../agentcore/credential-session.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../../shared/agent-credential-grants.js';
import { inventoryReferenceWrites } from '../../shared/agent-auth-inventory.js';
import { authorizeAgentCredentialRequest } from '../agent-authentication.js';
import {
  authorizeInvocationAccountingRequest,
  MAX_INVOCATIONS_PER_GRANT,
} from '../invocation-accounting.js';

const tableName = `accounting-transport-${randomUUID()}`;
const { client, doc: ddb } = makeDdb();
beforeAll(async () => createV2Table(client, tableName));
afterAll(async () => {
  await deleteV2Table(client, tableName);
  client.destroy();
});
const secret = 'inert-transport-accounting-secret-'.repeat(2);
const now = () => Date.parse('2026-10-19T12:00:00Z');
const binding = { provider: 'kiro', source: 'user', userId: 'transport-user' };
const payload = { command: 'capabilities', projectId: 'p', credentialBindings: { kiro: binding } };
const normalize = (writes) =>
  JSON.stringify(writes)
    .replaceAll(/AGENTAUTH#INVOCATION#[a-f0-9-]+/g, 'AGENTAUTH#INVOCATION#ID')
    .replaceAll(/REF#[a-f0-9]+/g, 'REF#ID')
    .replaceAll(/"id":"[a-f0-9-]+"/g, '"id":"ID"');

describe('runtime to broker accounting transport parity', () => {
  it('serializes requests and keeps begin/finish transactions identical to the local session path', async () => {
    const localWrites = [];
    const localDdb = {
      send: (command) => {
        if (command instanceof TransactWriteCommand) localWrites.push(command.input);
        return ddb.send(command);
      },
    };
    const local = createCredentialSession();
    await accountCredentialInvocation({
      ddb: localDdb,
      tableName,
      session: local,
      payload,
      bindings: [binding],
      now,
    });
    await local.release();

    const remoteWrites = [];
    const deps = {
      secret,
      now,
      env: {
        ENGINE_DATA_ENABLED: 'true',
        V2_PROCESS_TABLE: tableName,
        AGENT_SETTINGS_SSM_PREFIX: '/test',
      },
      ddbClient: {
        send: (command) => {
          if (command instanceof TransactWriteCommand) remoteWrites.push(command.input);
          return ddb.send(command);
        },
      },
      ssmClient: { send: async () => ({ Parameter: { Value: 'inert-provider-material' } }) },
    };
    const requests = [];
    let invocationId;
    const broker = async (input) => {
      const request = JSON.parse(JSON.stringify(input));
      requests.push(request);
      const response =
        request.action === 'resolve-agent-credentials'
          ? { ok: true, ...(await authorizeAgentCredentialRequest(request, deps)) }
          : await authorizeInvocationAccountingRequest(request, deps);
      if (response.accounting) invocationId = response.accounting.invocationId;
      return JSON.parse(JSON.stringify(response));
    };
    const runtimeDdb = {
      send: vi.fn(() => {
        throw new Error('runtime DDB tripwire');
      }),
    };
    const agentCredentialGrant = signAgentCredentialGrant(
      { purpose: 'capabilities', projectId: 'p', bindings: [binding] },
      secret,
      { now },
    );
    const verifiedGrantId = verifyAgentCredentialGrant(agentCredentialGrant, secret, {
      now,
    }).grantId;
    const context = await prepareCredentialInvocation({
      payload: { ...payload, agentCredentialGrant },
      authMode: 'capabilities',
      broker,
      ddb: runtimeDdb,
      env: { ENGINE_DATA_FUNCTION: 'engine-data', V2_PROCESS_TABLE: tableName },
    });
    const releaseJob = context.credentialSession.retain();
    const read = async () =>
      (
        await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: `AGENTAUTH#INVOCATION#${invocationId}`, sk: 'META' },
            ConsistentRead: true,
          }),
        )
      ).Item;
    await context.credentialSession.release();
    expect((await read()).state).toBe('ACTIVE');
    await releaseJob();
    const finished = await read();
    expect(finished.state).toBe('FINISHED');
    for (const { Put } of inventoryReferenceWrites(tableName, finished)) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: { pk: Put.Item.pk, sk: Put.Item.sk } }),
      );
      expect(Item.agentAuthTtl).toBe(finished.agentAuthTtl);
    }
    expect(requests.map((request) => request.action)).toEqual([
      'resolve-agent-credentials',
      'finish-invocation',
    ]);
    expect(Object.keys(requests[1]).toSorted()).toEqual(['action', 'ticket']);
    expect(runtimeDdb.send).not.toHaveBeenCalled();
    expect(localWrites).toHaveLength(2);
    expect(remoteWrites).toHaveLength(2);
    // Only the broker holds a verified grant, so only it adds the per-grant begin budget.
    const budget = remoteWrites[0].TransactItems.pop();
    expect(budget.Update).toMatchObject({
      Key: { pk: `AGENTAUTH#INVOCATION-BUDGET#${verifiedGrantId}`, sk: 'META' },
      ExpressionAttributeValues: { ':limit': MAX_INVOCATIONS_PER_GRANT },
    });
    expect(normalize(remoteWrites)).toBe(normalize(localWrites));
  });
});
