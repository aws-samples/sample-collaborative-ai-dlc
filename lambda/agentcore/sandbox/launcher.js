import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@aws-lambda-powertools/logger';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../cli/environment.js';

const context = new AsyncLocalStorage();
const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'sandbox' } });

// Until platform-admin configuration is connected, ordinary launches use this
// default. When enabled, these settings allow files, Unix sockets and all
// proxied destinations. SRT still isolates processes and direct networking.
export const DEFAULT_SANDBOX_CONFIG = Object.freeze({
  enabled: false,
  settings: {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowAllUnixSockets: true,
    },
    filesystem: { disabled: true, allowWrite: [], denyRead: [], denyWrite: [] },
  },
});

// Only trusted runtime code enters this context. Request payloads and child
// environment variables cannot enable, replace or disable the sandbox.
export const withSandbox = (
  {
    enabled = DEFAULT_SANDBOX_CONFIG.enabled,
    settings = DEFAULT_SANDBOX_CONFIG.settings,
    onEvent,
    observeFileWrites = false,
  },
  operation,
) => {
  if (typeof enabled !== 'boolean') throw new TypeError('sandbox.enabled must be a boolean');
  return context.run(
    { enabled, settings: structuredClone(settings), onEvent, observeFileWrites },
    operation,
  );
};

export const currentSandbox = () => context.getStore() ?? DEFAULT_SANDBOX_CONFIG;

export const spawnSandbox = (command, args, options, { sandbox, spawnFn = spawn }) => {
  const invocationId = randomUUID();
  const scratch = mkdtempSync(join(tmpdir(), 'aidlc-srt-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let child;
  try {
    child = spawnFn(process.execPath, [workerPath], {
      ...options,
      // The worker does not inherit platform/model credentials or loader hooks.
      // The filtered harness environment travels over private IPC instead.
      env: {
        ...childEnvironment({}, process.env),
        TMPDIR: scratch,
        CLAUDE_CODE_TMPDIR: scratch,
      },
      stdio: [...options.stdio, 'ipc'],
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  let starting = false;
  child.on('message', (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'sandbox.starting') starting = true;
    if (event.type === 'sandbox.error') child.sandboxError = 'sandbox_start_failed';
    const record = { ...event, invocationId };
    logger.info('sandbox event', record);
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
