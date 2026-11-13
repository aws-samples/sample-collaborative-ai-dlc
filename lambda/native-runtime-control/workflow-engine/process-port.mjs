// Runs only in the protected engine process. This pipe is a capability
// adapter, not a sandbox for code from the coding runtime.
import { readSync, writeSync } from 'node:fs';

const LIMIT = 4 * 1024 * 1024;
const pause = new Int32Array(new SharedArrayBuffer(4));
let nextId = 0;
const io = (perform) => {
  const deadline = Date.now() + 840_000;
  for (;;) {
    try {
      return perform();
    } catch (error) {
      if (!['EAGAIN', 'EINTR'].includes(error.code) || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 2);
    }
  }
};
const readExactly = (length) => {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = io(() => readSync(3, bytes, offset, length - offset, null));
    if (!count) throw new Error('NATIVE_ENGINE_PORT_CLOSED');
    offset += count;
  }
  return bytes;
};
const writeExactly = (bytes) => {
  let offset = 0;
  while (offset < bytes.length) {
    const count = io(() => writeSync(3, bytes, offset, bytes.length - offset));
    if (!count) throw new Error('NATIVE_ENGINE_PORT_CLOSED');
    offset += count;
  }
};
export const request = (value) => {
  const id = ++nextId;
  const body = Buffer.from(JSON.stringify({ id, ...value }));
  if (body.length > LIMIT) throw new Error('NATIVE_ENGINE_PORT_LIMIT');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  writeExactly(Buffer.concat([header, body]));
  const length = readExactly(4).readUInt32BE();
  if (!length || length > LIMIT) throw new Error('NATIVE_ENGINE_PORT_LIMIT');
  const response = JSON.parse(readExactly(length).toString('utf8'));
  if (response.id !== id) throw new Error('NATIVE_ENGINE_PORT_IDENTITY');
  if (response.error) throw new Error(response.error);
  return response.value;
};

export const spawnSync = (command, args = [], options = {}) => {
  const result = request({
    kind: 'process',
    command,
    args,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    timeoutMs: options.timeout ?? null,
    input: options.input === undefined ? null : Buffer.from(options.input).toString('base64'),
  });
  const decode = (value) => {
    const bytes = Buffer.from(value, 'base64');
    return options.encoding && options.encoding !== 'buffer'
      ? bytes.toString(options.encoding)
      : bytes;
  };
  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  return {
    pid: 0,
    status: result.exitCode,
    signal: result.signal ?? null,
    stdout,
    stderr,
    output: [null, stdout, stderr],
    ...(Number.isFinite(result.nativeExecutionMs)
      ? { nativeExecutionMs: result.nativeExecutionMs }
      : {}),
    ...(result.error
      ? { error: Object.assign(new Error(result.error), { code: result.error }) }
      : {}),
  };
};
export const execFileSync = (command, args = [], options = {}) => {
  const result = spawnSync(command, args, options);
  if (result.status !== 0) throw Object.assign(new Error('NATIVE_ENGINE_CHILD_FAILED'), result);
  return result.stdout;
};
export const execSync = (command, options = {}) =>
  execFileSync('/bin/sh', ['-c', command], options);
export const spawn = () => {
  throw new Error('NATIVE_ENGINE_ASYNC_PROCESS_UNSUPPORTED');
};
