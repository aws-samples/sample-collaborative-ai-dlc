import { describe, expect, it, vi } from 'vitest';
import { stopNativeExecutionSession } from '../execution-worker.js';
import { serialFixture } from './execution-serial-fixtures.js';

describe('AgentCore StopRuntimeSession confirmation', () => {
  it('uses the same token across worker retries and requires the exact returned session', async () => {
    const f = serialFixture();
    await f.ready();
    const row = f.row();
    const runtime = {
      send: vi.fn(async () => ({
        $metadata: { httpStatusCode: 200 },
        statusCode: 200,
        runtimeSessionId: row.runtimeSessionId,
      })),
    };
    const input = {
      runtime,
      draft: f.prepared,
      execution: row,
      recoveryId: '99999999-9999-4999-8999-999999999999',
      abortSignal: AbortSignal.timeout(1000),
    };
    expect(await stopNativeExecutionSession(input)).toMatchObject({ confirmed: true });
    await stopNativeExecutionSession({ ...input, execution: { ...row, version: row.version + 3 } });
    expect(runtime.send.mock.calls[0][0].input).toEqual(runtime.send.mock.calls[1][0].input);
    expect(runtime.send.mock.calls[0][0].input).toMatchObject({
      agentRuntimeArn: row.target.runtimeArn,
      qualifier: row.target.endpoint,
      runtimeSessionId: row.runtimeSessionId,
      clientToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    runtime.send.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200 },
      statusCode: 200,
      runtimeSessionId: 'wrong-session',
    });
    await expect(stopNativeExecutionSession(input)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED',
    });
    runtime.send.mockRejectedValueOnce(
      Object.assign(new Error('absent'), { name: 'ResourceNotFoundException' }),
    );
    await expect(stopNativeExecutionSession(input)).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
    });
  });
});
