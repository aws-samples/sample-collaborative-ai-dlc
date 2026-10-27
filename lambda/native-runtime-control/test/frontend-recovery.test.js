import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../../shared/native-recovery-mode.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR, MEMBERSHIP } from './fixtures.js';
import { resetSessionExpiry } from '../../../frontend/src/services/sessionExpiry.ts';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('../../../frontend/src/services/auth.ts', () => ({
  authService: { resolveSession: session.resolveSession },
}));

const ORIGIN = 'https://native-api.example.test';
const TOKEN = 'test-native-member-token';
let nativeIntentsService;

beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${ORIGIN}/api`);
  ({ nativeIntentsService } = await import('../../../frontend/src/services/nativeIntents.ts'));
});
beforeEach(() => {
  resetSessionExpiry();
  session.resolveSession.mockReset().mockResolvedValue({
    session: { idToken: TOKEN },
    expired: false,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllEnvs());

const fixture = async ({ workflowResumeState = 'created' } = {}) => {
  const f = executionFixture({ harness: 'claude', recoveryMode: NATIVE_WORKSPACE_RECOVERY });
  // Complete the existing authority fixture's prepared-row presentation. Its
  // request, package, binding and execution pins remain the fixture's real ones.
  Object.assign(f.prepared, {
    harness: f.configuration.harness,
    createdAt: f.now(),
    updatedAt: f.now(),
  });
  await f.start();
  let { row } = await f.store.claim(f.bindingIdentity);
  row = await f.store.advance({
    row,
    patch: {
      status: 'DISPATCHING',
      target: f.target(row),
      sourceBranch: 'main',
      sourceCommit: 'c'.repeat(40),
    },
  });
  const required = await f.store.recoveryRequired({
    row,
    reason: 'SESSION_LOST',
    workflowResumeState,
    stoppedSessionId: row.runtimeSessionId,
  });
  expect(required.recovery.canRecover).toBe(workflowResumeState === 'created');

  const enqueue = vi.fn(async () => {});
  const execution = createNativeExecutionApi({ enabled: true, store: f.store, enqueue });
  const recover = vi.spyOn(execution, 'recover');
  const authority = vi.spyOn(f.ddb, 'send');
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const router = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [f.identity.projectId],
    store: f.preparationStore,
    getMembershipSnapshot: membership,
    execution,
  });
  const connection = { loseNextAcknowledgement: false };

  // Only Cognito session resolution, API Gateway transport and the existing
  // in-memory AWS fixture are substituted. The frontend service/API wrapper,
  // public router, execution API and conditional authority writes all run.
  const transport = vi.fn(async (url, options) => {
    const target = new URL(url);
    expect(target.origin).toBe(ORIGIN);
    const route = /^\/api\/projects\/([^/]+)\/native-intents\/([^/]+)\/recover$/.exec(
      target.pathname,
    );
    expect(route).not.toBeNull();
    expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    const result = await router({
      httpMethod: options.method,
      resource: '/api/projects/{projectId}/native-intents/{intentId}/recover',
      path: target.pathname,
      pathParameters: { projectId: route[1], intentId: route[2] },
      body: options.body,
      requestContext: { authorizer: { claims: { sub: ACTOR } } },
    });
    if (connection.loseNextAcknowledgement && result.statusCode === 202) {
      connection.loseNextAcknowledgement = false;
      throw new TypeError('Failed to fetch');
    }
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  });
  vi.stubGlobal('fetch', transport);
  const request = Object.freeze({
    requestId: randomUUID(),
    recoveryId: required.recovery.id,
    confirmWorkspaceResume: true,
  });
  const resume = () =>
    nativeIntentsService.recover(f.identity.projectId, f.identity.executionId, request);
  return {
    ...f,
    required,
    enqueue,
    recover,
    authority,
    membership,
    connection,
    transport,
    request,
    resume,
  };
};

it('passes the frontend confirmation through the public router and retries one committed recovery after response loss', async () => {
  const f = await fixture();
  f.connection.loseNextAcknowledgement = true;

  await expect(f.resume()).rejects.toThrow('Failed to fetch');
  const accepted = f.row();
  expect(accepted).toMatchObject({
    status: 'RECOVERING',
    recovery: { id: f.request.recoveryId, writerGeneration: 2 },
    workspaceResume: { id: f.request.recoveryId, writerGeneration: 2 },
  });
  const result = await f.resume();

  expect(result.execution).toMatchObject({
    status: 'RECOVERING',
    revision: accepted.version,
    recovery: { id: f.request.recoveryId, canRecover: false },
    recoveryMode: NATIVE_WORKSPACE_RECOVERY,
  });
  expect(f.transport.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    f.request,
    f.request,
  ]);
  expect(f.recover).toHaveBeenCalledTimes(2);
  for (const [, input] of f.recover.mock.calls) expect(input).toEqual(f.request);
  expect(
    f.authority.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
  ).toHaveLength(1);
  expect(f.row()).toEqual(accepted);
  expect(f.membership).toHaveBeenCalledWith(f.identity.projectId, ACTOR);
});

it('rejects the same frontend recovery request before execution dispatch when membership is denied', async () => {
  const f = await fixture();
  f.membership.mockResolvedValue(null);

  await expect(f.resume()).rejects.toMatchObject({
    status: 403,
    body: { code: 'NATIVE_PREPARATION_FORBIDDEN' },
  });

  expect(f.transport).toHaveBeenCalledOnce();
  expect(f.membership).toHaveBeenCalledExactlyOnceWith(f.identity.projectId, ACTOR);
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.authority).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.row()).toEqual(f.required);
});

it.each(['not_created', 'unavailable'])(
  'rejects direct frontend recovery through the public router for %s workflow state',
  async (workflowResumeState) => {
    const f = await fixture({ workflowResumeState });
    await expect(f.resume()).rejects.toMatchObject({
      status: 409,
      body: { code: 'NATIVE_EXECUTION_CONFLICT' },
    });
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(
      f.authority.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(0);
    expect(f.row()).toEqual(f.required);
  },
);
