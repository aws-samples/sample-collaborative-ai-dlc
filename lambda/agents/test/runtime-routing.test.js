import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  fetchRuntimeCapabilities,
  resolveProjectRuntimeTarget,
  verifyMcpServers,
} from '../index.js';

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
});
