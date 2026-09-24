// Headless CLI spawn shell — runs a driver invocation as a child process and
// resolves the exit contract the runner cares about: { exitCode, stderrTail }.
//
// shell:false (argv comes from the driver, never concatenated). The prompt is
// either on argv (default) or piped on stdin (promptViaStdin). stdout is normally
// inherited to the container log, but callers can tee it with `onStdout` when they
// need live process output. `spawnFn` is injectable so the runner is fully
// testable with the child mocked.
//
// stderr: when `captureStderrTail` is set, stderr is TEE'd — still written to
// the container log AND buffered (last N bytes) so the runner can inspect the
// CLI's final error line (e.g. Kiro's ACP empty-completion signature) without
// losing the log. Otherwise stderr is inherited as before.

import { Logger } from '@aws-lambda-powertools/logger';
import { spawn } from 'node:child_process';
import { childEnvironment } from './environment.js';
import { currentCredentialSession } from '../credential-session.js';

const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'spawn' } });

// Keep only the last `max` bytes of a growing string — the tail is where a CLI
// prints its terminating error, and it bounds memory on a chatty child.
const clampTail = (s, max) => (s.length > max ? s.slice(s.length - max) : s);

// Session-owned process groups include tool/MCP descendants. Killing just the
// CLI parent would let those children continue with cached STS credentials.
const terminateChild = (child, detached, killProcessGroup) => {
  try {
    if (detached && child.pid) killProcessGroup(-child.pid, 'SIGKILL');
    else child.kill?.('SIGKILL');
  } catch {
    /* group has already exited */
  }
};

export const runChild = ({
  command,
  args,
  env,
  cwd,
  prompt,
  promptViaStdin = false,
  captureStderrTail = 0,
  onStdout = null,
  spawnFn = spawn,
  killProcessGroup = (pid, signal) => process.kill(pid, signal),
}) =>
  new Promise((resolve, reject) => {
    const capture = captureStderrTail > 0;
    const session = currentCredentialSession();
    try {
      session?.assertAvailable();
    } catch {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        stderrTail: '',
        timedOut: false,
        credentialError: session.signal.reason?.code ?? 'credential_unavailable',
      });
      return;
    }
    const detached = Boolean(session) && process.platform !== 'win32';
    const mergedEnv = childEnvironment(env, process.env, session?.credentialEnvironment);
    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: mergedEnv,
        shell: false,
        ...(detached ? { detached: true } : {}),
        stdio: [
          promptViaStdin ? 'pipe' : 'ignore',
          onStdout ? 'pipe' : 'inherit',
          capture ? 'pipe' : 'inherit',
        ],
      });
    } catch (e) {
      // spawn() throws SYNCHRONOUSLY for E2BIG (argv/env too large) — it never
      // reaches child.on('error'). Log the code loudly, then reject so the
      // runner's catch maps it to cli_error (was previously an invisible throw).
      logger.error('runChild failed', e, { command });
      reject(e);
      return;
    }
    let stderrTail = '';
    if (onStdout) {
      child.stdout?.on('data', (c) => {
        process.stdout.write(c);
        onStdout(c.toString());
      });
    }
    if (capture) {
      child.stderr?.on('data', (c) => {
        // Tee: preserve the container-log behaviour, then buffer the tail.
        process.stderr.write(c);
        stderrTail = clampTail(stderrTail + c.toString(), captureStderrTail);
      });
    }
    const cancel = () => {
      terminateChild(child, detached, killProcessGroup);
      finish(null);
    };
    session?.signal.addEventListener('abort', cancel, { once: true });
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      session?.signal.removeEventListener('abort', cancel);
      resolve({
        exitCode,
        stderrTail,
        ...(session?.signal.aborted
          ? {
              credentialError: session.signal.reason?.code ?? 'credential_unavailable',
            }
          : {}),
      });
    };
    if (session?.signal.aborted) cancel();
    child.on('error', () => finish(null)); // spawn failure → runner maps to FAILED
    child.on('close', (code) => finish(code));
    if (promptViaStdin) {
      try {
        child.stdin?.end(prompt ?? '');
      } catch {
        /* stdin may already be closed */
      }
    }
  });

// Run a short command and CAPTURE its stdout — used for the Kiro post-run session
// id capture (`--list-sessions --format json`), which the long-lived runChild
// can't do (it inherits stdout to the log). `captureStderr` additionally buffers
// stderr (kiro-cli prints its `/usage` report there). The prompt is either on
// argv (default) or piped on stdin (promptViaStdin) — the one-shot path pipes it
// so a large prompt never overflows ARG_MAX (spawn E2BIG). `timeoutMs` (optional)
// SIGKILLs a hung child — one-shot LLM calls must never wedge the derive
// command or the backfill route. Resolves { exitCode, stdout, stderr,
// timedOut }; a spawn error yields { exitCode: null, stdout: '', stderr: '' }
// so the caller degrades.
export const captureChild = ({
  command,
  args,
  env,
  cwd,
  prompt,
  promptViaStdin = false,
  captureStderr = false,
  timeoutMs = 0,
  spawnFn = spawn,
  killProcessGroup = (pid, signal) => process.kill(pid, signal),
}) =>
  new Promise((resolve) => {
    const session = currentCredentialSession();
    try {
      session?.assertAvailable();
    } catch {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        stderrTail: '',
        timedOut: false,
        credentialError: session.signal.reason?.code ?? 'credential_unavailable',
      });
      return;
    }
    const detached = Boolean(session) && process.platform !== 'win32';
    const mergedEnv = childEnvironment(env, process.env, session?.credentialEnvironment);
    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env: mergedEnv,
        shell: false,
        ...(detached ? { detached: true } : {}),
        stdio: [promptViaStdin ? 'pipe' : 'ignore', 'pipe', captureStderr ? 'pipe' : 'inherit'],
      });
    } catch (e) {
      // E2BIG throws synchronously here too. Log + degrade (this path resolves
      // rather than rejects — the caller treats exitCode null as a soft failure).
      logger.error('captureChild failed', e, { command });
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    let stderr = '';
    if (captureStderr) child.stderr?.on('data', (c) => (stderr += c.toString()));
    const cancel = () => {
      terminateChild(child, detached, killProcessGroup);
      finish(null);
    };
    session?.signal.addEventListener('abort', cancel, { once: true });
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      session?.signal.removeEventListener('abort', cancel);
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        ...(session?.signal.aborted
          ? {
              credentialError: session.signal.reason?.code ?? 'credential_unavailable',
            }
          : {}),
      });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          terminateChild(child, detached, killProcessGroup);
        } catch {
          /* already gone */
        }
        // Resolve immediately — a SIGKILLed child's close event may never
        // arrive through a mocked/edge-case stream teardown, and the caller
        // must not hang on the very thing the timeout guards against.
        finish(null);
      }, timeoutMs);
      // Never hold the event loop open for the watchdog alone.
      timer.unref?.();
    }
    if (session?.signal.aborted) cancel();
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    if (promptViaStdin) {
      try {
        child.stdin?.end(prompt ?? '');
      } catch {
        /* stdin may already be closed */
      }
    }
  });
