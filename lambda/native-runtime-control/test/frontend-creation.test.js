import { randomUUID } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeAuthority } from '../authority.js';
import { handler as publicHandler } from '../index.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { createNativeExecutionConfiguration } from '../execution-config.js';
import { executionRuntimeConfiguration } from '../execution-runtime.js';
import { createNativeIntentListing } from '../listing.js';
import { prepareBinding } from '../../shared/source-control-bindings.js';
import {
  ACTOR,
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  OTHER,
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
  // These entries represent ordinary Project/HAS_MEMBER/HAS_REPO records, not
  // deployment configuration. A new project can appear after the router exists.
  const projects = new Map();
  const addProject = (projectId) => {
    const member = {
      ...MEMBERSHIP,
      projectIdentity: `vertex-${projectId}`,
      membershipId: `edge-${projectId}`,
    };
    const codeBinding = prepareBinding({
      projectId,
      provider: applicationSource.provider,
      repo: applicationSource.repository,
      authType: 'gitlab-oauth',
      credentialRef: `oauth#gitlab#${ACTOR}`,
      connectionUserId: ACTOR,
      capabilities: { repositoryWrite: true },
    });
    projects.set(projectId, { member, codeBinding });
  };
  addProject(PROJECT);
  addProject(OTHER);
  const sources = {
    getAuthorizedBinding: vi.fn(async ({ projectId, actorId }) => {
      expect(actorId).toBe(ACTOR);
      return binding({
        projectId,
        projectIdentity: projects.get(projectId).member.projectIdentity,
      });
    }),
  };
  const jobs = {
    get: vi.fn(async ({ projectId }) => {
      const pin = candidate({ version: '2.11.1', projectId });
      return job({ projectId, candidate: pin, archiveReceipt: receipt(pin) });
    }),
  };
  const membership = vi.fn(async (projectId, actorId) =>
    actorId === ACTOR ? structuredClone(projects.get(projectId)?.member ?? null) : null,
  );
  const storageSend = f.ddb.send.getMockImplementation();
  f.ddb.send.mockImplementation((command) => {
    if (command instanceof QueryCommand) {
      const projectId = command.input.ExpressionAttributeValues[':project'];
      return {
        Items: [...f.rows.values()]
          .filter((row) => row.sk === 'RUNTIME' && row.projectId === projectId)
          .map((row) =>
            Object.fromEntries(
              ['pk', 'sk', 'projectId', 'createdAt', 'executionId'].map((key) => [key, row[key]]),
            ),
          ),
      };
    }
    if (command instanceof GetCommand && command.input.TableName === 'application-bindings') {
      expect(command.input.ConsistentRead).toBe(true);
      return { Item: structuredClone(projects.get(command.input.Key.projectId)?.codeBinding) };
    }
    return storageSend(command);
  });
  const graph = {
    V: vi.fn((vertex) => {
      const chain = {};
      for (const name of ['has', 'limit', 'project', 'by', 'out', 'hasLabel'])
        chain[name] = vi.fn(() => chain);
      chain.toList = vi.fn(async () => {
        if (vertex === undefined) {
          const projectId = chain.has.mock.calls.find(([label]) => label === 'Project')?.[2];
          const project = projects.get(projectId);
          return project
            ? [{ projectIdentity: project.member.projectIdentity, cliModels: [], tierModels: [] }]
            : [];
        }
        const project = [...projects.values()].find((p) => p.member.projectIdentity === vertex);
        if (!project) return [];
        return [
          {
            providers: [project.codeBinding.provider],
            repositories: [project.codeBinding.repo],
          },
        ];
      });
      return chain;
    }),
  };
  const resolveBindings = vi.fn(async ({ projectId, userId }) => {
    expect(projects.has(projectId)).toBe(true);
    expect(userId).toBe(ACTOR);
    return { bedrock: { provider: 'bedrock', source: 'user', userId } };
  });
  const configure = vi.fn(
    createNativeExecutionConfiguration({
      ddb: f.ddb,
      ssm: { send: vi.fn(async () => ({ Parameter: { Value: '{}' } })) },
      graph,
      resolveBindings,
      env: {
        AWS_REGION: 'us-east-1',
        NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
        NATIVE_EXECUTION_IMAGE_URI: IMAGE.uri,
        NATIVE_EXECUTION_IMAGE_DIGEST: IMAGE.digest,
        NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-publications',
        NATIVE_PACKAGES_BUCKET: 'native-packages',
        SOURCE_CONTROL_BINDINGS_TABLE: 'application-bindings',
        AGENT_SETTINGS_SSM_PREFIX: '/aidlc/dev',
        AGENT_CREDENTIAL_METADATA_FUNCTION: 'credential-metadata',
      },
    }),
  );
  const executionStore = createNativeExecutionStore({
    ddb: f.ddb,
    tableName: TABLE,
    preparationStore: f.store,
    now: () => 1000,
  });
  const enqueue = vi.fn();
  const execution = createNativeExecutionApi({
    enabled: true,
    store: executionStore,
    configure,
    enqueue,
    authorizeSource: (draft, actorId) =>
      sources.getAuthorizedBinding({ projectId: draft.projectId, actorId }),
  });
  const listing = createNativeIntentListing({ ddb: f.ddb, tableName: TABLE, store: f.store });
  const router = createNativeRuntimeApi({
    enabled: true,
    store: f.store,
    execution,
    image: IMAGE,
    getMembershipSnapshot: membership,
    listNativeIntents: (input) => listing.list(input),
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
      httpMethod: options.method ?? 'GET',
      resource: `/api/projects/{projectId}/native-intents${suffix}`,
      path: target.pathname,
      pathParameters: { projectId: route[1], ...(route[2] ? { intentId: route[2] } : {}) },
      headers: Object.fromEntries(new Headers(options.headers)),
      body: options.body,
      queryStringParameters: Object.fromEntries(target.searchParams),
      requestContext: { authorizer: { claims: { sub: 'untrusted-forwarded-user' } } },
    });
    if (connection.loseNextResponse && response.statusCode < 300) {
      connection.loseNextResponse = false;
      throw new TypeError('Response lost');
    }
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  vi.stubGlobal('fetch', transport);
  const ready = async (projectId = PROJECT, executionId = IDENTITY.executionId) => {
    const identity = { projectId, executionId };
    await client.prepare(projectId, executionId);
    const claim = await f.store.claim({ ...identity, bindingId: f.read(identity).bindingId });
    expect(claim.kind).toBe('claimed');
    await f.store.ready({ ...owner(claim.row), resources: resources(claim.row) });
  };
  return {
    ...f,
    projects,
    addProject,
    jobs,
    sources,
    membership,
    configure,
    resolveBindings,
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

it('lists, creates, corrects, prepares and explicitly starts existing and newly created spaces without deployment enrollment', async () => {
  const f = fixture();
  const newProject = randomUUID();
  await expect(client.capabilities(newProject)).rejects.toMatchObject({ status: 403 });
  expect(f.rows.size).toBe(0);
  // Normal project creation and membership, after the public router was built.
  f.addProject(newProject);
  const drafts = [];
  for (const projectId of [PROJECT, OTHER, newProject]) {
    expect(await client.capabilities(projectId)).toMatchObject({
      preparationEnabled: true,
      executionEnabled: true,
      unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
    });
    expect(await client.list(projectId)).toEqual({ items: [], nextCursor: null });
    const created = await client.create(projectId, draftRequest());
    expect(created.projectId).toBe(projectId);
    const page = await client.list(projectId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: created.id, projectId });
    expect(page.items[0]).not.toHaveProperty('prompt');
    await client.savePrompt(projectId, created.id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      prompt: `Request for ${projectId}`,
    });
    await f.ready(projectId, created.id);
    const identity = { projectId, executionId: created.id };
    expect(await f.executionStore.get(identity)).toBeNull();
    const started = await client.start(projectId, created.id, randomUUID(), 1);
    expect(started.execution.status).toBe('REQUESTED');
    const execution = await f.executionStore.get(identity);
    expect(execution.scope).toEqual(identity);
    expect(execution.configuration.credentialBinding).toEqual({
      provider: 'bedrock',
      source: 'user',
      userId: ACTOR,
    });
    expect(f.resolveBindings).toHaveBeenCalledWith(
      { projectId, userId: ACTOR },
      { functionName: 'credential-metadata' },
    );
    drafts.push(f.read(identity));
  }
  expect(new Set(drafts.map((row) => row.pk)).size).toBe(3);
  expect(new Set(drafts.map((row) => row.bindingId)).size).toBe(3);
  expect(new Set(drafts.map((row) => row.rootDirectory)).size).toBe(3);
  expect(new Set(drafts.map((row) => row.executionRoleArn)).size).toBe(3);
});

it.each(['list', 'create', 'correct', 'prepare', 'start'])(
  'denies a removed member at the public %s boundary without accepting work',
  async (operation) => {
    const f = fixture();
    await client.create(OTHER, draftRequest({ prompt: 'Ready request' }));
    await f.ready(OTHER);
    const retained = structuredClone([...f.rows]);
    f.membership.mockResolvedValue(null);
    f.enqueue.mockClear();
    const commands = {
      list: () => client.list(OTHER),
      create: () => client.create(OTHER, draftRequest({ intentId: randomUUID() })),
      correct: () =>
        client.savePrompt(OTHER, IDENTITY.executionId, {
          requestId: randomUUID(),
          expectedRevision: 0,
          prompt: 'Unauthorized change',
        }),
      prepare: () => client.prepare(OTHER, IDENTITY.executionId),
      start: () => client.start(OTHER, IDENTITY.executionId, randomUUID(), 0),
    };
    await expect(commands[operation]()).rejects.toMatchObject({ status: 403 });
    expect([...f.rows]).toEqual(retained);
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);

it('keeps execution identity, source bindings and starter credentials inside the requested project', async () => {
  const f = fixture();
  await client.create(OTHER, draftRequest({ prompt: 'Second project request' }));
  await f.ready(OTHER);
  await expect(client.get(PROJECT, IDENTITY.executionId)).rejects.toMatchObject({ status: 404 });
  const ownBinding = f.projects.get(OTHER).codeBinding;
  f.projects.get(OTHER).codeBinding = f.projects.get(PROJECT).codeBinding;
  await expect(client.start(OTHER, IDENTITY.executionId, randomUUID(), 0)).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_REQUIRED' },
  });
  expect(f.resolveBindings).not.toHaveBeenCalled();
  f.projects.get(OTHER).codeBinding = ownBinding;
  f.resolveBindings.mockResolvedValue({
    bedrock: { provider: 'bedrock', source: 'user', userId: 'another-member' },
  });
  await expect(client.start(OTHER, IDENTITY.executionId, randomUUID(), 0)).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_EXECUTION_CONFIG_CREDENTIAL_INVALID' },
  });
  expect(await f.executionStore.get({ ...IDENTITY, projectId: OTHER })).toBeNull();
});

it('rejects another member project package before accepting a draft', async () => {
  const f = fixture();
  const getJob = f.jobs.get.getMockImplementation();
  f.jobs.get.mockImplementation((input) => getJob({ ...input, projectId: PROJECT }));
  await expect(client.create(OTHER, draftRequest())).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_PREPARATION_PACKAGE_INVALID' },
  });
  expect(f.rows.size).toBe(0);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each(['before write', 'after write'])(
  'rechecks public creation membership %s without turning an uncertain commit into editable input',
  async (boundary) => {
    const f = fixture();
    if (boundary === 'before write') {
      const getJob = f.jobs.get.getMockImplementation();
      f.jobs.get.mockImplementation(async (input) => {
        f.membership.mockResolvedValue(null);
        return getJob(input);
      });
    } else {
      f.hooks.after = (command) => {
        if (command instanceof PutCommand) f.membership.mockResolvedValue(null);
      };
    }
    await expect(client.create(OTHER, draftRequest())).rejects.toMatchObject({
      status: 403,
      body: { code: 'NATIVE_PREPARATION_FORBIDDEN' },
    });
    expect(f.rows.size).toBe(boundary === 'before write' ? 0 : 1);
    expect(f.enqueue).not.toHaveBeenCalled();
    if (boundary === 'after write') {
      const retained = f.read({ ...IDENTITY, projectId: OTHER });
      expect(retained.request).toEqual(draftRequest());
      f.membership.mockResolvedValue(f.projects.get(OTHER).member);
      expect((await client.create(OTHER, draftRequest())).id).toBe(IDENTITY.executionId);
      expect(f.read({ ...IDENTITY, projectId: OTHER })).toEqual(retained);
    }
  },
);

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
