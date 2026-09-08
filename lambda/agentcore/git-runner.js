import { spawn } from 'node:child_process';

// AgentCore-owned Git commands must never execute hooks from a checked-out
// repository. Apply the override per invocation so repository and global Git
// configuration remain untouched.
export const NO_HOOKS_PATH = '/dev/null';
export const HOOKS_DISABLED_ARGS = Object.freeze(['-c', `core.hooksPath=${NO_HOOKS_PATH}`]);

const HOOKS_DISABLED_RUNNER = Symbol('hooks-disabled-git-runner');
const markHooksDisabled = (runner) =>
  Object.defineProperty(runner, HOOKS_DISABLED_RUNNER, { value: true });

// Preserve injected test-runner contracts while ensuring they observe the same
// command-scoped hook policy as the production process runner. Wrapping is
// idempotent so callers can safely pass an already protected runner through
// multiple orchestration layers.
export const withGitHooksDisabled = (runner) => {
  if (runner[HOOKS_DISABLED_RUNNER]) return runner;
  return markHooksDisabled((command, args, ...runnerArgs) =>
    runner(command, [...HOOKS_DISABLED_ARGS, ...args], ...runnerArgs),
  );
};

// The single production choke point for AgentCore-owned Git processes. Engine
// operations request captured output; workspace operations inherit output. Both
// receive the same command-scoped hook override before this one spawn call.
export const runGitCommand = markHooksDisabled(
  (
    command,
    args,
    { cwd, env = {}, spawnFn = spawn, captureOutput = false, inheritEnv = true } = {},
  ) =>
    new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const settle = (exitCode) => {
        if (settled) return;
        settled = true;
        resolve({ code: exitCode, exitCode, stdout, stderr });
      };

      let child;
      try {
        child = spawnFn(command, [...HOOKS_DISABLED_ARGS, ...args], {
          cwd,
          shell: false,
          env: inheritEnv ? { ...process.env, ...env } : env,
          stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        });
      } catch {
        settle(null);
        return;
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', () => settle(null));
      child.on('close', (exitCode) => settle(exitCode));
    }),
);
