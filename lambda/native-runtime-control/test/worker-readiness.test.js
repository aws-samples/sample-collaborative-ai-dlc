import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createNativeRuntimeWorker } from '../worker.js';

const QUEUE_URL =
  'https://sqs.us-east-1.amazonaws.com/746558295630/collaborative-ai-dlc-native-runs-dev-provisioning';
const QUEUE_ARN =
  'arn:aws:sqs:us-east-1:746558295630:collaborative-ai-dlc-native-runs-dev-provisioning';
const POINTER = { projectId: 'project-c', executionId: 'run-c' };
const RETRY = { batchItemFailures: [{ itemIdentifier: 'original-delivery' }] };
const SCOPE_HASH = createHash('sha256')
  .update(JSON.stringify([POINTER.projectId, POINTER.executionId]))
  .digest('hex');

function fixture(result = { status: 'waiting', phase: 'runtime' }) {
  const env = {
    NATIVE_PREPARATION_ENABLED: 'true',
    NATIVE_PREPARATION_PROJECT_IDS: JSON.stringify([POINTER.projectId]),
    NATIVE_RUNTIME_QUEUE_URL: QUEUE_URL,
    NATIVE_RUNTIME_ACCOUNT_ID: '746558295630',
    AWS_REGION: 'us-east-1',
    AWS_PARTITION: 'aws',
  };
  const record = {
    eventSource: 'aws:sqs',
    eventSourceARN: QUEUE_ARN,
    awsRegion: 'us-east-1',
    messageId: 'original-delivery',
    receiptHandle: 'opaque-delivery-receipt+/=',
    attributes: { ApproximateReceiveCount: '1' },
    body: JSON.stringify(POINTER),
  };
  const reconcile = vi.fn().mockResolvedValue(result);
  const changeMessageVisibility = vi.fn().mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
  const random = vi.fn(() => 0);
  const logger = { info: vi.fn() };
  const context = { getRemainingTimeInMillis: vi.fn(() => 25_000) };
  const worker = createNativeRuntimeWorker({
    reconcile,
    changeMessageVisibility,
    random,
    logger,
    env,
  });
  return {
    env,
    record,
    reconcile,
    changeMessageVisibility,
    random,
    logger,
    context,
    logs: () => logger.info.mock.calls.map(([text]) => JSON.parse(text)),
    run: () => worker({ Records: [record] }, context),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('released readiness delivery scheduling', () => {
  it.each(['access_point', 'iam_propagation', 'runtime', 'endpoint'])(
    'shortens the original receipt for %s but never acknowledges it',
    async (phase) => {
      const f = fixture({ status: 'waiting', phase });
      expect(await f.run()).toEqual(RETRY);
      expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(POINTER, {
        remainingMs: expect.any(Function),
      });
      expect(f.changeMessageVisibility).toHaveBeenCalledExactlyOnceWith(
        {
          QueueUrl: QUEUE_URL,
          ReceiptHandle: f.record.receiptHandle,
          VisibilityTimeout: 5,
        },
        { abortSignal: expect.any(AbortSignal) },
      );
      expect(f.logs()).toEqual([
        {
          event: 'native_runtime_readiness_scheduling',
          scopeHash: SCOPE_HASH,
          phase,
          outcome: 'scheduled',
          receiveCount: 1,
          delaySeconds: 5,
          httpStatus: 200,
        },
      ]);
    },
  );

  it('does not schedule until reconciliation has returned the released waiting result', async () => {
    const f = fixture();
    let release;
    f.reconcile.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const invocation = f.run();
    await Promise.resolve();
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
    release({ status: 'waiting', phase: 'access_point' });
    expect(await invocation).toEqual(RETRY);
    expect(f.changeMessageVisibility).toHaveBeenCalledTimes(1);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });

  it.each(['READY', 'FAILED', 'terminal', 'missing'])(
    'acknowledges only the existing terminal result %s without changing visibility',
    async (status) => {
      const f = fixture({ status });
      expect(await f.run()).toEqual({ batchItemFailures: [] });
      expect(f.changeMessageVisibility).not.toHaveBeenCalled();
      expect(f.logs()).toEqual([]);
    },
  );

  it.each([
    { status: 'pending' },
    { status: 'pending', phase: 'runtime' },
    { status: 'busy' },
    { status: 'waiting' },
    { status: 'waiting', phase: 'diagnostic' },
    { status: 'waiting', phase: 'lease_lost' },
    null,
  ])('retains the ordinary retry for an unrecognized or unsafe outcome %j', async (result) => {
    const f = fixture(result);
    expect(await f.run()).toEqual(RETRY);
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
    expect(f.logs()).toEqual([]);
  });

  it.each([undefined, {}, { $metadata: { httpStatusCode: 500 } }])(
    'never converts an ambiguous scheduling response %j into acknowledgement',
    async (response) => {
      const f = fixture();
      f.changeMessageVisibility.mockResolvedValueOnce(response);
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).toHaveBeenCalledTimes(1);
      expect(f.logs()).toEqual([
        expect.objectContaining({ outcome: 'unconfirmed', phase: 'runtime', delaySeconds: 5 }),
      ]);
    },
  );

  it.each(['ReceiptHandleIsInvalid', 'AccessDeniedException', 'TimeoutError'])(
    'retains the original delivery when visibility scheduling rejects with %s',
    async (name) => {
      const f = fixture();
      f.changeMessageVisibility.mockRejectedValueOnce(
        Object.assign(new Error('private'), { name }),
      );
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).toHaveBeenCalledTimes(1);
      expect(f.logs()[0].outcome).toBe('unconfirmed');
    },
  );

  it('does not log receipt handles, bodies or scheduling exceptions', async () => {
    const logs = ['log', 'info', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const f = fixture();
    f.changeMessageVisibility.mockRejectedValueOnce(
      new Error(`${f.record.receiptHandle} ${f.record.body}`),
    );
    expect(await f.run()).toEqual(RETRY);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(f.logs()).toEqual([
      {
        event: 'native_runtime_readiness_scheduling',
        scopeHash: SCOPE_HASH,
        phase: 'runtime',
        outcome: 'unconfirmed',
        receiveCount: 1,
        delaySeconds: 5,
      },
    ]);
    const text = f.logger.info.mock.calls[0][0];
    expect(text).not.toContain(f.record.receiptHandle);
    expect(text).not.toContain(f.record.body);
    expect(text).not.toContain(POINTER.projectId);
    expect(text).not.toContain(POINTER.executionId);
  });
});

describe('readiness metadata and queue boundary', () => {
  it.each([undefined, '', '0', '-1', '1.5', '01', ' 1', '1e2', 1, '9007199254740992'])(
    'falls back without changing visibility for invalid receive count %j',
    async (count) => {
      const f = fixture();
      f.record.attributes.ApproximateReceiveCount = count;
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).not.toHaveBeenCalled();
      expect(f.logs()[0]).toMatchObject({ outcome: 'skipped', phase: 'runtime' });
      expect(f.logs()[0]).not.toHaveProperty('receiveCount');
      expect(f.logs()[0]).not.toHaveProperty('delaySeconds');
    },
  );

  it.each([undefined, '', ' receipt ', 'receipt\nsecret', 'x'.repeat(4097)])(
    'falls back for an unusable receipt handle (case %#)',
    async (receipt) => {
      const f = fixture();
      f.record.receiptHandle = receipt;
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).not.toHaveBeenCalled();
      expect(f.logs()[0]).toMatchObject({ outcome: 'skipped', receiveCount: 1 });
    },
  );

  it.each([
    ['eventSourceARN', undefined],
    ['eventSourceARN', `${QUEUE_ARN}-other`],
    ['eventSourceARN', QUEUE_ARN.replace('746558295630', '111111111111')],
    ['eventSourceARN', QUEUE_ARN.replace('us-east-1', 'us-west-2')],
    ['eventSourceARN', QUEUE_ARN.replace('arn:aws:', 'arn:aws-cn:')],
    ['awsRegion', 'us-west-2'],
  ])('does not schedule a mismatched delivery %s=%j', async (field, value) => {
    const f = fixture();
    f.record[field] = value;
    expect(await f.run()).toEqual(RETRY);
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
  });

  it.each([
    ['NATIVE_RUNTIME_QUEUE_URL', undefined],
    ['NATIVE_RUNTIME_QUEUE_URL', QUEUE_URL.replace('https:', 'http:')],
    ['NATIVE_RUNTIME_QUEUE_URL', `${QUEUE_URL}?redirect=other`],
    ['NATIVE_RUNTIME_QUEUE_URL', QUEUE_URL.replace('amazonaws.com/', 'amazonaws.com.attacker/')],
    ['NATIVE_RUNTIME_QUEUE_URL', QUEUE_URL.replace('746558295630', '111111111111')],
    ['NATIVE_RUNTIME_ACCOUNT_ID', '111111111111'],
    ['AWS_REGION', 'us-west-2'],
    ['AWS_PARTITION', 'invalid'],
  ])('falls back safely for invalid scheduling configuration %s', async (field, value) => {
    const f = fixture();
    f.env[field] = value;
    expect(await f.run()).toEqual(RETRY);
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
  });

  it('does not accept queue or receipt overrides through the message body', async () => {
    const f = fixture();
    f.record.body = JSON.stringify({ ...POINTER, QueueUrl: QUEUE_URL, receiptHandle: 'forged' });
    expect(await f.run()).toEqual(RETRY);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
  });
});

describe('readiness backoff and bounded scheduling', () => {
  it.each([
    ['1', 5],
    ['2', 10],
    ['3', 20],
    ['4', 30],
    ['100', 30],
    ['9007199254740991', 30],
  ])('uses backoff %s -> %i seconds without jitter', async (count, delay) => {
    const f = fixture();
    f.record.attributes.ApproximateReceiveCount = count;
    expect(await f.run()).toEqual(RETRY);
    expect(f.changeMessageVisibility.mock.calls[0][0].VisibilityTimeout).toBe(delay);
  });

  it('bounds jitter to two extra seconds and caps every wait at thirty seconds', async () => {
    const f = fixture();
    for (const [count, min, max] of [
      ['1', 5, 7],
      ['2', 10, 12],
      ['3', 20, 22],
      ['4', 30, 30],
    ]) {
      for (const sample of [0, 0.25, 0.5, 0.999999]) {
        f.record.attributes.ApproximateReceiveCount = count;
        f.random.mockReturnValue(sample);
        expect(await f.run()).toEqual(RETRY);
        const delay = f.changeMessageVisibility.mock.lastCall[0].VisibilityTimeout;
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(min);
        expect(delay).toBeLessThanOrEqual(max);
      }
    }
  });

  it.each([NaN, -0.1, 1, Infinity])(
    'falls back for an invalid jitter sample %s',
    async (sample) => {
      const f = fixture();
      f.random.mockReturnValue(sample);
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).not.toHaveBeenCalled();
    },
  );

  it('does not consume the 100-receive redrive allowance within the ten-minute role grace', async () => {
    const f = fixture();
    let scheduledSeconds = 0;
    // An otherwise healthy sequential delivery stream, using minimum jitter.
    // Duplicate deliveries and AWS scheduling are separate live qualifications.
    for (let count = 1; count < 100; count += 1) {
      f.record.attributes.ApproximateReceiveCount = String(count);
      f.record.receiptHandle = `delivery-${count}`;
      expect(await f.run()).toEqual(RETRY);
      const input = f.changeMessageVisibility.mock.lastCall[0];
      expect(input.ReceiptHandle).toBe(`delivery-${count}`);
      scheduledSeconds += input.VisibilityTimeout;
    }
    expect(scheduledSeconds).toBeGreaterThan(600);
    expect(f.changeMessageVisibility).toHaveBeenCalledTimes(99);
  });

  it.each([undefined, NaN, Infinity, -1, 0, 2999])(
    'does not schedule without a finite remaining budget of at least three seconds: %s',
    async (remaining) => {
      const f = fixture();
      f.context.getRemainingTimeInMillis.mockReturnValue(remaining);
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).not.toHaveBeenCalled();
    },
  );

  it('checks remaining time after reconciliation rather than using its starting budget', async () => {
    const f = fixture();
    f.reconcile.mockImplementation(async (_pointer, { remainingMs }) => {
      expect(remainingMs()).toBe(25_000);
      f.context.getRemainingTimeInMillis.mockReturnValue(1000);
      return { status: 'waiting', phase: 'endpoint' };
    });
    expect(await f.run()).toEqual(RETRY);
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
  });

  it('aborts and returns within one second even if the scheduling port never settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.context.getRemainingTimeInMillis.mockReturnValue(3000);
    let rejectLate;
    f.changeMessageVisibility.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
    );
    const invocation = f.run();
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.changeMessageVisibility.mock.calls[0][1].abortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await invocation).toEqual(RETRY);
    expect(signal.aborted).toBe(true);
    expect(f.logs()).toEqual([
      expect.objectContaining({ outcome: 'unconfirmed', receiveCount: 1, delaySeconds: 5 }),
    ]);
    expect(f.logs()[0]).not.toHaveProperty('httpStatus');
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.changeMessageVisibility).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error('Late ambiguous failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.logger.info).toHaveBeenCalledTimes(1);
  });

  it('clears its deadline timer after a prompt scheduling acknowledgement', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(await f.run()).toEqual(RETRY);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sanitized scheduling outcomes', () => {
  it.each(['response', 'exception'])('sanitizes selected AWS metadata from a %s', async (kind) => {
    const f = fixture();
    const requestId = '736b25e1-e38f-4ef5-9f57-dbe1868f271c';
    const privateText = `${f.record.receiptHandle} ${f.record.body}`;
    const value = {
      name: privateText,
      message: privateText,
      code: privateText,
      $metadata: {
        httpStatusCode: kind === 'response' ? 200 : 503,
        requestId,
        credentials: privateText,
      },
      receiptHandle: privateText,
      body: privateText,
    };
    if (kind === 'response') f.changeMessageVisibility.mockResolvedValueOnce(value);
    else f.changeMessageVisibility.mockRejectedValueOnce(value);
    expect(await f.run()).toEqual(RETRY);
    expect(f.logs()).toEqual([
      {
        event: 'native_runtime_readiness_scheduling',
        scopeHash: SCOPE_HASH,
        phase: 'runtime',
        outcome: kind === 'response' ? 'scheduled' : 'unconfirmed',
        receiveCount: 1,
        delaySeconds: 5,
        httpStatus: kind === 'response' ? 200 : 503,
        requestId,
      },
    ]);
    expect(f.logger.info.mock.calls[0][0]).not.toContain(privateText);
  });

  it('omits malformed AWS metadata and never treats a string status as confirmed success', async () => {
    const f = fixture();
    f.changeMessageVisibility.mockResolvedValueOnce({
      $metadata: { httpStatusCode: '200', requestId: f.record.receiptHandle },
    });
    expect(await f.run()).toEqual(RETRY);
    expect(f.logs()[0]).toMatchObject({ outcome: 'unconfirmed' });
    expect(f.logs()[0]).not.toHaveProperty('httpStatus');
    expect(f.logs()[0]).not.toHaveProperty('requestId');
    expect(f.logger.info.mock.calls[0][0]).not.toContain(f.record.receiptHandle);
  });

  it('reports a skipped attempt with a selected delay when the return budget is too small', async () => {
    const f = fixture();
    f.record.attributes.ApproximateReceiveCount = '3';
    f.context.getRemainingTimeInMillis.mockReturnValue(2999);
    expect(await f.run()).toEqual(RETRY);
    expect(f.logs()).toEqual([
      {
        event: 'native_runtime_readiness_scheduling',
        scopeHash: SCOPE_HASH,
        phase: 'runtime',
        outcome: 'skipped',
        receiveCount: 3,
        delaySeconds: 20,
      },
    ]);
    expect(f.changeMessageVisibility).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'])(
    'does not change delivery handling if the log sink can %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'throw')
        f.logger.info.mockImplementation(() => {
          throw new Error('private logging failure');
        });
      else f.logger.info.mockRejectedValue(new Error('private logging failure'));
      expect(await f.run()).toEqual(RETRY);
      expect(f.changeMessageVisibility).toHaveBeenCalledTimes(1);
      expect(f.logger.info).toHaveBeenCalledTimes(1);
    },
  );
});
