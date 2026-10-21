import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { Logger } from '@aws-lambda-powertools/logger';
import { issueGatewayGrant } from '../../shared/gateway-grant.js';

// The broker builds its grant verifier from its environment at import time, so
// this suite drives the deployed wiring end to end through the handler.
vi.hoisted(() => {
  process.env.GATEWAY_GRANT_KEY_IDS = 'trusted';
  process.env.GATEWAY_GRANT_RETIREMENT_TABLE = 'retired-grants';
});

vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: vi.fn(async () => ({ username: 'test', password: 'inert-test-value' })),
}));

const { handler } = await import('../index.js');

const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const request = {
  action: 'source-control',
  projectId: 'p',
  executionId: 'e',
  provider: 'github',
  repository: 'Acme/API',
  requiredAccess: 'identity',
};
const { action: _action, ...legacyRequest } = request;
const grant = (jti, at = Date.now()) =>
  issueGatewayGrant(
    { mode: 'stage', projectId: 'p', intentId: 'i', executionId: 'e', stageId: 's' },
    {
      sign: async (message) => sign('sha256', message, keys.privateKey),
      keyId: 'trusted',
      randomId: () => jti,
      now: () => at,
    },
  );
const SERVED = { ok: true, committer: { name: 'App', email: 'app@example.test' } };

let ddb;
let kms;
let retired;
let executionRetiredAt;
let retirementLookup;
let pending;
beforeEach(() => {
  retired = new Set();
  pending = null;
  executionRetiredAt = null;
  retirementLookup = ({ Key }) => {
    if (Key.pk === 'EXEC#e') {
      return { Item: executionRetiredAt === null ? undefined : { retiredAt: executionRetiredAt } };
    }
    return { Item: retired.has(Key.pk) ? { pk: Key.pk } : undefined };
  };
  kms = mockClient(KMSClient);
  kms
    .on(GetPublicKeyCommand)
    .resolves({ PublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }) });
  ddb = mockClient(DynamoDBDocumentClient);
  ddb.on(GetCommand).callsFake((input) => {
    if (input.TableName === 'retired-grants') return retirementLookup(input);
    if (input.ProjectionExpression === 'pendingGrantRetirements') {
      return { Item: pending ? { pendingGrantRetirements: pending } : undefined };
    }
    return {
      Item: input.Key.pk
        ? {
            projectId: 'p',
            intentId: 'i',
            status: 'RUNNING',
            repos: ['acme/api'],
            gitProvider: 'github',
          }
        : { status: 'active', actorName: 'App', actorEmail: 'app@example.test', capabilities: {} },
    };
  });
  vi.stubEnv('ENGINE_DATA_ENABLED', 'true');
  vi.stubEnv('V2_PROCESS_TABLE', 'process');
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  ddb.restore();
  kms.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => {
  delete process.env.GATEWAY_GRANT_KEY_IDS;
  delete process.env.GATEWAY_GRANT_RETIREMENT_TABLE;
});

const retirementReads = () =>
  ddb.commandCalls(GetCommand).filter((call) => call.args[0].input.TableName === 'retired-grants');
// The META read of the jtis whose retirement is still owed, the only process
// read a grant check makes.
const pendingReads = () =>
  ddb
    .commandCalls(GetCommand)
    .filter((call) => call.args[0].input.ProjectionExpression === 'pendingGrantRetirements');

describe.each([
  ['transition', {}],
  ['enforcement', { RUNTIME_GRANTS_ENFORCED: 'true' }],
])('credential broker end-of-stage grant retirement (%s)', (_mode, flags) => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(flags)) vi.stubEnv(name, value);
  });

  it('serves a live grant after consistent jti and execution retirement reads', async () => {
    expect(await handler({ ...request, gatewayGrant: await grant('grant-live') })).toEqual(SERVED);
    expect(retirementReads().map((call) => call.args[0].input)).toEqual([
      expect.objectContaining({ Key: { pk: 'GRANT#grant-live' }, ConsistentRead: true }),
      expect.objectContaining({ Key: { pk: 'EXEC#e' }, ConsistentRead: true }),
    ]);
    expect(pendingReads().map((call) => call.args[0].input)).toEqual([
      expect.objectContaining({
        TableName: 'process',
        Key: { pk: 'EXEC#e', sk: 'META' },
        ConsistentRead: true,
      }),
    ]);
  });

  it('denies a grant issued before its execution was retired, before reading execution data', async () => {
    const issuedAt = Date.now();
    executionRetiredAt = Math.floor(issuedAt / 1000);
    expect(
      await handler({ ...request, gatewayGrant: await grant('grant-before-cancel', issuedAt) }),
    ).toEqual({ ok: false, code: 'GATEWAY_GRANT_RETIRED' });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(3);
    expect(pendingReads()).toHaveLength(1);
  });

  it('serves a re-driven run’s grant issued after the execution was retired', async () => {
    const issuedAt = Date.now();
    executionRetiredAt = Math.floor(issuedAt / 1000) - 1;
    expect(
      await handler({ ...request, gatewayGrant: await grant('grant-redrive', issuedAt) }),
    ).toEqual(SERVED);
  });

  it('denies a retired grant before reading any execution data', async () => {
    retired.add('GRANT#grant-done');
    expect(await handler({ ...request, gatewayGrant: await grant('grant-done') })).toEqual({
      ok: false,
      code: 'GATEWAY_GRANT_RETIRED',
    });
    // Only the retirement reads: no other execution data was read.
    expect(ddb.commandCalls(GetCommand)).toHaveLength(3);
    expect(retirementReads()).toHaveLength(2);
    expect(pendingReads()).toHaveLength(1);
  });

  it('denies a grant whose exhausted retirement is recorded on META and serves any other', async () => {
    pending = new Set(['grant-pending']);
    expect(await handler({ ...request, gatewayGrant: await grant('grant-pending') })).toEqual({
      ok: false,
      code: 'GATEWAY_GRANT_RETIRED',
    });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(1);
    expect(await handler({ ...request, gatewayGrant: await grant('grant-other') })).toEqual(SERVED);
  });

  it('fails closed when the retirement lookup fails', async () => {
    retirementLookup = () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    };
    expect(await handler({ ...request, gatewayGrant: await grant('grant-live') })).toEqual({
      ok: false,
      code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE',
    });
  });
});

describe('credential broker legacy shape', () => {
  it('stays on the legacy path in transition without a retirement read', async () => {
    expect(await handler(legacyRequest)).toEqual(SERVED);
    expect(retirementReads()).toHaveLength(0);
  });
});
