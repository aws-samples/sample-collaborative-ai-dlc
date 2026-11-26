import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeExecutionCredentialsLambda } from '../execution-credentials-entry.js';
import { ACTOR, IDENTITY, MEMBERSHIP, OTHER } from './fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const fixture = () => {
  const payload = { ...IDENTITY, attemptId: OTHER, epoch: 1 };
  const env = {
    NATIVE_RUNTIME_BINDINGS_TABLE: 'native-control',
    NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
    NATIVE_RUNTIME_FILE_SYSTEM_ID: 'fs-1234567890abcdef0',
    AWS_REGION: 'us-east-1',
    AWS_PARTITION: 'aws',
  };
  const ddb = { send: vi.fn() };
  const ssm = { send: vi.fn() };
  const secrets = { send: vi.fn() };
  const connection = { close: vi.fn().mockResolvedValue(undefined) };
  const openConnection = vi.fn().mockResolvedValue(connection);
  const preparation = { get: vi.fn() };
  const execution = { get: vi.fn() };
  const preparationFactory = vi.fn(() => preparation);
  const executionFactory = vi.fn(() => execution);
  const membershipSnapshot = vi.fn().mockResolvedValue(MEMBERSHIP);
  const resolved = { ok: true, model: { value: 'fixture-secret' } };
  const facade = vi.fn(async (input) => {
    expect(input).toEqual(payload);
    const deps = create.mock.calls[0][0];
    await deps.getMembershipSnapshot(IDENTITY.projectId, ACTOR);
    await deps.getMembershipSnapshot(IDENTITY.projectId, 'delegator');
    return resolved;
  });
  const create = vi.fn(() => facade);
  const facadeFactory = vi.fn().mockResolvedValue(create);
  const handler = createNativeExecutionCredentialsLambda({
    ddb,
    ssm,
    secrets,
    env,
    openConnection,
    membershipSnapshot,
    preparationFactory,
    executionFactory,
    facadeFactory,
  });
  return {
    payload,
    env,
    ddb,
    ssm,
    secrets,
    connection,
    openConnection,
    preparation,
    execution,
    preparationFactory,
    executionFactory,
    membershipSnapshot,
    resolved,
    facade,
    create,
    facadeFactory,
    handler,
  };
};

describe('separate native credentials Lambda entry', () => {
  it('constructs validating protected stores and supplies existing graph membership', async () => {
    const f = fixture();
    expect(await f.handler(f.payload)).toEqual(f.resolved);
    expect(f.preparationFactory).toHaveBeenCalledWith({
      ddb: f.ddb,
      tableName: 'native-control',
      deployment: {
        accountId: '123456789012',
        region: 'us-east-1',
        partition: 'aws',
        fileSystemId: 'fs-1234567890abcdef0',
      },
    });
    expect(f.executionFactory).toHaveBeenCalledWith({
      ddb: f.ddb,
      tableName: 'native-control',
      preparationStore: f.preparation,
    });
    expect(f.create).toHaveBeenCalledWith({
      executionStore: f.execution,
      preparationStore: f.preparation,
      ddb: f.ddb,
      ssm: f.ssm,
      secrets: f.secrets,
      env: f.env,
      getMembershipSnapshot: expect.any(Function),
    });
    expect(f.openConnection).toHaveBeenCalledOnce();
    expect(f.membershipSnapshot.mock.calls.map((args) => args.slice(1))).toEqual([
      [IDENTITY.projectId, ACTOR],
      [IDENTITY.projectId, 'delegator'],
    ]);
    expect(f.connection.close).toHaveBeenCalledOnce();
  });

  it('does not open graph when the facade rejects the request early', async () => {
    const f = fixture();
    f.facade.mockResolvedValue({ ok: false, code: 'DENIED' });
    expect(await f.handler(f.payload)).toEqual({ ok: false, code: 'DENIED' });
    expect(f.openConnection).not.toHaveBeenCalled();
  });

  it.each(['load', 'preparation', 'execution', 'graph', 'membership', 'facade', 'close'])(
    'suppresses secrets/errors when %s fails',
    async (phase) => {
      const f = fixture();
      const error = new Error('provider-secret-token');
      const targets = {
        load: f.facadeFactory,
        preparation: f.preparationFactory,
        execution: f.executionFactory,
        graph: f.openConnection,
        membership: f.membershipSnapshot,
        facade: f.facade,
        close: f.connection.close,
      };
      targets[phase].mockImplementation(() => {
        throw error;
      });
      const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
        vi.spyOn(console, name).mockImplementation(() => {}),
      );
      expect(await f.handler(f.payload)).toEqual({
        ok: false,
        code: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
      });
      expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
    },
  );

  it('silences actual inherited helper loggers before first import, including ALC override', async () => {
    vi.resetModules();
    vi.stubEnv('POWERTOOLS_LOG_LEVEL', 'DEBUG');
    vi.stubEnv('AWS_LAMBDA_LOG_LEVEL', 'ERROR');
    vi.stubEnv('POWERTOOLS_LOGGER_SAMPLE_RATE', '1');
    vi.stubEnv('GITHUB_APP_CONFIG_PARAM', '/aidlc/dev/github-app-config');
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const { createNativeExecutionCredentialsLambda: freshEntry } =
      await import('../execution-credentials-entry.js');
    const factory = vi.fn(() => ({ get: vi.fn().mockResolvedValue(null) }));
    const handler = freshEntry({
      ddb: { send: vi.fn() },
      ssm: { send: vi.fn() },
      secrets: { send: vi.fn() },
      preparationFactory: factory,
      executionFactory: factory,
    });
    const result = await handler({ action: 'legacy-broker', token: 'request-secret' });
    expect(result.ok).toBe(false);
    expect(process.env.AWS_LAMBDA_LOG_LEVEL).toBe('SILENT');
    expect(process.env.POWERTOOLS_LOG_LEVEL).toBe('SILENT');
    expect(process.env.POWERTOOLS_LOGGER_SAMPLE_RATE).toBe('0');
    const { clearGitHubAuthConfigCache, getGitHubAppConfig } =
      await import('../../shared/github-auth-config.js');
    clearGitHubAuthConfigCache();
    await getGitHubAppConfig({
      send: vi.fn().mockRejectedValue(new Error('raw-credential-provider-error')),
    });
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  });
});
