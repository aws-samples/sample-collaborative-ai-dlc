import { randomUUID } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeAuthority } from '../authority.js';
import { handler as publicHandler } from '../index.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { nativePreparedConfigurationPins } from '../execution-config.js';
import { executionRuntimeConfiguration } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import {
  ACTOR,
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  PROJECT,
  TABLE,
  binding,
  candidate,
  job,
  owner,
  receipt,
  request,
  resources,
  setup,
} from './fixtures.js';
import { resetSessionExpiry } from '../../../frontend/src/services/sessionExpiry.ts';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('../../../frontend/src/services/auth.ts', () => ({
  authService: { resolveSession: session.resolveSession },
}));
const ORIGIN = 'https://native-api.example.test';
const TOKEN = 'test-native-member-token';
const AUTHORITY = 'arn:aws:lambda:us-east-1:123456789012:function:native-authority';
let client;
beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${ORIGIN}/api`);
  vi.stubEnv('NATIVE_AUTHORITY_FUNCTION', AUTHORITY);
  ({ nativeIntentsService: client } =
    await import('../../../frontend/src/services/nativeIntents.ts'));
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

const applicationSource = { provider: 'gitlab', repository: 'group/application' };
const draftRequest = (overrides = {}) =>
  request({
    title: 'Shared title-only request',
    prompt: '',
    applicationSource: { ...applicationSource },
    ...overrides,
  });

function fixture() {
  const f = setup();
  const pin = candidate({ version: '2.11.1' });
  const sources = { getAuthorizedBinding: vi.fn(async () => binding()) };
  const jobs = { get: vi.fn(async () => job({ candidate: pin, archiveReceipt: receipt(pin) })) };
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const executionStore = createNativeExecutionStore({
    ddb: f.ddb,
    tableName: TABLE,
    preparationStore: f.store,
    now: () => 1000,
  });
  // Configuration inputs and provisioning are local ports. Actual repository
  // membership/binding resolution is exercised in execution-config.test.js.
  const configure = vi.fn(async ({ draft }) => ({
    ...executionFixture().configuration,
    ...nativePreparedConfigurationPins(draft),
    repository: { ...applicationSource, branch: null, bindingRevision: request().bindingRevision },
  }));
  const enqueue = vi.fn();
  const execution = createNativeExecutionApi({
    enabled: true,
    store: executionStore,
    configure,
    enqueue,
    authorizeSource: async () => {},
  });
  const router = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    execution,
    image: IMAGE,
    getMembershipSnapshot: membership,
    workflowSources: sources,
    jobs,
    enqueue,
  });
  const verify = vi.fn(async (token) => {
    if (token !== TOKEN) throw new Error('Invalid test identity');
    return { sub: ACTOR };
  });
  const authority = createNativeAuthority({
    stores: {},
    commands: router,
    verify,
    functionName: AUTHORITY,
  });
  vi.spyOn(LambdaClient.prototype, 'send').mockImplementation(async (command) => {
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input.FunctionName).toBe(`${AUTHORITY}:commands`);
    const result = await authority(JSON.parse(command.input.Payload.toString()), {
      invokedFunctionArn: command.input.FunctionName,
    });
    return { Payload: Buffer.from(JSON.stringify(result)) };
  });
  const connection = { loseNextResponse: false };
  const transport = vi.fn(async (url, options) => {
    const target = new URL(url);
    expect(target.origin).toBe(ORIGIN);
    const route =
      /^\/api\/projects\/([^/]+)\/native-intents(?:\/([^/]+)(?:\/(prepare|prompt|start))?)?$/.exec(
        target.pathname,
      );
    expect(route).not.toBeNull();
    const suffix = route[2] ? `/{intentId}${route[3] ? `/${route[3]}` : ''}` : '';
    const response = await publicHandler({
      httpMethod: options.method,
      resource: `/api/projects/{projectId}/native-intents${suffix}`,
      path: target.pathname,
      pathParameters: { projectId: route[1], ...(route[2] ? { intentId: route[2] } : {}) },
      headers: Object.fromEntries(new Headers(options.headers)),
      body: options.body,
      requestContext: { authorizer: { claims: { sub: 'untrusted-forwarded-user' } } },
    });
    if (connection.loseNextResponse && response.statusCode < 300) {
      connection.loseNextResponse = false;
      throw new TypeError('Response lost');
    }
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  vi.stubGlobal('fetch', transport);
  const ready = async () => {
    await client.prepare(PROJECT, IDENTITY.executionId);
    const claim = await f.store.claim({ ...IDENTITY, bindingId: f.read().bindingId });
    expect(claim.kind).toBe('claimed');
    await f.store.ready({ ...owner(claim.row), resources: resources(claim.row) });
  };
  return {
    ...f,
    jobs,
    sources,
    membership,
    configure,
    executionStore,
    enqueue,
    verify,
    transport,
    connection,
    ready,
  };
}

it('creates, corrects, prepares and starts a frontend title-only request through the authenticated public router', async () => {
  const f = fixture();
  const original = draftRequest();
  const created = await client.create(PROJECT, original);
  expect(created).toMatchObject({
    id: original.intentId,
    status: 'DRAFT',
    prompt: '',
    promptRevision: 0,
    applicationSource,
    package: { version: '2.11.1' },
  });
  const savedRequest = {
    requestId: randomUUID(),
    expectedRevision: 0,
    prompt: 'Exact corrected prompt.\nKeep human approvals.  ',
  };
  const saved = await client.savePrompt(PROJECT, created.id, savedRequest);
  expect(saved).toMatchObject({
    prompt: savedRequest.prompt,
    promptRevision: 1,
    applicationSource,
  });
  await f.ready();
  await expect(client.start(PROJECT, created.id, randomUUID(), 0)).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_PROMPT_CONFLICT' },
  });
  expect(await f.executionStore.get(IDENTITY)).toBeNull();
  const startId = randomUUID();
  f.connection.loseNextResponse = true;
  await expect(client.start(PROJECT, created.id, startId, 1)).rejects.toThrow('Response lost');
  const accepted = await f.executionStore.get(IDENTITY);
  const calls = f.transport.mock.calls.length;
  expect(f.configure).toHaveBeenCalledTimes(1);
  const recovered = await client.start(PROJECT, created.id, startId, 1);
  expect(f.transport).toHaveBeenCalledTimes(calls + 1);
  expect(recovered.execution.attemptId).toBe(accepted.attemptId);
  expect(await f.executionStore.get(IDENTITY)).toEqual(accepted);
  expect(f.configure).toHaveBeenCalledTimes(1);
  expect(f.read().request).toEqual(original);
  expect(executionRuntimeConfiguration(f.read(), accepted)).toMatchObject({
    prompt: savedRequest.prompt,
    repository: expect.objectContaining(applicationSource),
  });
  expect(f.membership.mock.calls.every(([, actor]) => actor === ACTOR)).toBe(true);
  expect(f.verify.mock.calls.every(([token]) => token === TOKEN)).toBe(true);
});

it('keeps one binding for competing identical creates and a lost response, rejecting a substituted application', async () => {
  const f = fixture();
  const input = draftRequest();
  f.connection.loseNextResponse = true;
  const results = await Promise.allSettled([
    client.create(PROJECT, input),
    client.create(PROJECT, structuredClone(input)),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const committed = f.read();
  const retry = await client.create(PROJECT, input);
  expect(retry.id).toBe(input.intentId);
  expect(f.read()).toEqual(committed);
  await expect(
    client.create(PROJECT, {
      ...input,
      applicationSource: { provider: 'github', repository: 'other/app' },
    }),
  ).rejects.toMatchObject({ status: 409, body: { code: 'NATIVE_PREPARATION_CONFLICT' } });
  expect(f.read()).toEqual(committed);
  expect(f.rows.size).toBe(1);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it('retains exact prompt acceptance after a lost response and refuses competing edits', async () => {
  const f = fixture();
  await client.create(PROJECT, draftRequest());
  const edit = { requestId: randomUUID(), expectedRevision: 0, prompt: 'Retained correction' };
  f.connection.loseNextResponse = true;
  await expect(client.savePrompt(PROJECT, IDENTITY.executionId, edit)).rejects.toThrow(
    'Response lost',
  );
  const committed = f.read();
  expect(await client.savePrompt(PROJECT, IDENTITY.executionId, edit)).toMatchObject({
    prompt: edit.prompt,
    promptRevision: 1,
  });
  await expect(
    client.savePrompt(PROJECT, IDENTITY.executionId, {
      ...edit,
      requestId: randomUUID(),
      prompt: 'Conflicting correction',
    }),
  ).rejects.toMatchObject({ status: 409, body: { code: 'NATIVE_PROMPT_CONFLICT' } });
  expect(f.read()).toEqual(committed);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([
  { provider: 'codecommit', repository: 'unsupported' },
  { provider: 'gitlab', repository: 'group/app', branch: 'unreviewed' },
  { provider: 'github', repository: 'https://example.test/private/repo' },
])(
  'rejects an invalid frontend application selection before reading package authority: %j',
  async (source) => {
    const f = fixture();
    await expect(
      client.create(PROJECT, draftRequest({ applicationSource: source })),
    ).rejects.toMatchObject({
      status: 400,
      body: { draftInputRejected: true },
    });
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.jobs.get).not.toHaveBeenCalled();
    expect(f.read()).toBeUndefined();
  },
);

it.each(['member denied', 'package changed', 'source revision changed'])(
  'refuses native creation when %s, without accepting or queuing a draft',
  async (reason) => {
    const f = fixture();
    if (reason === 'member denied') f.membership.mockResolvedValue(null);
    if (reason === 'package changed') f.jobs.get.mockResolvedValue(job({ state: 'RUNNING' }));
    if (reason === 'source revision changed')
      f.sources.getAuthorizedBinding.mockResolvedValue(binding({ revision: randomUUID() }));
    await expect(client.create(PROJECT, draftRequest())).rejects.toMatchObject({
      status: reason === 'member denied' ? 403 : 409,
    });
    expect(f.read()).toBeUndefined();
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);
