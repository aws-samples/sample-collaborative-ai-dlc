import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@aws-lambda-powertools/logger';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../cli/environment.js';
import { DEFAULT_SANDBOX_CONFIG, captureSandboxSettings } from '../../shared/sandbox-settings.js';

export { DEFAULT_SANDBOX_CONFIG };

const context = new AsyncLocalStorage();
const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'sandbox' } });

// Read execution state, never a sandbox value supplied in an invocation payload.
// Legacy started intents retain their original, unsandboxed behavior.
export const resolveInvocationSandbox = async ({ payload, store, readSettings }) => {
  const executionId = payload.executionId || payload.intentId;
  if (executionId) {
    const meta = await store.getExecution(executionId, { consistentRead: true });
    if (!meta || (payload.projectId && payload.projectId !== meta.projectId)) {
      throw new Error('Sandbox execution context does not match this invocation');
    }
    if (meta.status !== 'DRAFT') {
      return structuredClone(meta.agentSandbox ?? DEFAULT_SANDBOX_CONFIG);
    }
  }
  return captureSandboxSettings(await readSettings());
};

// Only trusted runtime code enters this context. Request payloads and child
// environment variables cannot enable, replace or disable the sandbox.
export const withSandbox = (
  {
    enabled = DEFAULT_SANDBOX_CONFIG.enabled,
    settings = DEFAULT_SANDBOX_CONFIG.settings,
    version = null,
    onEvent,
    observeFileWrites = false,
  },
  operation,
) => {
  if (typeof enabled !== 'boolean') throw new TypeError('sandbox.enabled must be a boolean');
  return context.run(
    { enabled, settings: structuredClone(settings), version, onEvent, observeFileWrites },
    operation,
  );
};

export const currentSandbox = () => context.getStore() ?? DEFAULT_SANDBOX_CONFIG;

export const spawnSandbox = (
  command,
  args,
  options,
  { sandbox, spawnFn = spawn, invocationId = randomUUID() },
) => {
  const scratch = mkdtempSync(join(tmpdir(), 'aidlc-srt-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let child;
  try {
    // AgentCore mounts /proc/sys read-only. SRT's bwrap --disable-userns
    // needs a writable sysctl in its own user namespace. Give the worker a
    // private /proc first; host mounts and namespace limits stay unchanged.
    // Keep the caller's uid, and kill the worker if its supervisor exits.
    child = spawnFn(
      '/usr/bin/unshare',
      [
        '--user',
        '--map-current-user',
        '--mount',
        '--pid',
        '--fork',
        '--kill-child',
        '--mount-proc',
        process.execPath,
        workerPath,
      ],
      {
        ...options,
        // The worker does not inherit platform/model credentials or loader hooks.
        // The filtered harness environment travels over private IPC instead.
        env: {
          ...childEnvironment({}, process.env),
          TMPDIR: scratch,
          CLAUDE_CODE_TMPDIR: scratch,
        },
        stdio: [...options.stdio, 'ipc'],
      },
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  let starting = false;
  child.on('message', (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'sandbox.starting') starting = true;
    if (event.type === 'sandbox.error') child.sandboxError = 'sandbox_start_failed';
    const record = { ...event, invocationId, sandboxVersion: sandbox.version ?? null };
    if (event.type === 'sandbox.error') {
      logger.error('sandbox event', record);
    } else if (
      [
        'sandbox.denied',
        'sandbox.cleanup_failed',
        'sandbox.log_gap',
        'sandbox.observation',
      ].includes(event.type)
    ) {
      logger.warn('sandbox event', record);
    } else {
      logger.info('sandbox event', record);
    }
    try {
      sandbox.onEvent?.(record);
    } catch {
      logger.warn('sandbox event consumer failed', { invocationId });
    }
  });
  child.on('close', () => {
    if (!starting) child.sandboxError ??= 'sandbox_start_failed';
    cleanup();
  });
  child.on('error', () => {
    child.sandboxError = 'sandbox_start_failed';
  });
  const sendFailed = () => {
    child.sandboxError = 'sandbox_start_failed';
    child.kill('SIGKILL');
  };
  try {
    child.send(
      {
        command,
        args,
        env: { ...options.env, TMPDIR: scratch, CLAUDE_CODE_TMPDIR: scratch },
        settings: {
          ...sandbox.settings,
          filesystem: {
            ...sandbox.settings.filesystem,
            allowWrite: [...(sandbox.settings.filesystem?.allowWrite ?? []), scratch],
          },
        },
        invocationId,
        observeFileWrites: sandbox.observeFileWrites,
      },
      (error) => {
        if (error) sendFailed();
      },
    );
  } catch {
    sendFailed();
  }
  return child;
};
