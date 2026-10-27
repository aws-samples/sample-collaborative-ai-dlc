import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import {
  ACTOR,
  IDENTITY,
  IMAGE,
  JOB,
  MEMBERSHIP,
  OTHER,
  PROJECT,
  REVISION,
  SOURCE,
  binding,
  createInput,
  event,
  job,
  owner,
  request,
  resources,
  setup,
} from './fixtures.js';

const makeApi = (options = {}) => {
  const f = setup();
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const sources = { getAuthorizedBinding: vi.fn(async () => binding()) };
  const jobs = { get: vi.fn(async () => job()) };
  const enqueue = vi.fn(async () => {});
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    workflowSources: sources,
    jobs,
    getMembershipSnapshot: membership,
    enqueue,
    image: IMAGE,
    ...options,
  });
  return { ...f, membership, sources, jobs, enqueue, api };
};
const json = (result) => JSON.parse(result.body);
const noWork = (f) => {
  expect(f.ddb.send).not.toHaveBeenCalled();
  expect(f.sources.getAuthorizedBinding).not.toHaveBeenCalled();
  expect(f.jobs.get).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
};

describe('native execution REST boundary', () => {
  const route = (action, overrides = {}) => {
    const read = ['publication', 'graph', 'files', 'outputs'].includes(action);
    const suffix = action === 'files' ? `/files/nf-${'a'.repeat(64)}` : `/${action}`;
    const base = event('get');
    return {
      ...base,
      resource: `${base.resource}/${action}${action === 'files' ? '/{fileId}' : ''}`,
      path: `${base.path}${suffix}`,
      pathParameters: {
        ...base.pathParameters,
        ...(action === 'files' ? { fileId: `nf-${'a'.repeat(64)}` } : {}),
      },
      httpMethod: read ? 'GET' : 'POST',
      ...(read ? {} : { body: JSON.stringify(action === 'start' ? { requestId: OTHER } : {}) }),
      ...overrides,
    };
  };
  const execution = () => ({
    enabled: true,
    start: vi.fn(async () => ({ executionAvailable: true, execution: { status: 'REQUESTED' } })),
    cancel: vi.fn(async () => ({
      executionAvailable: true,
      execution: { status: 'CANCEL_REQUESTED' },
    })),
    publication: vi.fn(async () => ({ id: 'committed' })),
    file: vi.fn(async () => ({ id: `nf-${'a'.repeat(64)}`, content: 'exact' })),
    graph: vi.fn(async () => ({ publicationId: 'committed', nodes: [], edges: [] })),
    status: vi.fn(async () => ({ executionAvailable: true, execution: null })),
  });
  it.each([{}, { confirmWorkspaceResume: true }])(
    'passes recovery confirmation through the REST boundary after membership checks %j',
    async (confirmation) => {
      const recover = vi.fn(async () => ({
        executionAvailable: true,
        execution: { status: 'RECOVERING' },
      }));
      const f = makeApi({ execution: { ...execution(), recover } });
      await f.store.create(createInput());
      const input = { requestId: OTHER, recoveryId: IDENTITY.executionId, ...confirmation };
      const resume = route('recover', { body: JSON.stringify(input) });
      expect((await f.api(resume)).statusCode).toBe(202);
      expect(recover).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ projectId: PROJECT }),
        input,
        expect.any(Function),
      );
      f.membership.mockResolvedValue(null);
      expect((await f.api(resume)).statusCode).toBe(403);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { confirmWorkspaceResume: false },
    { confirmWorkspaceResume: 'true' },
    { confirmWorkspaceResume: null },
    { confirmWorkspaceResume: true, actorId: ACTOR },
  ])('rejects malformed recovery confirmation before dispatch %j', async (confirmation) => {
    const recover = vi.fn();
    const f = makeApi({ execution: { ...execution(), recover } });
    const result = await f.api(
      route('recover', {
        body: JSON.stringify({
          requestId: OTHER,
          recoveryId: IDENTITY.executionId,
          ...confirmation,
        }),
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(recover).not.toHaveBeenCalled();
    noWork(f);
  });
  it('accepts independent output/event cursors only after membership and rejects malformed cursors', async () => {
    const outputs = vi.fn(async () => ({
      outputs: [],
      nextAfter: null,
      events: [],
      nextEventAfter: null,
    }));
    const f = makeApi({ execution: { ...execution(), outputs } });
    await f.store.create(createInput());
    const page = route('outputs', { queryStringParameters: { afterSeq: '128', afterEvent: '70' } });
    expect((await f.api(page)).statusCode).toBe(200);
    expect(outputs).toHaveBeenCalledWith(expect.any(Object), 128, expect.any(Function), 70);
    for (const query of [
      { afterEvent: '-1' },
      { afterEvent: 'NaN' },
      { afterSeq: '1', secret: 'x' },
    ])
      expect((await f.api(route('outputs', { queryStringParameters: query }))).statusCode).toBe(
        400,
      );
    expect(outputs).toHaveBeenCalledTimes(1);
    f.membership.mockResolvedValue(null);
    expect((await f.api(page)).statusCode).toBe(403);
    expect(outputs).toHaveBeenCalledTimes(1);
  });
  it.each(['start', 'cancel', 'publication', 'files', 'graph'])(
    'routes %s only after project membership checks',
    async (action) => {
      const service = execution();
      const f = makeApi({ execution: service });
      await f.store.create(createInput());
      const result = await f.api(route(action));
      expect(result.statusCode).toBe(['start', 'cancel'].includes(action) ? 202 : 200);
      const method = action === 'files' ? 'file' : action;
      expect(service[method]).toHaveBeenCalledTimes(1);
      if (action === 'start')
        expect(service.start).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: PROJECT }),
          ACTOR,
          OTHER,
          expect.any(Function),
        );
      f.membership.mockResolvedValue(null);
      expect((await f.api(route(action))).statusCode).toBe(403);
      expect(service[method]).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { body: undefined },
    { body: '{}' },
    { body: JSON.stringify({ requestId: OTHER, actorId: ACTOR }) },
    { body: JSON.stringify({ requestId: OTHER, model: 'override' }) },
    { path: '/api/projects/other/native-intents/id/start' },
    { httpMethod: 'GET' },
  ])('rejects start authority/identity overrides %j before dispatch', async (override) => {
    const service = execution();
    const f = makeApi({ execution: service });
    const response = await f.api(route('start', override));
    expect([400, 405]).toContain(response.statusCode);
    expect(service.start).not.toHaveBeenCalled();
    expect(f.membership).not.toHaveBeenCalled();
  });
  it('returns a fixed actionable configuration error, suppressing dependency details', async () => {
    const service = execution();
    service.start.mockRejectedValue(
      Object.assign(new Error('private credentials and provider response'), {
        code: 'NATIVE_EXECUTION_CONFIG_CREDENTIAL_REQUIRED',
      }),
    );
    const f = makeApi({ execution: service });
    await f.store.create(createInput());
    const response = await f.api(route('start'));
    expect(response.statusCode).toBe(409);
    expect(json(response)).toMatchObject({ code: 'NATIVE_EXECUTION_CONFIG_CREDENTIAL_REQUIRED' });
    expect(response.body).not.toContain('private');
  });
});

describe('native API authentication and gates', () => {
  it.each([false, undefined, 'true'])('defaults closed with enabled=%s', async (enabled) => {
    const f = makeApi({ enabled });
    const response = await f.api(event());
    expect(response.statusCode).toBe(503);
    expect(json(response).code).toBe('NATIVE_PREPARATION_DISABLED');
    expect(f.membership).not.toHaveBeenCalled();
    noWork(f);
  });

  it.each([
    ['no claims', {}],
    ['JWT fallback', { authorizer: { jwt: { claims: { sub: ACTOR } } } }],
    ['principal fallback', { authorizer: { principalId: ACTOR } }],
    ['actor fallback', { authorizer: { claims: { actorId: ACTOR } } }],
    ['inherited sub', { authorizer: { claims: Object.create({ sub: ACTOR }) } }],
    ['array claims', { authorizer: { claims: [ACTOR] } }],
    ['empty sub', { authorizer: { claims: { sub: '' } } }],
  ])('rejects %s without touching protected services', async (_label, requestContext) => {
    const f = makeApi();
    const response = await f.api(event('create', { requestContext, actorId: ACTOR }));
    expect(response.statusCode).toBe(401);
    noWork(f);
  });

  it.each([[], ['other-project'], null, [PROJECT, null]])(
    'fails closed for allowlist %j',
    async (allowedProjectIds) => {
      const f = makeApi({ allowedProjectIds });
      expect((await f.api(event())).statusCode).toBe(403);
      expect(f.membership).not.toHaveBeenCalled();
      noWork(f);
    },
  );

  it.each([null, { ...MEMBERSHIP, role: 'guest' }, { role: 'member' }])(
    'rejects invalid membership %j',
    async (membership) => {
      const f = makeApi();
      f.membership.mockResolvedValue(membership);
      expect((await f.api(event())).statusCode).toBe(403);
      noWork(f);
    },
  );

  it.each(['owner', 'admin', 'member'])(
    'exposes read-only capabilities for authenticated %s without reads or writes',
    async (role) => {
      const f = makeApi();
      f.membership.mockResolvedValue({ ...MEMBERSHIP, role });
      const response = await f.api(event('capabilities'));
      expect(response.statusCode).toBe(200);
      expect(json(response)).toEqual({
        preparationEnabled: true,
        executionEnabled: false,
        unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
      });
      expect(f.membership).toHaveBeenCalledWith(PROJECT, ACTOR);
      noWork(f);
    },
  );

  it('does not return capabilities if the project or member lifecycle changes while authorizing', async () => {
    const f = makeApi();
    f.membership
      .mockResolvedValueOnce(MEMBERSHIP)
      .mockResolvedValue({ ...MEMBERSHIP, membershipId: 'replacement' });
    expect((await f.api(event('capabilities'))).statusCode).toBe(403);
    noWork(f);
  });

  it.each([
    ['worker-shaped invocation', { operation: 'prepare' }],
    ['internal action', { action: 'ready' }],
    ['base64', { isBase64Encoded: true }],
    ['query fields', { queryStringParameters: { runtimeArn: 'injected' } }],
    ['multi-query fields', { multiValueQueryStringParameters: { actorId: [ACTOR] } }],
    ['wrong path', { path: `/api/projects/${OTHER}/native-intents` }],
    ['extra path fields', { pathParameters: { projectId: PROJECT, intentId: OTHER } }],
    ['non-string JSON body', { body: request() }],
    ['bad JSON', { body: '{' }],
    ['null JSON', { body: 'null' }],
    ['extra authority', { body: JSON.stringify({ ...request(), runtimeArn: 'injected' }) }],
  ])('rejects %s before authorization or persistence', async (_label, overrides) => {
    const f = makeApi();
    expect((await f.api(event('create', overrides))).statusCode).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    noWork(f);
  });

  it('bounds request bytes and restricts item/prepare/capability methods and bodies', async () => {
    const f = makeApi();
    expect((await f.api(event('create', { body: ' '.repeat(96 * 1024 + 1) }))).statusCode).toBe(
      413,
    );
    for (const operation of ['get', 'capabilities']) {
      expect((await f.api(event(operation, { body: '{}' }))).statusCode).toBe(400);
    }
    expect((await f.api(event('prepare', { body: '{"answer":"BlueLake"}' }))).statusCode).toBe(400);
    expect((await f.api(event('prepare', { httpMethod: 'GET' }))).statusCode).toBe(405);
    expect((await f.api(event('get', { httpMethod: 'POST' }))).statusCode).toBe(405);
    expect((await f.api({ ...event(), resource: '/worker' })).statusCode).toBe(404);
    expect(
      (await f.api(event('create', { httpMethod: 'OPTIONS', requestContext: {} }))).statusCode,
    ).toBe(200);
    noWork(f);
  });
});

describe('native draft creation and shared status', () => {
  it.each([
    ['long title', { title: 'x'.repeat(257) }],
    ['title controls', { title: 'Contains\u007fcontrol' }],
    ['long prompt', { prompt: 'x'.repeat(65537) }],
    ['prompt controls', { prompt: 'Contains\0control' }],
    ['encoded body size', { prompt: '\t'.repeat(65536) }],
  ])(
    'rejects %s before work and accepts correction at the same identity',
    async (_label, fields) => {
      const f = makeApi();
      const rejected = await f.api(event('create', { body: JSON.stringify(request(fields)) }));
      const oversizedBody = Buffer.byteLength(JSON.stringify(request(fields))) > 96 * 1024;
      expect(rejected.statusCode).toBe(oversizedBody ? 413 : 400);
      expect(json(rejected)).toMatchObject({
        code: oversizedBody ? 'NATIVE_PREPARATION_BODY_TOO_LARGE' : 'NATIVE_PREPARATION_INVALID',
        draftInputRejected: true,
      });
      expect(f.membership).not.toHaveBeenCalled();
      noWork(f);
      const corrected = await f.api(event('create', { body: JSON.stringify(request()) }));
      expect(corrected.statusCode).toBe(201);
      expect(f.read().request).toEqual(request());
      expect(json(corrected)).not.toHaveProperty('draftInputRejected');
      expect((await f.api(event())).statusCode).toBe(200);
    },
  );

  it('does not mark stored-row validation after a lost write acknowledgement as input rejection', async () => {
    const f = makeApi();
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) {
        f.write({ ...f.read(), requestFingerprint: 'corrupt' });
        throw new Error('Write acknowledgement lost');
      }
    };
    const response = await f.api(event());
    expect(response.statusCode).toBe(400);
    expect(json(response).code).toBe('NATIVE_PREPARATION_INVALID');
    expect(json(response)).not.toHaveProperty('draftInputRejected');
    expect(f.read().request).toEqual(request());
  });

  it('does not mark a post-commit membership rejection as editable input', async () => {
    const f = makeApi();
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) f.membership.mockResolvedValue(null);
    };
    const response = await f.api(event());
    expect(response.statusCode).toBe(403);
    expect(json(response)).not.toHaveProperty('draftInputRejected');
    expect(f.read().request).toEqual(request());
  });

  it('does not mark an immutable request conflict as editable input', async () => {
    const f = makeApi();
    expect((await f.api(event())).statusCode).toBe(201);
    const response = await f.api(
      event('create', { body: JSON.stringify(request({ title: 'Conflicting title' })) }),
    );
    expect(response.statusCode).toBe(409);
    expect(json(response)).not.toHaveProperty('draftInputRejected');
    expect(f.read().request).toEqual(request());
  });

  it('closes new draft admission while retaining prepared draft reads and preparation retries', async () => {
    const f = makeApi({ admissionEnabled: false });
    expect((await f.api(event('create', { body: JSON.stringify(request()) }))).statusCode).toBe(
      503,
    );
    await f.store.create(createInput());
    expect((await f.api(event('get'))).statusCode).toBe(200);
    expect((await f.api(event('prepare'))).statusCode).toBe(202);
    expect((await f.api(event('prepare'))).statusCode).toBe(202);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['title only', { title: 'Flappy bird', prompt: '' }],
    ['prompt only', { title: '', prompt: 'Build a small game.' }],
  ])(
    'accepts %s and preserves the exact request through create and read',
    async (_label, fields) => {
      const f = makeApi();
      const original = request(fields);
      const created = await f.api(event('create', { body: JSON.stringify(original) }));
      expect(created.statusCode).toBe(201);
      expect(json(created)).toMatchObject(fields);
      expect(f.read().request).toEqual(original);
      expect(json(await f.api(event('get')))).toMatchObject(fields);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    { title: '', prompt: '' },
    { title: ' ', prompt: '\n ' },
  ])('rejects blank title and prompt before any work: %j', async (fields) => {
    const f = makeApi();
    const response = await f.api(event('create', { body: JSON.stringify(request(fields)) }));
    expect(response.statusCode).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    noWork(f);
  });

  it('creates an immutable real draft and returns only the agreed DTO with ISO timestamps', async () => {
    const f = makeApi();
    const response = await f.api(event());
    expect(response.statusCode).toBe(201);
    expect(json(response)).toEqual({
      id: IDENTITY.executionId,
      projectId: PROJECT,
      executionBackend: 'native',
      title: request().title,
      prompt: request().prompt,
      promptRevision: 0,
      harness: 'codex',
      status: 'DRAFT',
      package: {
        version: '2.9.0',
        source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
      },
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
    });
    expect(f.jobs.get).toHaveBeenCalledWith({ projectId: PROJECT, jobId: JOB });
    expect(f.sources.getAuthorizedBinding).toHaveBeenCalledWith({
      projectId: PROJECT,
      actorId: ACTOR,
      sourceId: SOURCE.sourceId,
      expectedRevision: REVISION,
    });
    expect(JSON.stringify(f.read())).not.toContain('private-source-secret');
    expect(f.enqueue).not.toHaveBeenCalled();
    const duplicate = await f.api(event());
    expect(duplicate.statusCode).toBe(200);
    expect(json(duplicate)).toEqual(json(response));
    expect(
      (
        await f.api(
          event('create', { body: JSON.stringify(request({ prompt: 'conflicting work' })) }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it('allows another existing member to view without source/package access or side effects', async () => {
    const f = makeApi();
    await f.store.create(createInput());
    const before = f.read();
    f.ddb.send.mockClear();
    const response = await f.api(
      event('get', { requestContext: { authorizer: { claims: { sub: 'another-member' } } } }),
    );
    expect(response.statusCode).toBe(200);
    expect(json(response).status).toBe('DRAFT');
    expect(f.membership).toHaveBeenCalledWith(PROJECT, 'another-member');
    expect(f.ddb.send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(false);
    expect(f.read()).toEqual(before);
    expect(f.sources.getAuthorizedBinding).not.toHaveBeenCalled();
    expect(f.jobs.get).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('rejects recreated project identity on status and returns 404 for an absent intent', async () => {
    const f = makeApi();
    expect((await f.api(event('get'))).statusCode).toBe(404);
    await f.store.create(createInput());
    f.membership.mockResolvedValue({ ...MEMBERSHIP, projectIdentity: 'recreated' });
    expect((await f.api(event('get'))).statusCode).toBe(403);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('does not create after a source revision changes during package lookup', async () => {
    const f = makeApi();
    f.sources.getAuthorizedBinding
      .mockResolvedValueOnce(binding())
      .mockRejectedValue(
        Object.assign(new Error('private source details'), { code: 'WORKFLOW_SOURCE_CONFLICT' }),
      );
    const response = await f.api(event());
    expect(response.statusCode).toBe(409);
    expect(f.read()).toBeUndefined();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(response.body).not.toContain('private');
  });

  it('does not create after membership is revoked during package lookup', async () => {
    const f = makeApi();
    f.membership.mockResolvedValueOnce(MEMBERSHIP).mockResolvedValue(null);
    expect((await f.api(event())).statusCode).toBe(403);
    expect(f.read()).toBeUndefined();
  });

  it.each([
    ['unfinished', { state: 'RUNNING' }],
    ['other project', { projectId: OTHER }],
    ['other source', { sourceId: '0'.repeat(64) }],
    ['other revision', { bindingRevision: OTHER }],
    ['missing receipt', { archiveReceipt: null }],
  ])(
    'rejects %s import instead of treating the caller selection as a pin',
    async (_label, changes) => {
      const f = makeApi();
      f.jobs.get.mockResolvedValue(job(changes));
      expect((await f.api(event())).statusCode).toBe(409);
      expect(f.read()).toBeUndefined();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
});

describe('durable model-free preparation', () => {
  it('commits before sending an exact pointer; queue failure leaves retryable PREPARING with the same binding', async () => {
    const f = makeApi();
    await f.api(event());
    const draft = f.read();
    f.enqueue.mockImplementationOnce(async (pointer) => {
      expect(pointer).toEqual(IDENTITY);
      expect(f.read()).toMatchObject({ status: 'PREPARING', bindingId: draft.bindingId });
      throw new Error('private SQS credential failure');
    });
    const failed = await f.api(event('prepare', { body: '{}' }));
    expect(failed.statusCode).toBe(202);
    expect(failed.body).not.toContain('private');
    expect(f.read().status).toBe('PREPARING');
    const retry = await f.api(event('prepare'));
    expect(retry.statusCode).toBe(202);
    expect(f.read()).toMatchObject({ bindingId: draft.bindingId, version: 2, status: 'PREPARING' });
    expect(f.enqueue.mock.calls).toEqual([[IDENTITY], [IDENTITY]]);
  });

  it('rechecks current source authorization before re-enqueueing an existing PREPARING run', async () => {
    const f = makeApi();
    await f.api(event());
    await f.api(event('prepare'));
    f.enqueue.mockClear();
    f.sources.getAuthorizedBinding.mockRejectedValue(
      Object.assign(new Error('private credential reference'), {
        code: 'WORKFLOW_SOURCE_FORBIDDEN',
      }),
    );
    const response = await f.api(event('prepare'));
    expect(response.statusCode).toBe(403);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.read().status).toBe('PREPARING');
  });

  it('does not enqueue when source changes after CAS; retry can recover the committed state', async () => {
    const f = makeApi();
    await f.api(event());
    f.sources.getAuthorizedBinding
      .mockReset()
      .mockResolvedValueOnce(binding())
      .mockResolvedValueOnce(binding())
      .mockRejectedValueOnce(
        Object.assign(new Error('changed'), { code: 'WORKFLOW_SOURCE_CONFLICT' }),
      );
    expect((await f.api(event('prepare'))).statusCode).toBe(409);
    expect(f.read().status).toBe('PREPARING');
    expect(f.enqueue).not.toHaveBeenCalled();
    f.sources.getAuthorizedBinding.mockResolvedValue(binding());
    expect((await f.api(event('prepare'))).statusCode).toBe(202);
    expect(f.enqueue).toHaveBeenCalledWith(IDENTITY);
  });

  it('does not enqueue if membership changes after the preparation write', async () => {
    const f = makeApi();
    await f.api(event());
    f.hooks.after = (command) => {
      if (command instanceof PutCommand && command.input.Item.status === 'PREPARING')
        f.membership.mockResolvedValue(null);
    };
    expect((await f.api(event('prepare'))).statusCode).toBe(403);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.read().status).toBe('PREPARING');
  });

  it('accepts reordered Dynamo maps but rejects changed archive provenance before queueing', async () => {
    const f = makeApi();
    await f.api(event());
    const before = f.read();
    f.write({
      ...before,
      candidate: Object.fromEntries(Object.entries(before.candidate).toReversed()),
    });
    expect((await f.api(event('prepare'))).statusCode).toBe(202);
    f.enqueue.mockClear();
    f.jobs.get.mockResolvedValue(
      job({
        archiveReceipt: {
          ...before.archiveReceipt,
          manifest: { ...before.archiveReceipt.manifest, versionId: 'changed-version' },
        },
      }),
    );
    expect((await f.api(event('prepare'))).statusCode).toBe(409);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('returns READY without dispatching and hides every resource/lease field', async () => {
    const f = makeApi();
    const claimed = await f.claimed();
    await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
    const response = await f.api(event('prepare'));
    expect(response.statusCode).toBe(200);
    expect(json(response).status).toBe('READY');
    expect(response.body).not.toContain('arn:');
    for (const field of [
      'accessPointArn',
      'bindingId',
      'runtimeArn',
      'leaseToken',
      'imageUri',
      'archiveReceipt',
      'candidate',
      'rootDirectory',
    ])
      expect(json(response)).not.toHaveProperty(field);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('returns safe FAILED status; only an explicitly reauthorized prepare retries that generation', async () => {
    const f = makeApi();
    const claimed = await f.claimed();
    await f.store.fail({ ...owner(claimed), code: 'private error' });
    const response = await f.api(event('get'));
    expect(json(response)).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_provisioning_failed',
    });
    expect(f.enqueue).not.toHaveBeenCalled();
    f.sources.getAuthorizedBinding.mockRejectedValueOnce(
      Object.assign(new Error('changed'), { code: 'WORKFLOW_SOURCE_CONFLICT' }),
    );
    expect((await f.api(event('prepare'))).statusCode).toBe(409);
    expect(f.read().status).toBe('FAILED');
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await f.api(event('prepare'))).statusCode).toBe(202);
    expect(f.read()).toMatchObject({
      status: 'PREPARING',
      bindingId: claimed.bindingId,
      imageUri: IMAGE.uri,
    });
    expect(f.read()).not.toHaveProperty('failureCode');
    expect(f.enqueue).toHaveBeenCalledWith(IDENTITY);
  });

  it('redacts unknown service exceptions rather than returning raw messages', async () => {
    const f = makeApi();
    f.jobs.get.mockRejectedValue(new Error('secret provider token /private/path'));
    const response = await f.api(event());
    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({
      code: 'NATIVE_PREPARATION_INTERNAL_ERROR',
      error: 'Native preparation request failed',
    });
    expect(f.read()).toBeUndefined();
  });
});
