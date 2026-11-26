import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createNativePackageJobs, NativePackageJobError } from '../native-package-jobs.js';
import { describeNativePackagePin } from '../native-package-pin.js';
import { workflowSourceIdentity } from '../workflow-source-bindings.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const TABLE = 'native-package-jobs';
const JOB_ID = '10000000-0000-4000-8000-000000000001';
const REVISION = '20000000-0000-4000-8000-000000000001';
const OTHER_REVISION = '20000000-0000-4000-8000-000000000002';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOURCE = workflowSourceIdentity('github', 'example/workflows');
const KEY = { projectId: 'project-one', jobId: JOB_ID };
const request = (overrides = {}) => ({
  ...KEY,
  sourceId: SOURCE.sourceId,
  actorId: 'owner-one',
  bindingRevision: REVISION,
  requestedRelease: 'latest',
  ...overrides,
});
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const candidate = ({
  provider = 'github',
  repository = 'example/workflows',
  version = '2.9.0',
  ...extra
} = {}) => {
  const identity = {
    schemaVersion: 1,
    source: { provider, repository, release: `v${version}`, commit: 'a'.repeat(40) },
    target: 'linux-arm64',
    version,
    manifestSha256: 'b'.repeat(64),
    checksumsSha256: 'c'.repeat(64),
    assets: {
      binary: { name: 'aidlc-linux-arm64', sha256: 'd'.repeat(64), bytes: 17 },
      runtime: { name: `aidlc-runtime-${version}.tar.gz`, sha256: 'e'.repeat(64), bytes: 55 },
    },
    harnesses: ['claude', 'codex', 'kiro', 'opencode'],
  };
  const packagePin = { ...identity, packageId: digest(identity) };
  return {
    schemaVersion: 1,
    projectId: KEY.projectId,
    sourceId: workflowSourceIdentity(provider, repository).sourceId,
    bindingRevision: REVISION,
    requestedRelease: 'latest',
    packagePin,
    attestation: null,
    materializationId: describeNativePackagePin(packagePin, null).materializationId,
    ...extra,
  };
};
const receipt = (value = candidate(), overrides = {}) => ({
  schemaVersion: 1,
  materializationId: value.materializationId,
  manifest: { versionId: 'immutable-version-1', sha256: 'f'.repeat(64), bytes: 1024 },
  ...overrides,
});
const awsError = (name = 'ConditionalCheckFailedException') =>
  Object.assign(new Error('private DynamoDB host and credentials'), { name });

// Evaluate actual emitted conditions against mutable current rows. A hook can
// delay a command before evaluation or lose its acknowledgement after storage.
const statefulDdb = () => {
  const rows = new Map();
  const calls = [];
  const hooks = {};
  const id = (key) => JSON.stringify([key.projectId, key.jobId]);
  const read = (key = KEY) => structuredClone(rows.get(id(key)));
  const write = (row) => rows.set(id(row), structuredClone(row));
  const satisfies = (input) => {
    const row = read(input.Key ?? input.Item);
    return input.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[\w]+)\)$/.exec(clause);
      const comparison = /^(#[\w]+) (=|>|<=) (:[\w]+)$/.exec(clause);
      if (absent) return !row || !Object.hasOwn(row, input.ExpressionAttributeNames[absent[1]]);
      if (comparison) {
        const left = row?.[input.ExpressionAttributeNames[comparison[1]]];
        const right = input.ExpressionAttributeValues[comparison[3]];
        if (comparison[2] === '=') return isDeepStrictEqual(left, right);
        if (comparison[2] === '>') return left > right;
        return left <= right;
      }
      throw new Error(`Unsupported condition ${clause}`);
    });
  };
  const ddb = {
    send: async (command) => {
      calls.push(command);
      expect(command.input.TableName).toBe(TABLE);
      await hooks.before?.(command);
      const input = command.input;
      let result;
      if (command instanceof GetCommand) {
        expect(input.ConsistentRead).toBe(true);
        result = { Item: read(input.Key) };
      } else {
        if (!satisfies(input)) throw awsError();
        if (command instanceof PutCommand) {
          write(input.Item);
          result = {};
        } else if (command instanceof UpdateCommand) {
          const row = read(input.Key);
          const match = /^SET (.*?)(?: REMOVE (.*))?$/.exec(input.UpdateExpression);
          if (!match || !row) throw new Error('Invalid test update');
          for (const assignment of match[1].split(', ')) {
            const [name, value] = assignment.split(' = ');
            row[input.ExpressionAttributeNames[name]] = structuredClone(
              input.ExpressionAttributeValues[value],
            );
          }
          for (const name of match[2]?.split(', ') ?? [])
            delete row[input.ExpressionAttributeNames[name]];
          write(row);
          expect(input.ReturnValues).toBe('ALL_NEW');
          result = { Attributes: read(input.Key) };
        } else {
          throw new Error('Unexpected write command');
        }
      }
      await hooks.after?.(command, result);
      return result;
    },
  };
  return { ddb, calls, hooks, read, write, rows };
};
const setup = (options = {}) => {
  const storage = statefulDdb();
  let time = 1000;
  const jobs = createNativePackageJobs({
    ddb: storage.ddb,
    tableName: TABLE,
    now: () => time,
    leaseMs: 100,
    maxAttempts: 3,
    ...options,
  });
  return {
    ...storage,
    jobs,
    setTime: (value) => {
      time = value;
    },
    async running() {
      await jobs.create(request());
      const claimed = await jobs.claim(KEY);
      expect(claimed.kind).toBe('claimed');
      return { ...KEY, leaseToken: claimed.job.leaseToken };
    },
  };
};
const pauseOnce = (f, phase, predicate) => {
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  let entered = false;
  f.hooks[phase] = async (command) => {
    if (entered || !predicate(command)) return;
    entered = true;
    started.resolve();
    await released.promise;
  };
  return { started: started.promise, resume: released.resolve };
};
const isUpdate = (command) => command instanceof UpdateCommand;

describe('protected native package job requests', () => {
  it('creates only the immutable request projection and numeric timestamps', async () => {
    const f = setup();
    const created = await f.jobs.create({
      ...request(),
      token: 'private',
      leaseToken: 'injected',
      candidate: candidate(),
      state: 'SUCCEEDED',
    });
    expect(created).toMatchObject({
      ...request(),
      schemaVersion: 1,
      state: 'QUEUED',
      attempts: 0,
      createdAt: 1000,
      updatedAt: 1000,
      requestDigest: digest({ schemaVersion: 1, ...request() }),
      revision: expect.stringMatching(UUID),
    });
    expect(JSON.stringify(created)).not.toMatch(/private|injected|leaseToken|candidate|ttl/i);
    expect(f.read()).toEqual(created);
    expect(await f.jobs.get(KEY)).toEqual(created);
    expect(f.calls.filter((command) => command instanceof PutCommand)).toHaveLength(1);
  });

  it('defaults latest and handles duplicate creation without resetting running or terminal state', async () => {
    const f = setup();
    const original = await f.jobs.create({ ...request(), requestedRelease: undefined });
    expect(await f.jobs.create(request())).toEqual(original);
    const claimed = await f.jobs.claim(KEY);
    expect(await f.jobs.create(request())).toEqual(claimed.job);
    const failed = await f.jobs.fail({
      ...KEY,
      leaseToken: claimed.job.leaseToken,
      code: 'native_package_invalid',
    });
    expect(await f.jobs.create(request())).toEqual(failed);
    expect(f.read().state).toBe('FAILED');
  });

  it.each([
    { actorId: 'other-owner' },
    { sourceId: 'f'.repeat(64) },
    { bindingRevision: OTHER_REVISION },
    { requestedRelease: 'v2.9.0' },
  ])('rejects changed immutable request fields %j for the same key', async (change) => {
    const f = setup();
    const original = await f.jobs.create(request());
    await expect(f.jobs.create(request(change))).rejects.toMatchObject({
      code: 'native_package_job_conflict',
    });
    expect(f.read()).toEqual(original);
  });

  it('isolates the same job UUID across project keys', async () => {
    const f = setup();
    await f.jobs.create(request());
    const other = await f.jobs.create(request({ projectId: 'other-project' }));
    expect(await f.jobs.get({ ...KEY, projectId: 'other-project' })).toEqual(other);
    expect(f.rows.size).toBe(2);
  });

  it.each([
    { projectId: '../secret' },
    { jobId: 'not-a-uuid' },
    { actorId: '' },
    { actorId: 'owner\n' },
    { actorId: 'x'.repeat(257) },
    { sourceId: 'A'.repeat(64) },
    { bindingRevision: undefined },
    { requestedRelease: null },
    { requestedRelease: 'main' },
    { requestedRelease: 'v01.2.3' },
    { requestedRelease: 'v2.9.0\n' },
  ])('rejects invalid request %j before AWS I/O', async (change) => {
    const f = setup();
    await expect(f.jobs.create(request(change))).rejects.toMatchObject({
      code: 'native_package_job_invalid',
    });
    expect(f.calls).toEqual([]);
  });

  it.each([
    { leaseMs: 0 },
    { leaseMs: Infinity },
    { leaseMs: 1.5 },
    { leaseMs: 86400001 },
    { maxAttempts: 0 },
    { maxAttempts: Infinity },
    { maxAttempts: 101 },
    { maxAttempts: 2.5 },
    { tableName: '' },
    { tableName: 'secret\n' },
    { now: 42 },
  ])('rejects invalid factory configuration %j', (options) => {
    expect(() => setup(options)).toThrow(NativePackageJobError);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid clock %s',
    async (time) => {
      const f = setup();
      f.setTime(time);
      await expect(f.jobs.create(request())).rejects.toMatchObject({
        code: 'native_package_job_invalid',
      });
      expect(f.calls).toEqual([]);
    },
  );

  it('returns null and missing for absent rows without manufacturing a lease', async () => {
    const f = setup();
    expect(await f.jobs.get(KEY)).toBeNull();
    expect(await f.jobs.claim(KEY)).toEqual({ kind: 'missing' });
    await expect(f.jobs.assertLease({ ...KEY, leaseToken: REVISION })).rejects.toMatchObject({
      code: 'native_package_job_not_found',
    });
    expect(f.calls.every((command) => command instanceof GetCommand)).toBe(true);
  });
});

describe('atomic lease claims and terminal fencing', () => {
  it('lets only one duplicate delivery claim a queued job', async () => {
    const f = setup();
    await f.jobs.create(request());
    const results = await Promise.all([f.jobs.claim(KEY), f.jobs.claim(KEY), f.jobs.claim(KEY)]);
    expect(results.filter(({ kind }) => kind === 'claimed')).toHaveLength(1);
    expect(results.filter(({ kind }) => kind === 'busy')).toHaveLength(2);
    expect(f.read()).toMatchObject({
      state: 'RUNNING',
      attempts: 1,
      leaseToken: expect.stringMatching(UUID),
      leaseExpiresAt: 1100,
    });
  });

  it('reclaims exactly at expiry with a new token and fences the earlier worker', async () => {
    const f = setup();
    const first = await f.running();
    f.setTime(1099);
    expect((await f.jobs.claim(KEY)).kind).toBe('busy');
    f.setTime(1100);
    await expect(f.jobs.assertLease(first)).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
    const next = await f.jobs.claim(KEY);
    expect(next).toMatchObject({ kind: 'claimed', job: { attempts: 2, leaseExpiresAt: 1200 } });
    expect(next.job.leaseToken).not.toBe(first.leaseToken);
    for (const [method, extra] of [
      ['assertLease', {}],
      ['saveCandidate', { candidate: candidate() }],
      ['saveReceipt', { receipt: receipt() }],
      ['succeed', {}],
      ['fail', { code: 'native_package_invalid' }],
    ]) {
      await expect(f.jobs[method]({ ...first, ...extra })).rejects.toMatchObject({
        code: 'native_package_job_lease_lost',
      });
    }
    expect(f.read()).toEqual(next.job);
  });

  it('rejects expiry even without a competing claimant', async () => {
    const f = setup();
    const lease = await f.running();
    f.setTime(1100);
    await expect(f.jobs.saveCandidate({ ...lease, candidate: candidate() })).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
    expect(f.read()).not.toHaveProperty('candidate');
  });

  it('does not return an active lease if claim acknowledgement arrives after expiry', async () => {
    const f = setup();
    await f.jobs.create(request());
    f.hooks.after = async (command) => {
      if (isUpdate(command)) f.setTime(1100);
    };
    await expect(f.jobs.claim(KEY)).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
    expect(f.read().attempts).toBe(1);
  });

  it('atomically makes an expired exhausted job terminal and never revives it', async () => {
    const f = setup({ maxAttempts: 1 });
    const first = await f.running();
    await f.jobs.saveCandidate({ ...first, candidate: candidate() });
    f.setTime(1100);
    const outcomes = await Promise.all([f.jobs.claim(KEY), f.jobs.claim(KEY)]);
    for (const result of outcomes) {
      expect(result).toMatchObject({
        kind: 'terminal',
        job: { state: 'FAILED', attempts: 1, errorCode: 'native_package_job_attempts_exhausted' },
      });
      expect(result.job).not.toHaveProperty('leaseToken');
    }
    f.setTime(5000);
    expect(await f.jobs.claim(KEY)).toEqual(outcomes[0]);
    expect(f.read()).toHaveProperty('candidate');
    await expect(f.jobs.succeed(first)).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
  });

  it('a delayed earlier worker cannot write after an expired lease is replaced', async () => {
    const f = setup();
    const first = await f.running();
    const pause = pauseOnce(f, 'before', isUpdate);
    const delayed = f.jobs.saveCandidate({ ...first, candidate: candidate() });
    const denied = expect(delayed).rejects.toMatchObject({ code: 'native_package_job_lease_lost' });
    await pause.started;
    f.setTime(1100);
    const winner = await f.jobs.claim(KEY);
    pause.resume();
    await denied;
    expect(f.read()).toEqual(winner.job);
    expect(f.read()).not.toHaveProperty('candidate');
  });

  it('emits revision, state, attempt and unexpired token guards on leased mutations', async () => {
    const f = setup();
    const lease = await f.running();
    const before = f.read();
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    const input = f.calls.at(-1).input;
    expect(input.ConditionExpression).toContain('#revision = :revision');
    expect(input.ConditionExpression).toContain('#state = :state');
    expect(input.ConditionExpression).toContain('#attempts = :attempts');
    expect(input.ConditionExpression).toContain('#token = :token');
    expect(input.ConditionExpression).toContain('#expires > :now');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':revision': before.revision,
      ':token': lease.leaseToken,
      ':attempts': 1,
      ':now': 1000,
    });
    expect(f.read().revision).not.toBe(before.revision);
  });
});

describe('immutable candidate and receipt persistence', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'pins a reduced %s candidate once and strips untrusted extra claims',
    async (provider) => {
      const f = setup();
      const value = candidate({ provider });
      await f.jobs.create(request({ sourceId: value.sourceId }));
      const claimed = await f.jobs.claim(KEY);
      const lease = { ...KEY, leaseToken: claimed.job.leaseToken };
      const withClaims = {
        ...value,
        trust: { allowed: true },
        directory: '/private/cache',
        token: 'private-token',
        archiveReceipt: receipt(value),
        packagePin: {
          ...value.packagePin,
          inventory: { fileCount: 100000 },
          verification: { integrity: 'verified' },
        },
      };
      const saved = await f.jobs.saveCandidate({ ...lease, candidate: withClaims });
      expect(saved.candidate).toEqual(value);
      expect(saved.candidateDigest).toBe(digest(value));
      expect(JSON.stringify(saved)).not.toMatch(
        /private|inventory|verification|trust|archiveReceipt/,
      );
      expect(await f.jobs.saveCandidate({ ...lease, candidate: value })).toEqual(saved);
      await expect(
        f.jobs.saveCandidate({ ...lease, candidate: candidate({ provider, version: '2.10.0' }) }),
      ).rejects.toMatchObject({ code: 'native_package_job_conflict' });
      expect(f.read()).toEqual(saved);
    },
  );

  it('snapshots a candidate before awaiting a row read', async () => {
    const f = setup();
    const lease = await f.running();
    const value = candidate();
    const pause = pauseOnce(f, 'before', (command) => command instanceof GetCommand);
    const saving = f.jobs.saveCandidate({ ...lease, candidate: value });
    await pause.started;
    value.packagePin.source.commit = '0'.repeat(40);
    value.packagePin.assets.binary.sha256 = '0'.repeat(64);
    value.projectId = 'other-project';
    pause.resume();
    expect((await saving).candidate).toEqual(candidate());
  });

  it.each([
    { projectId: 'other-project' },
    { bindingRevision: OTHER_REVISION },
    { requestedRelease: 'v2.9.0' },
  ])('rejects a valid candidate from a different request %j', async (change) => {
    const f = setup();
    const lease = await f.running();
    await expect(
      f.jobs.saveCandidate({ ...lease, candidate: candidate(change) }),
    ).rejects.toMatchObject({ code: 'native_package_job_conflict' });
    expect(f.read()).not.toHaveProperty('candidate');
  });

  it('rejects an unrelated source and an explicit tag mismatch', async () => {
    const f = setup();
    const lease = await f.running();
    await expect(
      f.jobs.saveCandidate({ ...lease, candidate: candidate({ repository: 'other/repo' }) }),
    ).rejects.toMatchObject({ code: 'native_package_job_conflict' });
    await expect(
      f.jobs.saveCandidate({
        ...lease,
        candidate: candidate({ requestedRelease: 'v2.8.0' }),
      }),
    ).rejects.toMatchObject({ code: 'native_package_job_invalid' });
    expect(f.read()).not.toHaveProperty('candidate');
  });

  it('accepts an exact preview request but never a preview candidate for latest stable', async () => {
    const f = setup();
    const value = candidate({
      version: '2.10.0-preview.20260918.1',
      requestedRelease: 'v2.10.0-preview.20260918.1',
    });
    await f.jobs.create(request({ requestedRelease: value.requestedRelease }));
    const claimed = await f.jobs.claim(KEY);
    const lease = { ...KEY, leaseToken: claimed.job.leaseToken };
    expect((await f.jobs.saveCandidate({ ...lease, candidate: value })).candidate).toEqual(value);
    await expect(
      f.jobs.saveCandidate({ ...lease, candidate: { ...value, requestedRelease: 'latest' } }),
    ).rejects.toMatchObject({ code: 'native_package_job_invalid' });
  });

  it('preserves the first candidate across expired lease retries and duplicate deliveries', async () => {
    const f = setup();
    const first = await f.running();
    const saved = await f.jobs.saveCandidate({ ...first, candidate: candidate() });
    f.setTime(1100);
    const next = await f.jobs.claim(KEY);
    expect(next.job.candidateDigest).toBe(saved.candidateDigest);
    expect(next.job.candidate).toEqual(saved.candidate);
    const lease = { ...KEY, leaseToken: next.job.leaseToken };
    await expect(
      f.jobs.saveCandidate({ ...lease, candidate: candidate({ version: '2.10.0' }) }),
    ).rejects.toMatchObject({ code: 'native_package_job_conflict' });
    expect((await f.jobs.saveCandidate({ ...lease, candidate: candidate() })).attempts).toBe(2);
  });

  it('concurrent different candidates cannot overwrite each other within the same lease', async () => {
    const f = setup();
    const lease = await f.running();
    const values = [candidate(), candidate({ version: '2.10.0' })];
    const results = await Promise.allSettled(
      values.map((value) => f.jobs.saveCandidate({ ...lease, candidate: value })),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected').reason.code).toBe(
      'native_package_job_conflict',
    );
    expect(values).toContainEqual(f.read().candidate);
  });

  it('requires a candidate before receipt and a stored receipt before success', async () => {
    const f = setup();
    const lease = await f.running();
    await expect(f.jobs.saveReceipt({ ...lease, receipt: receipt() })).rejects.toMatchObject({
      code: 'native_package_job_conflict',
    });
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    await expect(
      f.jobs.succeed({ ...lease, result: { allowed: true }, receipt: receipt() }),
    ).rejects.toMatchObject({ code: 'native_package_job_conflict' });
    expect(f.read().state).toBe('RUNNING');
  });

  it('stores one exact receipt, snapshots it before I/O, and only then permits success', async () => {
    const f = setup();
    const lease = await f.running();
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    const value = receipt();
    const saving = f.jobs.saveReceipt({ ...lease, receipt: value });
    value.manifest.versionId = 'mutated';
    const saved = await saving;
    expect(saved.archiveReceipt).toEqual(receipt());
    expect(await f.jobs.saveReceipt({ ...lease, receipt: receipt() })).toEqual(saved);
    await expect(f.jobs.saveReceipt({ ...lease, receipt: value })).rejects.toMatchObject({
      code: 'native_package_job_conflict',
    });
    const succeeded = await f.jobs.succeed({ ...lease, result: { token: 'ignored' } });
    expect(succeeded).toMatchObject({ state: 'SUCCEEDED', archiveReceipt: receipt() });
    expect(succeeded).not.toHaveProperty('leaseToken');
    expect(succeeded).not.toHaveProperty('result');
    expect(await f.jobs.claim(KEY)).toEqual({ kind: 'terminal', job: succeeded });
    await expect(f.jobs.fail({ ...lease, code: 'native_package_invalid' })).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
    expect(f.read()).toEqual(succeeded);
  });

  it('rejects a receipt for another materialization and unexpected receipt fields', async () => {
    const f = setup();
    const lease = await f.running();
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    for (const value of [
      receipt(candidate({ version: '2.10.0' })),
      { ...receipt(), token: 'private' },
      { ...receipt(), manifest: { ...receipt().manifest, versionId: 'null' } },
    ]) {
      await expect(f.jobs.saveReceipt({ ...lease, receipt: value })).rejects.toMatchObject({
        code: 'native_package_job_invalid',
      });
    }
    expect(f.read()).not.toHaveProperty('archiveReceipt');
  });

  it('concurrent receipt retries converge without overwriting a different manifest version', async () => {
    const f = setup();
    const lease = await f.running();
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    const values = [
      receipt(),
      receipt(),
      receipt(candidate(), { manifest: { ...receipt().manifest, versionId: 'other-version' } }),
    ];
    const results = await Promise.allSettled(
      values.map((value) => f.jobs.saveReceipt({ ...lease, receipt: value })),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(2);
    expect(results.at(-1)).toMatchObject({
      status: 'rejected',
      reason: { code: 'native_package_job_conflict' },
    });
    expect(f.read().archiveReceipt).toEqual(receipt());
  });

  it('sanitizes unknown terminal failure details to a fixed code', async () => {
    const f = setup();
    const lease = await f.running();
    const failed = await f.jobs.fail({ ...lease, code: 'https://private/?token=secret' });
    expect(failed.errorCode).toBe('native_package_job_failed');
    expect(JSON.stringify(failed)).not.toMatch(/secret|https/);
    expect(await f.jobs.claim(KEY)).toEqual({ kind: 'terminal', job: failed });
  });
});

describe('DynamoDB acknowledgements and malformed state', () => {
  it.each(['ConditionalCheckFailedException', 'TimeoutError'])(
    'recovers a lost create acknowledgement reported as %s',
    async (name) => {
      const f = setup();
      f.hooks.after = async (command) => {
        if (command instanceof PutCommand) throw awsError(name);
      };
      expect(await f.jobs.create(request())).toEqual(f.read());
    },
  );

  it.each(['claim', 'saveCandidate', 'saveReceipt', 'succeed', 'fail'])(
    'recovers an applied %s update whose SDK retry sees a conditional failure',
    async (method) => {
      const f = setup();
      let lease;
      if (method === 'claim') await f.jobs.create(request());
      else {
        lease = await f.running();
        if (['saveReceipt', 'succeed'].includes(method))
          await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
        if (method === 'succeed') await f.jobs.saveReceipt({ ...lease, receipt: receipt() });
      }
      f.hooks.after = async (command) => {
        if (isUpdate(command)) throw awsError();
      };
      const result = await f.jobs[method](
        method === 'claim'
          ? KEY
          : {
              ...lease,
              candidate: candidate(),
              receipt: receipt(),
              code: 'native_package_invalid',
            },
      );
      expect(method === 'claim' ? result.job : result).toEqual(f.read());
    },
  );

  it('keeps an unknown unapplied writer failure safe and retryable under the same lease', async () => {
    const f = setup();
    const lease = await f.running();
    f.hooks.before = async (command) => {
      if (isUpdate(command)) throw awsError('NetworkError');
    };
    await expect(f.jobs.saveCandidate({ ...lease, candidate: candidate() })).rejects.toMatchObject({
      code: 'native_package_job_unavailable',
      message: 'Native package job storage is unavailable',
    });
    expect(f.read()).not.toHaveProperty('candidate');
    f.hooks.before = undefined;
    expect((await f.jobs.saveCandidate({ ...lease, candidate: candidate() })).candidate).toEqual(
      candidate(),
    );
  });

  it('does not claim success when an AWS mock acknowledges no actual update', async () => {
    const f = setup();
    await f.jobs.create(request());
    const send = f.ddb.send;
    f.ddb.send = async (command) => (isUpdate(command) ? {} : send(command));
    await expect(f.jobs.claim(KEY)).rejects.toMatchObject({
      code: 'native_package_job_unavailable',
    });
    expect(f.read().state).toBe('QUEUED');
  });

  it.each([
    [
      'wrong schema',
      (row) => {
        row.schemaVersion = 2;
      },
    ],
    [
      'missing release',
      (row) => {
        delete row.requestedRelease;
      },
    ],
    [
      'wrong request digest',
      (row) => {
        row.requestDigest = 'sha256:bad';
      },
    ],
    [
      'unexpected private field',
      (row) => {
        row.token = 'private';
      },
    ],
    [
      'unknown state',
      (row) => {
        row.state = 'RETRY';
      },
    ],
    [
      'negative attempt',
      (row) => {
        row.attempts = -1;
      },
    ],
    [
      'invalid revision',
      (row) => {
        row.revision = 'not-uuid';
      },
    ],
    [
      'invalid timestamp',
      (row) => {
        row.updatedAt = 'today';
      },
    ],
    [
      'time reversal',
      (row) => {
        row.updatedAt = 0;
      },
    ],
    [
      'terminal without receipt',
      (row) => {
        row.state = 'SUCCEEDED';
      },
    ],
    [
      'queued lease',
      (row) => {
        row.leaseToken = REVISION;
      },
    ],
    [
      'oversize record',
      (row) => {
        row.private = 'x'.repeat(64 * 1024);
      },
    ],
  ])('fails closed on %s', async (_name, change) => {
    const f = setup();
    await f.jobs.create(request());
    const row = f.read();
    change(row);
    f.write(row);
    await expect(f.jobs.get(KEY)).rejects.toMatchObject({ code: 'native_package_job_invalid' });
    await expect(f.jobs.claim(KEY)).rejects.toMatchObject({ code: 'native_package_job_invalid' });
  });

  it('rejects tampered persisted candidate, receipt, and digests before succeeding', async () => {
    const f = setup();
    const lease = await f.running();
    await f.jobs.saveCandidate({ ...lease, candidate: candidate() });
    await f.jobs.saveReceipt({ ...lease, receipt: receipt() });
    const original = f.read();
    for (const mutate of [
      (row) => {
        row.candidateDigest = 'sha256:bad';
      },
      (row) => {
        row.candidate.packagePin.inventory = { private: true };
      },
      (row) => {
        row.archiveReceipt.materializationId = `sha256:${'0'.repeat(64)}`;
      },
      (row) => {
        row.leaseExpiresAt = row.updatedAt;
      },
      (row) => {
        row.errorCode = 'native_package_invalid';
      },
    ]) {
      const row = structuredClone(original);
      mutate(row);
      f.write(row);
      await expect(f.jobs.succeed(lease)).rejects.toMatchObject({
        code: 'native_package_job_invalid',
      });
    }
  });

  it('returns fixed safe errors for storage failures and unknown error constructor input', async () => {
    const f = setup();
    f.hooks.before = async () => {
      throw awsError('private-failure');
    };
    await expect(f.jobs.get(KEY)).rejects.toMatchObject({
      name: 'NativePackageJobError',
      code: 'native_package_job_unavailable',
      message: 'Native package job storage is unavailable',
    });
    expect(new NativePackageJobError('https://private/secret').message).toBe(
      'Native package job inputs or stored state are invalid',
    );
  });
});
