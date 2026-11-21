import { randomUUID } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeAuthority } from '../authority.js';
import { handler as publicHandler } from '../index.js';
import { createNativeExecutionApi, nativeExecutionSummaries } from '../execution-api.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { createNativeExecutionConfiguration } from '../execution-config.js';
import { executionRuntimeConfiguration } from '../execution-runtime.js';
import { createNativeIntentListing } from '../listing.js';
import { createNativeRuntimeImagePolicy, nativeRuntimeImageKey } from '../runtime-images.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { nativeWaitingStatus } from '../../../frontend/src/lib/intentDiscovery.ts';
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
import { createNativeInputApi } from '../input-api.js';
import { inputFixture } from './input-fixtures.js';
import { materializeAttachments, attachmentPromptManifest } from '../../agentcore/attachments.js';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureNativeSource } from '../../source-control/native-source.js';
import { resolveNativeSourceCommit } from '../../shared/native-application-source.js';

const session = vi.hoisted(() => ({ resolveSession: vi.fn(), sourceCredential: vi.fn() }));
vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: session.sourceCredential,
}));
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
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'application-bindings');
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'git-connections');
  vi.stubEnv('JIRA_OAUTH_SECRET_NAME', 'fixture-jira-oauth');
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

function fixture({ sourceProvider = 'gitlab', trackerProvider = 'gitlab-issues' } = {}) {
  const f = setup();
  session.sourceCredential.mockResolvedValue({ token: 'fixture-source-token' });
  const selectedSource = { ...applicationSource, provider: sourceProvider };
  const sourceConnection = {
    userId: ACTOR,
    provider: sourceProvider,
    providerInstance: `${sourceProvider}#public`,
    status: 'active',
    generation: 'original',
    parameterName: '/fixture/source/token/member',
  };
  const inputPorts = inputFixture(trackerProvider);
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
      provider: selectedSource.provider,
      repo: selectedSource.repository,
      authType: `${sourceProvider}-oauth`,
      credentialRef: `oauth#${sourceProvider}#${ACTOR}`,
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
    if (command instanceof GetCommand && command.input.TableName === 'git-connections')
      return { Item: structuredClone(sourceConnection) };
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
      s3: inputPorts.s3,
      invokeTracker: inputPorts.invokeTracker,
      captureSource: async (input) => ({
        ok: true,
        source: await captureNativeSource({
          input,
          metadataOnly: input.metadataOnly === true,
          ddb: f.ddb,
          ssm: {},
          secrets: {},
          membership: async (actorId) => (await membership(input.projectId, actorId))?.role,
          repositories: async () => [{ provider: sourceProvider, repo: selectedSource.repository }],
          resolveCommit: (args) =>
            resolveNativeSourceCommit({ ...args, fetchImpl: inputPorts.fetchImpl }),
        }),
      }),
      env: {
        AWS_REGION: 'us-east-1',
        NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
        NATIVE_EXECUTION_IMAGE_URI: IMAGE.uri,
        NATIVE_EXECUTION_IMAGE_DIGEST: IMAGE.digest,
        NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-publications',
        NATIVE_PACKAGES_BUCKET: 'native-packages',
        ARTIFACTS_BUCKET: 'native-inputs',
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
  const executionReads = {
    store: executionStore,
    images: createNativeRuntimeImagePolicy({
      ddb: f.ddb,
      tableName: TABLE,
      env: { AWS_REGION: 'us-east-1', NATIVE_RUNTIME_ACCOUNT_ID: '123456789012' },
    }),
    deployment: () => ({ image: IMAGE }),
  };
  const execution = createNativeExecutionApi({
    enabled: true,
    ...executionReads,
    configure,
    enqueue,
    authorizeSource: (draft, actorId) =>
      sources.getAuthorizedBinding({ projectId: draft.projectId, actorId }),
  });
  const listing = createNativeIntentListing({ ddb: f.ddb, tableName: TABLE, store: f.store });
  const router = createNativeRuntimeApi({
    enabled: true,
    store: f.store,
    execution: {
      ...execution,
      summaries: (drafts) => nativeExecutionSummaries(drafts, executionReads),
    },
    inputs: createNativeInputApi({
      store: f.store,
      executionStore,
      bucket: 'native-inputs',
      accountId: '123456789012',
      ...inputPorts,
    }),
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
    if (target.origin !== ORIGIN) return inputPorts.fetchImpl(url, options);
    const route =
      /^\/api\/projects\/([^/]+)\/native-intents(?:\/([^/]+)(?:\/(prepare|prompt|start|inputs))?)?$/.exec(
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
    inputPorts,
    sourceConnection,
  };
}

it('delivers uploaded immutable content from the frontend serializer through admission to the actual materializer', async () => {
  const f = fixture();
  const draft = await client.create(
    PROJECT,
    draftRequest({ prompt: 'Use the selected reference.' }),
  );
  const bytes = Buffer.from('Approved input content.\n');
  const attachmentId = randomUUID();
  const uploaded = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'upload',
    attachmentId,
    filename: 'reference.md',
    mimeType: 'text/markdown',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  expect(uploaded.intent.inputs.pendingUploads).toHaveLength(1);
  const key = new URL(uploaded.upload.url).pathname.slice(1);
  f.inputPorts.put(key, bytes, 'text/markdown');
  const completed = await client.inputs(PROJECT, draft.id, 1, {
    operation: 'complete',
    attachmentId,
  });
  expect(completed.intent.inputRevision).toBe(2);
  expect(completed.intent.inputs.pendingUploads).toEqual([]);
  await f.ready();
  await expect(client.start(PROJECT, draft.id, randomUUID(), 0, 1)).rejects.toMatchObject({
    status: 409,
    body: { code: 'NATIVE_INPUT_CONFLICT' },
  });
  const requestId = randomUUID();
  f.connection.loseNextResponse = true;
  await expect(client.start(PROJECT, draft.id, requestId, 0, 2)).rejects.toThrow('Response lost');
  const row = await f.executionStore.get(IDENTITY);
  const pinned = structuredClone(row.configuration);
  expect(row.sourceCommit).toBe('c'.repeat(40));
  expect(pinned.inputs.attachments[0].sha256).toBe(
    createHash('sha256').update(bytes).digest('hex'),
  );
  f.inputPorts.put(key, Buffer.from('A later staging upload.'), 'text/markdown');
  f.projects.get(PROJECT).codeBinding.revision = randomUUID();
  const retry = await client.start(PROJECT, draft.id, requestId, 0, 2);
  expect((await f.executionStore.get(IDENTITY)).requestId).toBe(requestId);
  expect((await f.executionStore.get(IDENTITY)).configuration).toEqual(pinned);
  expect(f.configure).toHaveBeenCalledTimes(1);
  await expect(
    client.inputs(PROJECT, draft.id, 2, { operation: 'remove', attachmentId }),
  ).rejects.toMatchObject({ status: 409 });
  const workspace = await mkdtemp(join(tmpdir(), 'native-input-contract-'));
  try {
    const materialized = await materializeAttachments({
      workspaceDir: workspace,
      attachments: pinned.inputs.attachments,
      bucket: pinned.inputs.bucket,
      client: f.inputPorts.s3,
      strict: true,
    });
    expect(await readFile(join(workspace, materialized.attachments[0].path))).toEqual(bytes);
    expect(attachmentPromptManifest(materialized.attachments)).toContain('untrusted input');
    expect(JSON.stringify(retry)).not.toMatch(/s3VersionId|s3Key|fixture-source-token/);
  } finally {
    await chmod(join(workspace, '.aidlc/references'), 0o755).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
});

it('imports tracker text and provider attachments through the shared owners and pins their actual content', async () => {
  const f = fixture();
  const draft = await client.create(PROJECT, draftRequest({ prompt: 'Use the tracker inputs.' }));
  let result = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'tracker',
    bindingId: 'tracker-one',
    resourceId: '7',
  });
  expect(result.intent.inputs.attachments).toHaveLength(1);
  expect(result.intent.inputs.source).toMatchObject({ provider: 'gitlab-issues', resourceId: '7' });
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'discover',
  });
  expect(result.discovery.attachments).toHaveLength(1);
  expect(result.discovery.attachments[0]).not.toHaveProperty('url');
  const attachmentId = result.discovery.attachments[0].id;
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'import',
    attachmentId,
  });
  expect(result.importResult.status).toBe('imported');
  expect(result.intent.inputs.attachments).toHaveLength(2);
  const revision = result.intent.inputRevision;
  const duplicate = await client.inputs(PROJECT, draft.id, revision, {
    operation: 'import',
    attachmentId,
  });
  expect(duplicate.intent.inputRevision).toBe(revision);
  f.inputPorts.state.text = 'Tracker text changed after import.';
  f.inputPorts.state.attachment = Buffer.from('Tracker attachment replaced.');
  await f.ready();
  await client.start(PROJECT, draft.id, randomUUID(), 0, revision);
  const row = await f.executionStore.get(IDENTITY);
  const configuration = executionRuntimeConfiguration(f.read(IDENTITY), row);
  const workspace = await mkdtemp(join(tmpdir(), 'native-tracker-contract-'));
  try {
    const materialized = await materializeAttachments({
      workspaceDir: workspace,
      attachments: configuration.inputs.attachments,
      bucket: configuration.inputs.bucket,
      client: f.inputPorts.s3,
      strict: true,
    });
    const contents = await Promise.all(
      materialized.attachments.map((file) => readFile(join(workspace, file.path), 'utf8')),
    );
    expect(contents[0]).toContain('Original tracker specification.');
    expect(contents[0]).toContain('Preserve explicit human gates.');
    expect(contents[1]).toBe('Original required attachment.\n');
    expect(JSON.stringify(configuration)).not.toContain('attachmentUrl');
    expect(JSON.stringify(configuration)).not.toContain('fixture-source-token');
  } finally {
    await chmod(join(workspace, '.aidlc/references'), 0o755).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
});

it.each(
  ['github', 'gitlab', 'bitbucket'].flatMap((sourceProvider) =>
    ['github-issues', 'gitlab-issues', 'jira-cloud'].map((trackerProvider) => ({
      sourceProvider,
      trackerProvider,
    })),
  ),
)(
  'admits $sourceProvider source with $trackerProvider text and file bytes through their real provider owners',
  async (options) => {
    const f = fixture(options);
    const draft = await client.create(
      PROJECT,
      draftRequest({
        prompt: 'Use the selected inputs.',
        applicationSource: { ...applicationSource, provider: options.sourceProvider },
      }),
    );
    let result = await client.inputs(PROJECT, draft.id, 0, {
      operation: 'tracker',
      bindingId: 'tracker-one',
      resourceId: '7',
    });
    result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
      operation: 'discover',
    });
    const attachmentId = result.discovery.attachments[0].id;
    if (options.trackerProvider === 'jira-cloud') expect(attachmentId).toBe('123');
    result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
      operation: 'import',
      attachmentId,
    });
    expect(result.importResult.status).toBe('imported');
    expect(result.intent.inputs.attachments).toHaveLength(2);
    await f.ready();
    const started = await client.start(
      PROJECT,
      draft.id,
      randomUUID(),
      0,
      result.intent.inputRevision,
    );
    expect(started.execution.repository).toMatchObject({
      provider: options.sourceProvider,
      commit: 'c'.repeat(40),
    });
    const admitted = await f.executionStore.get(IDENTITY);
    expect(admitted.configuration.inputs.source.provider).toBe(options.trackerProvider);
    expect(
      admitted.configuration.inputs.attachments.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
    expect(JSON.stringify(started)).not.toMatch(
      /fixture-source-token|s3VersionId|credentialIdentity|bindingFingerprint/,
    );
  },
);

it('fences late import completion after explicit exclusion', async () => {
  const f = fixture();
  const draft = await client.create(PROJECT, draftRequest({ prompt: 'Read inputs.' }));
  let result = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'tracker',
    bindingId: 'tracker-one',
    resourceId: '7',
  });
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'discover',
  });
  const id = result.discovery.attachments[0].id;
  // The shared provider transfer is held before it can reserve/promote bytes.
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  // The existing finite provider port exposes a read hook; no live network.
  f.inputPorts.state.beforeDownload = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'import',
    attachmentId: id,
  });
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
  await entered.promise;
  const current = await client.get(PROJECT, draft.id);
  await client.inputs(PROJECT, draft.id, current.inputRevision, {
    operation: 'exclude-import',
    attachmentId: id,
  });
  release.resolve();
  await rejected;
  expect((await client.get(PROJECT, draft.id)).inputs.attachments).toHaveLength(1);
});

it('keeps a failed selected tracker file unresolved until retry or explicit exclusion', async () => {
  const f = fixture();
  const draft = await client.create(
    PROJECT,
    draftRequest({ prompt: 'Use tracker text and selected files.' }),
  );
  let result = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'tracker',
    bindingId: 'tracker-one',
    resourceId: '7',
  });
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'discover',
  });
  const attachmentId = result.discovery.attachments[0].id;
  f.inputPorts.state.failDownload = true;
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'import',
    attachmentId,
  });
  expect(result.importResult.status).toBe('failed');
  expect(result.intent.inputs.imports).toMatchObject([{ id: attachmentId, status: 'failed' }]);
  await f.ready();
  await expect(
    client.start(PROJECT, draft.id, randomUUID(), 0, result.intent.inputRevision),
  ).rejects.toMatchObject({ status: 409, body: { code: 'NATIVE_INPUT_PENDING' } });
  f.inputPorts.state.failDownload = false;
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'import',
    attachmentId,
  });
  expect(result.importResult.status).toBe('imported');
  expect(result.intent.inputs.imports).toEqual([]);
  f.inputPorts.state.access = false;
  await expect(
    client.start(PROJECT, draft.id, randomUUID(), 0, result.intent.inputRevision),
  ).rejects.toMatchObject({ status: 403, body: { code: 'NATIVE_INPUT_ACCESS' } });
  expect(await f.executionStore.get(IDENTITY)).toBeNull();
});

it.each([
  { filename: '../escape.md' },
  { filename: 'unsupported.exe' },
  { size: 5 * 1024 * 1024 + 1 },
  { mimeType: 'text/html' },
  { s3Key: 'another-project/private' },
])('rejects malformed, oversized and substituted upload metadata %j', async (patch) => {
  const f = fixture();
  const draft = await client.create(PROJECT, draftRequest({ prompt: 'Read my input.' }));
  await expect(
    client.inputs(PROJECT, draft.id, 0, {
      operation: 'upload',
      attachmentId: randomUUID(),
      filename: 'input.md',
      mimeType: 'text/markdown',
      size: 2,
      sha256: 'a'.repeat(64),
      ...patch,
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.inputPorts.calls).toEqual([]);
  expect(f.read(IDENTITY).inputDraft).toBeUndefined();
});

it('rejects byte substitution and input edits that race another revision', async () => {
  const f = fixture();
  const draft = await client.create(PROJECT, draftRequest({ prompt: 'Read immutable inputs.' }));
  const attachmentId = randomUUID();
  const result = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'upload',
    attachmentId,
    filename: 'input.txt',
    mimeType: 'text/plain',
    size: 2,
    sha256: createHash('sha256').update('ok').digest('hex'),
  });
  f.inputPorts.put(new URL(result.upload.url).pathname.slice(1), Buffer.from('no'), 'text/plain');
  await expect(
    client.inputs(PROJECT, draft.id, 1, { operation: 'complete', attachmentId }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    client.inputs(PROJECT, draft.id, 0, { operation: 'remove', attachmentId }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    client.inputs(OTHER, draft.id, 1, { operation: 'complete', attachmentId }),
  ).rejects.toMatchObject({ status: 404 });
  expect(f.read(IDENTITY).inputDraft.attachments).toEqual([]);
});

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

it('discovers a mixed protected page in one browser request and withholds the page on mid-read revocation', async () => {
  const { refreshNativeIntents, getNativeListing } =
    await import('../../../frontend/src/hooks/useNativeIntents.ts');
  const f = fixture();
  const titles = [
    'eligible',
    'also eligible',
    'unfenced',
    'historical',
    'reply',
    'continuing',
    'running',
    'terminal',
    'corrupt',
    'unstarted',
    'draft',
  ];
  let digest;
  for (const title of titles) {
    const draft = await client.create(
      PROJECT,
      draftRequest({ intentId: randomUUID(), title, prompt: 'Private task' }),
    );
    if (title === 'draft') continue;
    await f.ready(PROJECT, draft.id);
    if (title === 'unstarted') continue;
    const run = serialFixture({
      preparedDraft: f.read({ projectId: PROJECT, executionId: draft.id }),
    });
    await run.ready();
    digest = run.configuration.image.digest;
    if (['eligible', 'also eligible', 'unfenced', 'historical'].includes(title)) {
      const { row } = await run.store.claim(run.bindingIdentity);
      await run.store.recoveryRequired({
        row,
        reason: 'SESSION_LOST',
        workflowResumeState: 'created',
        ...(title !== 'unfenced' ? { stoppedSessionId: row.runtimeSessionId } : {}),
      });
    } else if (title === 'reply' || title === 'continuing') {
      await run.publish({ project: false });
      if (title === 'continuing') await run.respond();
    } else if (title === 'terminal') {
      const { row } = await run.store.claim(run.bindingIdentity);
      const { receipt: publication } = await run.turn();
      await run.store.publish({ row, publication });
    }
    const row = run.row();
    if (title === 'corrupt') row.configurationSha256 = '0'.repeat(64);
    if (title === 'historical') {
      delete row.stopConfirmation;
      delete row.recovery.workflowResumeState;
      row.recovery.canRecover = false;
    }
    f.write(row);
  }
  f.transport.mockClear();
  f.membership.mockClear();
  f.ddb.send.mockClear();
  let pending = 0,
    peak = 0;
  f.hooks.before = async (cmd) => {
    if (cmd.input.Key?.sk !== 'EXECUTION') return;
    peak = Math.max(peak, ++pending);
    await new Promise((resolve) => setImmediate(resolve));
    pending--;
  };
  await refreshNativeIntents(PROJECT);
  const rows = () =>
    Object.fromEntries(getNativeListing(PROJECT).items.map((item) => [item.title, item]));
  expect(Object.keys(rows())).toEqual(titles);
  expect(f.transport.mock.calls.map(([url]) => new URL(url).search)).toEqual([
    '?view=list&limit=25',
  ]);
  expect(f.membership).toHaveBeenCalledTimes(2);
  expect(peak).toBe(4);
  const keys = f.ddb.send.mock.calls.map(([cmd]) => cmd.input.Key?.sk ?? cmd.input.IndexName);
  expect(keys.toSorted()).toEqual(
    [
      'NativeByProjectCreatedAt',
      ...titles.map(() => 'RUNTIME'),
      ...titles.slice(1).map(() => 'EXECUTION'),
      'REVOCATION',
    ].toSorted(),
  );
  expect(Object.values(rows()).map(nativeWaitingStatus)).toEqual([
    'RECOVERY_REQUIRED',
    'RECOVERY_REQUIRED',
    null,
    null,
    'AWAITING_USER',
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(rows().continuing.execution).toMatchObject({
    status: 'DISPATCHING',
    turnSequence: 2,
    responsePending: true,
  });
  expect(rows().running.execution.status).toBe('RUNNING');
  expect(rows().terminal.execution.status).toBe('STOPPED');
  expect(rows().corrupt.executionStatusUnavailable).toBe(true);
  expect(rows().unstarted.execution).toBeNull();
  expect(rows().draft.execution).toBeUndefined();
  expect(JSON.stringify(rows())).not.toMatch(
    /Private task|Keep the original task|attemptId|actorId|recoveryId|imageDigest|credential|projectionStatus|publicationId/,
  );

  f.hooks.before = (cmd) => {
    if (cmd.input.Key?.sk === 'REVOCATION') throw new Error('Policy unavailable');
  };
  await refreshNativeIntents(PROJECT, 'refresh', true);
  expect(nativeWaitingStatus(rows().eligible)).toBeNull();
  expect(rows().eligible.execution.status).toBe('RECOVERY_REQUIRED');
  f.hooks.before = undefined;
  f.write(nativeRuntimeImageKey(digest)); // Even a malformed revocation fences this pin.
  await refreshNativeIntents(PROJECT, 'refresh', true);
  expect(nativeWaitingStatus(rows().eligible)).toBeNull();
  expect(rows().eligible.execution.status).toBe('RECOVERY_REQUIRED');
  f.hooks.after = (cmd) => {
    if (cmd.input.Key?.sk === 'EXECUTION') f.projects.delete(PROJECT);
  };
  await refreshNativeIntents(PROJECT, 'refresh', true);
  expect(getNativeListing(PROJECT)).toMatchObject({ denied: true, items: [] });
  expect(f.transport).toHaveBeenCalledTimes(4);
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

it.each(['source identity', 'tracker identity'])(
  'refuses %s replacement during the slow Start settings read',
  async (kind) => {
    const f = fixture();
    const draft = await client.create(
      PROJECT,
      draftRequest({ prompt: 'Use the admitted inputs.' }),
    );
    const imported = await client.inputs(PROJECT, draft.id, 0, {
      operation: 'tracker',
      bindingId: 'tracker-one',
      resourceId: '7',
    });
    await f.ready();
    f.resolveBindings.mockImplementationOnce(async () => {
      if (kind === 'source identity') f.sourceConnection.generation = 'replacement';
      else f.inputPorts.state.credentialIdentity = { generation: 'replacement' };
      return { bedrock: { provider: 'bedrock', source: 'user', userId: ACTOR } };
    });
    await expect(
      client.start(PROJECT, draft.id, randomUUID(), 0, imported.intent.inputRevision),
    ).rejects.toMatchObject({ status: kind === 'source identity' ? 409 : 403 });
    expect(await f.executionStore.get(IDENTITY)).toBeNull();
  },
);

it('retains an expired selected upload when another tracker attachment is imported', async () => {
  const f = fixture();
  const draft = await client.create(PROJECT, draftRequest({ prompt: 'Use all selected inputs.' }));
  let result = await client.inputs(PROJECT, draft.id, 0, {
    operation: 'tracker',
    bindingId: 'tracker-one',
    resourceId: '7',
  });
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'discover',
  });
  const selected = result.discovery.attachments[0].id;
  const attachmentId = randomUUID();
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'upload',
    attachmentId,
    filename: 'unfinished.txt',
    mimeType: 'text/plain',
    size: 2,
    sha256: createHash('sha256').update('ok').digest('hex'),
  });
  // Expiry changes capacity accounting in the shared managed importer. It must
  // not erase the native member's required selection when that importer runs.
  const row = f.read(IDENTITY);
  row.inputDraft.pendingAttachmentUploads[0].expiresAt = '2020-01-01T00:00:00Z';
  // Use the fixture's actual key, preserving all other protected rows.
  for (const [key, value] of f.rows)
    if (value.pk === row.pk && value.sk === 'RUNTIME') f.rows.set(key, structuredClone(row));
  result = await client.inputs(PROJECT, draft.id, result.intent.inputRevision, {
    operation: 'import',
    attachmentId: selected,
  });
  expect(result.importResult.status).toBe('imported');
  expect(result.intent.inputs.pendingUploads).toMatchObject([{ attachmentId }]);
  await f.ready();
  await expect(
    client.start(PROJECT, draft.id, randomUUID(), 0, result.intent.inputRevision),
  ).rejects.toMatchObject({ status: 409, body: { code: 'NATIVE_INPUT_PENDING' } });
});
