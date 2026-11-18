// This entry runs inside bwrap, with the safe outer environment plus SRT's
// generated proxy settings. Only now give the harness its invocation variables.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const harnessEnvironment = (env, outerEnv, sandboxEnv) => {
  const result = { ...env };
  for (const [name, value] of Object.entries(sandboxEnv)) {
    if (value !== outerEnv[name]) result[name] = value;
  }
  for (const name of Object.keys(outerEnv)) {
    if (!(name in sandboxEnv)) delete result[name];
  }
  // AgentCore may not resolve localhost inside the network namespace. Keep
  // SRT's generated credentials and ports, changing only the loopback hostname.
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'GRPC_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'grpc_proxy',
  ]) {
    if (!result[name]) continue;
    const proxy = new URL(result[name]);
    if (proxy.hostname === 'localhost') {
      proxy.hostname = '127.0.0.1';
      result[name] = proxy.toString();
    }
  }
  return result;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { command, args, env, outerEnv } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const result = spawnSync(command, args, {
    env: harnessEnvironment(env, outerEnv, process.env),
    shell: false,
    stdio: 'inherit',
  });
  // Avoid printing spawn errors: they can contain arguments or environment data.
  // Signal termination must remain a failure across the wrapper processes.
  process.exit(result.status ?? 1);
}
