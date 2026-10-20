import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { buildUnitPrRow } from '../../shared/v2-process-keys.js';
import {
  RUNTIME_ALIAS_ERROR_CODES,
  handleRuntimeOperation,
  isRuntimeAliasInvocation,
} from '../runtime-alias.js';
import { executeSourceControlOperation, handler } from '../index.js';

const now = () => Date.parse('2026-10-19T12:00:00Z');
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const foreignKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const scope = { mode: 'stage', projectId: 'p', intentId: 'i', executionId: 'e', stageId: 's' };
const env = {
  ENGINE_DATA_ENABLED: 'true',
  GATEWAY_GRANT_KEY_IDS: 'trusted',
  V2_PROCESS_TABLE: 'process',
};
const ALIAS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:source-control:runtime';
const UNQUALIFIED_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:source-control';

const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    now,
    publicKeyFor: async (id) => (id === 'trusted' ? keys.publicKey : null),
  });
const token = (overrides = {}, { privateKey = keys.privateKey, ...options } = {}) =>
  issueGatewayGrant(
    { ...scope, ...overrides },
    {
      sign: async (message) => sign('sha256', message, privateKey),
      keyId: 'trusted',
      now,
      ...options,
    },
  );

const unitPr = ({ executionId, number, repository = 'acme/api', provider = 'github' }) =>
  buildUnitPrRow({
    executionId,
    sectionIndex: 0,
    slug: 'api',
    repository,
    provider,
    number,
    sourceBranch: 'aidlc/unit-api',
    targetBranch: 'aidlc/intent',
    now: '2026-10-19T12:00:00Z',
  });

const harness = (overrides = {}) => {
  const execution = {
    projectId: 'p',
    intentId: 'i',
    status: 'RUNNING',
    repos: ['acme/api'],
    gitProvider: 'github',
    ...overrides.execution,
  };
  const binding = {
    projectId: 'p',
    provider: 'github',
    repo: 'acme/api',
    status: 'active',
    capabilities: { repositoryWrite: true },
    ...overrides.binding,
  };
  // The process table as rows keyed by partition: this execution opened PR 12
  // on acme/api; another execution of the same project opened PR 13 there.
  const processRows = overrides.processRows ?? [
    unitPr({ executionId: 'e', number: 12 }),
    unitPr({ executionId: 'other', number: 13 }),
  ];
  return {
    ddbClient: {
      send: vi.fn(async (command) => {
        const { input } = command;
        if (command instanceof QueryCommand) {
          const values = input.ExpressionAttributeValues;
          expect(input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :prefix)');
          return {
            Items: processRows.filter(
              (row) => row.pk === values[':pk'] && row.sk.startsWith(values[':prefix']),
            ),
          };
        }
        expect(command).toBeInstanceOf(GetCommand);
        return { Item: input.Key.pk ? execution : binding };
      }),
    },
    execute: vi.fn(async () => 'main'),
    verifyGrant,
    env,
  };
};

const operate = async (overrides = {}) => ({
  action: 'operate',
  gatewayGrant: await token(),
  projectId: 'p',
  executionId: 'e',
  provider: 'github',
  repo: 'Acme/API',
  operation: 'default-branch',
  args: {},
  ...overrides,
});

const codeOf = (promise) =>
  promise.then(
    () => 'ALLOWED',
    (error) => error.code,
  );

beforeEach(() => vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings'));
afterEach(() => vi.unstubAllEnvs());

describe('source-control runtime alias', () => {
  it('is selected only by the trusted alias-qualified function ARN', () => {
    expect(isRuntimeAliasInvocation({ invokedFunctionArn: ALIAS_ARN })).toBe(true);
    expect(isRuntimeAliasInvocation({ invokedFunctionArn: UNQUALIFIED_ARN })).toBe(false);
    expect(isRuntimeAliasInvocation({ invokedFunctionArn: `${UNQUALIFIED_ARN}:7` })).toBe(false);
    expect(isRuntimeAliasInvocation(undefined)).toBe(false);
  });

  it.each([
    ['default-branch', {}],
    ['pr-status', { number: 12 }],
    ['pr-status', { number: '12' }],
    ['set-pr-draft', { number: 12, draft: true }],
  ])('allows %s on an execution repository', async (operation, args) => {
    const deps = harness();
    await expect(handleRuntimeOperation(await operate({ operation, args }), deps)).resolves.toBe(
      'main',
    );
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        provider: 'github',
        repo: 'Acme/API',
        operation,
        args,
        repos: [{ provider: 'github', repo: 'Acme/API' }],
      }),
    );
    expect(deps.ddbClient.send.mock.calls[0][0].input).toMatchObject({
      TableName: 'process',
      ConsistentRead: true,
    });
  });

  it.each([
    ['create-pr', {}],
    ['merge-branch', {}],
    ['contents', { path: 'README.md' }],
    ['validate-project', {}],
    ['toString', {}],
  ])('rejects the %s operation', async (operation, args) => {
    const deps = harness();
    expect(await codeOf(handleRuntimeOperation(await operate({ operation, args }), deps))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['default-branch', { branch: 'main' }],
    ['pr-status', {}],
    ['pr-status', { number: 0 }],
    ['pr-status', { number: -1 }],
    ['pr-status', { number: '12/../../x' }],
    ['pr-status', { number: '1'.repeat(11) }],
    ['pr-status', { number: 12, extra: true }],
    ['set-pr-draft', { number: 12, draft: false }],
    ['set-pr-draft', { number: 12 }],
    ['set-pr-draft', { number: 12, draft: 'true' }],
  ])('rejects %s args %j', async (operation, args) => {
    const deps = harness();
    expect(await codeOf(handleRuntimeOperation(await operate({ operation, args }), deps))).toBe(
      'INVALID_REQUEST',
    );
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it('rejects API envelopes, validate-project and extra fields', async () => {
    const deps = harness();
    const apiEnvelope = {
      httpMethod: 'GET',
      path: '/projects/p/source-control/branches',
      requestContext: { authorizer: { claims: { sub: 'u' } } },
      pathParameters: { projectId: 'p' },
    };
    for (const event of [
      apiEnvelope,
      { action: 'validate-project', projectId: 'p' },
      { ...(await operate()), requestContext: apiEnvelope.requestContext },
      { ...(await operate()), action: 'validate-project' },
    ]) {
      expect(await codeOf(handleRuntimeOperation(event, deps))).toBe('INVALID_REQUEST');
    }
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { gatewayGrant: '' }, 'INVALID_REQUEST'],
    ['malformed', { gatewayGrant: 'x.y.z' }, 'GATEWAY_GRANT_INVALID'],
  ])('denies a %s grant before any data read', async (_label, overrides, code) => {
    const deps = harness();
    expect(await codeOf(handleRuntimeOperation(await operate(overrides), deps))).toBe(code);
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it('denies expired, foreign-key and non-engine grants before any data read', async () => {
    const deps = harness();
    const cases = [
      [await token({}, { ttlSeconds: 60, now: () => now() - 120_000 }), 'GATEWAY_GRANT_EXPIRED'],
      [await token({}, { privateKey: foreignKeys.privateKey }), 'GATEWAY_GRANT_INVALID'],
      [
        await token({ mode: 'discussion', executionId: undefined, stageId: undefined }),
        'GATEWAY_GRANT_SCOPE_MISMATCH',
      ],
    ];
    for (const [gatewayGrant, code] of cases) {
      expect(await codeOf(handleRuntimeOperation(await operate({ gatewayGrant }), deps))).toBe(
        code,
      );
    }
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign execution', { executionId: 'other' }],
    ['foreign project', { projectId: 'other' }],
  ])('denies a %s before any data read', async (_label, overrides) => {
    const deps = harness();
    expect(await codeOf(handleRuntimeOperation(await operate(overrides), deps))).toBe(
      'GATEWAY_GRANT_SCOPE_MISMATCH',
    );
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['missing execution', { execution: null }, 'GATEWAY_GRANT_SCOPE_MISMATCH'],
    ['foreign intent', { execution: { intentId: 'other' } }, 'GATEWAY_GRANT_SCOPE_MISMATCH'],
    ['foreign project', { execution: { projectId: 'other' } }, 'GATEWAY_GRANT_SCOPE_MISMATCH'],
    ['terminal execution', { execution: { status: 'COMPLETED' } }, 'EXECUTION_NOT_ACTIVE'],
    [
      'repository outside the execution',
      { execution: { repos: ['acme/web'] } },
      'REPOSITORY_NOT_ON_EXECUTION',
    ],
    [
      'repository of another provider',
      { execution: { gitProvider: 'gitlab' } },
      'REPOSITORY_NOT_ON_EXECUTION',
    ],
  ])('denies a %s', async (_label, overrides, code) => {
    const deps = harness(overrides);
    if (overrides.execution === null) {
      deps.ddbClient.send.mockResolvedValue({});
    }
    expect(await codeOf(handleRuntimeOperation(await operate(), deps))).toBe(code);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['pr-status', { number: 13 }],
    ['set-pr-draft', { number: 13, draft: true }],
    ['pr-status', { number: '99' }],
  ])('denies %s %j on a review this execution did not open', async (operation, args) => {
    const deps = harness();
    expect(await codeOf(handleRuntimeOperation(await operate({ operation, args }), deps))).toBe(
      'REVIEW_NOT_IN_EXECUTION',
    );
    expect(deps.execute).not.toHaveBeenCalled();
    // A stable code the alias handler returns as-is rather than masking it.
    expect(RUNTIME_ALIAS_ERROR_CODES.has('REVIEW_NOT_IN_EXECUTION')).toBe(true);
  });

  it.each([
    ['another repository', unitPr({ executionId: 'e', number: 12, repository: 'acme/web' })],
    ['another provider', unitPr({ executionId: 'e', number: 12, provider: 'gitlab' })],
  ])('denies an own review number recorded on %s', async (_label, row) => {
    const deps = harness({ execution: { repos: ['acme/api', 'acme/web'] }, processRows: [row] });
    expect(
      await codeOf(
        handleRuntimeOperation(
          await operate({ operation: 'pr-status', args: { number: 12 } }),
          deps,
        ),
      ),
    ).toBe('REVIEW_NOT_IN_EXECUTION');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('keeps the binding checks of the shared operation', async () => {
    const deps = harness({ binding: { status: 'invalid' } });
    expect(
      await codeOf(
        handleRuntimeOperation(await operate(), {
          ...deps,
          execute: executeSourceControlOperation,
        }),
      ),
    ).toBe('SOURCE_CONTROL_NOT_READY');
  });

  it.each([
    ['engine-data disabled', { ENGINE_DATA_ENABLED: 'false' }],
    ['no verifier key', { GATEWAY_GRANT_KEY_IDS: ' ' }],
  ])('fails closed with %s', async (_label, overrides) => {
    const deps = { ...harness(), env: { ...env, ...overrides } };
    expect(await codeOf(handleRuntimeOperation(await operate(), deps))).toBe(
      'GATEWAY_GRANT_NOT_CONFIGURED',
    );
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });
});

describe('source-control handler routing', () => {
  it('routes the alias before inspecting the action and returns only safe codes', async () => {
    vi.stubEnv('ENGINE_DATA_ENABLED', 'true');
    vi.stubEnv('GATEWAY_GRANT_KEY_IDS', 'trusted');
    const context = { invokedFunctionArn: ALIAS_ARN };
    await expect(handler({ action: 'validate-project', projectId: 'p' }, context)).resolves.toEqual(
      { ok: false, code: 'INVALID_REQUEST' },
    );
    await expect(
      handler(
        {
          httpMethod: 'GET',
          path: '/projects/p/source-control',
          requestContext: { authorizer: { claims: { sub: 'u' } } },
          pathParameters: { projectId: 'p' },
        },
        context,
      ),
    ).resolves.toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('fails closed on the alias when the flag is off', async () => {
    vi.stubEnv('ENGINE_DATA_ENABLED', '');
    await expect(handler(await operate(), { invokedFunctionArn: ALIAS_ARN })).resolves.toEqual({
      ok: false,
      code: 'GATEWAY_GRANT_NOT_CONFIGURED',
    });
  });

  it('leaves the unqualified entry point on its legacy API contract', async () => {
    await expect(
      handler(
        { httpMethod: 'GET', path: '/projects/p/source-control' },
        {
          invokedFunctionArn: UNQUALIFIED_ARN,
        },
      ),
    ).resolves.toMatchObject({ statusCode: 401 });
  });
});
