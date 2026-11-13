// This is loaded by Bun in a separate, protected service. It is never loaded
// into an agent CLI and never claims to isolate mutually hostile processes.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnSync } from './process-port.mjs';

const modules = JSON.parse(readFileSync(process.env.NATIVE_ENGINE_MODULES, 'utf8'));
delete process.env.NATIVE_ENGINE_MODULES;
Bun.plugin({
  name: 'native-pinned-engine',
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?child_process$/ }, () => {
      throw new Error('NATIVE_ENGINE_UNMEDIATED_PROCESS');
    });
    build.onLoad({ filter: /.*/, namespace: 'file' }, ({ path }) => {
      if (!Object.hasOwn(modules, path) || realpathSync(path) !== path)
        throw new Error('NATIVE_ENGINE_MODULE_DENIED');
      const contents = readFileSync(path);
      if (createHash('sha256').update(contents).digest('hex') !== modules[path])
        throw new Error('NATIVE_ENGINE_MODULE_CHANGED');
      const extension = extname(path);
      return {
        contents: contents.toString('utf8'),
        loader:
          extension === '.ts'
            ? 'ts'
            : ['.js', '.mjs', '.cjs'].includes(extension)
              ? 'js'
              : extension === '.json'
                ? 'json'
                : extension === '.toml'
                  ? 'toml'
                  : 'text',
      };
    });
  },
});
Bun.spawnSync = (options, extra = {}) => {
  const input = Array.isArray(options) ? { ...extra, cmd: options } : options;
  const result = spawnSync(input.cmd[0], input.cmd.slice(1), {
    cwd: input.cwd,
    env: input.env,
    ...(typeof input.stdin === 'string' && input.stdin !== 'pipe' && input.stdin !== 'ignore'
      ? { input: input.stdin }
      : input.stdin instanceof Uint8Array
        ? { input: input.stdin }
        : {}),
  });
  if (input.stdout === 'inherit' && result.stdout) process.stdout.write(result.stdout);
  if (input.stderr === 'inherit' && result.stderr) process.stderr.write(result.stderr);
  return {
    exitCode: result.status,
    signalCode: result.signal,
    success: result.status === 0 && result.signal === null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
Bun.spawn = () => {
  throw new Error('NATIVE_ENGINE_ASYNC_PROCESS_UNSUPPORTED');
};
