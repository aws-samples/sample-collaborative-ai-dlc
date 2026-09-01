import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { invokeDiscussionAssist } from '../services.js';

const CORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core';
const MANAGED_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed';
const PROCESS_TABLE = 'process';
const ddbMock = mockClient(DynamoDBDocumentClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);

const invoke = () =>
  invokeDiscussionAssist({
    intentId: 'intent-1',
    payload: {
      command: 'discussion-assist-start',
      discussionId: 'discussion-1',
    },
  });

describe('discussion assist runtime routing', () => {
  beforeEach(() => {
    ddbMock.reset();
    agentcoreMock.reset();
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', CORE_RUNTIME_ARN);
    vi.stubEnv('V2_PROCESS_TABLE', PROCESS_TABLE);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ ok: true }) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the managed runtime from the intent snapshot when available', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        environment: {
          runtimeArn: MANAGED_RUNTIME_ARN,
          runtimeEndpoint: 'revision_r_1',
        },
      },
    });

    await expect(invoke()).resolves.toEqual({ ok: true });

    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input).toMatchObject({
      agentRuntimeArn: MANAGED_RUNTIME_ARN,
      qualifier: 'revision_r_1',
    });
  });

  it('falls back to the core runtime when the intent snapshot is missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(invoke()).resolves.toEqual({ ok: true });

    const input = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(input.agentRuntimeArn).toBe(CORE_RUNTIME_ARN);
    expect(input).not.toHaveProperty('qualifier');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('runtime snapshot missing'));
  });

  it('falls back to the core runtime when the snapshot lookup fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('throttled'));

    await expect(invoke()).resolves.toEqual({ ok: true });

    const input = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(input.agentRuntimeArn).toBe(CORE_RUNTIME_ARN);
    expect(input).not.toHaveProperty('qualifier');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });
});
