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
  const sandbox = { enabled: true, version: 3, settings: {} };
  const readSandbox = vi.fn(async () => sandbox);
  expect(await qualifyAgentAuthRuntime(snapshot, { runtime, env: {}, readSandbox })).toEqual({
    agentAuthProtocol: 2,
    agentAuthModes: ['keys', 'iam'],
  });
  const input = runtime.send.mock.calls[0][0].input;
  expect(input).toMatchObject({ agentRuntimeArn: 'runtime', qualifier: 'published' });
  // The runtime cannot read the settings itself, so the probe carries them.
  expect(JSON.parse(input.payload.toString())).toEqual({
    command: 'capabilities',
    agentSandbox: sandbox,
  });
  expect(readSandbox).toHaveBeenCalledOnce();
});
it('sends a policy the caller already resolved without reading the settings', async () => {
  const runtime = {
    send: vi.fn(async () => ({
      response: {
        transformToString: async () =>
          JSON.stringify({ ok: true, agentAuthProtocol: 2, agentAuthModes: ['keys'] }),
      },
    })),
  };
  const readSandbox = vi.fn();
  const sandbox = { enabled: false, version: null, settings: {} };
  await qualifyAgentAuthRuntime(
    { runtimeArn: 'runtime', runtimeEndpoint: 'published' },
    { runtime, env: {}, sandbox, readSandbox },
  );
  expect(readSandbox).not.toHaveBeenCalled();
  expect(JSON.parse(runtime.send.mock.calls[0][0].input.payload.toString()).agentSandbox).toEqual(
    sandbox,
  );
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
  const sandbox = { enabled: false };
  expect((await qualifyAgentAuthRuntime(snapshot, { runtime, sandbox })).agentAuthModes).toEqual([
    'keys',
  ]);
  deployedModes = ['keys', 'iam'];
  expect(
    (await qualifyAgentAuthRuntime(snapshot, { runtime, sandbox, requiredModes: ['iam'] }))
      .agentAuthModes,
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
          readSandbox: async () => ({ enabled: false }),
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
        readSandbox: async () => ({ enabled: false }),
        qualifyRuntime: async () => ({ agentAuthProtocol: 2, agentAuthModes: ['keys', 'iam'] }),
      },
    );
    expect(prepared.agentCredentialGrant).toBe('signed');
    expect(prepared.agentSandbox).toEqual({ enabled: false });
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

describe('sandbox runtime qualification', () => {
  const snapshot = {
    runtimeArn: 'selected-runtime',
    runtimeEndpoint: 'published-revision',
    agentAuthProtocol: 2,
    agentAuthModes: ['keys'],
  };
  const runtimeFor = (sandboxEnforcement) => ({
    send: vi.fn(async () => ({
      response: {
        transformToString: async () =>
          JSON.stringify({ ok: true, ...snapshot, sandboxEnforcement }),
      },
    })),
  });

  it.each([undefined, false, 'true'])(
    'rejects an older or invalid runtime before issuing a standalone grant: %s',
    async (sandboxEnforcement) => {
      const runtime = runtimeFor(sandboxEnforcement);
      const issueGrant = vi.fn();
      await expect(
        prepareAgentInvocation(
          {
            purpose: 'compose',
            runtimeCapabilities: snapshot,
            credentialBinding: { provider: 'kiro', source: 'platform' },
          },
          {
            issueGrant,
            readSandbox: async () => ({ enabled: true }),
            qualifyRuntime: (capabilities, options) =>
              qualifyAgentAuthRuntime(capabilities, { ...options, runtime }),
          },
        ),
      ).rejects.toMatchObject({ code: 'AGENT_SANDBOX_RUNTIME_UNSUPPORTED' });
      expect(issueGrant).not.toHaveBeenCalled();
      expect(runtime.send.mock.calls[0][0].input).toMatchObject({
        agentRuntimeArn: 'selected-runtime',
        qualifier: 'published-revision',
      });
      expect(JSON.parse(runtime.send.mock.calls[0][0].input.payload).agentSandbox).toEqual({
        enabled: true,
      });
    },
  );

  it('accepts a runtime that reports enforcement and preserves the existing grant flow', async () => {
    const runtime = runtimeFor(true);
    const issueGrant = vi.fn(async () => 'grant');
    const result = await prepareAgentInvocation(
      {
        purpose: 'compose',
        runtimeCapabilities: snapshot,
        credentialBinding: { provider: 'kiro', source: 'platform' },
      },
      {
        issueGrant,
        readSandbox: async () => ({ enabled: true }),
        qualifyRuntime: (capabilities, options) =>
          qualifyAgentAuthRuntime(capabilities, { ...options, runtime }),
      },
    );
    expect(result.agentCredentialGrant).toBe('grant');
  });

  it('does not require sandbox support for a captured disabled policy', async () => {
    const qualifyRuntime = vi.fn();
    await prepareAgentInvocation(
      { purpose: 'execution', credentialBinding: { provider: 'kiro', source: 'platform' } },
      {
        issueGrant: async () => 'grant',
        readSandbox: async () => ({ enabled: false }),
        qualifyRuntime,
      },
    );
    expect(qualifyRuntime).not.toHaveBeenCalled();
  });

  it('uses verified Instances evidence and rejects its absence without allocating a session', async () => {
    const runtime = runtimeFor(true);
    const instances = { ...snapshot, capacityProviderArn: 'capacity-provider' };
    await expect(
      qualifyAgentAuthRuntime(instances, { runtime, requireSandbox: true }),
    ).rejects.toMatchObject({ code: 'AGENT_SANDBOX_RUNTIME_UNSUPPORTED' });
    await expect(
      qualifyAgentAuthRuntime(
        { ...instances, sandboxEnforcement: true },
        { runtime, requireSandbox: true },
      ),
    ).resolves.toMatchObject({ sandboxEnforcement: true });
    expect(runtime.send).not.toHaveBeenCalled();
  });
});
