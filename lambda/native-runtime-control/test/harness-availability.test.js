import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeAuthority } from '../authority.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR, MEMBERSHIP, event } from './fixtures.js';

const CODE = 'NATIVE_EXECUTION_KIRO_UNAVAILABLE';
const fixture = (harness = 'kiro') => {
  const f = executionFixture({ harness });
  Object.assign(f.prepared, { harness, createdAt: f.now(), updatedAt: f.now() });
  if (harness === 'kiro') f.configuration.credentialBinding.provider = 'kiro';
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const configure = vi.fn(async () => structuredClone(f.configuration));
  const authorizeSource = vi.fn(async () => {});
  const enqueue = vi.fn(async () => {});
  const policy = { disabled: [], error: null };
  const ssm = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetParameterCommand);
      expect(command.input).toEqual({ Name: '/aidlc/dev/disabled-clis' });
      if (policy.error) throw policy.error;
      return { Parameter: { Value: JSON.stringify(policy.disabled) } };
    }),
  };
  const execution = createNativeExecutionApi({
    enabled: true,
    ssm,
    settingsPrefix: '/aidlc/dev',
    store: f.store,
    configure,
    authorizeSource,
    enqueue,
  });
  const commands = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [f.identity.projectId],
    store: f.preparationStore,
    getMembershipSnapshot: membership,
    execution,
  });
  const authority = createNativeAuthority({
    commands,
    verify: async (token) => {
      expect(token).toBe('native-test-member-token');
      return { sub: ACTOR };
    },
    functionName: 'arn:aws:lambda:us-east-1:111122223333:function:native-test-authority',
  });
  const calls = vi.spyOn(f.ddb, 'send');
  const invoke = async (route, body) => {
    const item = event(route === 'capabilities' ? 'capabilities' : 'get');
    const command = ['start', 'cancel'].includes(route);
    const result = await authority(
      {
        ...item,
        headers: { Authorization: 'Bearer native-test-member-token' },
        ...(command
          ? {
              httpMethod: 'POST',
              resource: `${item.resource}/${route}`,
              path: `${item.path}/${route}`,
              body: JSON.stringify(body ?? {}),
            }
          : {}),
      },
      {
        invokedFunctionArn:
          'arn:aws:lambda:us-east-1:111122223333:function:native-test-authority:commands',
      },
    );
    expect(result.ok).toBe(true);
    return { status: result.value.statusCode, body: JSON.parse(result.value.body) };
  };
  return { ...f, policy, ssm, membership, configure, authorizeSource, enqueue, calls, invoke };
};
const writes = (f) =>
  f.calls.mock.calls.filter(([command]) => command instanceof TransactWriteCommand);

describe('native harness availability through the public command authority', () => {
  it('reports the temporary limit before Start and rejects repeated direct Kiro requests without admitting work', async () => {
    const f = fixture();
    expect(await f.invoke('capabilities')).toEqual({
      status: 200,
      body: {
        preparationEnabled: true,
        executionEnabled: true,
        unavailableHarnesses: { kiro: CODE },
      },
    });
    const before = structuredClone([...f.rows]);
    expect(await f.invoke('get')).toMatchObject({
      status: 200,
      body: {
        harness: 'kiro',
        status: 'READY',
        executionAvailable: false,
        startUnavailableReason: CODE,
        execution: null,
      },
    });
    const request = { requestId: randomUUID(), promptRevision: 0 };
    for (const input of [request, request, { requestId: randomUUID(), promptRevision: 0 }])
      expect(await f.invoke('start', input)).toEqual({
        status: 409,
        body: {
          code: CODE,
          error:
            'Kiro is temporarily unavailable for new native executions while AI-DLC input and authentication qualification is pending. Choose Claude Code, Codex or OpenCode.',
        },
      });
    expect([...f.rows]).toEqual(before);
    expect(f.row()).toBeUndefined();
    expect(writes(f)).toHaveLength(0);
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.authorizeSource).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.membership).toHaveBeenCalledWith(f.identity.projectId, ACTOR);
  });

  it.each([{ harness: 'claude' }, { unavailableHarnesses: {} }, { executionAvailable: true }])(
    'rejects a caller attempt to override the protected availability with %j',
    async (override) => {
      const f = fixture();
      expect(
        await f.invoke('start', { requestId: randomUUID(), promptRevision: 0, ...override }),
      ).toMatchObject({
        status: 400,
        body: { code: 'NATIVE_PREPARATION_INVALID' },
      });
      expect(f.membership).not.toHaveBeenCalled();
      expect(writes(f)).toHaveLength(0);
      expect(f.configure).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it('still checks membership before exposing a draft or its Start rejection', async () => {
    const f = fixture();
    f.membership.mockResolvedValue(null);
    for (const route of ['capabilities', 'get', 'start'])
      expect(await f.invoke(route, { requestId: randomUUID(), promptRevision: 0 })).toMatchObject({
        status: 403,
        body: { code: 'NATIVE_PREPARATION_FORBIDDEN' },
      });
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.ssm.send).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'opencode'])(
    'enforces the shared disabled-%s policy on capabilities, draft status and direct Start',
    async (harness) => {
      const f = fixture(harness);
      f.policy.disabled = [harness];
      expect(await f.invoke('capabilities')).toMatchObject({
        status: 200,
        body: { unavailableHarnesses: { [harness]: 'agent_cli_disabled', kiro: CODE } },
      });
      expect(await f.invoke('get')).toMatchObject({
        status: 200,
        body: { executionAvailable: false, startUnavailableReason: 'agent_cli_disabled' },
      });
      const request = { requestId: randomUUID(), promptRevision: 0 };
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await f.invoke('start', request)).toEqual({
          status: 400,
          body: {
            code: 'agent_cli_disabled',
            error: 'The selected agent CLI is disabled by the platform administrator',
          },
        });
      expect(writes(f)).toHaveLength(0);
      expect(f.configure).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
      f.policy.disabled = [];
      expect(await f.invoke('start', request)).toMatchObject({ status: 202 });
      expect(writes(f)).toHaveLength(1);
    },
  );

  it.each(['AccessDeniedException', 'ServiceUnavailableException'])(
    'fails closed on %s without exposing policy errors or admitting work',
    async (name) => {
      const f = fixture('codex');
      f.policy.error = Object.assign(new Error('private policy error'), { name });
      for (const route of ['capabilities', 'get', 'start'])
        expect(await f.invoke(route, { requestId: randomUUID(), promptRevision: 0 })).toEqual({
          status: 503,
          body: {
            code: 'NATIVE_EXECUTION_CONFIG_UNAVAILABLE',
            error: 'Native execution configuration is unavailable',
          },
        });
      expect(writes(f)).toHaveLength(0);
      expect(f.configure).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it('allows the shared missing-parameter default while retaining the native Kiro restriction', async () => {
    const f = fixture('codex');
    f.policy.error = Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
    expect(await f.invoke('capabilities')).toMatchObject({
      status: 200,
      body: { unavailableHarnesses: { kiro: CODE } },
    });
    expect(await f.invoke('start', { requestId: randomUUID(), promptRevision: 0 })).toMatchObject({
      status: 202,
    });
  });

  it.each(['disabled', 'unreadable'])(
    'keeps an admitted Start identity and configuration when policy becomes %s',
    async (change) => {
      const f = fixture('codex');
      const request = { requestId: randomUUID(), promptRevision: 0 };
      const result = await f.invoke('start', request);
      const accepted = structuredClone(f.row());
      f.policy.disabled = ['codex'];
      if (change === 'unreadable') f.policy.error = new Error('policy unavailable');
      f.configuration.model = 'later-project-model';
      f.ssm.send.mockClear();
      expect(await f.invoke('start', request)).toEqual(result);
      expect(await f.invoke('get')).toMatchObject({
        status: 200,
        body: { executionAvailable: true, execution: result.body.execution },
      });
      expect(f.row()).toEqual(accepted);
      expect(writes(f)).toHaveLength(1);
      expect(f.configure).toHaveBeenCalledTimes(1);
      expect(f.ssm.send).not.toHaveBeenCalled();
    },
  );

  it.each(['claude', 'codex', 'opencode'])(
    'preserves ordinary new Start admission and immutable retry for %s',
    async (harness) => {
      const f = fixture(harness);
      expect(await f.invoke('get')).toMatchObject({
        status: 200,
        body: { executionAvailable: true, execution: null },
      });
      const request = { requestId: randomUUID(), promptRevision: 0 };
      const result = await f.invoke('start', request);
      expect(result).toMatchObject({ status: 202, body: { execution: { status: 'REQUESTED' } } });
      const accepted = f.row();
      expect(await f.invoke('start', request)).toEqual(result);
      expect(f.row()).toEqual(accepted);
      expect(f.row().configuration.harness).toBe(harness);
      expect(writes(f)).toHaveLength(1);
      expect(f.configure).toHaveBeenCalledTimes(1);
    },
  );

  it('retains an already admitted Kiro run, its pins, Start retry and cancellation', async () => {
    const f = fixture();
    // A retained execution predates the admission limit. The real store still
    // understands its configuration; no new Kiro request uses this test seam.
    await f.start();
    const accepted = f.row();
    f.calls.mockClear();
    const status = await f.invoke('get');
    expect(status).toMatchObject({
      status: 200,
      body: { harness: 'kiro', executionAvailable: true, execution: { status: 'REQUESTED' } },
    });
    expect(status.body).not.toHaveProperty('startUnavailableReason');
    expect(await f.invoke('start', { requestId: randomUUID(), promptRevision: 0 })).toMatchObject({
      status: 202,
    });
    expect(f.row()).toEqual(accepted);
    expect(writes(f)).toHaveLength(0);
    expect(f.configure).not.toHaveBeenCalled();
    expect(await f.invoke('cancel')).toMatchObject({
      status: 202,
      body: { execution: { status: 'CANCEL_REQUESTED' } },
    });
    expect(f.row().configuration).toEqual(accepted.configuration);
  });
});
