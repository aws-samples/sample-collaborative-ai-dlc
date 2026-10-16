// Execute a trusted, pinned command with caller-supplied argv and environment.
// Captured output is private evidence: this module never logs or tees it.
// Linux uses a per-command subreaper for ordinary tools that change groups.
// This is not a sandbox for hostile executable code.
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const linuxOwner = process.platform === 'linux';
const ownerPath = fileURLToPath(new URL('./command-owner.py', import.meta.url));

export const NATIVE_COMMAND_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  stdoutBytes: 2 * 1024 * 1024,
  stderrBytes: 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  cleanupMs: 750,
});

const SPAWN_CODES = new Set([
  'ENOENT',
  'EACCES',
  'ENOEXEC',
  'E2BIG',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'EAGAIN',
]);
const noop = () => {};
const resultFor = (spawnError = null) => ({
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  outputLimitExceeded: false,
  spawnError,
  cleanupComplete: true,
});
const validString = (value) => typeof value === 'string' && !value.includes('\0');
const outputBound = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= NATIVE_COMMAND_LIMITS.maxOutputBytes;
const spawnCode = (error) => (SPAWN_CODES.has(error?.code) ? error.code : 'SPAWN_FAILED');

const argumentsFor = (options) => {
  const {
    command,
    args,
    cwd,
    env,
    timeoutMs = NATIVE_COMMAND_LIMITS.timeoutMs,
    stdoutBytes = NATIVE_COMMAND_LIMITS.stdoutBytes,
    stderrBytes = NATIVE_COMMAND_LIMITS.stderrBytes,
    outputLimitAction = 'terminate',
    stdin,
    signal,
    onStdoutChunk,
  } = options;
  if (
    !validString(command) ||
    !isAbsolute(command) ||
    !validString(cwd) ||
    !isAbsolute(cwd) ||
    !Array.isArray(args) ||
    !args.every(validString) ||
    !env ||
    typeof env !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(env)) ||
    (timeoutMs !== null &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) ||
    !['terminate', 'truncate'].includes(outputLimitAction) ||
    (stdin !== undefined &&
      (!(typeof stdin === 'string' || Buffer.isBuffer(stdin)) ||
        Buffer.byteLength(stdin) > 1024 * 1024)) ||
    !outputBound(stdoutBytes) ||
    !outputBound(stderrBytes) ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    (onStdoutChunk !== undefined && typeof onStdoutChunk !== 'function')
  ) {
    throw new Error('Invalid command arguments');
  }
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.includes('=') || !validString(key) || !validString(value)) {
      throw new Error('Invalid command environment');
    }
    environment[key] = value;
  }
  // Node specially forwards ambient coverage even with options.env. An own
  // undefined value suppresses that fallback and is omitted from exec's env.
  if (!Object.hasOwn(environment, 'NODE_V8_COVERAGE')) environment.NODE_V8_COVERAGE = undefined;
  // Fail closed if a runtime tries to add other inherited environment fields.
  Object.freeze(environment);
  return {
    command,
    args: [...args],
    cwd,
    env: environment,
    timeoutMs,
    stdoutBytes,
    stderrBytes,
    outputLimitAction,
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    signal,
    onStdoutChunk,
  };
};

const captureFor = (limit) => {
  // A fixed buffer also bounds retention when a process emits tiny chunks.
  const buffer = Buffer.alloc(limit);
  let used = 0;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const accepted = Math.min(bytes.length, limit - used);
      bytes.copy(buffer, used, 0, accepted);
      used += accepted;
      return accepted !== bytes.length;
    },
    text() {
      // Decode joined bytes once. Replacement characters for malformed UTF-8
      // can expand the encoding, so bound the returned string as well. write()
      // without end() omits any code point cut by the final byte boundary.
      const decoded = new StringDecoder('utf8').write(buffer.subarray(0, used));
      const encoded = Buffer.from(decoded, 'utf8');
      return new StringDecoder('utf8').write(encoded.subarray(0, limit));
    },
  };
};

/**
 * Returns process status and bounded private stdout/stderr; never throws raw
 * spawn errors. spawnError is null, INVALID_ARGUMENT, UNSUPPORTED_PLATFORM,
 * IO_ERROR, SPAWN_FAILED, or an allowlisted OS error code above.
 *
 * A pre-aborted signal prevents spawning and returns exitCode/signal null.
 * On Linux cleanupComplete requires close AND the owner's all-children-reaped
 * receipt. Other POSIX hosts retain group cleanup (not runtime qualification).
 * If false, the caller must halt all subsequent commands. Even normal command
 * exit triggers cleanup of any remaining ordinary descendants.
 * timeoutMs:null explicitly disables the command deadline. outputLimitAction:
 * 'truncate' keeps draining both streams after their capture buffers fill;
 * it never stops the child. Defaults retain bounded operator-probe behavior.
 * Optional stdin is a bounded literal payload; no shell or ambient input.
 */
export const runNativeCommand = async (options) => {
  let input;
  try {
    input = argumentsFor(options);
  } catch {
    return resultFor('INVALID_ARGUMENT');
  }
  if (process.platform === 'win32') return resultFor('UNSUPPORTED_PLATFORM');
  if (input.signal?.aborted) return resultFor();

  return new Promise((resolve) => {
    const result = resultFor();
    const stdout = captureFor(input.stdoutBytes);
    const stderr = captureFor(input.stderrBytes);
    const deadline = input.timeoutMs === null ? null : Date.now() + input.timeoutMs;
    let child;
    let pid;
    let exited = false;
    let closed = false;
    let cleaning = false;
    let finished = false;
    let timeout;
    let cleanupTimeout;
    let poll;
    let pressure = null;
    let drainingPressure = null;
    let ownerStatus = '';
    let ownerReceipt = false;
    const onOwnerStatus = (chunk) => {
      if (ownerStatus !== null)
        ownerStatus =
          ownerStatus.length + chunk.length > 256 ? null : ownerStatus + chunk.toString('ascii');
    };

    const groupGone = () => {
      if (pid === undefined) return true; // spawn failed before obtaining a PID
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    };

    const finish = (cleanupComplete) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(cleanupTimeout);
      clearTimeout(poll);
      input.signal?.removeEventListener('abort', abort);
      child?.removeListener('exit', onExit);
      child?.removeListener('close', onClose);
      child?.removeListener('error', onError);
      // Late errors after forced teardown must not become unhandled events or
      // retain the capture buffers through their former listener closures.
      child?.on('error', noop);
      child?.stdin?.removeListener('error', onStdinError);
      child?.stdin?.on('error', noop);
      child?.stdin?.destroy();
      child?.stdio?.[3]?.removeListener('data', onOwnerStatus);
      child?.stdio?.[3]?.removeListener('error', onStreamError);
      child?.stdio?.[3]?.on('error', noop);
      child?.stdio?.[3]?.destroy();
      for (const [stream, onData] of [
        [child?.stdout, onStdout],
        [child?.stderr, onStderr],
      ]) {
        stream?.removeListener('data', onData);
        stream?.removeListener('error', onStreamError);
        stream?.on('error', noop);
        stream?.destroy();
      }
      if (!cleanupComplete) child?.unref();
      resolve({ ...result, stdout: stdout.text(), stderr: stderr.text(), cleanupComplete });
    };

    const checkCleanup = () => {
      if (finished) return;
      if (closed && (linuxOwner ? ownerReceipt || pid === undefined : groupGone())) {
        finish(true);
      } else if (poll === undefined) {
        poll = setTimeout(() => {
          poll = undefined;
          checkCleanup();
        }, 20);
      }
    };

    const cleanup = () => {
      if (finished || cleaning) return;
      if (exited && pressure && !input.signal?.aborted && !result.timedOut && !result.spawnError) {
        // A normally exited producer may still have buffered stdout. Preserve
        // its observer's persistence backpressure before the cleanup deadline.
        if (drainingPressure !== pressure) {
          drainingPressure = pressure;
          Promise.resolve(pressure).then(cleanup, () => {
            result.spawnError ??= 'IO_ERROR';
            cleanup();
          });
        }
        return;
      }
      cleaning = true;
      // A blocked observer must not prevent draining/closing a killed child.
      pressure = null;
      child?.stdout?.resume();
      clearTimeout(timeout);
      cleanupTimeout = setTimeout(() => {
        // The child handle cannot signal a reused PID after its exit event.
        if (linuxOwner && !exited) child?.kill('SIGKILL');
        finish(false);
      }, NATIVE_COMMAND_LIMITS.cleanupMs);
      if (linuxOwner && pid !== undefined) {
        // Keep the owner alive to adopt/reap descendants, including setsid tools.
        if (!exited) child.kill('SIGTERM');
        checkCleanup();
        return;
      }
      let groupSignalled = false;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
          groupSignalled = true;
        } catch {
          // Absence is verified separately; permission/other failures cannot
          // grant cleanupComplete while the process group still exists.
        }
      }
      if (!exited && !groupSignalled) {
        try {
          child?.kill('SIGKILL');
        } catch {}
      }
      checkCleanup();
    };
    const abort = () => cleanup();
    const onStdout = (chunk) => {
      if (finished) return;
      try {
        // The observer sees every chunk, independently of the private capture
        // prefix. It must retain its own bounded projection, never raw output.
        const pending = input.onStdoutChunk?.(chunk);
        if (pending && typeof pending.then === 'function') {
          pressure = pending;
          child.stdout.pause();
          Promise.resolve(pending).then(
            () => {
              if (pressure !== pending || finished) return;
              pressure = null;
              child.stdout.resume();
            },
            () => {
              if (pressure !== pending || finished) return;
              result.spawnError ??= 'IO_ERROR';
              cleanup();
            },
          );
        }
      } catch {
        result.spawnError ??= 'IO_ERROR';
        cleanup();
        return;
      }
      if (!finished && stdout.append(chunk)) {
        result.outputLimitExceeded = true;
        if (input.outputLimitAction === 'terminate') cleanup();
      }
    };
    const onStderr = (chunk) => {
      if (!finished && stderr.append(chunk)) {
        result.outputLimitExceeded = true;
        if (input.outputLimitAction === 'terminate') cleanup();
      }
    };
    const onStreamError = () => {
      if (finished) return;
      result.spawnError ??= 'IO_ERROR';
      cleanup();
    };
    const onStdinError = (error) => {
      // A command may close its input after consuming the prompt.
      if (error?.code !== 'EPIPE') onStreamError();
    };
    const onError = (error) => {
      if (finished) return;
      result.spawnError ??= spawnCode(error);
      cleanup();
    };
    const recordExit = (code, signal) => {
      result.exitCode = Number.isSafeInteger(code) && code >= 0 ? code : null;
      result.signal = Object.hasOwn(osConstants.signals, signal) ? signal : null;
      exited = true;
    };
    const onExit = (code, signal) => {
      recordExit(code, signal);
      cleanup();
    };
    const onClose = (code, signal) => {
      recordExit(code, signal);
      if (linuxOwner && pid !== undefined) {
        try {
          const receipt = JSON.parse(ownerStatus);
          if (
            receipt.cleanupComplete !== true ||
            !(
              receipt.exitCode === null ||
              (Number.isInteger(receipt.exitCode) &&
                receipt.exitCode >= 0 &&
                receipt.exitCode <= 255)
            ) ||
            !(receipt.signal === null || Object.hasOwn(osConstants.signals, receipt.signal)) ||
            !(
              receipt.spawnError === null ||
              SPAWN_CODES.has(receipt.spawnError) ||
              receipt.spawnError === 'SPAWN_FAILED'
            )
          )
            throw new Error('Invalid command owner receipt');
          Object.assign(result, {
            exitCode: receipt.exitCode,
            signal: receipt.signal,
            spawnError: result.spawnError ?? receipt.spawnError,
          });
          ownerReceipt = true;
        } catch {
          result.spawnError ??= 'IO_ERROR';
        }
      }
      closed = true;
      cleanup();
      checkCleanup();
    };

    try {
      child = spawn(
        linuxOwner ? '/usr/bin/python3' : input.command,
        linuxOwner ? ['-I', '-S', ownerPath, input.command, ...input.args] : input.args,
        {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          detached: true,
          stdio: [
            input.stdin === undefined ? 'ignore' : 'pipe',
            'pipe',
            'pipe',
            ...(linuxOwner ? ['pipe'] : []),
          ],
        },
      );
      // Only signal the group ID obtained from this real spawn result.
      if (Number.isSafeInteger(child.pid) && child.pid > 1) pid = child.pid;
    } catch (error) {
      result.spawnError = spawnCode(error);
      finish(true);
      return;
    }
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
    child.stdout.on('error', onStreamError);
    child.stderr.on('error', onStreamError);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.stdio?.[3]?.on('data', onOwnerStatus);
    child.stdio?.[3]?.on('error', onStreamError);
    child.stdin?.on('error', onStdinError);
    child.stdin?.end(input.stdin);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) {
      cleanup();
    } else if (deadline !== null) {
      const remaining = deadline - Date.now();
      const expire = () => {
        if (cleaning || finished) return;
        result.timedOut = true;
        cleanup();
      };
      if (remaining <= 0) expire();
      else timeout = setTimeout(expire, remaining);
    }
  });
};
