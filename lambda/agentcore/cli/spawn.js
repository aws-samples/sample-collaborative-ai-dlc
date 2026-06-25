// Headless CLI spawn shell — runs a driver invocation as a child process and
// resolves the exit contract the runner cares about: { exitCode }.
//
// shell:false (argv comes from the driver, never concatenated). The prompt is
// either on argv (default) or piped on stdin (promptViaStdin). stdout/stderr are
// inherited to the container log; the agent's human-facing output goes through
// the MCP send_output tool, not stdout parsing. `spawnFn` is injectable so the
// runner is fully testable with the child mocked.

import { spawn } from 'node:child_process';

export const runChild = ({
  command,
  args,
  env,
  cwd,
  prompt,
  promptViaStdin = false,
  spawnFn = spawn,
}) =>
  new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: [promptViaStdin ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    });
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode });
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
