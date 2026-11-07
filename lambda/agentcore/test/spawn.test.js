import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { captureChild, runChild } from '../cli/spawn.js';
import { createCredentialSession } from '../credential-session.js';
import { Logger } from '@aws-lambda-powertools/logger';
import { getDriver } from '../cli/drivers.js';
import { withSandbox } from '../sandbox/launcher.js';
import { createCliToolLogSink } from '../output-normalizer.js';

const HOUR = 3600_000;
const START = 1_000_000;
const PID = 123456;
const launchers = [
  ['runChild', runChild],
  ['captureChild', captureChild],
];

// Never exits on its own: only termination (or an explicit emit) settles it.
const hungChild = () => {
  const child = new EventEmitter();
  child.pid = PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};
const unavailable = (credentialError) => ({
  exitCode: null,
  stdout: '',
  stderr: '',
  stderrTail: '',
  timedOut: false,
  credentialError,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('children launched inside a credential session', () => {
  it.each(launchers)(
    '%s kills the owned process group on expiry and never spawns again',
    async (_name, launch) => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const session = createCredentialSession({
        expiresAt: START + HOUR,
        expirationCode: 'fixture_credential_expired',
      });
      const child = hungChild();
      const spawnFn = vi.fn(() => child);
      const killProcessGroup = vi.fn();
      const launched = session.run(async () => {
        const first = launch({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup });
        await vi.advanceTimersByTimeAsync(HOUR);
        // Work already inside the session keeps running after expiry; a later
        // launch there must resolve with the reason rather than throw.
        return {
          first: await first,
          later: await launch({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup }),
        };
      });
      expect(spawnFn.mock.calls[0][2].detached).toBe(true);
      const { first, later } = await launched;
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
      expect(first).toMatchObject({
        exitCode: null,
        credentialError: 'fixture_credential_expired',
      });
      expect(later).toEqual(unavailable('fixture_credential_expired'));
      expect(() =>
        session.run(() => launch({ command: 'fixture', args: [], env: {}, spawnFn })),
      ).toThrow();
      expect(spawnFn).toHaveBeenCalledOnce();
      await session.release();
    },
  );

  it.each(launchers)(
    '%s resolves with credentialError instead of throwing once the session is disposed',
    async (_name, launch) => {
      const session = createCredentialSession({ env: { KIRO_API_KEY: 'invocation-token' } });
      const spawnFn = vi.fn();
      const result = await session.run(async () => {
        await session.release();
        return launch({ command: 'fixture', args: [], env: {}, spawnFn });
      });
      expect(result).toEqual(unavailable('credential_session_disposed'));
      expect(spawnFn).not.toHaveBeenCalled();
    },
  );

  it.each(launchers)(
    '%s settles on cancellation even when the group has already exited',
    async (_name, launch) => {
      const session = createCredentialSession();
      const child = hungChild();
      const killProcessGroup = vi.fn(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      const result = session.run(() =>
        launch({ command: 'fixture', args: [], env: {}, spawnFn: () => child, killProcessGroup }),
      );
      session.cancel(Object.assign(new Error('revoked'), { code: 'fixture_revoked' }));
      expect(await result).toMatchObject({ exitCode: null, credentialError: 'fixture_revoked' });
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      await session.release();
    },
  );

  it('kills the owned process group when captureChild times out', async () => {
    const session = createCredentialSession();
    const child = hungChild();
    const killProcessGroup = vi.fn();
    try {
      const result = await session.run(() =>
        captureChild({
          command: 'fixture',
          args: [],
          env: {},
          timeoutMs: 5,
          spawnFn: () => child,
          killProcessGroup,
        }),
      );
      expect(result).toMatchObject({ exitCode: null, timedOut: true });
      expect(result).not.toHaveProperty('credentialError');
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await session.release();
    }
  });

  it('does not detach on win32, where only the child itself can be killed', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const session = createCredentialSession();
    try {
      const child = hungChild();
      const spawnFn = vi.fn(() => child);
      const killProcessGroup = vi.fn();
      const result = session.run(() =>
        captureChild({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup }),
      );
      expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
      session.cancel();
      expect(await result).toMatchObject({ credentialError: 'credential_expired' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(killProcessGroup).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      await session.release();
    }
  });
});

describe('children launched without a credential session', () => {
  it('keeps engine commands in the runtime process group', async () => {
    const child = hungChild();
    const spawnFn = vi.fn(() => child);
    const result = runChild({ command: 'git', args: ['status'], env: {}, spawnFn });
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
    child.emit('close', 0);
    expect(await result).toEqual({ exitCode: 0, stderrTail: '' });
  });

  it('kills only the child when captureChild times out', async () => {
    const child = hungChild();
    const spawnFn = vi.fn(() => child);
    const killProcessGroup = vi.fn();
    const result = await captureChild({
      command: 'fixture',
      args: [],
      env: {},
      timeoutMs: 5,
      spawnFn,
      killProcessGroup,
    });
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
    expect(result).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killProcessGroup).not.toHaveBeenCalled();
  });
});

// Recorded protocol shapes, with a tool error followed by successful work and
// a successful harness exit. No model call is needed to test log handling.
const toolEvents = (cli) => {
  if (cli === 'claude')
    return [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'private conversation' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/blocked/file' } },
            {
              type: 'tool_use',
              id: 'write-1',
              name: 'Write',
              input: { file_path: '/work/file', content: 'private file contents' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-1',
              is_error: true,
              content: 'EACCES: /blocked/file fixture-secret-value',
            },
            { type: 'tool_result', tool_use_id: 'write-1', content: 'private successful output' },
          ],
        },
      },
    ];
  if (cli === 'kiro')
    return [
      {
        type: 'sessionUpdate',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'private conversation' },
          },
        },
      },
      ...[
        {
          toolCallId: 'read-1',
          kind: 'read',
          status: 'failed',
          rawInput: { path: '/blocked/file' },
          rawOutput: { items: [{ Text: 'EACCES: /blocked/file fixture-secret-value' }] },
        },
        {
          toolCallId: 'write-1',
          kind: 'edit',
          status: 'completed',
          rawInput: { path: '/work/file', content: 'private file contents' },
          rawOutput: { items: [{ Text: 'private successful output' }] },
        },
      ].map((update) => ({
        type: 'sessionUpdate',
        data: { update: { sessionUpdate: 'tool_call', ...update } },
      })),
    ];
  if (cli === 'codex')
    return [
      { type: 'item.completed', item: { type: 'agent_message', text: 'private conversation' } },
      {
        type: 'item.completed',
        item: {
          id: 'read-1',
          type: 'command_execution',
          command: 'head /blocked/file',
          status: 'completed',
          exit_code: 1,
          aggregated_output: 'EACCES: /blocked/file fixture-secret-value',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'write-1',
          type: 'file_change',
          status: 'completed',
          changes: [{ kind: 'add', path: '/work/file', diff: 'private file contents' }],
        },
      },
    ];
  return [
    { type: 'text', part: { text: 'private conversation' } },
    {
      type: 'tool_use',
      part: {
        callID: 'read-1',
        tool: 'read',
        state: {
          status: 'error',
          input: { filePath: '/blocked/file' },
          error: 'EACCES: /blocked/file fixture-secret-value',
        },
      },
    },
    {
      type: 'tool_use',
      part: {
        callID: 'write-1',
        tool: 'write',
        state: {
          status: 'completed',
          input: { filePath: '/work/file', content: 'private file contents' },
          output: 'private successful output',
        },
      },
    },
  ];
};

describe.each(launchers)('%s tool logging', (_name, launch) => {
  it.each(['claude', 'kiro', 'codex', 'opencode'])(
    'logs failed and successful %s tools even when the harness exits zero',
    async (cli) => {
      const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const invocation = getDriver(cli).buildInvocation({ prompt: 'private prompt' });
      const stream = toolEvents(cli)
        .map((event) => JSON.stringify(event))
        .join('\n');
      const onStdout = vi.fn();
      const child = hungChild();
      const pending = launch({
        ...invocation,
        env: { KIRO_API_KEY: 'fixture-secret-value' },
        logContext: { executionId: 'exec-1', stageInstanceId: 'stage-1' },
        onStdout,
        spawnFn: () => child,
      });
      // Include split JSON and a final line without a newline.
      child.stdout.emit('data', stream.slice(0, 21));
      child.stdout.emit('data', stream.slice(21));
      child.emit('close', 0);
      const result = await pending;
      expect(result.exitCode).toBe(0);
      const failure = warn.mock.calls.find(([, record]) => record?.type === 'cli.tool')?.[1];
      const success = info.mock.calls.find(([, record]) => record?.type === 'cli.tool')?.[1];
      expect(failure).toMatchObject({
        cli,
        status: 'error',
        toolCallId: 'read-1',
        executionId: 'exec-1',
        stageInstanceId: 'stage-1',
        sandboxEnabled: false,
      });
      expect(failure.error).toContain('EACCES: /blocked/file [REDACTED]');
      expect(success).toMatchObject({
        status: 'completed',
        toolCallId: 'write-1',
        targets: ['/work/file'],
      });
      expect(success.invocationId).toBe(failure.invocationId);
      const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...stdout.mock.calls]);
      expect(logs).not.toMatch(
        /private conversation|private file contents|private successful output|fixture-secret-value|private prompt/,
      );
      if (launch === runChild)
        expect(onStdout.mock.calls.map(([chunk]) => chunk).join('')).toBe(stream);
      else expect(result.stdout).toBe(stream);
    },
  );

  it('shares the invocation ID with SRT and does not label tool errors as sandbox denials', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    const child = hungChild();
    let sandboxRequest;
    child.send = (request) => {
      sandboxRequest = request;
    };
    const pending = withSandbox({ enabled: true }, () =>
      launch({
        ...getDriver('codex').buildInvocation({ prompt: 'test' }),
        env: {},
        spawnFn: () => child,
      }),
    );
    child.emit('message', { type: 'sandbox.starting' });
    child.stdout.emit('data', JSON.stringify(toolEvents('codex')[1]));
    child.emit('close', 0);
    expect((await pending).exitCode).toBe(0);
    const record = warn.mock.calls[0][1];
    expect(record).toMatchObject({
      type: 'cli.tool',
      status: 'error',
      sandboxEnabled: true,
      invocationId: sandboxRequest.invocationId,
    });
    expect(record).not.toHaveProperty('confirmedDenial');
  });
});

describe('tool log contents', () => {
  it('logs write failures without file contents, and conversation tools without their messages', () => {
    const log = vi.fn();
    const sink = createCliToolLogSink({
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      env: {},
      log,
    });
    sink.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'write',
              name: 'Write',
              input: { file_path: '/blocked/write', content: 'private contents' },
            },
            {
              type: 'tool_use',
              id: 'question',
              name: 'mcp__aidlc__ask_question',
              input: { question: 'private question' },
            },
          ],
        },
      }) + '\n',
    );
    sink.write(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'write',
              is_error: true,
              content: 'EROFS: /blocked/write',
            },
            {
              type: 'tool_result',
              tool_use_id: 'question',
              is_error: true,
              content: 'private answer',
            },
          ],
        },
      }),
    );
    sink.flush();
    expect(log.mock.calls[0][0]).toMatchObject({
      tool: 'Write',
      status: 'error',
      targets: ['/blocked/write'],
      error: 'EROFS: /blocked/write',
    });
    expect(log.mock.calls[1][0]).toMatchObject({ tool: 'ask_question', status: 'error' });
    expect(log.mock.calls[1][0]).not.toHaveProperty('error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it('redacts command credentials before bounding error details', () => {
    const log = vi.fn();
    const sink = createCliToolLogSink({
      command: 'codex',
      args: ['exec', '--json'],
      env: { OPENAI_API_KEY: 'fixture-known-secret' },
      log,
    });
    sink.write(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'shell',
          status: 'completed',
          exit_code: 1,
          command:
            'curl https://user:password@example.invalid/?token=fixture-query-secret --api-key fixture-known-secret',
          aggregated_output: 'EACCES: fixture-known-secret ' + 'x'.repeat(4096),
        },
      }),
    );
    sink.flush();
    const record = log.mock.calls[0][0];
    expect(record.status).toBe('error');
    expect(record.error).toContain('EACCES: [REDACTED]');
    expect(record.error.length).toBeLessThanOrEqual(2048);
    expect(record.command).not.toMatch(/user:password|fixture-query-secret|fixture-known-secret/);
  });
});
