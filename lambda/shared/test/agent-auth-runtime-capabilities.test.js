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
