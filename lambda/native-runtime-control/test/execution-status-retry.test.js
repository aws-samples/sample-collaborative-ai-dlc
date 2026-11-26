import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  createNativeExecutionSupervisor,
  invokeNativeExecutionRuntime,
  readNativeRuntimeReport,
} from '../execution-worker.js';
import { createNativeExecutionDiagnostics } from '../execution-diagnostics.js';
import { executionIdentity } from '../execution-runtime.js';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';

const SECRET = 'status-retry-private-prompt-token-error-canary';
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

// The real SDK/HTTP reader, protected CAS store and immutable publication codecs
// are composed here. Only the local server stands in for AWS and the harness.
const fixture = async ({ raw = false } = {}) => {
  const f = serialFixture();
  await f.start();
  const commands = [];
  const steps = [];
  const lines = [];
  const diagnostics = createNativeExecutionDiagnostics({
    scope: f.identity,
    logger: { info: (line) => lines.push(line) },
  });
  let activeSequence = 1;
  let activeRequest;
  let published;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    commands.push(payload);
    if (['native-start', 'native-continue'].includes(payload.command)) {
      activeSequence = payload.sequence;
      activeRequest = payload.requestId;
      published = undefined;
    }
    const step = steps[0]?.command === payload.command ? steps.shift() : {};
    await step.before?.();
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (step.kind === 'sdk-owner')
      return send(
        409,
        { ok: false, code: step.code, message: SECRET },
        step.header ? { 'x-amzn-errortype': step.header } : {},
      );
    if (['sdk-409', 'sdk-untyped'].includes(step.kind))
      return send(
        409,
        { message: `${SECRET} native_execution_existing_owner`, code: SECRET },
        step.kind === 'sdk-409' ? { 'x-amzn-errortype': 'RuntimeClientError' } : {},
      );
    if (step.kind === 'http-503')
      return send(
        503,
        { message: SECRET, code: SECRET },
        { 'x-amzn-errortype': 'ServiceUnavailableException' },
      );
    if (step.kind === 'reset') return req.socket.destroy();
    if (step.kind === 'truncated') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 10000 });
      res.write(`{"private":"${SECRET}`);
      return setImmediate(() => res.destroy());
    }
    if (step.kind === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`{"private":"${SECRET}`);
    }
    if (step.kind === 'wrong-content') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(SECRET);
    }
    if (step.kind === 'oversized') return send(200, { [SECRET]: 'x'.repeat(270000) });
    if (step.kind === 'owner')
      return send(409, { ok: false, code: 'native_execution_owner_conflict', message: SECRET });
    if (step.kind === 'scope')
      return send(400, { ok: false, code: 'native_execution_scope_mismatch', message: SECRET });
    if (step.kind === 'publication') published = await f.turn(activeSequence);
    const report = {
      ...executionIdentity(f.row()),
      writerGeneration: 1,
      sequence: activeSequence,
      ...(activeRequest ? { requestId: activeRequest } : {}),
      status: published ? 'publication_ready' : 'running',
      recovered: false,
      ...(published
        ? {
            nativeSessionId: published.receipt.nativeSessionId,
            receipt: published.receipt,
            interaction: published.interactionReceipt,
          }
        : {}),
      private: SECRET,
    };
    if (step.kind === 'cold') {
      report.recovered = true;
      report.status = 'failed';
      report.code = 'native_execution_existing_owner';
    }
    if (step.kind === 'identity') report.bindingId = SECRET;
    if (step.kind === 'sequence') report.sequence++;
    if (step.kind === 'generation') report.writerGeneration++;
    send(200, report);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const runtime = new BedrockAgentCoreClient({
    endpoint: url,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local-only', secretAccessKey: SECRET },
    maxAttempts: 1,
  });
  cleanup.push(async () => {
    runtime.destroy();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    diagnostics,
    authorize: vi.fn(async () => {}),
    upgrade: vi.fn(async ({ execution }) => ({ ready: true, target: f.target(execution) })),
    credentials: vi.fn(async (execution) => ({
      ok: true,
      ...executionIdentity(execution),
      model: { provider: 'bedrock', value: SECRET },
      git: { username: 'git', password: SECRET },
      source: SERIAL_SOURCE,
    })),
    publications: f.publications,
    interactions: f.interactions,
    project: vi.fn(async () => {}),
    fence: {
      ensureActive: vi.fn(async () => {}),
      suspend: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    },
    stop: vi.fn(async ({ execution }) => ({
      confirmed: true,
      runtimeSessionId: execution.runtimeSessionId,
    })),
    invoke: vi.fn(async (input) => {
      if (!raw) return invokeNativeExecutionRuntime({ runtime, diagnostics, ...input });
      // Exercise a parsed non-200 runtime response as well as SDK-thrown errors.
      const body = await new Promise((resolve, reject) => {
        request(url, { method: 'POST' }, resolve)
          .on('error', reject)
          .end(JSON.stringify(input.payload));
      });
      return readNativeRuntimeReport(
        { contentType: body.headers['content-type'], statusCode: body.statusCode, response: body },
        { diagnostics, phase: input.payload.command.slice('native-'.length) },
      );
    }),
  };
  const run = createNativeExecutionSupervisor(ports);
  const dispatch = async () => {
    for (let i = 0; i < 4; i++) await run(f.identity);
  };
  const next = (kind, command = 'native-status', before, options = {}) =>
    steps.push({ kind, command, before, ...options });
  const events = () => lines.map((line) => JSON.parse(line));
  const unchangedWriter = (before) => {
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      attemptId: before.attemptId,
      runtimeSessionId: before.runtimeSessionId,
      writerGeneration: before.writerGeneration,
      epoch: before.epoch,
      target: before.target,
      dispatch: before.dispatch,
    });
    expect(f.row().leaseToken).toBeUndefined();
    expect(f.row().recovery).toBeUndefined();
    expect(ports.fence.suspend).not.toHaveBeenCalled();
    expect(ports.fence.cancel).not.toHaveBeenCalled();
    expect(ports.stop).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(commands.filter((p) => p.command === 'native-start')).toHaveLength(1);
  };
  return { ...f, ports, run, dispatch, next, commands, events, unchangedWriter };
};

describe('acknowledged native turns retry only unconfirmed status reads', () => {
  it.each([
    ['sdk-409', 'SDK_FAILURE', false],
    ['sdk-untyped', 'SDK_FAILURE', false],
    ['http-503', 'SDK_FAILURE', false],
    ['http-503', 'HTTP_NON_200', true],
    ['truncated', 'BODY_READ_FAILED', false],
    ['bad-json', 'BODY_JSON_INVALID', false],
    ['oversized', 'BODY_TOO_LARGE', false],
    ['wrong-content', 'CONTENT_TYPE_INVALID', false],
    ['reset', 'SDK_FAILURE', false],
  ])(
    'retries %s (%s), then reads a healthy report and publication',
    async (kind, category, raw) => {
      const f = await fixture({ raw });
      await f.dispatch();
      const before = f.row();
      const credentialsRead = f.ports.credentials.mock.calls.length;
      f.next(kind);
      expect(await f.run(f.identity)).toEqual({ pending: true, status: 'RUNNING' });
      f.unchangedWriter(before);
      expect(f.events().at(-1)).toMatchObject({
        phase: 'status',
        stage: 'decision',
        code: 'STATUS_READ_RETRY',
        failureClass: category,
      });
      expect(await f.run(f.identity)).toEqual({ pending: true, status: 'RUNNING' });
      f.unchangedWriter(before);
      f.next('publication');
      expect(await f.run(f.identity)).toEqual({ pending: true, status: 'AWAITING_USER' });
      expect(f.row().publication.sequence).toBe(1);
      expect(f.ports.credentials).toHaveBeenCalledTimes(credentialsRead);
      expect(f.commands.map((p) => p.command)).toEqual([
        'native-start',
        'native-status',
        'native-status',
        'native-status',
      ]);
    },
  );

  it('has no retry count or model-age cutoff and never reissues a model command', async () => {
    const f = await fixture();
    await f.dispatch();
    const before = f.row();
    for (let i = 0; i < 12; i++) {
      f.tick(24 * 60 * 60 * 1000);
      f.next('sdk-409');
      expect(await f.run(f.identity)).toEqual({ pending: true, status: 'RUNNING' });
      f.unchangedWriter(before);
    }
    expect(await f.run(f.identity)).toEqual({ pending: true, status: 'RUNNING' });
    expect(f.commands.filter((p) => p.command !== 'native-status')).toHaveLength(1);
  });

  it.each(['owner', 'scope', 'identity', 'sequence', 'generation', 'cold'])(
    'requires recovery for confirmed %s after an unconfirmed read',
    async (kind) => {
      const f = await fixture({ raw: true });
      await f.dispatch();
      f.next('http-503');
      await f.run(f.identity);
      expect(f.ports.stop).not.toHaveBeenCalled();
      f.next(kind);
      expect(await f.run(f.identity)).toMatchObject({
        pending: false,
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(f.ports.fence.suspend).toHaveBeenCalledOnce();
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(f.commands.filter((p) => p.command === 'native-start')).toHaveLength(1);
    },
  );

  it.each(
    [
      'native_execution_existing_owner',
      'native_execution_owner_conflict',
      'native_execution_reply_conflict',
      'native_execution_local_record_unavailable',
      'native_execution_reply_admission_unconfirmed',
      'native_execution_scope_mismatch',
      'native_execution_owner_invalid',
      'native_execution_local_record_invalid',
      'native_execution_cancelled',
    ].flatMap((code) => [undefined, 'RuntimeClientError'].map((header) => ({ code, header }))),
  )(
    'durably gates real SDK structured rejection $code with header $header',
    async ({ code, header }) => {
      const f = await fixture();
      await f.dispatch();
      const before = f.row();
      const authorityChecks = f.ports.authorize.mock.calls.length;
      f.next('sdk-owner', 'native-status', undefined, { code, header });
      expect(await f.run(f.identity)).toMatchObject({
        pending: false,
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      const sdkError = await f.ports.invoke.mock.results.at(-1).value.catch((error) => error);
      expect(sdkError).toMatchObject({
        name: header ?? code,
        code,
        $metadata: { httpStatusCode: 409 },
      });
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: false },
        attemptId: before.attemptId,
        runtimeSessionId: before.runtimeSessionId,
        epoch: before.epoch,
        dispatch: before.dispatch,
      });
      expect(f.row().leaseToken).toBeUndefined();
      expect(f.ports.authorize.mock.calls.length).toBeGreaterThan(authorityChecks);
      expect(f.ports.fence.suspend).toHaveBeenCalledOnce();
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(f.ports.fence.cancel).not.toHaveBeenCalled();
      expect(f.commands.map((p) => p.command)).toEqual(['native-start', 'native-status']);
      expect(f.events().some((e) => e.code === 'STATUS_READ_RETRY')).toBe(false);
      expect(f.events().at(-1)).toMatchObject({
        code: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
        errorCode: code,
      });
      expect(JSON.stringify(f.events())).not.toContain(SECRET);
      expect(JSON.stringify(f.row())).not.toContain(SECRET);
    },
  );

  it('keeps an ambiguous initial Start behind the delivery guard', async () => {
    const f = await fixture();
    f.next('sdk-409', 'native-start');
    await f.dispatch();
    expect(f.row()).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: false },
      dispatch: { sequence: 1 },
    });
    expect(f.ports.stop).toHaveBeenCalledOnce();
    expect(f.commands.map((p) => p.command)).toEqual(['native-start']);
    expect(f.events().some((e) => e.code === 'STATUS_READ_RETRY')).toBe(false);
  });

  it.each(['preflight', 'continue'])(
    'preserves the DISPATCHING %s guard after a real accepted reply',
    async (phase) => {
      const f = await fixture();
      await f.dispatch();
      f.next('publication');
      await f.run(f.identity);
      await f.run(f.identity);
      await f.respond();
      f.next('sdk-409', phase === 'preflight' ? 'native-status' : 'native-continue');
      await f.run(f.identity);
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: {
          reason: phase === 'preflight' ? 'CHECKPOINT_UNAVAILABLE' : 'DELIVERY_UNCERTAIN',
          canRecover: false,
        },
      });
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(f.commands.filter((p) => p.command === 'native-start')).toHaveLength(1);
      expect(f.commands.filter((p) => p.command === 'native-continue')).toHaveLength(
        phase === 'preflight' ? 0 : 1,
      );
      expect(f.events().some((e) => e.code === 'STATUS_READ_RETRY')).toBe(false);
    },
  );

  it('retries only status after an acknowledged Continue without resending the accepted reply', async () => {
    const f = await fixture();
    await f.dispatch();
    f.next('publication');
    await f.run(f.identity);
    await f.run(f.identity);
    await f.respond();
    await f.run(f.identity);
    const before = f.row();
    expect(before).toMatchObject({
      status: 'RUNNING',
      turnSequence: 2,
      response: { deliveryStatus: 'delivered' },
    });
    f.next('sdk-409');
    await f.run(f.identity);
    f.unchangedWriter(before);
    await f.run(f.identity);
    expect(f.row().response).toEqual(before.response);
    expect(f.commands.filter((p) => p.command === 'native-continue')).toHaveLength(1);
  });

  it.each(['sdk-409', 'sdk-owner'])(
    'lets cancellation during %s win before retry or recovery',
    async (kind) => {
      const f = await fixture();
      await f.dispatch();
      f.next(kind, 'native-status', () => f.store.cancel(f.bindingIdentity), {
        code: 'native_execution_scope_mismatch',
      });
      await expect(f.run(f.identity)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_LEASE_LOST',
      });
      expect(f.row().status).toBe('CANCEL_REQUESTED');
      expect(f.ports.fence.suspend).not.toHaveBeenCalled();
      const count = f.commands.length;
      expect(await f.run(f.identity)).toEqual({ pending: false, status: 'CANCELLED' });
      expect(f.commands).toHaveLength(count);
      expect(f.ports.fence.cancel).toHaveBeenCalledOnce();
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(f.events().some((e) => e.code === 'STATUS_READ_RETRY')).toBe(false);
    },
  );

  it.each([
    ['membership', 'NATIVE_EXECUTION_FORBIDDEN', 'native_execution_access_denied', 'sdk-409'],
    ['configuration', 'WORKFLOW_SOURCE_CONFLICT', 'native_execution_source_changed', 'sdk-409'],
    ['membership', 'NATIVE_EXECUTION_FORBIDDEN', 'native_execution_access_denied', 'sdk-owner'],
    ['configuration', 'WORKFLOW_SOURCE_CONFLICT', 'native_execution_source_changed', 'sdk-owner'],
  ])(
    'lets %s revocation during a failed read win over retry',
    async (_label, code, failureCode, kind) => {
      const f = await fixture();
      await f.dispatch();
      f.next(
        kind,
        'native-status',
        () => {
          f.ports.authorize.mockRejectedValue(Object.assign(new Error(SECRET), { code }));
        },
        { code: 'native_execution_scope_mismatch' },
      );
      expect(await f.run(f.identity)).toMatchObject({
        pending: false,
        status: 'FAILED',
        failureCode,
      });
      expect(f.ports.fence.cancel).toHaveBeenCalledOnce();
      expect(f.ports.fence.suspend).not.toHaveBeenCalled();
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(f.events().some((e) => e.code === 'STATUS_READ_RETRY')).toBe(false);
    },
  );
});
