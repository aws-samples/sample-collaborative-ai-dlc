import { describe, expect, it, vi } from 'vitest';
import { qualifyAgentAuthRuntime } from '../agent-auth-runtime-capabilities.js';
import { prepareAgentInvocation } from '../agent-credential-service.js';
import { normalizeConnection } from '../agent-auth-catalog.js';
import { connectionBinding } from '../agent-binding-selection.js';
it('probes the actual default target without credentials before qualifying IAM', async () => {
  const runtime = {
    send: vi.fn(async () => ({
      response: {
        transformToString: async () =>
          JSON.stringify({ ok: true, agentAuthProtocol: 2, agentAuthModes: ['keys', 'iam'] }),
      },
    })),
  };
  const snapshot = { runtimeArn: 'runtime', runtimeEndpoint: 'published' };
  expect(await qualifyAgentAuthRuntime(snapshot, { runtime, env: {} })).toEqual({
    agentAuthProtocol: 2,
    agentAuthModes: ['keys', 'iam'],
  });
  const input = runtime.send.mock.calls[0][0].input;
  expect(input).toMatchObject({ agentRuntimeArn: 'runtime', qualifier: 'published' });
  expect(JSON.parse(input.payload.toString())).toEqual({ command: 'capabilities' });
});
it('qualifies the deployed image after older qualification sessions have been pinned', async () => {
  let deployedModes = ['keys'];
  const sessions = new Map();
  const runtime = {
    send: vi.fn(async ({ input }) => {
      if (!sessions.has(input.runtimeSessionId))
        sessions.set(input.runtimeSessionId, deployedModes);
      return {
        response: {
          transformToString: async () =>
            JSON.stringify({
              ok: true,
              agentAuthProtocol: 2,
              agentAuthModes: sessions.get(input.runtimeSessionId),
            }),
        },
      };
    }),
  };
  const snapshot = { runtimeArn: 'runtime', runtimeEndpoint: 'published' };
  expect((await qualifyAgentAuthRuntime(snapshot, { runtime })).agentAuthModes).toEqual(['keys']);
  deployedModes = ['keys', 'iam'];
  expect(
    (await qualifyAgentAuthRuntime(snapshot, { runtime, requiredModes: ['iam'] })).agentAuthModes,
  ).toEqual(['keys', 'iam']);
});
describe('qualification before IAM grants', () => {
  const binding = connectionBinding(
    normalizeConnection({
      id: 'iam',
      revision: 1,
      mode: 'iam',
      backend: 'bedrock',
      mechanism: 'assume-role',
      source: 'platform',
      configuration: { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' },
    }),
    1,
  );
  it('fails closed on unsupported runtimes before minting a grant', async () => {
    const issueGrant = vi.fn();
    await expect(
      prepareAgentInvocation(
        { purpose: 'execution', credentialBinding: binding },
        {
          issueGrant,
          qualifyRuntime: async () => ({ agentAuthProtocol: 2, agentAuthModes: ['keys'] }),
        },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
    expect(issueGrant).not.toHaveBeenCalled();
  });
  it('qualifies default snapshots and issues the exact pinned IAM binding', async () => {
    const issueGrant = vi.fn(async () => 'signed');
    const prepared = await prepareAgentInvocation(
      { purpose: 'compose', projectId: 'p', credentialBinding: binding },
      {
        issueGrant,
        qualifyRuntime: async () => ({ agentAuthProtocol: 2, agentAuthModes: ['keys', 'iam'] }),
      },
    );
    expect(prepared.agentCredentialGrant).toBe('signed');
    expect(issueGrant.mock.calls[0][0].bindings).toEqual([binding]);
  });
});

describe('fallback qualification on the Instances compute type', () => {
  const instancesSnapshot = {
    runtimeArn: 'runtime',
    runtimeEndpoint: 'published',
    capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
  };

  it('uses the evidence recorded by the revision validation, without a probe session', async () => {
    const runtime = { send: vi.fn() };
    const snapshot = {
      ...instancesSnapshot,
      agentAuthProtocol: 2,
      agentAuthModes: ['keys', 'iam'],
    };
    expect(await qualifyAgentAuthRuntime(snapshot, { runtime, requiredModes: ['iam'] })).toBe(
      snapshot,
    );
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it('refuses without opening a session when the evidence is missing', async () => {
    const runtime = { send: vi.fn() };
    await expect(
      qualifyAgentAuthRuntime(instancesSnapshot, { runtime, env: {}, requiredModes: ['iam'] }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
    await expect(
      qualifyAgentAuthRuntime(
        { ...instancesSnapshot, agentAuthProtocol: 2, agentAuthModes: ['keys'] },
        { runtime, env: {}, requiredModes: ['iam'] },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
    expect(runtime.send).not.toHaveBeenCalled();
  });
});
