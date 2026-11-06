import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PutCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { makeDdb, createV2Table, deleteV2Table } from '../../agentcore/test/helpers/v2-table.js';
import { normalizeConnection } from '../../shared/agent-auth-contracts.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
import { signAgentCredentialGrant } from '../../shared/agent-credential-grants.js';
import { createAgentConnectionRepository } from '../../shared/agent-connection-repository.js';
import { createAgentAuthChangeService } from '../../shared/agent-auth-changes.js';
import { TEST_CONNECTION_MODE } from '../../shared/test/helpers/auth-modes.js';
import { FIXTURE_BROKER_PROVIDER, FIXTURE_RENEWAL } from './helpers/fixture-broker-provider.js';
import { createBrokerProviderRegistry } from '../agent-provider-registry.js';
import { authorizeAgentCredentialRequest } from '../agent-authentication.js';
import { authorizeInvocationAccountingRequest } from '../invocation-accounting.js';

vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) =>
  (await import('../../shared/test/helpers/auth-modes.js')).withAuthModes(importOriginal),
);
const secret = 'inert-provider-accounting-secret-'.repeat(2);
const tableName = `accounting-provider-${randomUUID()}`;
const { client, doc: ddb } = makeDdb();
const connection = normalizeConnection({
  id: 'accounting-test-provider',
  revision: 1,
  mode: TEST_CONNECTION_MODE.id,
  backend: TEST_CONNECTION_MODE.backend,
  mechanism: TEST_CONNECTION_MODE.mechanisms[0],
  source: 'space',
  projectId: 'p',
  configuration: { region: 'eu-west-1' },
});
const binding = connectionBinding(connection, 0);
const repository = createAgentConnectionRepository({ ddb, tableName, base: '/test' });
beforeAll(async () => {
  await createV2Table(client, tableName);
  await repository.putConnection(connection);
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { pk: 'EXEC#e', sk: 'META', projectId: 'p', credentialBinding: binding },
    }),
  );
});
afterAll(async () => {
  await deleteV2Table(client, tableName);
  client.destroy();
});

const harness = () => {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const now = () => time;
  const issue = vi.fn(async () => ({
    token: 'inert-provider-material',
    expiresAt: time + 900_000,
  }));
  const ddbClient = { send: vi.fn((command) => ddb.send(command)) };
  const verifyGrant = vi.fn(async () => ({
    mode: 'stage',
    projectId: 'p',
    executionId: 'e',
    grantId: 'gateway-grant',
    issuedAt: Math.floor(time / 1000),
  }));
  const isGrantRetired = vi.fn(async () => false);
  const deps = {
    secret,
    now,
    ddbClient,
    ssmClient: {
      send: vi.fn(() => {
        throw new Error('SSM tripwire');
      }),
    },
    env: { ENGINE_DATA_ENABLED: 'true', V2_PROCESS_TABLE: tableName },
    registry: createBrokerProviderRegistry([FIXTURE_BROKER_PROVIDER]),
    tokenClient: { issue },
    verifyGrant,
    isGrantRetired,
  };
  const request = (purpose = 'execution') => ({
    action: 'resolve-agent-credentials',
    command: purpose === 'execution' ? 'run-stage' : purpose,
    invocationNonce: randomUUID(),
    grant: signAgentCredentialGrant(
      {
        purpose,
        projectId: 'p',
        executionId: purpose === 'execution' ? 'e' : null,
        bindings: [binding],
      },
      secret,
      { now },
    ),
    ...(purpose === 'execution' ? { gatewayGrant: 'injected-gateway-grant' } : {}),
  });
  return {
    ...deps,
    issue,
    request,
    advance: (ms) => {
      time += ms;
    },
    resolve: (event) => authorizeAgentCredentialRequest(event, deps),
    finish: (ticket) =>
      authorizeInvocationAccountingRequest({ action: 'finish-invocation', ticket }, deps),
  };
};

describe('accounting beside signed provider authority', () => {
  it('accounts verification without Gateway or execution reads and cannot renew it', async () => {
    const h = harness();
    const result = await h.resolve(h.request('verify-connection'));
    expect(result.credentials[0].lease.renewal).toBeNull();
    expect(result.accounting.ticket).toBeTypeOf('string');
    expect(h.verifyGrant).not.toHaveBeenCalled();
    expect(
      h.ddbClient.send.mock.calls.some(([command]) => command.input.Key?.pk.startsWith('EXEC#')),
    ).toBe(false);
    expect(h.issue).toHaveBeenCalledWith(expect.objectContaining({ request: 'verify' }));
    await expect(
      h.resolve({ action: FIXTURE_RENEWAL.action, grant: result.accounting.ticket }),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    await h.finish(result.accounting.ticket);
  });

  it('preserves one invocation across renewal after both initial grants expire', async () => {
    const h = harness();
    const event = h.request();
    const result = await h.resolve(event);
    const { grant } = result.credentials[0].lease.renewal;
    const ceiling = result.credentials[0].lease.authorizationExpiresAt;
    h.advance(600_000);
    h.ddbClient.send.mockClear();
    h.verifyGrant.mockClear();
    await expect(h.resolve(event)).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_EXPIRED',
    });
    const renewal = await h.resolve({ action: FIXTURE_RENEWAL.action, grant });
    expect(renewal).not.toHaveProperty('accounting');
    expect(renewal.credentials[0].lease.authorizationExpiresAt).toBe(ceiling);
    expect(h.verifyGrant).not.toHaveBeenCalled();
    expect(h.isGrantRetired).toHaveBeenCalledExactlyOnceWith({
      grantId: 'gateway-grant',
      executionId: 'e',
      issuedAt: Math.floor(Date.parse('2026-10-19T12:00:00Z') / 1000),
    });
    expect(
      h.ddbClient.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand),
    ).toBe(false);
    const { Items } = await ddb.send(new ScanCommand({ TableName: tableName }));
    expect(Items.filter((row) => row.id === result.accounting.invocationId)).toHaveLength(1);
    expect(await h.finish(result.accounting.ticket)).toEqual({ ok: true });
  });

  it('invalidates an actual reviewed inventory before returning provider material', async () => {
    const h = harness();
    const changes = createAgentAuthChangeService({ repository });
    const review = await changes.preview(
      { kind: 'policy', mode: 'keys', defaultConnectionId: 'legacy-platform-bedrock' },
      'admin',
    );
    const result = await h.resolve(h.request('capabilities'));
    await expect(changes.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    await h.finish(result.accounting.ticket);
  });
});
