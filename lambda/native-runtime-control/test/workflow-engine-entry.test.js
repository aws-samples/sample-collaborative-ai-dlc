// The protected engine's own Lambda entry: every operation re-derives access
// from the authority table, current membership and the existing input owners.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeWorkflowEngineLambda } from '../workflow-engine-entry.js';
import { nativePreparedConfigurationPins } from '../execution-config.js';
import { nativeInputSnapshot } from '../../shared/native-inputs.js';
import { WorkflowSourceError } from '../../shared/workflow-source-bindings.js';
import {
  ACTOR,
  DEPLOYMENT,
  MEMBERSHIP,
  SOURCE,
  TABLE,
  binding,
  owner,
  resources,
  setup as fixtures,
} from './fixtures.js';

const SOURCE_CONTROL = `arn:aws:lambda:us-east-1:${DEPLOYMENT.accountId}:function:source-control`;
const TRACKERS = `arn:aws:lambda:us-east-1:${DEPLOYMENT.accountId}:function:trackers`;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-bindings');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const IMAGE = {
  uri: `${DEPLOYMENT.accountId}.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'b'.repeat(64)}`,
  digest: `sha256:${'b'.repeat(64)}`,
};
const activeBinding = (overrides = {}) =>
  binding({
    schemaVersion: 1,
    purpose: 'workflow-source',
    status: 'active',
    access: 'read',
    repo: SOURCE.repository,
    authType: 'github-app',
    capabilities: { repositoryRead: true, repositoryWrite: false },
    ...overrides,
  });
const setup = async () => {
  // A real READY draft from the production preparation store, as the
  // credentials facade test builds it, with the execution row it authorizes.
  const prepared = fixtures();
  const claimed = await prepared.claimed();
  const draft = await prepared.store.ready({ ...owner(claimed), resources: resources(claimed) });
  const configuration = {
    ...nativePreparedConfigurationPins(draft),
    recoveryMode: 'efs-workspace-v1',
    model: 'openai.test',
    inputs: nativeInputSnapshot(draft, 'native-inputs'),
    repository: {
      provider: 'github',
      repository: 'jwthewes/flappy-bird',
      branch: 'develop',
      commit: 'c'.repeat(40),
      credentialIdentity: 'd'.repeat(64),
      bindingRevision: 'binding-revision-one',
    },
    credentialBinding: { provider: 'bedrock', source: 'platform' },
    image: structuredClone(IMAGE),
    publicationBucket: 'native-publications-dev',
    packageBucket: 'native-packages-dev',
    accountId: DEPLOYMENT.accountId,
  };
  const row = {
    scope: { projectId: draft.projectId, executionId: draft.executionId },
    bindingId: draft.bindingId,
    epoch: 1,
    turnSequence: 1,
    writerGeneration: 1,
    attemptId: '90000000-0000-4000-8000-000000000001',
    runtimeSessionId: '90000000-0000-4000-8000-000000000002',
    startedBy: ACTOR,
    configuration,
    status: 'RUNNING',
    cancelRequested: false,
  };
  const f = {
    identity: row.scope,
    row: () => row,
    configuration,
    preparationStore: { get: vi.fn(async () => structuredClone(state.draft)) },
    store: {
      get: vi.fn(async () => structuredClone(row)),
      response: vi.fn(async () => structuredClone(state.answer)),
    },
    ddb: { send: vi.fn(async () => ({})) },
  };
  const state = {
    draft,
    answer: null,
    members: {},
    sourceBinding: activeBinding(),
    source: {
      ok: true,
      source: {
        bindingRevision: configuration.repository.bindingRevision,
        credentialIdentity: configuration.repository.credentialIdentity,
        settings: { schemaVersion: 1, files: [] },
      },
    },
  };
  const ddb = {
    send: vi.fn(async (command) =>
      command.input.TableName === 'workflow-bindings'
        ? { Item: structuredClone(state.sourceBinding) }
        : f.ddb.send(command),
    ),
  };
  const lambda = {
    send: vi.fn(async (command) => {
      expect(command.input.FunctionName).toBe(SOURCE_CONTROL);
      return { Payload: Buffer.from(JSON.stringify(state.source)) };
    }),
  };
  const connection = { close: vi.fn(async () => {}) };
  const membershipSnapshot = vi.fn(async (_graph, _projectId, actorId) =>
    Object.hasOwn(state.members, actorId)
      ? state.members[actorId]
      : { ...MEMBERSHIP, membershipId: `edge-${actorId}` },
  );
  const env = {
    AWS_REGION: 'us-east-1',
    AWS_PARTITION: 'aws',
    NATIVE_RUNTIME_BINDINGS_TABLE: TABLE,
    NATIVE_RUNTIME_ACCOUNT_ID: DEPLOYMENT.accountId,
    NATIVE_RUNTIME_FILE_SYSTEM_ID: DEPLOYMENT.fileSystemId,
    NATIVE_EXECUTION_PUBLICATION_BUCKET: configuration.publicationBucket,
    NATIVE_PACKAGES_BUCKET: configuration.packageBucket,
    NATIVE_EXECUTION_IMAGE_URI: IMAGE.uri,
    NATIVE_EXECUTION_IMAGE_DIGEST: IMAGE.digest,
    NEPTUNE_ENDPOINT: 'localhost',
    SOURCE_CONTROL_FUNCTION: SOURCE_CONTROL,
    TRACKERS_FUNCTION: TRACKERS,
  };
  const preparationFactory = vi.fn(() => f.preparationStore);
  const executionFactory = vi.fn(() => f.store);
  const refusals = [];
  // Stand in for the service: exercise the entry's authority ports directly.
  const invoke = (use, payload = { schemaVersion: 1 }, overrides = {}) =>
    createNativeWorkflowEngineLambda({
      ddb,
      s3: { send: vi.fn() },
      lambda,
      iam: { send: vi.fn() },
      codebuild: { send: vi.fn() },
      env,
      openConnection: async () => {
        if (state.connectionFailure) throw state.connectionFailure;
        return connection;
      },
      membershipSnapshot,
      // The shared execution fixture supplies the validated stores, as the
      // credentials entry test does; their wiring is asserted below.
      preparationFactory,
      executionFactory,
      logRefusal: (line) => refusals.push(line),
      serviceFactory: (ports) => async () => {
        const row = await ports.executionStore.get(f.identity);
        const draft = await ports.preparationStore.get(f.identity);
        return use({ ports, row, draft });
      },
      ...overrides,
    })(payload, {});
  const authorize = (alter = (value) => value) =>
    invoke(async ({ ports, row, draft }) => {
      await ports.authorizeAccess(alter({ row, draft }));
      return { ok: true };
    });
  return {
    f,
    state,
    ddb,
    lambda,
    connection,
    membershipSnapshot,
    preparationFactory,
    executionFactory,
    refusals,
    failConnection: (error) => (state.connectionFailure = error),
    invoke,
    authorize,
  };
};

describe('protected workflow engine entry', () => {
  it('admits the current starter with unchanged source, configuration and image, then closes its graph connection', async () => {
    const t = await setup();
    expect(await t.authorize()).toEqual({ ok: true });
    expect(t.refusals).toEqual([]);
    expect(t.membershipSnapshot).toHaveBeenCalled();
    expect(t.lambda.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lambda.send.mock.calls[0][0].input.Payload)).toMatchObject({
      action: 'native-source-access',
      projectId: t.f.identity.projectId,
      userId: t.f.row().startedBy,
    });
    expect(t.connection.close).toHaveBeenCalledTimes(1);
    expect(t.preparationFactory).toHaveBeenCalledWith({
      ddb: t.ddb,
      tableName: TABLE,
      deployment: {
        accountId: DEPLOYMENT.accountId,
        region: 'us-east-1',
        partition: 'aws',
        fileSystemId: DEPLOYMENT.fileSystemId,
      },
    });
    expect(t.executionFactory).toHaveBeenCalledWith({
      ddb: t.ddb,
      tableName: TABLE,
      preparationStore: t.f.preparationStore,
    });
  });

  it.each([
    ['is no longer a member', null],
    ['was reduced to a viewer', { ...MEMBERSHIP, role: 'viewer' }],
    ['belongs to a recreated project', { ...MEMBERSHIP, projectIdentity: 'vertex-two' }],
  ])('refuses every operation once the starter %s', async (_label, membership) => {
    const t = await setup();
    t.state.members[t.f.row().startedBy] = membership;
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
    expect(t.lambda.send).not.toHaveBeenCalled();
    expect(t.connection.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a draft from another binding', async () => {
    const t = await setup();
    expect(
      await t.authorize(({ row, draft }) => ({
        row,
        draft: { ...draft, bindingId: '77777777-7777-4777-8777-777777777777' },
      })),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
  });

  it('requires the accepting member of an applied reply to still hold that membership', async () => {
    const t = await setup();
    t.f.row().response = { interactionId: 'c'.repeat(64), actorId: 'responding-member' };
    t.state.answer = { member: { membershipId: 'edge-responding-member' } };
    expect(await t.authorize()).toEqual({ ok: true });
    expect(t.f.store.response).toHaveBeenCalledWith(expect.anything(), 'c'.repeat(64));
    t.state.members['responding-member'] = { ...MEMBERSHIP, membershipId: 'edge-rejoined' };
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
    t.state.members['responding-member'] = null;
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
    t.state.members = {};
    t.state.answer = null;
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
  });

  it.each([
    ['a refused source check', (source) => (source.ok = false)],
    ['a rebound source', (source) => (source.source.bindingRevision = 'another-revision')],
    [
      'a replaced source credential',
      (source) => (source.source.credentialIdentity = '0'.repeat(64)),
    ],
  ])('refuses %s', async (_label, alter) => {
    const t = await setup();
    alter(t.state.source);
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_SOURCE_CHANGED' });
  });

  it('fails closed when the methodology source binding or the captured configuration changed', async () => {
    const t = await setup();
    t.state.sourceBinding = activeBinding({ revision: '30000000-0000-4000-8000-000000000009' });
    const changed = await t.authorize();
    expect(changed.ok).toBe(false);
    expect(changed.code).toMatch(/^NATIVE_/);
    expect(t.lambda.send).not.toHaveBeenCalled();
    const other = await setup();
    expect(
      await other.authorize(({ row, draft }) => ({
        draft,
        row: { ...row, configuration: { ...row.configuration, harness: 'claude' } },
      })),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_CONFIGURATION_CHANGED' });
    // The draft is read again: a rebound draft is refused even when the
    // operation started with the original one.
    const rebound = await setup();
    expect(
      await rebound.authorize((value) => {
        rebound.state.draft = { ...value.draft, bindingId: '77777777-7777-4777-8777-777777777777' };
        return value;
      }),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_CONFIGURATION_CHANGED' });
  });

  it('captures methodology settings only through the source owner at the pinned commit', async () => {
    const t = await setup();
    const authorize = vi.fn(async () => {});
    const settings = await t.invoke(async ({ ports, row }) => ({
      ok: true,
      settings: await ports.loadSettings({ row, authorize }),
    }));
    expect(settings).toEqual({ ok: true, settings: { schemaVersion: 1, files: [] } });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.lambda.send.mock.calls[0][0].input.Payload)).toMatchObject({
      action: 'native-workflow-settings',
      commit: 'c'.repeat(40),
      bindingRevision: 'binding-revision-one',
    });
    t.state.source.source.credentialIdentity = '0'.repeat(64);
    expect(
      await t.invoke(async ({ ports, row }) => ports.loadSettings({ row, authorize })),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_SOURCE_CHANGED' });
  });

  it('returns only a closed failure code for unexpected errors', async () => {
    const t = await setup();
    const result = await t.invoke(async () => {
      throw Object.assign(new Error('private provider detail'), { code: 'ECONNRESET' });
    });
    expect(result).toEqual({ ok: false, code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(
      await t.invoke(async () => {
        throw Object.assign(new Error('private'), { code: 'NATIVE_ENGINE_WRITER_CHANGED' });
      }),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_WRITER_CHANGED' });
  });

  it('says in one line which step refused a request, with the same code for the caller', async () => {
    // The first live run: the membership lookup failed and every request was
    // answered "unavailable" with nothing recorded about why.
    const t = await setup();
    t.membershipSnapshot.mockRejectedValueOnce(
      new WorkflowSourceError(
        'WORKFLOW_SOURCE_UNAVAILABLE',
        'Project membership lookup is unavailable',
      ),
    );
    expect(
      await t.invoke(
        async ({ ports, row, draft }) => {
          await ports.authorizeAccess({ row, draft });
          return { ok: true };
        },
        { schemaVersion: 1, action: 'status' },
      ),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(t.refusals).toEqual([
      {
        event: 'native_engine_refused',
        action: 'status',
        step: 'membership',
        code: 'NATIVE_ENGINE_UNAVAILABLE',
        errorName: 'WorkflowSourceError',
        errorCode: 'WORKFLOW_SOURCE_UNAVAILABLE',
        status: null,
      },
    ]);
  });

  it.each([
    [
      'the graph connection',
      (t) => t.failConnection(Object.assign(new Error('socket'), { code: 'ECONNREFUSED' })),
      { step: 'graph-connection', errorName: 'Error', errorCode: 'ECONNREFUSED', status: null },
    ],
    [
      'the source owner call',
      (t) =>
        t.lambda.send.mockRejectedValueOnce(
          Object.assign(new Error('not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          }),
        ),
      { step: 'source-access', errorName: 'AccessDeniedException', errorCode: null, status: 403 },
    ],
    [
      'the execution row',
      (t) =>
        t.f.store.get.mockRejectedValueOnce(
          Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
        ),
      {
        step: 'execution',
        errorName: 'ProvisionedThroughputExceededException',
        errorCode: null,
        status: null,
      },
    ],
  ])('names %s as the failing step', async (_label, fail, expected) => {
    const t = await setup();
    fail(t);
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(t.refusals).toEqual([
      {
        event: 'native_engine_refused',
        action: null,
        code: 'NATIVE_ENGINE_UNAVAILABLE',
        ...expected,
      },
    ]);
  });

  it('records a refusal the access check decides, and one an operation ends with', async () => {
    const t = await setup();
    t.state.members[t.f.row().startedBy] = null;
    expect(await t.authorize()).toEqual({ ok: false, code: 'NATIVE_ENGINE_FORBIDDEN' });
    expect(t.refusals).toMatchObject([
      { step: 'access', code: 'NATIVE_ENGINE_FORBIDDEN', errorCode: 'NATIVE_ENGINE_FORBIDDEN' },
    ]);
    // The service answers a failed operation as recorded and reports what raised it.
    const other = await setup();
    expect(
      await other.invoke(async ({ ports }) => {
        const error = Object.assign(new Error('no'), { code: 'NATIVE_ENGINE_DECISION_MISMATCH' });
        ports.reportFailure(error, error.code);
        return { ok: true, status: 'failed' };
      }),
    ).toEqual({ ok: true, status: 'failed' });
    expect(other.refusals).toMatchObject([
      { step: 'operation', code: 'NATIVE_ENGINE_DECISION_MISMATCH', errorName: 'Error' },
    ]);
    // A line that cannot be written leaves the answer as it is.
    const silent = await setup();
    expect(
      await silent.invoke(
        async () => {
          throw new Error('unexpected');
        },
        undefined,
        {
          logRefusal: () => {
            throw new Error('log stream closed');
          },
        },
      ),
    ).toEqual({ ok: false, code: 'NATIVE_ENGINE_UNAVAILABLE' });
  });

  it('never writes an error message, a request value or anything that is not a plain identifier', async () => {
    const secret = 'ghp_0123456789 the prompt and a file body';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The default writer: one JSON line.
      const t = await setup();
      const result = await t.invoke(
        async () => {
          throw Object.assign(new Error(secret), { name: secret, code: `${secret}\n{"x":1}` });
        },
        { schemaVersion: 1, action: secret, identity: { projectId: secret }, args: [secret] },
        { logRefusal: undefined },
      );
      expect(result).toEqual({ ok: false, code: 'NATIVE_ENGINE_UNAVAILABLE' });
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0];
      expect(line).not.toContain('ghp_');
      expect(line).not.toContain('prompt');
      expect(JSON.parse(line)).toEqual({
        event: 'native_engine_refused',
        action: null,
        step: 'service',
        code: 'NATIVE_ENGINE_UNAVAILABLE',
        errorName: null,
        errorCode: null,
        status: null,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
