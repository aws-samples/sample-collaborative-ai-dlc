import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  DeleteCapacityProviderSessionCommand,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  fetchRuntimeCapabilities,
  resolveProjectRuntimeTarget,
  verifyMcpServers,
} from '../index.js';
import { TEST_CONNECTION_MODE } from '../../shared/test/helpers/auth-modes.js';

// A registered non-keys mode stands in for whichever provider a deployment adds.
vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) =>
  (await import('../../shared/test/helpers/auth-modes.js')).withAuthModes(importOriginal),
);

const CORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core';
const MANAGED_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed';
const REGISTRY_TABLE = 'environment-registry';
const ddbMock = mockClient(DynamoDBDocumentClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);

const projectTraversal = (environmentId) => {
  const traversal = {
    V: vi.fn(() => traversal),
    has: vi.fn(() => traversal),
    valueMap: vi.fn(() => traversal),
    next: vi.fn().mockResolvedValue({
      done: false,
      value: new Map([['environment_id', [environmentId]]]),
    }),
  };
  return traversal;
};

const runtimeResponse = (value) => ({
  response: { transformToString: async () => JSON.stringify(value) },
});

describe('agent utility runtime routing', () => {
  beforeEach(() => {
    ddbMock.reset();
    agentcoreMock.reset();
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', CORE_RUNTIME_ARN);
    vi.stubEnv('ENVIRONMENT_REGISTRY_TABLE', REGISTRY_TABLE);
    vi.stubEnv('RUNTIME_COMPATIBILITY_VERSION', '1');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', 'g'.repeat(48));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the managed runtime and revision qualifier assigned to a project', async () => {
    ddbMock.on(GetCommand).callsFake(async (input) => {
      if (input.Key.sk === 'META') {
        return {
          Item: {
            environmentId: 'env-1',
            name: 'Managed environment',
            status: 'PUBLISHED',
            publishedRevisionId: 'r-1',
          },
        };
      }
      return {
        Item: {
          revisionId: 'r-1',
          status: 'PUBLISHED',
          imageDigest: 'sha256:managed',
          runtimeArn: MANAGED_RUNTIME_ARN,
          runtimeEndpoint: 'revision_r_1',
          runtimeCompatibilityVersion: '1',
          verification: { status: 'PASSED' },
        },
      };
    });

    await expect(
      resolveProjectRuntimeTarget(projectTraversal('env-1'), 'project-1'),
    ).resolves.toEqual({
      agentRuntimeArn: MANAGED_RUNTIME_ARN,
      qualifier: 'revision_r_1',
    });
  });

  it('passes the resolved managed target to capability and MCP verification probes', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).callsFake(async (input) => {
      const payload = JSON.parse(Buffer.from(input.payload).toString());
      return runtimeResponse(payload.command === 'capabilities' ? { clis: [] } : { results: {} });
    });
    const runtimeTarget = {
      agentRuntimeArn: MANAGED_RUNTIME_ARN,
      qualifier: 'revision_r_1',
    };

    await fetchRuntimeCapabilities(runtimeTarget);
    await verifyMcpServers({
      mcpServersByTier: { global: {}, project: {} },
      projectId: 'project-1',
      runtimeTarget,
    });

    const calls = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[0].input).toMatchObject(runtimeTarget);
    }
  });

  it('keeps global capability discovery on the protected core runtime', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves(runtimeResponse({ clis: [] }));

    await fetchRuntimeCapabilities();

    const input = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(input.agentRuntimeArn).toBe(CORE_RUNTIME_ARN);
    expect(input).not.toHaveProperty('qualifier');
  });

  it('discovers a new mode after a deployment while older sessions still run the key-only image', async () => {
    const mode = TEST_CONNECTION_MODE.id;
    let deployedModes = ['keys'];
    const sessions = new Map();
    agentcoreMock.on(InvokeAgentRuntimeCommand).callsFake(async (input) => {
      if (!sessions.has(input.runtimeSessionId))
        sessions.set(input.runtimeSessionId, deployedModes);
      const modes = sessions.get(input.runtimeSessionId);
      const payload = JSON.parse(Buffer.from(input.payload).toString());
      const authed = modes.includes(mode) && Boolean(payload.agentCredentialGrant);
      return runtimeResponse({
        ok: true,
        agentAuthProtocol: 2,
        agentAuthModes: modes,
        clis: [{ cli: 'claude', installed: true, authed, available: authed }],
      });
    });

    expect((await fetchRuntimeCapabilities()).agentAuthModes).toEqual(['keys']);
    deployedModes = ['keys', mode];
    const caps = await fetchRuntimeCapabilities(undefined, {
      bedrock: {
        version: 2,
        provider: 'bedrock',
        source: 'platform',
        connectionId: 'platform-test-connection',
        connectionRevision: 1,
        policyRevision: 1,
        mode,
        backend: 'bedrock',
        mechanism: 'oauth-machine',
        configuration: { region: 'eu-west-1' },
      },
    });
    expect(caps.clis).toEqual([{ cli: 'claude', installed: true, authed: true, available: true }]);
    // Qualification and credential redemption must inspect the same fresh image.
    const calls = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand);
    expect(calls).toHaveLength(3);
    expect(calls[1].args[0].input.runtimeSessionId).not.toBe(
      calls[0].args[0].input.runtimeSessionId,
    );
    expect(calls[1].args[0].input.runtimeSessionId).toBe(calls[2].args[0].input.runtimeSessionId);
    expect(sessions.get(calls[0].args[0].input.runtimeSessionId)).toEqual(['keys']);
  });

  describe('probes against an Instances runtime', () => {
    const CP_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123:capacity-provider/cp-9';
    const instancesTarget = {
      agentRuntimeArn: MANAGED_RUNTIME_ARN,
      qualifier: 'revision_r_1',
      capacityProviderArn: CP_ARN,
    };
    const timeline = () => {
      const steps = [];
      ddbMock.on(PutCommand).callsFake(async (input) => {
        steps.push(['own', input.Item.sessionId, input.Item]);
        return {};
      });
      ddbMock.on(DeleteCommand).callsFake(async (input) => {
        steps.push(['disown', input.Key.pk]);
        return {};
      });
      agentcoreMock.on(InvokeAgentRuntimeCommand).callsFake(async (input) => {
        steps.push(['invoke', input.runtimeSessionId, input]);
        const payload = JSON.parse(Buffer.from(input.payload).toString());
        return runtimeResponse(payload.command === 'capabilities' ? { clis: [] } : { results: {} });
      });
      agentcoreMock.on(StopRuntimeSessionCommand).callsFake(async (input) => {
        steps.push(['stop', input.runtimeSessionId, input]);
        return {};
      });
      agentcoreMock.on(DeleteCapacityProviderSessionCommand).callsFake(async (input) => {
        steps.push(['delete', input.sessionId, input]);
        return {};
      });
      return steps;
    };

    it('carries the capacity provider from the space snapshot, outside the SDK input', async () => {
      ddbMock.on(GetCommand).callsFake(async (input) =>
        input.Key.sk === 'META'
          ? { Item: { environmentId: 'ec2', status: 'PUBLISHED', publishedRevisionId: 'r-1' } }
          : {
              Item: {
                revisionId: 'r-1',
                status: 'PUBLISHED',
                imageDigest: 'sha256:x',
                runtimeArn: MANAGED_RUNTIME_ARN,
                runtimeEndpoint: 'revision_r_1',
                runtimeCompatibilityVersion: '1',
                capacityProviderArn: CP_ARN,
                verification: { status: 'PASSED' },
              },
            },
      );
      await expect(
        resolveProjectRuntimeTarget(projectTraversal('ec2'), 'project-1'),
      ).resolves.toEqual(instancesTarget);
    });

    for (const [name, probe] of [
      ['capabilities', () => fetchRuntimeCapabilities(instancesTarget, {}, 'project-1')],
      [
        'verify-mcp',
        () =>
          verifyMcpServers({
            mcpServersByTier: { global: {}, project: {} },
            projectId: 'project-1',
            runtimeTarget: instancesTarget,
          }),
      ],
    ]) {
      it(`${name}: owns the session before invoking it and releases it afterwards`, async () => {
        const steps = timeline();
        await probe();
        const kinds = steps.map(([kind]) => kind);
        expect(kinds[0]).toBe('own');
        expect(kinds.slice(-3)).toEqual(['stop', 'delete', 'disown']);
        const session = steps[0][1];
        expect(steps.filter(([kind]) => kind === 'invoke').every(([, id]) => id === session)).toBe(
          true,
        );
        expect(steps[0][2]).toMatchObject({
          capacityProviderArn: CP_ARN,
          notBefore: expect.any(String),
        });
        for (const [, , input] of steps.filter(([kind]) => kind === 'invoke')) {
          expect(input).not.toHaveProperty('capacityProviderArn');
        }
      });
    }

    it('does not invoke when the ownership record cannot be written', async () => {
      ddbMock.on(PutCommand).rejects(new Error('registry unavailable'));
      agentcoreMock.on(InvokeAgentRuntimeCommand).resolves(runtimeResponse({ results: {} }));
      const result = await verifyMcpServers({
        mcpServersByTier: { global: {}, project: {} },
        projectId: 'project-1',
        runtimeTarget: instancesTarget,
      });
      expect(result.error).toMatch(/registry unavailable/);
      expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
    });

    it('keeps the record (the poller finishes it) when the response is lost and the delete fails', async () => {
      const steps = timeline();
      agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error('socket hang up'));
      agentcoreMock
        .on(DeleteCapacityProviderSessionCommand)
        .rejects(Object.assign(new Error('internal'), { name: 'InternalServerException' }));
      const result = await verifyMcpServers({
        mcpServersByTier: { global: {}, project: {} },
        projectId: 'project-1',
        runtimeTarget: instancesTarget,
      });
      expect(result.error).toMatch(/socket hang up/);
      // Stopped and a delete attempted; the record is never removed.
      expect(steps.map(([kind]) => kind)).toEqual(['own', 'stop']);
      expect(agentcoreMock.commandCalls(DeleteCapacityProviderSessionCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });
});
