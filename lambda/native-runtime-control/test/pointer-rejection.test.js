import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAuthority } from '../authority.js';
import { nativeAuthorityPort } from '../authority-client.js';
import { nativeExecutionKey } from '../execution-store.js';
import { createNativeExecutionWorker } from '../execution-worker.js';
import { createNativeProjectionWorker, createNativeProjector } from '../projection-worker.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { IMAGE } from './fixtures.js';

// The consumers run against the real authority, stores and validator over the
// fixture table. Only the Lambda transport between them is replaced.
const AUTHORITY = 'native-authority';
const ENV = {
  AWS_REGION: 'us-east-1',
  AWS_PARTITION: 'aws',
  NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
  NATIVE_RUNTIME_FILE_SYSTEM_ID: 'fs-1234567890abcdef0',
  NATIVE_RUNTIME_IMAGE_URI: IMAGE.uri,
  NATIVE_RUNTIME_IMAGE_DIGEST: IMAGE.digest,
  NATIVE_RUNTIME_SUBNET_IDS: '["subnet-123abc"]',
  NATIVE_RUNTIME_SECURITY_GROUP_IDS: '["sg-123abc"]',
  NATIVE_RUNTIME_ROLE_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/native-boundary',
  NATIVE_RUNTIME_ECR_REPOSITORY_ARN: 'arn:aws:ecr:us-east-1:123456789012:repository/agentcore',
  NATIVE_AUTHORITY_FUNCTION: AUTHORITY,
  NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-publications',
  NATIVE_RUNTIME_BINDINGS_TABLE: 'native-run-bindings',
  NATIVE_EXECUTION_QUEUE_URL: 'execution-queue',
};
const CONTEXT = { getRemainingTimeInMillis: () => 120_000 };

const setup = async ({ published = false } = {}) => {
  const f = serialFixture();
  await f.ready();
  if (published) await f.publish({ project: false });
  const run = createNativeAuthority({
    stores: {
      // The deployed observation also consults the image policy after this read.
      execution: { ...f.store, observeRevocation: (scope) => f.store.get(scope) },
      preparation: f.preparationStore,
      projection: f.projection,
    },
    functionName: AUTHORITY,
  });
  const refuse = new Map();
  const calls = [];
  const lambda = {
    send: async (command) => {
      const request = JSON.parse(Buffer.from(command.input.Payload).toString('utf8'));
      calls.push(request.operation);
      const reply = refuse.has(request.operation)
        ? { ok: false, code: refuse.get(request.operation) }
        : await run(request, { invokedFunctionArn: command.input.FunctionName });
      return { Payload: Buffer.from(JSON.stringify(reply)) };
    },
  };
  const sqs = { send: vi.fn(async () => ({ MessageId: 'sent' })) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const lines = (level) => logger[level].mock.calls.map(([text]) => JSON.parse(text));
  // A development row written under an earlier contract: the removed field
  // makes the current validator reject the stored execution on every read.
  const retire = () => {
    const key = nativeExecutionKey(f.identity);
    const stored = [...f.rows.values()].find((row) => row.pk === key.pk && row.sk === key.sk);
    stored.recoveryCheckpoint = {};
  };
  const record = (body = JSON.stringify(f.identity)) => ({
    Records: [{ messageId: 'message-1', body }],
  });
  const executionWorker = (env = {}) =>
    createNativeExecutionWorker({
      env: { ...ENV, ...env },
      lambda,
      sqs,
      logger,
      ddb: f.ddb,
      s3: { send: vi.fn() },
      runtime: {},
      control: {},
      iam: {},
      efs: {},
    });
  const projectionWorker = (ports = {}) =>
    createNativeProjectionWorker({
      reconcile: createNativeProjector({
        store: nativeAuthorityPort(
          'projection',
          'projection',
          ['claim', 'acknowledge', 'release'],
          {
            lambda,
            functionName: AUTHORITY,
          },
        ),
        publications: f.publications,
        interactions: f.interactions,
        authorize: f.recheck,
        project: vi.fn(),
        ...ports,
      }),
      sqs,
      queueUrl: 'projection-queue',
      logger,
    });
  return {
    f,
    refuse,
    calls,
    sqs,
    logger,
    lines,
    retire,
    record,
    executionWorker,
    projectionWorker,
  };
};
const scopeHash = (identity) => createHash('sha256').update(JSON.stringify(identity)).digest('hex');
const FAILED = { batchItemFailures: [{ itemIdentifier: 'message-1' }] };
const ACKNOWLEDGED = { batchItemFailures: [] };

describe('native execution pointers', () => {
  it('acknowledges a pointer to an execution the current contract rejects, logging it once', async () => {
    const t = await setup();
    t.retire();
    const stored = structuredClone([...t.f.rows]);
    expect(await t.executionWorker()(t.record(), CONTEXT)).toEqual(ACKNOWLEDGED);
    expect(t.calls).toEqual(['get']);
    expect(t.lines('info')).toEqual([
      {
        event: 'native_execution_pointer_rejected',
        code: 'NATIVE_EXECUTION_INVALID',
        scopeHash: scopeHash(t.f.identity),
      },
    ]);
    expect(t.logger.warn).not.toHaveBeenCalled();
    expect(t.sqs.send).not.toHaveBeenCalled();
    expect([...t.f.rows]).toEqual(stored);
  });

  it.each([
    ['not JSON', '{"projectId":'],
    ['not an identity', JSON.stringify({ projectId: 'p', executionId: 'not-a-uuid' })],
    ['more than an identity', JSON.stringify({ projectId: 'p', executionId: 'e', token: 't' })],
  ])('acknowledges a pointer that is %s without naming its content', async (_name, body) => {
    const t = await setup();
    expect(await t.executionWorker()(t.record(body), CONTEXT)).toEqual(ACKNOWLEDGED);
    expect(t.calls).toEqual([]);
    expect(t.lines('info')).toEqual([
      { event: 'native_execution_pointer_rejected', code: 'NATIVE_POINTER_MALFORMED' },
    ]);
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the authority fails', 'get', 'NATIVE_AUTHORITY_UNAVAILABLE'],
    // Past the first read the same code refuses a request, not the execution.
    ['a later call is refused', 'claim', 'NATIVE_EXECUTION_INVALID'],
    ['a later call fails', 'claim', 'NATIVE_AUTHORITY_UNAVAILABLE'],
  ])('still reports a batch item failure when %s', async (_name, operation, code) => {
    const t = await setup();
    t.refuse.set(operation, code);
    expect(await t.executionWorker()(t.record(), CONTEXT)).toEqual(FAILED);
    expect(t.lines('warn')).toEqual([{ event: 'native_execution_retry', code }]);
    expect(t.lines('info').map((line) => line.event)).not.toContain(
      'native_execution_pointer_rejected',
    );
    expect(t.sqs.send).not.toHaveBeenCalled();
  });

  it('keeps polling a valid execution another worker holds with a fresh pointer', async () => {
    const t = await setup();
    expect((await t.f.store.claim(t.f.bindingIdentity)).kind).toBe('claimed');
    expect(await t.executionWorker()(t.record(), CONTEXT)).toEqual(ACKNOWLEDGED);
    expect(t.calls).toEqual(['get', 'claim']);
    expect(t.sqs.send).toHaveBeenCalledTimes(1);
    expect(t.sqs.send.mock.calls[0][0].input).toEqual({
      QueueUrl: 'execution-queue',
      DelaySeconds: 5,
      MessageBody: JSON.stringify(t.f.identity),
    });
    expect(t.lines('info')).toEqual([
      { event: 'native_execution_reconciled', scopeHash: scopeHash(t.f.identity), status: 'busy' },
    ]);
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it('acknowledges a cancellation pointer only after the read alone rejects the execution', async () => {
    const t = await setup();
    const worker = t.executionWorker({ NATIVE_CANCELLATION_ONLY: 'true' });
    // The observation is refused while the execution itself still reads.
    t.refuse.set('observeRevocation', 'NATIVE_EXECUTION_INVALID');
    expect(await worker(t.record(), CONTEXT)).toEqual(FAILED);
    expect(t.calls).toEqual(['observeRevocation', 'get']);
    expect(t.lines('warn')).toEqual([
      { event: 'native_execution_retry', code: 'NATIVE_EXECUTION_INVALID' },
    ]);
    expect(t.logger.info).not.toHaveBeenCalled();

    t.refuse.clear();
    t.retire();
    expect(await worker(t.record(), CONTEXT)).toEqual(ACKNOWLEDGED);
    expect(t.lines('info')).toEqual([
      {
        event: 'native_execution_pointer_rejected',
        code: 'NATIVE_EXECUTION_INVALID',
        scopeHash: scopeHash(t.f.identity),
      },
    ]);
    expect(t.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('native projection pointers', () => {
  it('acknowledges a pointer to a published execution the current contract rejects, logging it once', async () => {
    const t = await setup({ published: true });
    t.retire();
    const stored = structuredClone([...t.f.rows]);
    const project = vi.fn();
    expect(await t.projectionWorker({ project })(t.record())).toEqual(ACKNOWLEDGED);
    expect(t.calls).toEqual(['claim']);
    expect(t.lines('info')).toEqual([
      {
        event: 'native_projection_pointer_rejected',
        code: 'NATIVE_EXECUTION_INVALID',
        scopeHash: scopeHash(t.f.identity),
      },
    ]);
    expect(t.logger.warn).not.toHaveBeenCalled();
    expect(t.sqs.send).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect([...t.f.rows]).toEqual(stored);
  });

  it.each([
    ['not JSON', 'projectId=p', 'NATIVE_POINTER_MALFORMED', []],
    // The authority owns the identity contract; the worker does not repeat it.
    ['not an identity', JSON.stringify({ projectId: 7 }), 'NATIVE_EXECUTION_INVALID', ['claim']],
  ])('acknowledges a pointer that is %s', async (_name, body, code, calls) => {
    const t = await setup({ published: true });
    expect(await t.projectionWorker()(t.record(body))).toEqual(ACKNOWLEDGED);
    expect(t.calls).toEqual(calls);
    expect(t.lines('info')).toEqual([{ event: 'native_projection_pointer_rejected', code }]);
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it('still reports a batch item failure when the authority fails', async () => {
    const t = await setup({ published: true });
    t.refuse.set('claim', 'NATIVE_AUTHORITY_UNAVAILABLE');
    expect(await t.projectionWorker()(t.record())).toEqual(FAILED);
    expect(t.lines('warn')).toEqual([
      { event: 'native_projection_retry', code: 'NATIVE_AUTHORITY_UNAVAILABLE' },
    ]);
    expect(t.logger.info).not.toHaveBeenCalled();
  });

  it('still reports a batch item failure for a claimed publication that cannot be projected yet', async () => {
    const t = await setup({ published: true });
    // Past the claim, neither an unknown failure nor the same code is final.
    const authorize = vi
      .fn()
      .mockRejectedValueOnce(new Error('Native projection authorization changed'))
      .mockRejectedValueOnce(
        Object.assign(new Error('refused'), { code: 'NATIVE_EXECUTION_INVALID' }),
      );
    const worker = t.projectionWorker({ authorize });
    expect(await worker(t.record())).toEqual(FAILED);
    expect(await worker(t.record())).toEqual(FAILED);
    expect(t.calls).toEqual(['claim', 'release', 'claim', 'release']);
    expect(t.lines('warn')).toEqual([
      { event: 'native_projection_retry', code: 'NATIVE_PROJECTION_RETRY' },
      { event: 'native_projection_retry', code: 'NATIVE_EXECUTION_INVALID' },
    ]);
    expect(t.logger.info).not.toHaveBeenCalled();
    expect(t.sqs.send).not.toHaveBeenCalled();
  });

  it('keeps polling a valid publication another projector holds with a fresh pointer', async () => {
    const t = await setup({ published: true });
    expect((await t.f.projection.claim(t.f.identity)).kind).toBe('claimed');
    expect(await t.projectionWorker()(t.record())).toEqual(ACKNOWLEDGED);
    expect(t.sqs.send).toHaveBeenCalledTimes(1);
    expect(t.sqs.send.mock.calls[0][0].input).toEqual({
      QueueUrl: 'projection-queue',
      DelaySeconds: 5,
      MessageBody: JSON.stringify(t.f.identity),
    });
    expect(t.logger.info).not.toHaveBeenCalled();
    expect(t.logger.warn).not.toHaveBeenCalled();
  });
});
