import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const probe = fileURLToPath(new URL('./fixtures/execution-worker-warm.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../execution-worker.js', import.meta.url));

describe('native worker warm invocation connections', () => {
  it.each(['execution', 'cancellation'])(
    '%s polls reuse transport connections and keep each queued identity',
    async (mode) => {
      const { stdout } = await run(process.execPath, [probe, worker, mode], {
        timeout: 20_000,
        maxBuffer: 16 * 1024,
      });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        mode,
        invocations: 64,
        requests: 64,
        failedInvocations: 0,
        identitiesMatch: true,
        warnings: 0,
        boundedConnections: true,
        sdkTransport: 'real',
        endpoint: 'loopback-only',
      });
      expect(result.maximumConnections).toBeLessThanOrEqual(2);
    },
    30_000,
  );
});
