import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeAuthority } from '../authority.js';
import { handler as publicHandler } from '../index.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../../shared/native-recovery-mode.js';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';
import { ACTOR, MEMBERSHIP } from './fixtures.js';
import { resetSessionExpiry } from '../../../frontend/src/services/sessionExpiry.ts';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('../../../frontend/src/services/auth.ts', () => ({
  authService: { resolveSession: session.resolveSession },
}));

const ORIGIN = 'https://native-api.example.test';
const TOKEN = 'test-native-member-token';
const AUTHORITY = 'arn:aws:lambda:us-east-1:123456789012:function:native-authority';
let nativeIntentsService;

beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${ORIGIN}/api`);
  vi.stubEnv('NATIVE_AUTHORITY_FUNCTION', AUTHORITY);
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

const fixture = async ({ state = 'recovery', workflowResumeState = 'created' } = {}) => {
  const f = serialFixture({ harness: 'claude', packageVersion: '2.11.1' });
  Object.assign(f.prepared, {
    harness: f.configuration.harness,
    createdAt: f.now(),
    updatedAt: f.now(),
  });
  const execution = f.api;
  const recover = vi.spyOn(execution, 'recover');
  const authority = vi.spyOn(f.ddb, 'send');
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const router = createNativeRuntimeApi({
    enabled: true,
    store: f.preparationStore,
    getMembershipSnapshot: membership,
    execution,
  });
  const verify = vi.fn(async (token) => {
    if (token !== TOKEN)
      throw Object.assign(new Error('Invalid test token'), {
        code: 'NATIVE_AUTHORITY_FORBIDDEN',
      });
    return { sub: ACTOR };
  });
  const commands = vi.fn(router);
  const authorityHandler = createNativeAuthority({
    stores: {},
    commands,
    verify,
    functionName: AUTHORITY,
  });
  vi.spyOn(LambdaClient.prototype, 'send').mockImplementation(async (command) => {
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input.FunctionName).toBe(`${AUTHORITY}:commands`);
    const value = await authorityHandler(JSON.parse(command.input.Payload.toString()), {
      invokedFunctionArn: command.input.FunctionName,
    });
    return { Payload: Buffer.from(JSON.stringify(value)) };
  });
  const connection = { loseNextAcknowledgement: false, eventPatch: {} };
  // The real frontend service, authenticated API wrapper, public Lambda adapter,
  // authority JWT boundary, router, execution API and conditional store all run.
  // Only HTTP/Lambda transport, token verification and local AWS storage are injected.
  const transport = vi.fn(async (url, options) => {
    const target = new URL(url);
    expect(target.origin).toBe(ORIGIN);
    const route =
      /^\/api\/projects\/([^/]+)\/native-intents\/([^/]+)(?:\/(start|response|cancel|recover|interaction))?$/.exec(
        target.pathname,
      );
    expect(route).not.toBeNull();
    const suffix = route[3] ? `/${route[3]}` : '';
    const headers = Object.fromEntries(new Headers(options.headers));
    const result = await publicHandler({
      httpMethod: options.method,
      resource: `/api/projects/{projectId}/native-intents/{intentId}${suffix}`,
      path: target.pathname,
      pathParameters: { projectId: route[1], intentId: route[2] },
      queryStringParameters: Object.fromEntries(target.searchParams),
      body: options.body,
      headers,
      // This forwarded claim must never win over the verified original JWT.
      requestContext: { authorizer: { claims: { sub: 'forged-adapter-actor' } } },
      ...connection.eventPatch,
    });
    if (connection.loseNextAcknowledgement && result.statusCode === 202) {
      connection.loseNextAcknowledgement = false;
      throw new TypeError('Failed to fetch');
    }
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  });
  vi.stubGlobal('fetch', transport);
  const startRequest = Object.freeze({
    requestId: randomUUID(),
    promptRevision: 0,
    inputRevision: 0,
  });
  const start = (request = startRequest) =>
    nativeIntentsService.start(
      f.identity.projectId,
      f.identity.executionId,
      request.requestId,
      request.promptRevision,
    );
  const cancel = () => nativeIntentsService.cancel(f.identity.projectId, f.identity.executionId);
  const reply = (request) =>
    nativeIntentsService.respond(f.identity.projectId, f.identity.executionId, request);
  let replyRequest;
  let retained;
  let required;
  if (state !== 'draft') {
    await start();
    const claimed = await f.store.claim(f.bindingIdentity);
    const dispatching = await f.store.advance({
      row: claimed.row,
      patch: {
        status: 'DISPATCHING',
        target: f.target(claimed.row),
        sourceBranch: SERIAL_SOURCE.branch,
        sourceCommit: SERIAL_SOURCE.commit,
      },
    });
    const running = await f.store.advance({ row: dispatching, patch: { status: 'RUNNING' } });
    await f.store.release({ row: running });
    await f.publish({
      project: false,
      files: [{ path: 'fixture.txt', role: 'code', content: Buffer.from('opaque fixture bytes') }],
    });
    replyRequest = Object.freeze(f.replyRequest({ text: 'The member answer fixture.\n' }));
    if (state === 'recovery') {
      retained = await reply(replyRequest);
      const claimed = await f.store.claim(f.bindingIdentity);
      required = await f.store.recoveryRequired({
        row: claimed.row,
        reason: 'DELIVERY_UNCERTAIN',
        workflowResumeState,
        stoppedSessionId: claimed.row.runtimeSessionId,
      });
      expect(required.recovery.canRecover).toBe(workflowResumeState === 'created');
    }
  }
  const request = required
    ? Object.freeze({
        requestId: randomUUID(),
        recoveryId: required.recovery.id,
        confirmWorkspaceResume: true,
      })
    : null;
  const resume = (input = request) =>
    nativeIntentsService.recover(f.identity.projectId, f.identity.executionId, input);
  const send = (action, body, query = '') =>
    fetch(
      `${ORIGIN}/api/projects/${f.identity.projectId}/native-intents/${f.identity.executionId}/${action}${query}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      },
    );
  for (const spy of [authority, membership, transport, recover, f.enqueue, commands, verify])
    spy.mockClear();
  return {
    ...f,
    required,
    retained,
    recover,
    authority,
    membership,
    commands,
    verify,
    connection,
    transport,
    startRequest,
    replyRequest,
    request,
    start,
    cancel,
    reply,
    resume,
    send,
  };
};

const scenarios = [
  ['start', 'draft', (f) => f.start(), (f) => f.startRequest],
  ['response', 'awaiting', (f) => f.reply(f.replyRequest), (f) => f.replyRequest],
  ['cancel', 'awaiting', (f) => f.cancel(), () => ({})],
  ['recover', 'recovery', (f) => f.resume(), (f) => f.request],
];
const writes = (f) =>
  f.authority.mock.calls.filter(([command]) => command instanceof TransactWriteCommand);

it.each(scenarios)(
  'accepts frontend %s once after a lost HTTP response, without automatic retry or a new identity',
  async (_action, state, invoke, body) => {
    const f = await fixture({ state });
    const expected = structuredClone(body(f));
    f.connection.loseNextAcknowledgement = true;
    await expect(invoke(f)).rejects.toThrow('Failed to fetch');
    expect(f.transport).toHaveBeenCalledOnce();
    const accepted = f.row();
    const ledger = structuredClone([...f.rows]);
    const result = await invoke(f);
    expect(result.execution.attemptId).toBe(accepted.attemptId);
    expect(result.execution.turnSequence).toBe(accepted.turnSequence);
    expect(f.row()).toEqual(accepted);
    expect([...f.rows]).toEqual(ledger);
    expect(writes(f)).toHaveLength(1);
    expect(f.transport.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      expected,
      expected,
    ]);
    expect(f.verify.mock.calls).toEqual([[TOKEN], [TOKEN]]);
    expect(f.membership.mock.calls.every(([, actorId]) => actorId === ACTOR)).toBe(true);
    if (f.retained) {
      const saved = await f.store.response(f.row(), f.replyRequest.interactionId);
      expect(saved.commandId).toBe(f.retained.response.id);
      expect(saved.text).toBe(f.replyRequest.text);
      expect(f.row().response).toBeUndefined();
    }
  },
);

it.each(scenarios)(
  'denies frontend %s before protected reads or writes',
  async (_action, state, invoke) => {
    const f = await fixture({ state });
    const before = structuredClone([...f.rows]);
    f.verify.mockResolvedValue({ sub: ACTOR, 'cognito:groups': ['platform-admin'] });
    f.membership.mockResolvedValue(null);
    await expect(invoke(f)).rejects.toMatchObject({
      status: 403,
      body: { code: 'NATIVE_PREPARATION_FORBIDDEN' },
    });
    expect(f.authority).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect([...f.rows]).toEqual(before);
  },
);

it.each(scenarios)(
  'withholds a frontend %s acceptance after membership revocation without undoing or repeating it',
  async (_action, state, invoke) => {
    const f = await fixture({ state });
    f.hooks.after = (command) => {
      if (command instanceof TransactWriteCommand) f.membership.mockResolvedValue(null);
    };
    await expect(invoke(f)).rejects.toMatchObject({ status: 403 });
    const accepted = f.row();
    expect(writes(f)).toHaveLength(1);
    f.membership.mockResolvedValue({ ...MEMBERSHIP });
    await invoke(f);
    expect(f.row()).toEqual(accepted);
    expect(writes(f)).toHaveLength(1);
  },
);

it.each(scenarios)(
  'requires the original token for frontend %s, regardless of forwarded claims',
  async (_action, state, invoke) => {
    const f = await fixture({ state });
    f.connection.eventPatch = { headers: {} };
    await expect(invoke(f)).rejects.toMatchObject({ code: 'NATIVE_AUTHORITY_FORBIDDEN' });
    expect(f.commands).not.toHaveBeenCalled();
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.authority).not.toHaveBeenCalled();
  },
);

it.each(scenarios)(
  'rejects extra frontend %s authority fields and query parameters before membership',
  async (action, state, _invoke, body) => {
    const f = await fixture({ state });
    const before = structuredClone([...f.rows]);
    for (const field of [
      'actorId',
      'operation',
      'configuration',
      'writerGeneration',
      'nativeSessionId',
      'approved',
    ]) {
      expect((await f.send(action, { ...body(f), [field]: 'untrusted' })).status).toBe(400);
    }
    expect((await f.send(action, body(f), '?requestId=override')).status).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.authority).not.toHaveBeenCalled();
    expect([...f.rows]).toEqual(before);
  },
);

it('keeps one Start and its original pins across competing members, and rejects a conflicting revision', async () => {
  const f = await fixture({ state: 'draft' });
  await f.start();
  const accepted = f.row();
  f.configuration.model = 'changed-setting';
  f.verify.mockResolvedValue({ sub: 'second-member' });
  await f.start({ requestId: randomUUID(), promptRevision: 0, inputRevision: 0 });
  expect(f.row()).toEqual(accepted);
  expect(f.configure).toHaveBeenCalledOnce();
  expect(writes(f)).toHaveLength(1);
  await expect(f.start({ ...f.startRequest, promptRevision: 1 })).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_PROMPT_CONFLICT' },
  });
  expect(f.row()).toEqual(accepted);
});

it('reconciles a Start transaction response loss at the public boundary with the same pinned identity', async () => {
  const f = await fixture({ state: 'draft' });
  f.hooks.after = (command) => {
    if (command instanceof TransactWriteCommand) throw new Error('Lost storage acknowledgement');
  };
  const result = await f.start();
  expect(result.execution.attemptId).toBe(f.row().attemptId);
  const accepted = f.row();
  await f.start();
  expect(f.row()).toEqual(accepted);
  expect(writes(f)).toHaveLength(1);
});

it('rejects conflicting reply retries and a substituted request or member without changing the accepted answer', async () => {
  const f = await fixture({ state: 'awaiting' });
  const accepted = await f.reply(f.replyRequest);
  const row = f.row();
  for (const patch of [
    { text: 'Different answer' },
    { requestId: randomUUID() },
    { interactionId: 'a'.repeat(64) },
    { contentSha256: 'b'.repeat(64) },
  ]) {
    await expect(f.reply({ ...f.replyRequest, ...patch })).rejects.toMatchObject({ status: 409 });
  }
  f.verify.mockResolvedValue({ sub: 'second-member' });
  await expect(f.reply(f.replyRequest)).rejects.toMatchObject({ status: 409 });
  expect(f.row()).toEqual(row);
  expect(writes(f)).toHaveLength(1);
  const saved = await f.store.response(row, f.replyRequest.interactionId);
  expect(saved.commandId).toBe(accepted.response.id);
  expect(saved.actorId).toBe(ACTOR);
  expect(saved.member).toEqual({
    membershipId: MEMBERSHIP.membershipId,
    projectIdentity: MEMBERSHIP.projectIdentity,
  });
});

it('keeps one resume writer across members and retry IDs, and rejects a conflicting recovery episode', async () => {
  const f = await fixture();
  await f.resume();
  const accepted = f.row();
  f.verify.mockResolvedValue({ sub: 'second-member' });
  await f.resume({ ...f.request, requestId: randomUUID() });
  expect(f.row()).toEqual(accepted);
  await expect(f.resume({ ...f.request, recoveryId: randomUUID() })).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_EXECUTION_CONFLICT' },
  });
  expect(writes(f)).toHaveLength(1);
  expect(f.row().workspaceResume.id).toBe(f.request.recoveryId);
});

it('makes cancellation own the epoch and rejects a stale worker and a subsequent reply', async () => {
  const f = await fixture({ state: 'awaiting' });
  await f.reply(f.replyRequest);
  const stale = await f.store.claim(f.bindingIdentity);
  f.authority.mockClear();
  await f.cancel();
  const cancelled = f.row();
  expect(cancelled.epoch).toBe(stale.row.epoch + 1);
  await expect(f.store.dispatched({ row: stale.row })).rejects.toMatchObject({
    code: 'NATIVE_EXECUTION_CANCELLED',
  });
  await expect(f.reply(f.replyRequest)).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_EXECUTION_CANCELLED' },
  });
  await f.cancel();
  expect(f.row()).toEqual(cancelled);
  expect(writes(f)).toHaveLength(1);
});

it.each([
  ['start', 'draft', (f) => ({ ...f.startRequest, promptRevision: undefined })],
  [
    'start',
    'draft',
    (f) => ({ ...f.startRequest, requestId: 'a1227042-0661-1843-8138-9d08fdd0a890' }),
  ],
  ['start', 'draft', (f) => ({ ...f.startRequest, promptRevision: -1 })],
  ['response', 'awaiting', (f) => ({ ...f.replyRequest, text: ' ' })],
  ['response', 'awaiting', (f) => ({ ...f.replyRequest, text: 'reply\u0000' })],
  ['response', 'awaiting', (f) => ({ ...f.replyRequest, selection: null })],
  ['response', 'awaiting', (f) => ({ ...f.replyRequest, contentSha256: 'invalid' })],
  ['recover', 'recovery', (f) => ({ ...f.request, recoveryId: 'untrusted-episode' })],
  ['recover', 'recovery', (f) => ({ ...f.request, confirmWorkspaceResume: false })],
  ['recover', 'recovery', (f) => ({ ...f.request, confirmWorkspaceResume: 'true' })],
  ['cancel', 'awaiting', () => ({ epoch: 99 })],
])(
  'rejects malformed frontend-shaped %s input at the REST boundary %#',
  async (action, state, body) => {
    const f = await fixture({ state });
    const before = structuredClone([...f.rows]);
    expect((await f.send(action, body(f))).status).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.authority).not.toHaveBeenCalled();
    expect([...f.rows]).toEqual(before);
  },
);

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

it.each([
  { confirmWorkspaceResume: undefined },
  { confirmWorkspaceResume: false },
  { checkpoint: { id: 'a'.repeat(64) } },
  { recoveryMode: 'snapshot-v1' },
])(
  'rejects an obsolete or unconfirmed recovery envelope at the public router %j',
  async (patch) => {
    const f = await fixture();
    // Bypass the frontend's projection to exercise the actual public request boundary.
    const response = await fetch(
      `${ORIGIN}/api/projects/${f.identity.projectId}/native-intents/${f.identity.executionId}/recover`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ ...f.request, ...patch }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'NATIVE_PREPARATION_INVALID' });
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(
      f.authority.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(0);
    expect(f.row()).toEqual(f.required);
  },
);
