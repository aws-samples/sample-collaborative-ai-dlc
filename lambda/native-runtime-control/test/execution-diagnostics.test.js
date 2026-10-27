import { recordNativeBoundary } from '../../shared/native-lifecycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  createNativeExecutionDiagnostics,
  emitNativeExecutionDiagnostic,
  nativeDiagnosticError,
  nativeDiagnosticReport,
} from '../execution-diagnostics.js';
import {
  createNativeExecutionSupervisor,
  invokeNativeExecutionRuntime,
  readNativeRuntimeReport,
} from '../execution-worker.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';

const CANARY = 'secret-canary-prompt-model-token-session-content-DO-NOT-LOG';

it('emits only bounded numeric CLI timing fields without evaluating getters', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    recordNativeBoundary({}, 'harnessUsageObserved', 100, {
      durationMs: 300,
      durationApiMs: 200,
      numTurns: 2,
      prompt: CANARY,
    });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      type: 'native.lifecycle',
      boundary: 'harnessUsageObserved',
      at: 100,
      durationMs: 300,
      durationApiMs: 200,
      numTurns: 2,
    });
    recordNativeBoundary({}, 'harnessUsageObserved', 101, {
      get durationMs() {
        throw Error(CANARY);
      },
      durationApiMs: 86400001,
      numTurns: -1,
    });
    expect(JSON.parse(log.mock.calls[1][0])).toEqual({
      type: 'native.lifecycle',
      boundary: 'harnessUsageObserved',
      at: 101,
    });
  } finally {
    log.mockRestore();
  }
});
const REQUEST_ID = 'a4444444-4444-4444-8444-444444444444';
const scope = {
  projectId: 'diagnostic-project',
  executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const identity = {
  ...scope,
  bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  runtimeSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  epoch: 1,
};
const row = {
  ...identity,
  scope,
  writerGeneration: 1,
  target: {
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/native_test-abcdefghijkl',
    endpoint: 'exec_test',
  },
};
const sinks = () => {
  const lines = [];
  const logger = { info: vi.fn((line) => lines.push(line)) };
  const diagnostics = createNativeExecutionDiagnostics({ logger, scope });
  return {
    logger,
    diagnostics,
    lines,
    events: () => lines.map((line) => JSON.parse(line)),
    assertPrivate: () => {
      expect(lines.join('\n')).not.toContain(CANARY);
      expect(lines.join('\n')).not.toContain(identity.runtimeSessionId);
      expect(lines.join('\n')).not.toContain(scope.projectId);
      for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThan(2048);
    },
  };
};
const servers = [];
const clients = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
});
const endpoint = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const sdk = (url) => {
  const client = new BedrockAgentCoreClient({
    endpoint: url,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local-test-key', secretAccessKey: CANARY },
    maxAttempts: 1,
  });
  clients.push(client);
  return client;
};
const payload = {
  command: 'native-status',
  ...identity,
  writerGeneration: 1,
  untrusted: CANARY,
};

describe('native controller diagnostic privacy boundary', () => {
  it.each(['INTAKE_UNAVAILABLE', 'WORKFLOW_STATE_UNAVAILABLE'])(
    'records recovery reason %s without leaking raw workflow data or invoking getters',
    (reason) => {
      const s = sinks();
      const getter = vi.fn(() => {
        throw Error(CANARY);
      });
      s.diagnostics({
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason,
        workflowResumeState: CANARY,
        request: CANARY,
        get stateFile() {
          return getter();
        },
      });
      expect(s.events()[0]).toMatchObject({
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason,
      });
      expect(s.events()[0].workflowResumeState).toBeUndefined();
      s.diagnostics({ reason: CANARY });
      expect(s.events()[1].reason).toBe('unknown');
      s.diagnostics(Object.defineProperty({}, 'reason', { get: getter }));
      expect(s.events()[2].reason).toBeUndefined();
      expect(getter).not.toHaveBeenCalled();
      s.assertPrivate();
    },
  );

  it('preserves bounded output rejection evidence through runtime, mapper, sink and lifecycle', () => {
    const s = sinks();
    const getter = vi.fn(() => {
      throw new Error(CANARY);
    });
    const diagnostic = {
      reason: 'result_mismatch',
      recordType: 'result',
      recordIndex: 41,
      queries: 2,
      messages: 8,
      textBytes: 1200,
      resultBytes: 250,
      rawFrame: CANARY,
      get prompt() {
        return getter();
      },
    };
    const expected = {
      reason: 'result_mismatch',
      recordType: 'result',
      recordIndex: 41,
      queries: 2,
      messages: 8,
      textBytes: 1200,
      resultBytes: 250,
    };
    s.diagnostics({
      ...nativeDiagnosticReport(row, {
        ...identity,
        status: 'failed',
        code: 'native_execution_output_result',
        outputDiagnostic: diagnostic,
      }),
      phase: 'status',
      stage: 'report',
      code: 'REPORT_OBSERVED',
    });
    expect(s.events()[0]).toMatchObject({
      runtimeCode: 'native_execution_output_result',
      outputDiagnostic: expected,
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      recordNativeBoundary({}, 'outputRejected', 100, diagnostic);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({
        type: 'native.lifecycle',
        boundary: 'outputRejected',
        at: 100,
        ...expected,
      });
      s.diagnostics({
        outputDiagnostic: {
          reason: 'result_empty',
          recordType: CANARY,
          queries: Infinity,
          get messages() {
            return getter();
          },
        },
      });
      expect(s.events()[1].outputDiagnostic).toEqual({ reason: 'result_empty' });
      expect(getter).not.toHaveBeenCalled();
      s.assertPrivate();
    } finally {
      log.mockRestore();
    }
  });
  it('retains bounded snapshot evidence through runtime, lifecycle and controller sinks', () => {
    const s = sinks();
    const getter = vi.fn(() => {
      throw new Error(CANARY);
    });
    const expected = {
      reason: 'symbolic_link',
      phase: 'final',
      pathClass: 'dependency_bin',
      pathSha256: 'a'.repeat(64),
      pathDepth: 3,
      entries: 42,
      files: 9,
      bytes: 1200,
    };
    const diagnostic = {
      ...expected,
      path: CANARY,
      target: CANARY,
      get prompt() {
        return getter();
      },
    };
    s.diagnostics({
      ...nativeDiagnosticReport(row, {
        ...identity,
        status: 'failed',
        code: 'native_snapshot_link',
        snapshotDiagnostic: diagnostic,
      }),
      phase: 'status',
      stage: 'report',
      code: 'REPORT_OBSERVED',
    });
    expect(s.events()[0]).toMatchObject({
      runtimeCode: 'native_snapshot_link',
      snapshotDiagnostic: expected,
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      recordNativeBoundary({}, 'snapshotRejected', 100, diagnostic);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({
        type: 'native.lifecycle',
        boundary: 'snapshotRejected',
        at: 100,
        ...expected,
      });
      const hostile = {
        reason: 'symbolic_link',
        phase: CANARY,
        pathClass: CANARY,
        pathSha256: CANARY,
        pathDepth: -1,
        entries: Infinity,
        files: 2 ** 40,
        get bytes() {
          return getter();
        },
      };
      s.diagnostics({ snapshotDiagnostic: hostile });
      recordNativeBoundary({}, 'snapshotRejected', 101, hostile);
      expect(s.events()[1].snapshotDiagnostic).toEqual({ reason: 'symbolic_link' });
      expect(JSON.parse(log.mock.calls[1][0])).toEqual({
        type: 'native.lifecycle',
        boundary: 'snapshotRejected',
        at: 101,
        reason: 'symbolic_link',
      });
      s.diagnostics({ snapshotDiagnostic: { reason: CANARY } });
      s.diagnostics({
        snapshotDiagnostic: {
          get reason() {
            return getter();
          },
        },
      });
      expect(s.events()[2].snapshotDiagnostic).toBeUndefined();
      expect(s.events()[3].snapshotDiagnostic).toBeUndefined();
      expect(getter).not.toHaveBeenCalled();
      s.assertPrivate();
    } finally {
      log.mockRestore();
    }
  });
  it.each([
    'native_recovery_home_path_invalid',
    'native_recovery_session_id_mismatch',
    'native_recovery_session_cwd_invalid',
    'native_execution_question_spec_invalid',
    'native_execution_question_spec_unsafe',
    'native_recovery_adapter_failed',
    'native_recovery_cancelled',
    'native_recovery_time_failed',
    'native_snapshot_changed',
  ])('retains %s through both the runtime report mapper and diagnostic sink', (code) => {
    const s = sinks();
    s.diagnostics({
      ...nativeDiagnosticReport(row, { ...identity, status: 'failed', code }),
      phase: 'status',
      stage: 'report',
      code: 'REPORT_OBSERVED',
    });
    expect(s.events()[0].runtimeCode).toBe(code);
    s.assertPrivate();
  });

  it('retains a safe restore cause without serializing the recovery error', () => {
    const s = sinks();
    s.diagnostics({
      ...nativeDiagnosticReport(row, {
        ...identity,
        status: 'stopped_needs_review',
        code: 'native_execution_recovery_failed',
        recoveryFailureCode: 'native_recovery_time_failed',
        message: CANARY,
      }),
      phase: 'recover',
      stage: 'report',
      code: 'REPORT_OBSERVED',
    });
    expect(s.events()[0]).toMatchObject({
      runtimeCode: 'native_execution_recovery_failed',
      recoveryFailureCode: 'native_recovery_time_failed',
    });
    s.assertPrivate();
  });

  it.each([
    ['legacy both absent', undefined, undefined, []],
    ['legacy accepts generation one', undefined, 1, []],
    ['legacy rejects generation two', undefined, 2, ['writerGeneration']],
    ['explicit generation requires echo', 1, undefined, ['writerGeneration']],
  ])(
    'matches identity validation for %s',
    (_label, storedGeneration, reportedGeneration, mismatches) => {
      const s = sinks();
      s.diagnostics({
        ...nativeDiagnosticReport(
          { ...row, writerGeneration: storedGeneration },
          { ...identity, writerGeneration: reportedGeneration, sequence: 1, status: 'preparing' },
        ),
        phase: 'status',
        stage: 'report',
        code: 'REPORT_OBSERVED',
      });
      expect(s.events()[0].identityMismatches).toEqual(mismatches);
      expect(s.events()[0].expectedWriterGeneration).toBe(1);
      s.assertPrivate();
    },
  );

  it('logs only closed enums and bounded primitives, with field-name-only identity mismatch', () => {
    const s = sinks();
    const report = {
      ...identity,
      runtimeSessionId: CANARY,
      epoch: 999,
      writerGeneration: 2,
      sequence: 9,
      status: 'failed',
      code: 'native_execution_initialization_unverified',
      recovered: false,
      message: CANARY,
      initializationChecks: [{ id: CANARY }],
      arbitrary: { credentials: CANARY },
    };
    s.diagnostics({
      ...nativeDiagnosticReport(row, report),
      phase: 'status',
      stage: 'report',
      code: 'REPORT_OBSERVED',
      message: CANARY,
      stack: CANARY,
      body: report,
    });
    expect(s.events()[0]).toMatchObject({
      event: 'native_execution_diagnostic',
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'failed',
      runtimeCode: 'native_execution_initialization_unverified',
      sequence: 9,
      expectedSequence: 1,
      sequenceMatches: false,
      recovered: false,
      recoveredPresent: true,
      identityMismatches: ['epoch', 'runtimeSessionId', 'writerGeneration'],
    });
    s.assertPrivate();
  });

  it.each([
    'invalid',
    'failed',
    'incomplete',
    'terminal',
    'session',
    'credential',
    'limit',
    'json',
    'utf8',
    'shape',
    'text',
    'result',
  ])('reports the harness output failure code native_execution_output_%s', (suffix) => {
    const s = sinks();
    s.diagnostics({
      phase: 'status',
      stage: 'report',
      code: 'REPORT_OBSERVED',
      runtimeCode: `native_execution_output_${suffix}`,
    });
    expect(s.events()[0]).toMatchObject({ runtimeCode: `native_execution_output_${suffix}` });
  });

  it('never coerces untrusted values or evaluates diagnostic getters', () => {
    const s = sinks();
    const getter = vi.fn(() => {
      throw new Error(CANARY);
    });
    const coercion = { toString: getter, toJSON: getter };
    const error = Object.defineProperties(new Error(CANARY), {
      name: { get: getter },
      $metadata: { get: getter },
    });
    const input = {
      phase: CANARY,
      stage: coercion,
      code: CANARY,
      status: [CANARY],
      runtimeCode: `native_execution_${CANARY}`,
      failureClass: CANARY,
      sequence: Infinity,
      writerGeneration: 2 ** 53,
      httpStatus: CANARY,
      awsRequestId: CANARY,
      identityMismatches: [CANARY, 'epoch', 'epoch'],
      ...nativeDiagnosticError(error),
    };
    s.diagnostics(input);
    expect(s.events()[0]).toMatchObject({
      phase: 'unknown',
      stage: 'unknown',
      code: 'unknown',
      status: 'unknown',
      runtimeCode: 'unknown',
      failureClass: 'unknown',
      errorName: 'unknown',
      identityMismatches: ['epoch'],
    });
    expect(s.events()[0]).not.toHaveProperty('sequence');
    expect(s.events()[0]).not.toHaveProperty('httpStatus');
    expect(s.events()[0]).not.toHaveProperty('awsRequestId');
    expect(getter).not.toHaveBeenCalled();
    s.assertPrivate();
  });

  it('ignores logger/sink failures and bounds oversized mismatch arrays', () => {
    const s = sinks();
    const fields = Array(10_000_000);
    fields[0] = 'bindingId';
    fields[9_999_999] = CANARY;
    s.diagnostics({ identityMismatches: fields });
    expect(s.events()[0].identityMismatches).toEqual(['bindingId']);
    expect(() =>
      emitNativeExecutionDiagnostic(() => {
        throw new Error(CANARY);
      }, {}),
    ).not.toThrow();
    const broken = createNativeExecutionDiagnostics({
      logger: {
        info: () => {
          throw new Error(CANARY);
        },
      },
      scope,
    });
    expect(() => broken({ status: CANARY })).not.toThrow();
    s.assertPrivate();
  });
});

describe('real loopback SDK and streamed body diagnostics', () => {
  it('classifies an actual socket failure separately from an HTTP service rejection', async () => {
    const s = sinks();
    const url = await endpoint((req) => {
      req.resume();
      req.socket.destroy();
    });
    await expect(
      invokeNativeExecutionRuntime({
        runtime: sdk(url),
        execution: row,
        payload,
        diagnostics: s.diagnostics,
      }),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(s.events()[0]).toMatchObject({
      phase: 'status',
      stage: 'sdk',
      code: 'SDK_FAILURE',
      errorCode: 'ECONNRESET',
    });
    expect(s.events()[0]).not.toHaveProperty('httpStatus');
    s.assertPrivate();
  });

  it('distinguishes an SDK HTTP409 before the body reader and preserves the original error', async () => {
    const s = sinks();
    const url = await endpoint((req, res) => {
      req.resume();
      res.writeHead(409, {
        'content-type': 'application/json',
        'x-amzn-errortype': 'RuntimeClientError',
        'x-amzn-requestid': REQUEST_ID,
      });
      res.end(JSON.stringify({ message: CANARY, code: CANARY }));
    });
    await expect(
      invokeNativeExecutionRuntime({
        runtime: sdk(url),
        execution: row,
        payload,
        diagnostics: s.diagnostics,
      }),
    ).rejects.toMatchObject({ name: 'RuntimeClientError', message: CANARY });
    expect(s.events()).toEqual([
      expect.objectContaining({
        phase: 'status',
        stage: 'sdk',
        code: 'SDK_FAILURE',
        errorName: 'RuntimeClientError',
        httpStatus: 409,
        awsRequestId: REQUEST_ID,
      }),
    ]);
    s.assertPrivate();
  });

  it('reads a real chunked HTTP response unchanged and emits no body content', async () => {
    const s = sinks();
    const value = {
      ...identity,
      writerGeneration: 1,
      sequence: 1,
      status: 'preparing',
      private: CANARY,
    };
    const encoded = JSON.stringify(value);
    const url = await endpoint((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(encoded.slice(0, 30));
      setImmediate(() => res.end(encoded.slice(30)));
    });
    const result = await invokeNativeExecutionRuntime({
      runtime: sdk(url),
      execution: row,
      payload,
      diagnostics: s.diagnostics,
    });
    expect(result).toEqual(value);
    expect(s.lines).toHaveLength(0);
  });

  it('closes an invalid-content response before a later status retry can open another stream', async () => {
    const s = sinks();
    const body = Readable.from([Buffer.from(CANARY)]);
    await expect(
      readNativeRuntimeReport(
        { contentType: 'text/plain', statusCode: 200, response: body },
        { diagnostics: s.diagnostics, phase: 'status' },
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_RUNTIME_UNAVAILABLE' });
    expect(body.destroyed).toBe(true);
    expect(s.events()[0]).toMatchObject({ code: 'CONTENT_TYPE_INVALID' });
    s.assertPrivate();
  });

  it.each(['wrong-content-type', 'bad-json', 'oversized', 'owner-rejection'])(
    'classifies %s on a real SDK streamed success response without changing failure behavior',
    async (kind) => {
      const s = sinks();
      const url = await endpoint((req, res) => {
        req.resume();
        res.writeHead(200, {
          'content-type':
            kind === 'wrong-content-type' ? `text/plain; secret=${CANARY}` : 'application/json',
        });
        const content =
          kind === 'bad-json'
            ? `{"${CANARY}":`
            : kind === 'oversized'
              ? JSON.stringify({ private: CANARY, padding: 'x'.repeat(270_000) })
              : kind === 'owner-rejection'
                ? JSON.stringify({
                    ok: false,
                    code: 'native_execution_existing_owner',
                    message: CANARY,
                  })
                : CANARY;
        res.end(content);
      });
      await expect(
        invokeNativeExecutionRuntime({
          runtime: sdk(url),
          execution: row,
          payload,
          diagnostics: s.diagnostics,
        }),
      ).rejects.toBeDefined();
      expect(s.events()).toContainEqual(
        expect.objectContaining({
          phase: 'status',
          code: {
            'wrong-content-type': 'CONTENT_TYPE_INVALID',
            'bad-json': 'BODY_JSON_INVALID',
            oversized: 'BODY_TOO_LARGE',
            'owner-rejection': 'OWNER_REJECTED',
          }[kind],
        }),
      );
      s.assertPrivate();
    },
  );

  it('distinguishes a truncated HTTP stream from invalid JSON and keeps stream cleanup', async () => {
    const s = sinks();
    const url = await endpoint((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 10_000 });
      res.write(`{"private":"${CANARY}`);
      setImmediate(() => res.destroy());
    });
    const body = await new Promise((resolve, reject) => {
      request(url, (response) => resolve(response))
        .on('error', reject)
        .end();
    });
    await expect(
      readNativeRuntimeReport(
        {
          contentType: 'application/json',
          statusCode: 200,
          response: body,
        },
        { diagnostics: s.diagnostics, phase: 'status' },
      ),
    ).rejects.toBeDefined();
    expect(s.events()).toContainEqual(
      expect.objectContaining({
        stage: 'body',
        code: 'BODY_READ_FAILED',
        httpStatus: 200,
      }),
    );
    expect(s.events().some((event) => event.code === 'BODY_JSON_INVALID')).toBe(false);
    expect(body.destroyed).toBe(true);
    s.assertPrivate();
  });

  it.each([
    { statusCode: 502, runtimeCode: undefined, expectedCode: undefined },
    { statusCode: 500, runtimeCode: CANARY, expectedCode: 'unknown' },
    {
      statusCode: 400,
      runtimeCode: 'native_execution_scope_mismatch',
      expectedCode: 'native_execution_scope_mismatch',
    },
    {
      statusCode: 500,
      runtimeCode: 'native_execution_start_failed',
      expectedCode: 'native_execution_start_failed',
    },
  ])(
    'logs non-200 $statusCode with allowlisted runtime code $expectedCode and preserves reader error ordering',
    async ({ statusCode, runtimeCode, expectedCode }) => {
      const s = sinks();
      const body = Readable.from([
        Buffer.from(JSON.stringify({ ok: false, code: runtimeCode, message: CANARY })),
      ]);
      await expect(
        readNativeRuntimeReport(
          {
            statusCode,
            contentType: 'application/json',
            response: body,
          },
          { diagnostics: s.diagnostics, phase: 'start' },
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_RUNTIME_UNAVAILABLE' });
      expect(s.events()).toHaveLength(1);
      expect(s.events()[0]).toMatchObject({
        phase: 'start',
        stage: 'http',
        code: 'HTTP_NON_200',
        httpStatus: statusCode,
      });
      if (expectedCode === undefined) expect(s.events()[0]).not.toHaveProperty('runtimeCode');
      else expect(s.events()[0].runtimeCode).toBe(expectedCode);
      expect(body.destroyed).toBe(true);
      s.assertPrivate();
    },
  );
});

describe('supervisor decision diagnostics preserve protected behavior', () => {
  const fixture = async () => {
    const f = executionFixture();
    await f.start();
    const s = sinks();
    const ports = {
      store: f.store,
      preparationStore: f.preparationStore,
      now: f.now,
      diagnostics: s.diagnostics,
      authorize: vi.fn(async () => {}),
      upgrade: vi.fn(async ({ execution }) => ({ ready: true, target: f.target(execution) })),
      credentials: vi.fn(async (execution) => ({
        ok: true,
        ...executionIdentity(execution),
        model: { provider: 'bedrock', value: CANARY },
        git: { username: 'git', password: CANARY },
        source: { commit: 'e'.repeat(40), branch: 'develop' },
      })),
      fence: {
        ensureActive: vi.fn(async () => {}),
        suspend: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
      },
      stop: vi.fn(async ({ execution }) => ({
        confirmed: true,
        runtimeSessionId: execution.runtimeSessionId,
      })),
      invoke: vi.fn(async ({ execution }) => ({
        ...executionIdentity(execution),
        writerGeneration: 1,
        sequence: 1,
        status: 'preparing',
        recovered: false,
        private: CANARY,
      })),
    };
    const run = createNativeExecutionSupervisor(ports);
    for (let i = 0; i < 4; i++) await run(f.identity);
    expect(f.row().status).toBe('RUNNING');
    return { ...f, ...s, run, ports };
  };

  it.each(['identity', 'sequence', 'cold'])(
    'records %s before the unchanged DELIVERY_UNCERTAIN decision without another Start',
    async (kind) => {
      const f = await fixture();
      const before = f.row();
      f.ports.invoke.mockImplementationOnce(async ({ execution }) => {
        return {
          ...executionIdentity(execution),
          writerGeneration: 1,
          sequence: kind === 'sequence' ? 2 : 1,
          status: kind === 'cold' ? 'failed' : 'preparing',
          recovered: kind === 'cold',
          code: kind === 'cold' ? 'native_execution_initialization_unverified' : undefined,
          ...(kind === 'identity' ? { bindingId: CANARY } : {}),
          private: CANARY,
        };
      });
      await f.run(f.identity);
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: false },
        attemptId: before.attemptId,
        epoch: before.epoch,
        dispatch: before.dispatch,
      });
      const events = f.events();
      expect(events.at(-1)).toMatchObject({
        phase: 'status',
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
        dispatchPresent: true,
      });
      if (kind === 'identity') expect(events.at(-1).identityMismatches).toEqual(['bindingId']);
      if (kind === 'sequence') expect(events.at(-1).sequenceMatches).toBe(false);
      if (kind === 'cold')
        expect(events.at(-1)).toMatchObject({
          recovered: true,
          status: 'failed',
          runtimeCode: 'native_execution_initialization_unverified',
        });
      expect(
        f.ports.invoke.mock.calls.filter(([input]) => input.payload.command === 'native-start'),
      ).toHaveLength(1);
      f.assertPrivate();
    },
  );

  it('records an unconfirmed status SDK error before retrying only the status read', async () => {
    const f = await fixture();
    const before = f.row();
    f.ports.invoke.mockRejectedValueOnce(
      Object.assign(new Error(CANARY), {
        name: 'RuntimeClientError',
        $metadata: { httpStatusCode: 409, requestId: REQUEST_ID },
        body: { secret: CANARY },
      }),
    );
    expect(await f.run(f.identity)).toEqual({ pending: true, status: 'RUNNING' });
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      attemptId: before.attemptId,
      epoch: before.epoch,
      dispatch: before.dispatch,
    });
    expect(f.events().at(-1)).toMatchObject({
      phase: 'status',
      stage: 'decision',
      code: 'STATUS_READ_RETRY',
      failureClass: 'SDK_FAILURE',
      errorName: 'RuntimeClientError',
      httpStatus: 409,
      dispatchPresent: true,
    });
    expect(f.row().recovery).toBeUndefined();
    expect(f.ports.fence.suspend).not.toHaveBeenCalled();
    expect(f.ports.stop).not.toHaveBeenCalled();
    await f.run(f.identity);
    expect(
      f.ports.invoke.mock.calls.filter(([input]) => input.payload.command === 'native-start'),
    ).toHaveLength(1);
    f.assertPrivate();
  });

  it('does not convert a hot initialization failure to recovery', async () => {
    const f = await fixture();
    f.ports.invoke.mockImplementationOnce(async ({ execution }) => ({
      ...executionIdentity(execution),
      writerGeneration: 1,
      sequence: 1,
      status: 'failed',
      recovered: false,
      code: 'native_execution_initialization_unverified',
      message: CANARY,
    }));
    await f.run(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_initialization_unverified',
    });
    expect(f.events().at(-1)).toMatchObject({
      code: 'RUNTIME_TERMINAL',
      status: 'failed',
      runtimeCode: 'native_execution_initialization_unverified',
      recovered: false,
    });
    f.assertPrivate();
  });

  it('keeps state transitions when a diagnostic sink throws', async () => {
    const f = await fixture();
    f.ports.diagnostics = () => {
      throw new Error(CANARY);
    };
    const run = createNativeExecutionSupervisor(f.ports);
    f.ports.invoke.mockImplementationOnce(async ({ execution }) => ({
      ...executionIdentity(execution),
      writerGeneration: 1,
      sequence: 1,
      status: 'failed',
      recovered: false,
      code: 'native_execution_initialization_unverified',
    }));
    await run(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_initialization_unverified',
    });
  });
});

it('persists bounded presentation reason/hash/counts without raw fields or getters', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const getter = vi.fn(() => {
    throw Error('private getter');
  });
  try {
    recordNativeBoundary({ projectId: 'fixture' }, 'questionPresentation', 123, {
      reason: 'invalid_schema',
      sha256: 'a'.repeat(64),
      suppliedQuestions: 6,
      suppliedOptions: 12,
      askType: 'scope-confirm',
      responseRoute: 'next',
      suppliedChoices: 3,
      suppliedScopeOptions: 11,
      prompt: CANARY,
      options: [CANARY],
      raw: CANARY,
    });
    const event = JSON.parse(info.mock.calls[0][0]);
    expect(event).toMatchObject({
      reason: 'invalid_schema',
      sha256: 'a'.repeat(64),
      suppliedQuestions: 6,
      suppliedOptions: 12,
      askType: 'scope-confirm',
      responseRoute: 'next',
      suppliedChoices: 3,
      suppliedScopeOptions: 11,
    });
    expect(JSON.stringify(event)).not.toContain(CANARY);
    const hostile = Object.defineProperties(
      {},
      {
        reason: { get: getter },
        sha256: { get: getter },
        bytes: { get: getter },
        askType: { get: getter },
        responseRoute: { get: getter },
        suppliedChoices: { get: getter },
        suppliedScopeOptions: { get: getter },
      },
    );
    expect(() => recordNativeBoundary({}, 'questionPresentation', 123, hostile)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(info.mock.calls[1][0])).toEqual({
      type: 'native.lifecycle',
      boundary: 'questionPresentation',
      at: 123,
    });
    recordNativeBoundary({}, 'questionPresentation', 123, {
      askType: CANARY,
      responseRoute: CANARY,
      suppliedChoices: 514,
      suppliedScopeOptions: -1,
    });
    expect(JSON.parse(info.mock.calls[2][0])).toEqual({
      type: 'native.lifecycle',
      boundary: 'questionPresentation',
      at: 123,
    });
  } finally {
    info.mockRestore();
  }
});
