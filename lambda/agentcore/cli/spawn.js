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

// Keep only the last `max` bytes of a growing string — the tail is where a CLI
// prints its terminating error, and it bounds memory on a chatty child.
const clampTail = (s, max) => (s.length > max ? s.slice(s.length - max) : s);

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
}) =>
  new Promise((resolve) => {
    const capture = captureStderrTail > 0;
    const child = spawnFn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: [
        promptViaStdin ? 'pipe' : 'ignore',
        onStdout ? 'pipe' : 'inherit',
        capture ? 'pipe' : 'inherit',
      ],
    });
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
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stderrTail });
    };
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
// can't do (it inherits stdout to the log). Resolves { exitCode, stdout }; a
// spawn error yields { exitCode: null, stdout: '' } so the caller degrades.
export const captureChild = ({ command, args, env, cwd, spawnFn = spawn }) =>
  new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
