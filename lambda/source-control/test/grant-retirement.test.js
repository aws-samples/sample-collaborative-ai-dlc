import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { Logger } from '@aws-lambda-powertools/logger';
import { issueGatewayGrant } from '../../shared/gateway-grant.js';
import { isGatewayGrantRetired } from '../../shared/gateway-grant-retirement.js';
import { gatewayGrantVerifier, handleRuntimeOperation } from '../runtime-alias.js';

// The function builds its runtime grant verifier from its environment at import
// time, so the handler cases below exercise the deployed wiring.
vi.hoisted(() => {
  process.env.GATEWAY_GRANT_KEY_IDS = 'trusted';
  process.env.GATEWAY_GRANT_RETIREMENT_TABLE = 'retired-grants';
});

const { handler } = await import('../index.js');

const ALIAS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:source-control:runtime';
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const env = {
  ENGINE_DATA_ENABLED: 'true',
  GATEWAY_GRANT_KEY_IDS: 'trusted',
  V2_PROCESS_TABLE: 'process',
};
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
const operate = async (jti, at) => ({
  action: 'operate',
  gatewayGrant: await grant(jti, at),
  projectId: 'p',
  executionId: 'e',
  provider: 'github',
  repo: 'Acme/API',
  operation: 'default-branch',
  args: {},
});
const EXECUTION = {
  projectId: 'p',
  intentId: 'i',
  status: 'RUNNING',
  repos: ['acme/api'],
  gitProvider: 'github',
};

// `retired`: jti keys; `executionRetiredAt`: the EXEC#e record's retiredAt;
// `pending`: the jtis META records as unretired.
const retirementTable = (retired = new Set(), executionRetiredAt = null, pending = null) => ({
  send: vi.fn(async ({ input }) => {
    if (input.TableName === 'process') {
      return { Item: pending ? { pendingGrantRetirements: pending } : undefined };
    }
    if (input.Key.pk === 'EXEC#e') {
      return { Item: executionRetiredAt === null ? undefined : { retiredAt: executionRetiredAt } };
    }
    return { Item: retired.has(input.Key.pk) ? { pk: input.Key.pk } : undefined };
  }),
});

const seam = ({ retired, executionRetiredAt, pending, isRetired } = {}) => {
  const table = retirementTable(retired, executionRetiredAt, pending);
  return {
    ddbClient: { send: vi.fn(async () => ({ Item: EXECUTION })) },
    execute: vi.fn(async () => 'main'),
    env,
    verifyGrant: gatewayGrantVerifier(
      async (kid) => (kid === 'trusted' ? keys.publicKey : null),
      isRetired ??
        ((claims) =>
          isGatewayGrantRetired(
            { ddb: table, tableName: 't', processTableName: 'process' },
            claims,
          )),
    ),
  };
};

describe('source-control runtime alias end-of-stage grant retirement', () => {
  it('serves a live grant', async () => {
    const deps = seam();
    await expect(handleRuntimeOperation(await operate('grant-live'), deps)).resolves.toBe('main');
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('denies a retired grant before any process read or provider call', async () => {
    const deps = seam({ retired: new Set(['GRANT#grant-done']) });
    await expect(handleRuntimeOperation(await operate('grant-done'), deps)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIRED',
    });
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('denies a grant issued at or before its execution was retired', async () => {
    const issuedAt = Date.now();
    const deps = seam({ executionRetiredAt: Math.floor(issuedAt / 1000) });
    await expect(
      handleRuntimeOperation(await operate('grant-before-cancel', issuedAt), deps),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_RETIRED' });
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('serves a re-driven run’s grant issued after the execution was retired', async () => {
    const issuedAt = Date.now();
    const deps = seam({ executionRetiredAt: Math.floor(issuedAt / 1000) - 1 });
    await expect(
      handleRuntimeOperation(await operate('grant-redrive', issuedAt), deps),
    ).resolves.toBe('main');
  });

  it('denies a grant whose exhausted retirement is recorded on META and serves any other', async () => {
    const deps = seam({ pending: new Set(['grant-pending']) });
    await expect(
      handleRuntimeOperation(await operate('grant-pending'), deps),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_RETIRED' });
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    await expect(handleRuntimeOperation(await operate('grant-other'), deps)).resolves.toBe('main');
  });

  it('fails closed when the retirement lookup fails', async () => {
    const deps = seam({
      isRetired: async () => {
        throw new Error('ThrottlingException');
      },
    });
    await expect(handleRuntimeOperation(await operate('grant-live'), deps)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE',
    });
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

describe('source-control runtime alias handler wiring', () => {
  let ddb;
  let kms;
  beforeEach(() => {
    kms = mockClient(KMSClient);
    kms
      .on(GetPublicKeyCommand)
      .resolves({ PublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }) });
    ddb = mockClient(DynamoDBDocumentClient);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
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

  it('surfaces a retired grant from the deployed retirement table', async () => {
    ddb.on(GetCommand).callsFake(({ TableName, Key }) => ({
      Item:
        TableName === 'retired-grants'
          ? Key.pk.startsWith('GRANT#')
            ? Key
            : undefined
          : EXECUTION,
    }));
    await expect(
      handler(await operate('grant-done'), { invokedFunctionArn: ALIAS_ARN }),
    ).resolves.toEqual({ ok: false, code: 'GATEWAY_GRANT_RETIRED' });
    const reads = ddb.commandCalls(GetCommand).map((call) => call.args[0].input);
    expect(reads).toEqual([
      expect.objectContaining({
        TableName: 'process',
        Key: { pk: 'EXEC#e', sk: 'META' },
        ConsistentRead: true,
        ProjectionExpression: 'pendingGrantRetirements',
      }),
      expect.objectContaining({
        TableName: 'retired-grants',
        Key: { pk: 'GRANT#grant-done' },
        ConsistentRead: true,
      }),
      expect.objectContaining({
        TableName: 'retired-grants',
        Key: { pk: 'EXEC#e' },
        ConsistentRead: true,
        ProjectionExpression: 'retiredAt',
      }),
    ]);
  });

  it('surfaces an execution retirement from the deployed retirement table', async () => {
    const issuedAt = Date.now();
    ddb.on(GetCommand).callsFake(({ TableName, Key }) => ({
      Item:
        TableName === 'retired-grants'
          ? Key.pk === 'EXEC#e'
            ? { retiredAt: Math.floor(issuedAt / 1000) + 1 }
            : undefined
          : EXECUTION,
    }));
    await expect(
      handler(await operate('grant-before-cancel', issuedAt), { invokedFunctionArn: ALIAS_ARN }),
    ).resolves.toEqual({ ok: false, code: 'GATEWAY_GRANT_RETIRED' });
    // Only the retirement reads: the projected META read of pending jtis.
    expect(
      ddb
        .commandCalls(GetCommand)
        .filter((c) => c.args[0].input.TableName !== 'retired-grants')
        .map((c) => c.args[0].input.ProjectionExpression),
    ).toEqual(['pendingGrantRetirements']);
  });

  it('surfaces a failed retirement lookup as unavailable', async () => {
    ddb
      .on(GetCommand)
      .rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(
      handler(await operate('grant-live'), { invokedFunctionArn: ALIAS_ARN }),
    ).resolves.toEqual({ ok: false, code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE' });
  });
});
