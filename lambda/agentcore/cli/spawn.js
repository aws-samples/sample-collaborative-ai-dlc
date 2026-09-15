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

import { spawn } from 'node:child_process';
import { currentCredentialSignal } from '../invocation-credentials.js';

// Keep only the last `max` bytes of a growing string — the tail is where a CLI
// prints its terminating error, and it bounds memory on a chatty child.
const clampTail = (s, max) => (s.length > max ? s.slice(s.length - max) : s);

// Give an IAM invocation its own process group, so cancelling an agent also
// stops its tool/MCP children. Allow a brief graceful exit, then bound teardown
// even when the CLI ignores SIGTERM or never closes its streams.
const watchCancellation = ({ child, signal, detached, finish, killProcessGroup, abortGraceMs }) => {
  let timer;
  let disposed = false;
  const kill = (name) => {
    try {
      if (detached && child.pid) killProcessGroup(-child.pid, name);
      else child.kill?.(name);
    } catch {
      // The process/group may already have exited.
    }
  };
  const abort = () => {
    if (disposed) return;
    timer = setTimeout(() => {
      kill('SIGKILL');
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      finish(null);
    }, abortGraceMs);
    timer.unref?.();
    kill('SIGTERM');
  };
  return {
    kill,
    start() {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // The parent may exit before a child that ignores SIGTERM. Stop the
      // remaining group before checkpointing files or reporting completion.
      if (signal?.aborted) kill('SIGKILL');
    },
  };
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
  signal = currentCredentialSignal(),
  abortGraceMs = 5000,
  killProcessGroup = (pid, name) => process.kill(pid, name),
}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, stderrTail: '', aborted: true });
      return;
    }
    const capture = captureStderrTail > 0;
    const mergedEnv = { ...process.env, ...env };
    const detached = Boolean(signal) && process.platform !== 'win32';
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
      console.error(`[spawn:error] runChild command=${command} code=${e?.code} msg=${e?.message}`);
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
    let settled = false;
    let cancellation;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      resolve({ exitCode, stderrTail, ...(signal?.aborted ? { aborted: true } : {}) });
    };
    child.on('error', () => finish(null)); // spawn failure → runner maps to FAILED
    child.on('close', (code) => finish(code));
    cancellation = watchCancellation({
      child,
      signal,
      detached,
      finish,
      killProcessGroup,
      abortGraceMs,
    });
    cancellation.start();
    if (promptViaStdin && !signal?.aborted) {
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
  signal = currentCredentialSignal(),
  abortGraceMs = 5000,
  killProcessGroup = (pid, name) => process.kill(pid, name),
}) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const mergedEnv = { ...process.env, ...env };
    const detached = Boolean(signal) && process.platform !== 'win32';
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
      console.error(
        `[spawn:error] captureChild command=${command} code=${e?.code} msg=${e?.message}`,
      );
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false });
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    let stderr = '';
    if (captureStderr) child.stderr?.on('data', (c) => (stderr += c.toString()));
    let settled = false;
    let timedOut = false;
    let timer = null;
    let cancellation;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cancellation?.dispose();
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        ...(signal?.aborted ? { aborted: true } : {}),
      });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (cancellation) cancellation.kill('SIGKILL');
          else child.kill?.('SIGKILL');
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
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    cancellation = watchCancellation({
      child,
      signal,
      detached,
      finish,
      killProcessGroup,
      abortGraceMs,
    });
    cancellation.start();
    if (promptViaStdin && !signal?.aborted) {
      try {
        child.stdin?.end(prompt ?? '');
      } catch {
        /* stdin may already be closed */
      }
    }
  });
