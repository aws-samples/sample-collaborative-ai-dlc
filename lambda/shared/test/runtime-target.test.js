import { describe, expect, it, vi } from 'vitest';
import { resolveRuntimeTarget, runtimeTargetInput } from '../runtime-target.js';
import { laneSessionIdFor, runtimeSessionIdFor } from '../intent-deletion.js';
import { stopSessions } from '../runtime-session.js';

describe('runtime target snapshots', () => {
  it('refuses native META, including a supplied environment or alleged binding', () => {
    const meta = {
      executionBackend: 'native',
      environment: { runtimeArn: 'shared-runtime', runtimeEndpoint: 'DEFAULT' },
      nativeRuntimeBinding: { status: 'READY', runtimeArn: 'alleged-native-runtime' },
    };
    expect(() => runtimeTargetInput(meta, 'fallback')).toThrow(
      expect.objectContaining({ code: 'native_runtime_binding_required' }),
    );
  });

  it.each([null, '', 'future', false])('refuses invalid backend %j', (executionBackend) => {
    expect(() => resolveRuntimeTarget({ executionBackend }, 'fallback')).toThrow(
      expect.objectContaining({ code: 'invalid_execution_backend' }),
    );
  });

  it('resolves the immutable runtime ARN and endpoint from execution metadata', () => {
    const meta = {
      environment: {
        runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed',
        runtimeEndpoint: 'revision_r_1',
      },
    };
    expect(resolveRuntimeTarget(meta, 'fallback')).toEqual({
      agentRuntimeArn: meta.environment.runtimeArn,
      qualifier: 'revision_r_1',
      capacityProviderArn: null,
    });
    expect(runtimeTargetInput(meta, 'fallback')).toEqual({
      agentRuntimeArn: meta.environment.runtimeArn,
      qualifier: 'revision_r_1',
    });
  });

  it('carries the capacity provider of an Instances-backed snapshot', () => {
    const meta = {
      environmentSnapshot: {
        runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed',
        runtimeEndpoint: 'revision_r_1',
        capacityProviderArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:capacity-provider/cp-1',
      },
    };
    expect(resolveRuntimeTarget(meta).capacityProviderArn).toBe(
      'arn:aws:bedrock-agentcore:eu-west-1:123:capacity-provider/cp-1',
    );
    // The SDK-shaped input never leaks the provider.
    expect(runtimeTargetInput(meta)).toEqual({
      agentRuntimeArn: meta.environmentSnapshot.runtimeArn,
      qualifier: 'revision_r_1',
    });
  });

  it('keeps legacy executions on the deployment runtime without a qualifier', () => {
    expect(runtimeTargetInput({}, 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core')).toEqual({
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core',
    });
  });

  it('keeps explicit platform executions on their existing fallback', () => {
    expect(runtimeTargetInput({ executionBackend: 'platform' }, 'platform-runtime')).toEqual({
      agentRuntimeArn: 'platform-runtime',
    });
  });

  it('uses the snapshotted endpoint for the main and parallel session stops', async () => {
    const agentcore = { send: vi.fn().mockResolvedValue({}) };
    const target = {
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed',
      qualifier: 'revision_r_1',
    };
    await stopSessions({
      client: agentcore,
      target,
      sessionIds: [
        runtimeSessionIdFor('intent-1'),
        laneSessionIdFor('intent-1', 2, 'api'),
        laneSessionIdFor('intent-1', 2, 'ui'),
      ],
    });

    expect(agentcore.send).toHaveBeenCalledTimes(3);
    expect(agentcore.send.mock.calls.map(([command]) => command.input)).toEqual([
      { ...target, runtimeSessionId: runtimeSessionIdFor('intent-1') },
      { ...target, runtimeSessionId: laneSessionIdFor('intent-1', 2, 'api') },
      { ...target, runtimeSessionId: laneSessionIdFor('intent-1', 2, 'ui') },
    ]);
  });
});
