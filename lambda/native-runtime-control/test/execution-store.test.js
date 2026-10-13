import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import {
  createNativeExecutionStore,
  nativeExecutionConfiguration,
  nativeExecutionKey,
} from '../execution-store.js';
import {
  ACTOR,
  DEPLOYMENT,
  IDENTITY,
  IMAGE,
  OTHER,
  TABLE,
  candidate,
  request,
  resources,
} from './fixtures.js';

const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const preparationKey = nativeRuntimeBindingKey(IDENTITY);
const executionKey = { ...preparationKey, sk: 'EXECUTION' };
const bindingIdentity = { ...IDENTITY, bindingId: OTHER };
const CONFIGURATION = {
  harness: 'codex',
  model: null,
  promptSha256: digest(request().prompt),
  packageId: candidate().packagePin.packageId,
  materializationId: candidate().materializationId,
  source: {
    sourceId: request().sourceId,
    bindingRevision: request().bindingRevision,
    packageJobId: request().packageJobId,
  },
  repository: {
    provider: 'github',
    repository: 'JWThewes/flappy-bird',
    branch: null,
    bindingRevision: request().bindingRevision,
  },
  credentialBinding: { provider: 'bedrock', source: 'platform' },
  image: {
    uri: IMAGE.uri.replaceAll('a'.repeat(64), 'b'.repeat(64)),
    digest: `sha256:${'b'.repeat(64)}`,
  },
  publicationBucket: 'native-publications',
  packageBucket: 'native-packages',
  accountId: DEPLOYMENT.accountId,
};
const PREPARED = {
  ...preparationKey,
  ...IDENTITY,
  bindingId: OTHER,
  status: 'READY',
  version: 7,
  requestFingerprint: `sha256:${'d'.repeat(64)}`,
  request: request(),
  candidate: candidate(),
  imageUri: IMAGE.uri,
  imageDigest: IMAGE.digest,
  ...resources({ ...IDENTITY, bindingId: OTHER }),
};
const TARGET = {
  runtimeArn: PREPARED.runtimeArn,
  runtimeId: PREPARED.runtimeId,
  runtimeVersion: '2',
  imageDigest: CONFIGURATION.image.digest,
  rolePolicySha256: 'a'.repeat(64),
};
const targetFor = (row) => {
  const endpoint = `exec_${digest(row.attemptId).slice(0, 32)}`;
  return { ...TARGET, endpoint, endpointArn: `${TARGET.runtimeArn}/runtime-endpoint/${endpoint}` };
};
const COMMIT = 'e'.repeat(40);
const PUBLICATION = {
  id: '5'.repeat(64),
  sequence: 1,
  manifest: {
    key: 'executions/first/manifest.json',
    versionId: 'immutable-version-one',
    sha256: 'f'.repeat(64),
    bytes: 2048,
  },
  question: { path: 'aidlc-docs/inception/questions.md', sha256: 'a'.repeat(64) },
  outcome: 'WAITING_FOR_INPUT',
  nativeSessionId: 'session-123',
  filesCount: 3,
};
const error = (name = 'TimeoutError') =>
  Object.assign(new Error('Private transport details must never escape'), { name });
const rejection = (suffix) => ({ code: `NATIVE_EXECUTION_${suffix}` });
const putOf = (command) =>
  command instanceof TransactWriteCommand
    ? command.input.TransactItems.find((item) => item.Put)?.Put
    : undefined;

// The fixture interprets actual request conditions and commits all transaction
// items atomically. Hooks can suspend before the transaction or lose its reply.
// It does not decide success from method names or canned expected responses.
const setup = ({ leaseMs = 100 } = {}) => {
  const rows = new Map();
  const hooks = {};
  const key = (item) => JSON.stringify([item.pk, item.sk]);
  const read = (itemKey = executionKey) => clone(rows.get(key(itemKey)));
  const write = (row) => rows.set(key(row), clone(row));
  const condition = (operation) => {
    const existing = read(operation.Key ?? operation.Item);
    return operation.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[A-Za-z0-9]+|pk|sk)\)$/.exec(clause);
      if (absent) {
        const field = operation.ExpressionAttributeNames?.[absent[1]] ?? absent[1];
        return existing === undefined || !Object.hasOwn(existing, field);
      }
      const match = /^(#[A-Za-z0-9]+) (=|>|<=) (:[A-Za-z0-9]+)$/.exec(clause);
      if (!match) throw new Error(`Unsupported test condition: ${clause}`);
      const left = existing?.[operation.ExpressionAttributeNames[match[1]]];
      const right = operation.ExpressionAttributeValues[match[3]];
      if (match[2] === '=') return isDeepStrictEqual(left, right);
      if (match[2] === '>') return left > right;
      return left <= right;
    });
  };
  const ddb = {
    send: vi.fn(async (command) => {
      await hooks.before?.(command);
      let result;
      if (command instanceof GetCommand) {
        expect(command.input.TableName).toBe(TABLE);
        expect(command.input.ConsistentRead).toBe(true);
        const item = read(command.input.Key);
        result = item === undefined ? {} : { Item: item };
      } else if (command instanceof TransactWriteCommand) {
        const actions = command.input.TransactItems;
        expect(actions.length).toBeGreaterThan(0);
        const touchedKeys = new Set();
        for (const action of actions) {
          const operation = action.Put ?? action.ConditionCheck;
          expect(operation.TableName).toBe(TABLE);
          const rowKey = key(operation.Key ?? operation.Item);
          expect(touchedKeys.has(rowKey)).toBe(false);
          touchedKeys.add(rowKey);
          if (!condition(operation)) {
            throw Object.assign(error('TransactionCanceledException'), {
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
            });
          }
        }
        for (const action of actions) {
          if (action.Put) {
            expect(action.Put.Item.sk).toMatch(/^(EXECUTION|(?:PUBLICATION|EVENT)#[0-9]{16})$/);
            expect(action.Put.Item).not.toHaveProperty('projectId');
            expect(action.Put.Item).not.toHaveProperty('createdAt');
            write(action.Put.Item);
          }
        }
        result = {};
      } else throw new Error('Only protected Get/TransactWrite is allowed');
      await hooks.after?.(command, result);
      return result;
    }),
  };
  write(PREPARED);
  let time = 1000;
  const preparationStore = {
    get: vi.fn(async (input) => {
      expect(input).toEqual(IDENTITY);
      return read(preparationKey) ?? null;
    }),
  };
  const store = createNativeExecutionStore({
    ddb,
    tableName: TABLE,
    preparationStore,
    now: () => time,
    leaseMs,
  });
  const start = (overrides = {}) =>
    store.start({
      ...IDENTITY,
      actorId: ACTOR,
      requestId: 'start-one',
      configuration: clone(CONFIGURATION),
      ...overrides,
    });
  const claimed = async () => {
    await start();
    return (await store.claim(bindingIdentity)).row;
  };
  const dispatching = async () => {
    const row = await claimed();
    return store.advance({
      row,
      patch: {
        sourceCommit: COMMIT,
        sourceBranch: 'main',
        target: targetFor(row),
        status: 'DISPATCHING',
      },
    });
  };
  const running = async () =>
    store.advance({
      row: await dispatching(),
      patch: { status: 'RUNNING' },
    });
  const published = async () => store.publish({ row: await running(), publication: PUBLICATION });
  const pause = (predicate) => {
    let resume;
    let arrived;
    let paused = false;
    const waiting = new Promise((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    hooks.before = async (command) => {
      if (!paused && predicate(command)) {
        paused = true;
        arrived();
        await gate;
      }
    };
    return { waiting, resume };
  };
  return {
    rows,
    read,
    write,
    hooks,
    ddb,
    preparationStore,
    store,
    start,
    claimed,
    dispatching,
    running,
    published,
    pause,
    setTime: (value) => {
      time = value;
    },
  };
};

describe('first native Start and protected preparation boundary', () => {
  it('records acceptance through publication and cancellation without lease noise or invented success', async () => {
    const f = setup();
    let row = await f.dispatching();
    f.setTime(1010);
    row = await f.store.dispatchAttempted({ row });
    row = await f.store.advance({ row, patch: { status: 'RUNNING' } });
    f.setTime(1020);
    row = await f.store.advance({ row, patch: {} });
    f.setTime(1040);
    row = await f.store.publish({ row, publication: PUBLICATION });
    await f.store.cancel(bindingIdentity);
    const events = [...f.rows.values()].filter((r) => r.sk.startsWith('EVENT#'));
    expect(events.map((r) => r.type)).toEqual([
      'native.accepted',
      'native.dispatching',
      'native.dispatch.attempted',
      'native.running',
      'native.published',
      'native.cancel_requested',
    ]);
    expect(events[0]).toMatchObject({
      revision: 1,
      actor: ACTOR,
      timestamp: new Date(1000).toISOString(),
    });
    expect(events[2].summary).toContain('Acceptance to dispatch: 10 ms');
    expect(events[4].summary).toContain('Dispatch to publication: 30 ms');
    expect(events[4].summary).toContain(PUBLICATION.id);
    expect(events[4].summary).toContain('waiting for input');
    expect(JSON.stringify(events)).not.toMatch(
      /credentialBinding|manifest|native-session|leaseToken|promptSha256/,
    );
    const before = clone(events);
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('CANCELLED'),
    );
    expect([...f.rows.values()].filter((r) => r.sk.startsWith('EVENT#'))).toEqual(before);
  });

  it('commits lifecycle and execution together, recovers a lost ACK and never backfills retained history', async () => {
    const f = setup();
    let row = await f.dispatching();
    // A retained row has no old ledger. An update must not reconstruct its past.
    for (const [key, value] of f.rows) if (value.sk.startsWith('EVENT#')) f.rows.delete(key);
    f.hooks.before = (command) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems.some((v) => v.Put?.Item.sk.startsWith('EVENT#'))
      )
        throw error();
    };
    await expect(f.store.dispatchAttempted({ row })).rejects.toMatchObject(
      rejection('UNAVAILABLE'),
    );
    expect(f.read()).toEqual(row);
    expect([...f.rows.values()].filter((r) => r.sk.startsWith('EVENT#'))).toEqual([]);
    delete f.hooks.before;
    f.hooks.after = (command) => {
      if (command instanceof TransactWriteCommand) throw error();
    };
    row = await f.store.dispatchAttempted({ row });
    expect(await f.store.dispatchAttempted({ row })).toEqual(row);
    const events = [...f.rows.values()].filter((r) => r.sk.startsWith('EVENT#'));
    expect(events.map((r) => r.type)).toEqual(['native.dispatch.attempted']);
  });

  it('creates one non-indexed execution with immutable starter/configuration/preparation pins', async () => {
    const f = setup();
    const original = clone(CONFIGURATION);
    const { row, created } = await f.start({ configuration: original });
    expect(created).toBe(true);
    expect(nativeExecutionKey(IDENTITY)).toEqual(executionKey);
    expect(row).toMatchObject({
      ...executionKey,
      scope: IDENTITY,
      status: 'REQUESTED',
      startedBy: ACTOR,
      requestId: 'start-one',
      version: 1,
      epoch: 1,
      fence: 0,
      cancelRequested: false,
      startedAt: 1000,
      updatedAt: 1000,
      attemptId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      runtimeSessionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      configuration: CONFIGURATION,
      preparation: {
        bindingId: OTHER,
        version: 7,
        requestFingerprint: PREPARED.requestFingerprint,
        image: IMAGE,
        accessPointArn: PREPARED.accessPointArn,
        fileSystemId: PREPARED.fileSystemId,
        executionRoleArn: PREPARED.executionRoleArn,
      },
    });
    expect(row.configuration.image.digest).not.toBe(row.preparation.image.digest);
    expect(row).not.toHaveProperty('leaseToken');
    expect(row).not.toHaveProperty('publication');
    expect(row).not.toHaveProperty('publicationEpoch');
    expect(row).not.toHaveProperty('target');
    expect(f.read(preparationKey)).toEqual(PREPARED);
    original.source.bindingRevision = 'changed';
    row.configuration.model = 'changed';
    expect((await f.store.get(IDENTITY)).configuration).toEqual(CONFIGURATION);
    expect(f.rows.size).toBe(3);
  });

  it('concurrent Starts from different members and request ids retain exactly one starter/session', async () => {
    const f = setup();
    const results = await Promise.all([
      f.start(),
      f.start({ actorId: 'member-two', requestId: 'start-two' }),
    ]);
    expect(results.map((result) => result.created).toSorted()).toEqual([false, true]);
    expect(results[0].row).toEqual(results[1].row);
    expect(f.read().startedBy).toBe(ACTOR);
    const reordered = Object.fromEntries(Object.entries(CONFIGURATION).toReversed());
    expect(await f.start({ actorId: 'member-three', configuration: reordered })).toEqual({
      row: f.read(),
      created: false,
    });
    expect(f.rows.size).toBe(3);
  });

  it('concurrent different configurations conflict without changing the winner', async () => {
    const f = setup();
    const results = await Promise.allSettled([
      f.start(),
      f.start({ actorId: 'member-two', configuration: { ...CONFIGURATION, model: 'other-model' } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject(
      rejection('CONFLICT'),
    );
    expect(f.read().configuration).toEqual(CONFIGURATION);
  });

  it('replayed Start after dispatch and cancellation never creates another attempt', async () => {
    const f = setup();
    const dispatched = await f.dispatching();
    const cancelled = await f.store.cancel(bindingIdentity);
    const retry = await f.start({ actorId: 'member-two', requestId: 'different-request' });
    expect(retry).toEqual({ created: false, row: cancelled });
    expect(retry.row.attemptId).toBe(dispatched.attemptId);
    expect(retry.row.runtimeSessionId).toBe(dispatched.runtimeSessionId);
  });

  it.each(['DRAFT', 'PREPARING', 'FAILED'])(
    'rejects %s preparation without creating an execution',
    async (status) => {
      const f = setup();
      f.write({ ...PREPARED, status });
      await expect(f.start()).rejects.toMatchObject(rejection('NOT_READY'));
      expect(f.read()).toBeUndefined();
    },
  );

  it('rejects missing preparation and hides preparation transport errors', async () => {
    const f = setup();
    f.preparationStore.get.mockResolvedValueOnce(null).mockRejectedValueOnce(error());
    await expect(f.start()).rejects.toMatchObject(rejection('NOT_FOUND'));
    await expect(f.start()).rejects.toMatchObject(rejection('UNAVAILABLE'));
    expect(f.read()).toBeUndefined();
  });

  it.each([
    ['version', { version: 8 }],
    ['binding', { bindingId: '60000000-0000-4000-8000-000000000001' }],
    ['request fingerprint', { requestFingerprint: `sha256:${'e'.repeat(64)}` }],
    ['readiness', { status: 'PREPARING' }],
    [
      'image and generation',
      { version: 8, imageUri: CONFIGURATION.image.uri, imageDigest: CONFIGURATION.image.digest },
    ],
    [
      'access point and generation',
      {
        version: 8,
        accessPointArn: PREPARED.accessPointArn.replace('1234567890abcdef0', '0234567890abcdef0'),
      },
    ],
  ])('atomically rejects preparation %s changing after the read', async (_label, change) => {
    const f = setup();
    const gate = f.pause((command) => command instanceof TransactWriteCommand);
    const pending = f.start();
    const rejected = expect(pending).rejects.toMatchObject(rejection('CONFLICT'));
    await gate.waiting;
    f.write({ ...PREPARED, ...change });
    gate.resume();
    await rejected;
    expect(f.read()).toBeUndefined();
  });

  it('preparation deletion during Start cannot leave an orphan execution', async () => {
    const f = setup();
    const gate = f.pause((command) => command instanceof TransactWriteCommand);
    const pending = f.start();
    const rejected = expect(pending).rejects.toMatchObject(rejection('CONFLICT'));
    await gate.waiting;
    f.rows.delete(JSON.stringify([preparationKey.pk, preparationKey.sk]));
    gate.resume();
    await rejected;
    expect(f.rows.size).toBe(0);
  });

  it.each([
    ['prompt', { promptSha256: '0'.repeat(64) }],
    ['harness', { harness: 'claude' }],
    ['package', { packageId: `sha256:${'0'.repeat(64)}` }],
    ['materialization', { materializationId: `sha256:${'0'.repeat(64)}` }],
    ['source', { source: { ...CONFIGURATION.source, sourceId: '0'.repeat(64) } }],
    ['source revision', { source: { ...CONFIGURATION.source, bindingRevision: OTHER } }],
    ['source job', { source: { ...CONFIGURATION.source, packageJobId: OTHER } }],
    [
      'wrong credential owner',
      { credentialBinding: { provider: 'bedrock', source: 'user', userId: 'member-two' } },
    ],
  ])('rejects %s not bound to the prepared draft/starter', async (_label, changes) => {
    const f = setup();
    await expect(
      f.start({ configuration: { ...CONFIGURATION, ...changes } }),
    ).rejects.toMatchObject(rejection('INVALID'));
    expect(f.read()).toBeUndefined();
  });

  it('recovers a lost create acknowledgement with consistent protected state', async () => {
    const f = setup();
    f.hooks.after = (command) => {
      if (command instanceof TransactWriteCommand) throw error();
    };
    const result = await f.start();
    expect(result).toEqual({ row: f.read(), created: false });
    expect(f.ddb.send.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(
      2,
    );
  });
});

describe('strict schema, scope and persisted data bounds', () => {
  it.each([
    ['token', { token: 'secret' }],
    ['prompt text', { prompt: 'do work' }],
    ['timeout', { timeoutMs: 600000 }],
    ['graph authority', { approved: true }],
    ['model object', { model: { key: 'secret' } }],
    ['long model', { model: 'x'.repeat(257) }],
    ['missing null model', { model: undefined }],
    ['unknown harness', { harness: 'other' }],
    ['prompt hash prefix', { promptSha256: `sha256:${'a'.repeat(64)}` }],
    ['package unprefixed', { packageId: 'a'.repeat(64) }],
    ['account', { accountId: '123' }],
    ['bucket ARN', { publicationBucket: 'arn:aws:s3:::bucket' }],
    ['unsafe bucket', { packageBucket: 'bad..bucket' }],
    ['source secret', { source: { ...CONFIGURATION.source, token: 'secret' } }],
    [
      'repository URL',
      {
        repository: {
          ...CONFIGURATION.repository,
          repository: 'https://token@github.com/owner/repo',
        },
      },
    ],
    [
      'repository traversal',
      { repository: { ...CONFIGURATION.repository, repository: '../repo' } },
    ],
    ['repository provider', { repository: { ...CONFIGURATION.repository, provider: 'other' } }],
    ['floating commit field', { repository: { ...CONFIGURATION.repository, commit: COMMIT } }],
    [
      'branch shell syntax',
      { repository: { ...CONFIGURATION.repository, branch: 'main; steal secret' } },
    ],
    ['branch traversal', { repository: { ...CONFIGURATION.repository, branch: '../main' } }],
    ['git reflog', { repository: { ...CONFIGURATION.repository, branch: 'main@{1}' } }],
    [
      'credential token',
      { credentialBinding: { provider: 'bedrock', source: 'platform', token: 'secret' } },
    ],
    [
      'credential secret ref',
      { credentialBinding: { provider: 'bedrock', source: 'space', secretRef: '/secret' } },
    ],
    ['credential provider', { credentialBinding: { provider: 'kiro', source: 'platform' } }],
    [
      'extra credential user',
      { credentialBinding: { provider: 'bedrock', source: 'platform', userId: ACTOR } },
    ],
    ['missing credential user', { credentialBinding: { provider: 'bedrock', source: 'user' } }],
    ['image tag', { image: { ...CONFIGURATION.image, uri: IMAGE.uri.split('@')[0] + ':latest' } }],
    ['image mismatch', { image: { ...CONFIGURATION.image, digest: IMAGE.digest } }],
    ['image extra env', { image: { ...CONFIGURATION.image, env: { TOKEN: 'secret' } } }],
  ])('rejects malformed/unknown configuration: %s', async (_label, changes) => {
    const f = setup();
    await expect(
      f.start({ configuration: { ...CONFIGURATION, ...changes } }),
    ).rejects.toMatchObject(rejection('INVALID'));
    expect(f.ddb.send).not.toHaveBeenCalled();
  });

  it('rejects getters, non-enumerable secrets and prototype-bearing configuration', () => {
    const nonEnumerable = clone(CONFIGURATION);
    Object.defineProperty(nonEnumerable, 'secret', { value: 'hidden' });
    const getter = { ...CONFIGURATION };
    const readSecret = vi.fn();
    Object.defineProperty(getter, 'model', { get: readSecret, enumerable: true });
    for (const value of [
      nonEnumerable,
      getter,
      Object.assign(Object.create(CONFIGURATION), CONFIGURATION),
    ]) {
      expect(() => nativeExecutionConfiguration(value)).toThrow('Invalid native execution');
    }
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'opencode', 'kiro'])(
    'accepts %s with matching existing credential-provider metadata',
    (harness) => {
      const value = {
        ...CONFIGURATION,
        harness,
        model: 'provider.model-v1:0',
        credentialBinding: {
          provider: harness === 'kiro' ? 'kiro' : 'bedrock',
          source: 'user',
          userId: ACTOR,
        },
        repository: { ...CONFIGURATION.repository, branch: 'feature/pipe-art' },
      };
      expect(nativeExecutionConfiguration(value)).toEqual(value);
    },
  );

  it.each([
    ['GSI projectId', { projectId: IDENTITY.projectId }],
    ['GSI createdAt', { createdAt: 1000 }],
    ['unknown authority', { approved: true }],
    ['huge unknown field', { transcript: 'x'.repeat(400 * 1024) }],
    ['wrong key', { sk: 'RUNTIME' }],
    ['wrong scope', { scope: { ...IDENTITY, projectId: 'another-project' } }],
    ['wrong hash', { configurationSha256: '0'.repeat(64) }],
    ['configuration mutation', { configuration: { ...CONFIGURATION, model: 'different' } }],
    ['missing immutable field', { attemptId: undefined }],
    ['invalid epoch', { epoch: 2 }],
    ['fake completed status', { status: 'SUCCEEDED' }],
    ['unpaired lease', { leaseToken: OTHER }],
    ['early running', { status: 'RUNNING' }],
  ])('fails closed on corrupted stored row: %s', async (_label, changes) => {
    const f = setup();
    await f.start();
    f.rows.set(JSON.stringify([executionKey.pk, executionKey.sk]), { ...f.read(), ...changes });
    await expect(f.store.get(IDENTITY)).rejects.toMatchObject(rejection('INVALID'));
  });

  it('rejects malformed method envelopes and constructor/clock values', async () => {
    const f = setup();
    for (const override of [
      { ddb: null },
      { tableName: '*' },
      { preparationStore: {} },
      { leaseMs: 0 },
      { leaseMs: 3600001 },
      { now: null },
    ]) {
      expect(() =>
        createNativeExecutionStore({
          ddb: f.ddb,
          tableName: TABLE,
          preparationStore: f.preparationStore,
          ...override,
        }),
      ).toThrow('Native execution storage is unavailable');
    }
    for (const action of [
      () => f.store.get({ ...IDENTITY, approved: true }),
      () => f.store.claim({ ...bindingIdentity, version: 1 }),
      () => f.store.cancel({ ...bindingIdentity, actorId: ACTOR }),
      () => f.start({ startedBy: 'fake' }),
      () => f.store.advance({ row: {}, patch: {}, approved: true }),
    ])
      await expect(action()).rejects.toMatchObject(rejection('INVALID'));
    f.setTime(Number.MAX_SAFE_INTEGER);
    await expect(f.start()).rejects.toMatchObject(rejection('UNAVAILABLE'));
  });
});

describe('serial control-plane ownership and same-attempt dispatch', () => {
  it('concurrent claims have one owner and one busy result', async () => {
    const f = setup();
    const { row: started } = await f.start();
    const results = await Promise.all([
      f.store.claim(bindingIdentity),
      f.store.claim(bindingIdentity),
    ]);
    expect(results.map((result) => result.kind).toSorted()).toEqual(['busy', 'claimed']);
    expect(results[0].row).toEqual(results[1].row);
    expect(f.read()).toMatchObject({
      version: 2,
      fence: 1,
      epoch: 1,
      leaseExpiresAt: 1100,
      attemptId: started.attemptId,
      runtimeSessionId: started.runtimeSessionId,
    });
  });

  it('requires both exact source commit and upgraded runtime pins before dispatch', async () => {
    const f = setup();
    const row = await f.claimed();
    const target = targetFor(row);
    for (const patch of [
      { status: 'DISPATCHING' },
      { status: 'DISPATCHING', sourceCommit: COMMIT },
      { status: 'DISPATCHING', target },
      { status: 'DISPATCHING', target, sourceCommit: COMMIT },
      { sourceBranch: null },
      { sourceBranch: '../main' },
      { sourceCommit: 'main' },
      { target: { ...target, runtimeVersion: '1' } },
      { target: { ...target, imageDigest: IMAGE.digest } },
      { target: { ...target, runtimeArn: target.runtimeArn + 'other' } },
      { target: { ...target, runtimeId: target.runtimeId + 'other' } },
      { target: { ...target, endpoint: PREPARED.runtimeEndpoint } },
      { target: { ...target, endpointArn: target.endpointArn + 'other' } },
      { target: { ...target, rolePolicySha256: 'unverified' } },
    ])
      await expect(f.store.advance({ row, patch })).rejects.toMatchObject(rejection('INVALID'));
    const upgrading = await f.store.advance({
      row,
      patch: { status: 'UPGRADING', sourceCommit: COMMIT, sourceBranch: 'main' },
    });
    const dispatching = await f.store.advance({
      row: upgrading,
      patch: { status: 'DISPATCHING', target },
    });
    expect(dispatching).toMatchObject({
      status: 'DISPATCHING',
      target,
      sourceCommit: COMMIT,
      sourceBranch: 'main',
      attemptId: row.attemptId,
      runtimeSessionId: row.runtimeSessionId,
    });
  });

  it('never repins runtime/source or rewinds after dispatch; empty advance only renews ownership', async () => {
    const f = setup();
    const row = await f.dispatching();
    for (const patch of [
      { status: 'REQUESTED' },
      { status: 'UPGRADING' },
      { sourceCommit: 'f'.repeat(40) },
      { sourceBranch: 'other-branch' },
      { target: { ...targetFor(row), runtimeVersion: '3' } },
      { status: 'WAITING_FOR_INPUT' },
      { status: 'STOPPED' },
      { status: 'CANCELLED' },
    ])
      await expect(f.store.advance({ row, patch })).rejects.toMatchObject(rejection('CONFLICT'));
    for (const patch of [
      { attemptId: OTHER },
      { epoch: 2 },
      { runtimeSessionId: OTHER },
      { publication: PUBLICATION },
      { publicationEpoch: 1 },
      { projectionStatus: 'complete' },
      { timeoutMs: 100 },
      { leaseExpiresAt: 1e6 },
      { configuration: CONFIGURATION },
      { approved: true },
    ])
      await expect(f.store.advance({ row, patch })).rejects.toMatchObject(rejection('INVALID'));
    f.setTime(1099);
    const renewed = await f.store.advance({ row, patch: {} });
    expect(renewed).toMatchObject({
      status: 'DISPATCHING',
      leaseToken: row.leaseToken,
      leaseExpiresAt: 1199,
      attemptId: row.attemptId,
      runtimeSessionId: row.runtimeSessionId,
      epoch: 1,
    });
    const repeatedPins = await f.store.advance({
      row: renewed,
      patch: { sourceCommit: COMMIT, sourceBranch: 'main', target: targetFor(row) },
    });
    expect(repeatedPins.target).toEqual(targetFor(row));
  });

  it.each(['DISPATCHING', 'RUNNING'])(
    'expired %s ownership reconciles the same persisted attempt/session',
    async (status) => {
      const f = setup();
      const original = status === 'RUNNING' ? await f.running() : await f.dispatching();
      f.setTime(1100);
      const { row, kind } = await f.store.claim(bindingIdentity);
      expect(kind).toBe('claimed');
      expect(row).toMatchObject({
        status,
        attemptId: original.attemptId,
        runtimeSessionId: original.runtimeSessionId,
        epoch: original.epoch,
        target: targetFor(original),
        sourceCommit: COMMIT,
        sourceBranch: 'main',
        fence: original.fence + 1,
        leaseExpiresAt: 1200,
      });
      expect(row.leaseToken).not.toBe(original.leaseToken);
      for (const action of [
        () => f.store.advance({ row: original, patch: { status: 'RUNNING' } }),
        () => f.store.release({ row: original }),
        () => f.store.publish({ row: original, publication: PUBLICATION }),
      ])
        await expect(action()).rejects.toMatchObject(rejection('LEASE_LOST'));
      expect(f.read()).toEqual(row);
    },
  );

  it('an expired owner cannot write even before a takeover', async () => {
    const f = setup();
    const row = await f.running();
    f.setTime(1100);
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('LEASE_LOST'),
    );
    await expect(f.store.release({ row })).rejects.toMatchObject(rejection('LEASE_LOST'));
    expect(f.read()).toEqual(row);
  });

  it('release permits immediate takeover without another model attempt', async () => {
    const f = setup();
    const row = await f.running();
    const released = await f.store.release({ row });
    expect(released).not.toHaveProperty('leaseToken');
    expect(released).not.toHaveProperty('leaseExpiresAt');
    const next = await f.store.claim(bindingIdentity);
    expect(next.kind).toBe('claimed');
    expect(next.row).toMatchObject({
      status: 'RUNNING',
      attemptId: row.attemptId,
      runtimeSessionId: row.runtimeSessionId,
      target: targetFor(row),
      sourceCommit: COMMIT,
      sourceBranch: 'main',
      epoch: 1,
      fence: row.fence + 1,
    });
  });

  it('uses full-row equality as well as version/fence, rejecting forged owned snapshots', async () => {
    const f = setup();
    const row = await f.running();
    for (const changed of [
      { ...row, target: { ...targetFor(row), runtimeVersion: '3' } },
      { ...row, sourceCommit: '1'.repeat(40) },
      { ...row, leaseToken: OTHER },
    ])
      await expect(f.store.advance({ row: changed, patch: {} })).rejects.toMatchObject(
        rejection('LEASE_LOST'),
      );
    expect(f.read()).toEqual(row);
  });

  it('rejects nested target accessors/prototypes and non-JSON patch values before cloning them', async () => {
    const f = setup();
    const row = await f.claimed();
    const target = targetFor(row);
    const accessed = vi.fn(() => '2');
    const accessor = { ...target };
    Object.defineProperty(accessor, 'runtimeVersion', { enumerable: true, get: accessed });
    const hidden = { ...target };
    Object.defineProperty(hidden, 'secret', { value: 'private' });
    for (const patch of [
      { target: accessor },
      { target: hidden },
      { target: Object.assign(Object.create(target), target) },
      { sourceCommit: () => COMMIT },
      { sourceBranch: () => 'main' },
      { failureCode: () => 'private stack trace' },
      { status: 'MADE_UP' },
    ]) {
      await expect(f.store.advance({ row, patch })).rejects.toMatchObject(rejection('INVALID'));
    }
    expect(accessed).not.toHaveBeenCalled();
    expect(f.read()).toEqual(row);
  });

  it.each(['advance', 'release', 'publish', 'projected'])(
    'fences %s if another owner wins after its consistent read but before its write',
    async (operation) => {
      const f = setup();
      const row = operation === 'projected' ? await f.published() : await f.running();
      const gate = f.pause((command) => command instanceof TransactWriteCommand);
      const action = {
        advance: () => f.store.advance({ row, patch: {} }),
        release: () => f.store.release({ row }),
        publish: () => f.store.publish({ row, publication: PUBLICATION }),
        projected: () => f.store.projected({ row }),
      }[operation];
      const pending = action();
      const rejected = expect(pending).rejects.toMatchObject(rejection('CONFLICT'));
      await gate.waiting;
      f.setTime(1100);
      const successor = (await f.store.claim(bindingIdentity)).row;
      gate.resume();
      await rejected;
      expect(f.read()).toEqual(successor);
      expect(successor.attemptId).toBe(row.attemptId);
      expect(successor.runtimeSessionId).toBe(row.runtimeSessionId);
    },
  );

  it('pins the resolved branch to an explicitly requested branch before dispatch', async () => {
    const f = setup();
    const configuration = {
      ...CONFIGURATION,
      repository: { ...CONFIGURATION.repository, branch: 'feature/pipes' },
    };
    await f.start({ configuration });
    const { row } = await f.store.claim(bindingIdentity);
    await expect(f.store.advance({ row, patch: { sourceBranch: 'main' } })).rejects.toMatchObject(
      rejection('INVALID'),
    );
    const pinned = await f.store.advance({
      row,
      patch: {
        sourceBranch: 'feature/pipes',
        sourceCommit: 'e'.repeat(64),
        target: targetFor(row),
        status: 'DISPATCHING',
      },
    });
    expect(pinned.sourceBranch).toBe('feature/pipes');
    expect(pinned.sourceCommit).toBe('e'.repeat(64));
  });

  it('failed execution is terminal and does not silently restart on Start or claim', async () => {
    const f = setup();
    const row = await f.claimed();
    const failed = await f.store.advance({ row, patch: { status: 'FAILED' } });
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'native_execution_failed' });
    expect(failed).not.toHaveProperty('leaseToken');
    expect(await f.store.claim(bindingIdentity)).toEqual({ kind: 'terminal', row: failed });
    expect((await f.start()).row).toEqual(failed);
  });

  it('wrong binding cannot claim/cancel and missing identity cannot be created by claim', async () => {
    const f = setup();
    expect(await f.store.claim(bindingIdentity)).toEqual({ kind: 'missing' });
    await expect(f.store.cancel(bindingIdentity)).rejects.toMatchObject(rejection('NOT_FOUND'));
    await f.start();
    const wrong = { ...bindingIdentity, bindingId: '60000000-0000-4000-8000-000000000001' };
    await expect(f.store.claim(wrong)).rejects.toMatchObject(rejection('CONFLICT'));
    await expect(f.store.cancel(wrong)).rejects.toMatchObject(rejection('CONFLICT'));
  });
});

describe('immutable first publication and transactional ingestion outbox', () => {
  it.each([false, true])(
    'rejects publicationEpoch without a committed publication (cancelled=%s)',
    async (cancelled) => {
      const f = setup();
      await f.start();
      if (cancelled) await f.store.cancel(bindingIdentity);
      f.write({ ...f.read(), publicationEpoch: 1 });
      await expect(f.store.get(IDENTITY)).rejects.toMatchObject(rejection('INVALID'));
    },
  );

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['fractional', 1.5],
    ['string', '1'],
    ['future or cancellation epoch', 2],
  ])('rejects %s publication epoch before and after cancellation', async (_label, value) => {
    for (const cancelled of [false, true]) {
      const f = setup();
      await f.published();
      if (cancelled) await f.store.cancel(bindingIdentity);
      const row = { ...f.read(), publicationEpoch: value };
      if (value === undefined) delete row.publicationEpoch;
      f.write(row);
      await expect(f.store.get(IDENTITY)).rejects.toMatchObject(rejection('INVALID'));
    }
  });

  it('derives publicationEpoch from authority rather than accepting a caller-selected epoch', async () => {
    const f = setup();
    const row = await f.running();
    await expect(
      f.store.publish({ row, publication: PUBLICATION, publicationEpoch: row.epoch }),
    ).rejects.toMatchObject(rejection('INVALID'));
    await expect(
      f.store.publish({ row, publication: { ...PUBLICATION, publicationEpoch: row.epoch } }),
    ).rejects.toMatchObject(rejection('INVALID'));
    expect(f.read()).toEqual(row);
    const published = await f.store.publish({ row, publication: PUBLICATION });
    await expect(
      f.store.advance({ row: published, patch: { publicationEpoch: published.epoch } }),
    ).rejects.toMatchObject(rejection('INVALID'));
    expect(f.read()).toEqual(published);
  });

  it('commits exact manifest metadata/question and pending outbox together, then acknowledges projection', async () => {
    const f = setup();
    const row = await f.published();
    expect(row).toMatchObject({
      status: 'WAITING_FOR_INPUT',
      publication: PUBLICATION,
      publicationEpoch: 1,
      projectionStatus: 'pending',
    });
    const publicationWrites = f.ddb.send.mock.calls
      .map(([command]) => putOf(command))
      .filter((put) => put?.Item.publication);
    expect(publicationWrites).toHaveLength(1);
    expect(publicationWrites[0].Item.projectionStatus).toBe('pending');
    expect(publicationWrites[0].Item.publicationEpoch).toBe(row.epoch);
    const projected = await f.store.projected({ row });
    expect(projected.publication).toEqual(PUBLICATION);
    expect(projected.publicationEpoch).toBe(row.epoch);
    expect(projected.projectionStatus).toBe('complete');
    expect(projected).not.toHaveProperty('leaseToken');
    expect(await f.store.claim(bindingIdentity)).toEqual({ kind: 'terminal', row: projected });
    expect(f.read(preparationKey).status).toBe('READY');
  });

  it('publishes STOPPED without interpreting process exit as workflow success', async () => {
    const f = setup();
    const row = await f.store.publish({
      row: await f.dispatching(),
      publication: { ...PUBLICATION, outcome: 'STOPPED', question: null, filesCount: 0 },
    });
    expect(row.status).toBe('STOPPED');
    expect((await f.store.claim(bindingIdentity)).kind).toBe('busy');
    const released = await f.store.release({ row });
    const claimant = await f.store.claim(bindingIdentity);
    expect(claimant.kind).toBe('claimed');
    expect(claimant.row.attemptId).toBe(released.attemptId);
    expect((await f.store.projected({ row: claimant.row })).projectionStatus).toBe('complete');
  });

  it('same publication replay with the current owner is a no-op; mutation/replacement is rejected', async () => {
    const f = setup();
    const row = await f.published();
    const calls = f.ddb.send.mock.calls.length;
    expect(await f.store.publish({ row, publication: clone(PUBLICATION) })).toEqual(row);
    expect(f.ddb.send.mock.calls.length).toBe(calls + 1);
    for (const publication of [
      { ...PUBLICATION, id: '6'.repeat(64) },
      { ...PUBLICATION, nativeSessionId: 'different-session' },
      { ...PUBLICATION, manifest: { ...PUBLICATION.manifest, versionId: 'other-version' } },
      { ...PUBLICATION, manifest: { ...PUBLICATION.manifest, sha256: '1'.repeat(64) } },
      { ...PUBLICATION, question: { ...PUBLICATION.question, sha256: '1'.repeat(64) } },
    ])
      await expect(f.store.publish({ row, publication })).rejects.toMatchObject(
        rejection('CONFLICT'),
      );
    expect(f.read()).toEqual(row);
  });

  it.each([
    ['zero sequence', { sequence: 0 }],
    ['S3 unversioned', { manifest: { ...PUBLICATION.manifest, versionId: 'null' } }],
    ['manifest extra flag', { manifest: { ...PUBLICATION.manifest, verified: true } }],
    ['manifest traversal', { manifest: { ...PUBLICATION.manifest, key: '../manifest.json' } }],
    [
      'oversized manifest metadata',
      { manifest: { ...PUBLICATION.manifest, versionId: 'x'.repeat(1025) } },
    ],
    ['manifest zero bytes', { manifest: { ...PUBLICATION.manifest, bytes: 0 } }],
    [
      'manifest huge byte claim',
      { manifest: { ...PUBLICATION.manifest, bytes: 16 * 1024 * 1024 + 1 } },
    ],
    ['invalid hash', { manifest: { ...PUBLICATION.manifest, sha256: 'not-a-hash' } }],
    ['question absolute path', { question: { ...PUBLICATION.question, path: '/secret' } }],
    ['question backslash', { question: { ...PUBLICATION.question, path: '..\\secret' } }],
    ['question traversal', { question: { ...PUBLICATION.question, path: 'docs/../secret' } }],
    [
      'question empty segment',
      { question: { ...PUBLICATION.question, path: 'docs//question.md' } },
    ],
    ['question unknown answer', { question: { ...PUBLICATION.question, approved: true } }],
    ['missing wait question', { question: null }],
    ['question outside any files', { filesCount: 0 }],
    ['negative files', { filesCount: -1 }],
    ['huge files claim', { filesCount: 100001 }],
    ['finished plus question', { outcome: 'STOPPED' }],
    ['pretend success', { outcome: 'SUCCEEDED' }],
    ['runtime authority', { approved: true }],
    ['inline content', { transcript: 'private conversation' }],
  ])('rejects invalid publication: %s', async (_label, changes) => {
    const f = setup();
    const row = await f.running();
    await expect(
      f.store.publish({ row, publication: { ...PUBLICATION, ...changes } }),
    ).rejects.toMatchObject(rejection('INVALID'));
    expect(f.read()).toEqual(row);
  });

  it('rejects a valid future publication sequence before its response is accepted', async () => {
    const f = setup();
    const row = await f.running();
    await expect(
      f.store.publish({
        row,
        publication: { ...PUBLICATION, sequence: 2 },
      }),
    ).rejects.toMatchObject(rejection('CONFLICT'));
    expect(f.read()).toEqual(row);
  });

  it('cannot publish before dispatch or project without a committed publication', async () => {
    const f = setup();
    const row = await f.claimed();
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('CONFLICT'),
    );
    await expect(f.store.projected({ row })).rejects.toMatchObject(rejection('CONFLICT'));
  });

  it('two competing publications cannot replace the first committed manifest', async () => {
    const f = setup();
    const row = await f.running();
    const results = await Promise.allSettled([
      f.store.publish({ row, publication: PUBLICATION }),
      f.store.publish({ row, publication: { ...PUBLICATION, id: '6'.repeat(64) } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject(
      rejection('CONFLICT'),
    );
    expect(f.read().publication).toEqual(PUBLICATION);
  });

  it('pending ingestion survives lease takeover but the old owner cannot acknowledge it', async () => {
    const f = setup();
    const first = await f.published();
    f.setTime(1100);
    const second = await f.store.claim(bindingIdentity);
    await expect(f.store.projected({ row: first })).rejects.toMatchObject(rejection('LEASE_LOST'));
    expect(second.row.publication).toEqual(PUBLICATION);
    expect(second.row.publicationEpoch).toBe(first.publicationEpoch);
    expect(second.row.projectionStatus).toBe('pending');
    expect((await f.store.projected({ row: second.row })).projectionStatus).toBe('complete');
  });
});

describe('cancellation and publication fences', () => {
  it.each(['pending', 'complete'])(
    'keeps %s publication readable with its original epoch throughout cancellation and stop',
    async (projectionStatus) => {
      const f = setup();
      const published = await f.published();
      if (projectionStatus === 'complete') await f.store.projected({ row: published });
      await f.store.cancel(bindingIdentity);
      const stopping = await f.store.get(IDENTITY);
      expect(stopping).toMatchObject({
        scope: published.scope,
        bindingId: published.bindingId,
        attemptId: published.attemptId,
        epoch: published.epoch + 1,
        publicationEpoch: published.epoch,
        publication: published.publication,
        projectionStatus,
        status: 'CANCEL_REQUESTED',
      });
      const stopper = (await f.store.claim(bindingIdentity)).row;
      await expect(f.store.projected({ row: stopper })).rejects.toMatchObject(
        rejection('CANCELLED'),
      );
      await f.store.advance({ row: stopper, patch: { status: 'CANCELLED' } });
      const stopped = await f.store.get(IDENTITY);
      expect(stopped).toMatchObject({
        scope: stopping.scope,
        bindingId: stopping.bindingId,
        attemptId: stopping.attemptId,
        status: 'CANCELLED',
        epoch: stopping.epoch,
        publicationEpoch: published.epoch,
        publication: published.publication,
        projectionStatus,
      });
      expect(await f.store.cancel(bindingIdentity)).toEqual(stopped);
      expect(await f.store.get({ ...IDENTITY, projectId: 'another-project' })).toBeNull();
    },
  );

  it('revokes live ownership immediately and durably requests stop; stop confirmation needs a new owner', async () => {
    const f = setup();
    const running = await f.running();
    const cancelled = await f.store.cancel(bindingIdentity);
    expect(cancelled).toMatchObject({
      status: 'CANCEL_REQUESTED',
      epoch: 2,
      cancelRequested: true,
      stop: { state: 'PENDING', requestedAt: 1000 },
      attemptId: running.attemptId,
      runtimeSessionId: running.runtimeSessionId,
    });
    expect(cancelled).not.toHaveProperty('leaseToken');
    expect(await f.store.cancel(bindingIdentity)).toEqual(cancelled);
    await expect(f.store.publish({ row: running, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('CANCELLED'),
    );
    await expect(
      f.store.advance({ row: running, patch: { status: 'RUNNING' } }),
    ).rejects.toMatchObject(rejection('LEASE_LOST'));
    const stopper = await f.store.claim(bindingIdentity);
    expect(stopper.kind).toBe('claimed');
    await expect(
      f.store.advance({ row: stopper.row, patch: { status: 'RUNNING' } }),
    ).rejects.toMatchObject(rejection('CONFLICT'));
    await expect(
      f.store.advance({ row: stopper.row, patch: { sourceCommit: COMMIT } }),
    ).rejects.toMatchObject(rejection('CANCELLED'));
    const done = await f.store.advance({ row: stopper.row, patch: { status: 'CANCELLED' } });
    expect(done).toMatchObject({
      status: 'CANCELLED',
      epoch: 2,
      stop: { state: 'COMPLETED', completedAt: 1000 },
    });
    expect(await f.store.claim(bindingIdentity)).toEqual({ kind: 'terminal', row: done });
    expect((await f.start()).row).toEqual(done);
  });

  it('cancellation works after expiry and expired stop ownership never implies stop completed', async () => {
    const f = setup();
    await f.running();
    f.setTime(1100);
    await f.store.cancel(bindingIdentity);
    const first = (await f.store.claim(bindingIdentity)).row;
    f.setTime(1200);
    const next = (await f.store.claim(bindingIdentity)).row;
    expect(next).toMatchObject({
      status: 'CANCEL_REQUESTED',
      epoch: 2,
      stop: { state: 'PENDING' },
      attemptId: first.attemptId,
      runtimeSessionId: first.runtimeSessionId,
    });
    await expect(
      f.store.advance({ row: first, patch: { status: 'CANCELLED' } }),
    ).rejects.toMatchObject(rejection('LEASE_LOST'));
  });

  it('cancellation winning between publish read and transaction prevents publication/outbox creation', async () => {
    const f = setup();
    const row = await f.running();
    const gate = f.pause((command) => Boolean(putOf(command)?.Item.publication));
    const pending = f.store.publish({ row, publication: PUBLICATION });
    const rejected = expect(pending).rejects.toMatchObject(rejection('CONFLICT'));
    await gate.waiting;
    const cancelled = await f.store.cancel(bindingIdentity);
    gate.resume();
    await rejected;
    expect(f.read()).toEqual(cancelled);
    expect(f.read()).not.toHaveProperty('publication');
    expect(f.read()).not.toHaveProperty('publicationEpoch');
    expect(f.read()).not.toHaveProperty('projectionStatus');
  });

  it('publication winning first remains immutable, but racing cancel fences pending ingestion', async () => {
    const f = setup();
    const row = await f.running();
    const gate = f.pause((command) => putOf(command)?.Item.cancelRequested === true);
    const cancelling = f.store.cancel(bindingIdentity);
    await gate.waiting;
    const published = await f.store.publish({ row, publication: PUBLICATION });
    gate.resume();
    const cancelled = await cancelling;
    expect(cancelled).toMatchObject({
      status: 'CANCEL_REQUESTED',
      epoch: 2,
      publication: PUBLICATION,
      publicationEpoch: published.epoch,
      projectionStatus: 'pending',
      stop: { state: 'PENDING' },
    });
    await expect(f.store.projected({ row: published })).rejects.toMatchObject(
      rejection('CANCELLED'),
    );
    expect(f.read()).toEqual(cancelled);
  });

  it('cancellation racing a projection acknowledgement fences the old transaction', async () => {
    const f = setup();
    const row = await f.published();
    const gate = f.pause((command) => putOf(command)?.Item.projectionStatus === 'complete');
    const pending = f.store.projected({ row });
    const rejected = expect(pending).rejects.toMatchObject(rejection('CONFLICT'));
    await gate.waiting;
    const cancelled = await f.store.cancel(bindingIdentity);
    gate.resume();
    await rejected;
    expect(f.read()).toEqual(cancelled);
    expect(cancelled.projectionStatus).toBe('pending');
  });

  it('concurrent cancels increment epoch once and preserve already projected history', async () => {
    const f = setup();
    const projected = await f.store.projected({ row: await f.published() });
    const results = await Promise.all([
      f.store.cancel(bindingIdentity),
      f.store.cancel(bindingIdentity),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].epoch).toBe(2);
    expect(results[0].publication).toEqual(projected.publication);
    expect(results[0].publicationEpoch).toBe(projected.publicationEpoch);
    expect(results[0].projectionStatus).toBe('complete');
  });
});

describe('acknowledgement loss, transport failure and CAS evidence', () => {
  it('fails closed when a consistent read is unavailable, including acknowledgement recovery', async () => {
    const f = setup();
    const row = await f.running();
    f.hooks.before = (command) => {
      if (command instanceof GetCommand) throw error('AccessDeniedException');
    };
    await expect(f.store.get(IDENTITY)).rejects.toMatchObject(rejection('UNAVAILABLE'));
    expect(f.read()).toEqual(row);
    delete f.hooks.before;
    f.hooks.after = (command) => {
      if (command instanceof TransactWriteCommand) {
        f.hooks.before = () => {
          throw error('AccessDeniedException');
        };
        throw error();
      }
    };
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('UNAVAILABLE'),
    );
    expect(f.read().publication).toEqual(PUBLICATION);
    expect(f.read().projectionStatus).toBe('pending');
  });

  it.each(['claim', 'advance', 'release', 'publish', 'projected', 'cancel', 'stop'])(
    'recovers exact committed %s after losing the transaction acknowledgement',
    async (operation) => {
      const f = setup();
      let action;
      if (operation === 'claim') {
        await f.start();
        action = async () => (await f.store.claim(bindingIdentity)).row;
      } else if (operation === 'projected') {
        const row = await f.published();
        action = () => f.store.projected({ row });
      } else if (operation === 'stop') {
        await f.start();
        await f.store.cancel(bindingIdentity);
        const { row } = await f.store.claim(bindingIdentity);
        action = () => f.store.advance({ row, patch: { status: 'CANCELLED' } });
      } else {
        const row = await f.running();
        action = {
          advance: () => f.store.advance({ row, patch: {} }),
          release: () => f.store.release({ row }),
          publish: () => f.store.publish({ row, publication: PUBLICATION }),
          cancel: () => f.store.cancel(bindingIdentity),
        }[operation];
      }
      f.hooks.after = (command) => {
        if (command instanceof TransactWriteCommand) throw error();
      };
      expect(await action()).toEqual(f.read());
    },
  );

  it('does not mistake a newer takeover for acknowledgement of an old publication', async () => {
    const f = setup();
    const row = await f.running();
    let takenOver;
    f.hooks.after = async (command) => {
      if (putOf(command)?.Item.publication) {
        delete f.hooks.after;
        f.setTime(1100);
        takenOver = (await f.store.claim(bindingIdentity)).row;
        throw error();
      }
    };
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('CONFLICT'),
    );
    expect(f.read()).toEqual(takenOver);
    expect(f.read().projectionStatus).toBe('pending');
    expect(f.read().attemptId).toBe(row.attemptId);
  });

  it('does not acknowledge a publication that was cancelled before its lost reply was recovered', async () => {
    const f = setup();
    const row = await f.running();
    f.hooks.after = async (command) => {
      if (putOf(command)?.Item.publication) {
        delete f.hooks.after;
        await f.store.cancel(bindingIdentity);
        throw error();
      }
    };
    await expect(f.store.publish({ row, publication: PUBLICATION })).rejects.toMatchObject(
      rejection('CONFLICT'),
    );
    expect(f.read().status).toBe('CANCEL_REQUESTED');
    expect(f.read().projectionStatus).toBe('pending');
  });

  it('ambiguous no-write failure preserves the same attempt for reconciliation and hides AWS details', async () => {
    const f = setup();
    const row = await f.dispatching();
    f.hooks.before = (command) => {
      if (command instanceof TransactWriteCommand) throw error();
    };
    await expect(f.store.advance({ row, patch: { status: 'RUNNING' } })).rejects.toMatchObject({
      ...rejection('UNAVAILABLE'),
      message: 'Native execution storage is unavailable',
    });
    expect(f.read()).toEqual(row);
    delete f.hooks.before;
    f.setTime(1100);
    const reclaimed = (await f.store.claim(bindingIdentity)).row;
    expect(reclaimed).toMatchObject({
      status: 'DISPATCHING',
      attemptId: row.attemptId,
      runtimeSessionId: row.runtimeSessionId,
    });
  });

  it('every mutation CAS includes version, binding, epoch, cancellation, attempt/session and lease fence', async () => {
    const f = setup();
    const published = await f.published();
    await f.store.projected({ row: published });
    await f.store.cancel(bindingIdentity);
    const stopper = await f.store.claim(bindingIdentity);
    await f.store.advance({ row: stopper.row, patch: { status: 'CANCELLED' } });
    const puts = f.ddb.send.mock.calls
      .map(([command]) => putOf(command))
      .filter(Boolean)
      .slice(1);
    expect(puts.length).toBeGreaterThan(5);
    for (const put of puts) {
      for (const field of [
        'version',
        'bindingId',
        'epoch',
        'cancelRequested',
        'attemptId',
        'runtimeSessionId',
        'fence',
        'status',
        'configurationSha256',
      ]) {
        expect(put.ConditionExpression).toContain(`#${field} = :${field}`);
        expect(put.ExpressionAttributeNames[`#${field}`]).toBe(field);
      }
      expect(put.ConditionExpression).toContain('#leaseToken');
      expect(put.ConditionExpression).toContain('#leaseExpiresAt');
      expect(Buffer.byteLength(JSON.stringify(put.Item))).toBeLessThan(32 * 1024);
    }
  });
});
