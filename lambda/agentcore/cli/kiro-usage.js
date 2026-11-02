import { buildKiroUsage, getDriver, parseKiroCreditRate } from './drivers.js';
import { captureChild } from './spawn.js';

// /usage does not spend credits. Cache its overage rate for the container life;
// a lost credential or timeout leaves the cache empty so the next invocation retries.
let cachedKiroCreditRate;
export const resetKiroCreditRateCache = () => {
  cachedKiroCreditRate = undefined;
};

export const captureKiroCreditRate = async ({ env, workspaceDir, spawnFn }) => {
  if (cachedKiroCreditRate !== undefined) return cachedKiroCreditRate;
  const usage = buildKiroUsage();
  const { stdout, stderr, credentialError, timedOut } = await captureChild({
    command: usage.command,
    args: usage.args,
    env: getDriver('kiro').envForAuth(env),
    cwd: workspaceDir,
    captureStderr: true,
    timeoutMs: 10_000,
    spawnFn,
  });
  const rate = parseKiroCreditRate(`${stderr ?? ''}\n${stdout ?? ''}`);
  if (rate == null && (credentialError || timedOut)) return null;
  cachedKiroCreditRate = rate;
  return rate;
};
