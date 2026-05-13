import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddbMock = mockClient(DynamoDBClient);

const TABLE = 'test-agent-outputs';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../get-agent-output.js')).handler;
};

describe('get-agent-output handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('AGENT_OUTPUTS_TABLE', TABLE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('executionId + agentType', () => {
    it('issues a GetItem against the outputs table with the composite key', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      const handler = await loadHandler();
      await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 1);
      expect(ddbMock).toHaveReceivedCommandWith(GetItemCommand, {
        TableName: TABLE,
        Key: {
          executionId: { S: 'exec-1' },
          agentType: { S: 'inception' },
        },
      });
    });

    it('returns empty tasks/outputText when no item is found', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({ tasks: [], outputText: '' });
    });

    it('merges parsed structured output over the base response', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'raw text' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
          output: {
            S: JSON.stringify({
              tasks: [{ id: 't1', title: 'Task one' }],
              outputText: 'structured text',
            }),
          },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'completed',
        outputText: 'structured text',
        completedAt: '2026-05-13T10:00:00Z',
        tasks: [{ id: 't1', title: 'Task one' }],
      });
    });

    it('falls back to the base response when output is malformed JSON', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'raw text' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
          output: { S: '{not valid json' },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'completed',
        outputText: 'raw text',
        completedAt: '2026-05-13T10:00:00Z',
      });
    });

    it('returns the base response when the item has no output field', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'running' },
          outputText: { S: 'partial text' },
          completedAt: { S: '' },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'review' });

      expect(res).toEqual({
        status: 'running',
        outputText: 'partial text',
        completedAt: '',
      });
    });

    it('defaults missing status/outputText/completedAt fields', async () => {
      ddbMock.on(GetItemCommand).resolves({ Item: {} });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'unknown',
        outputText: '',
        completedAt: '',
      });
    });

    it('keeps base fields when structured output omits them', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'raw text' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
          output: { S: JSON.stringify({ tasks: [{ id: 't1' }] }) },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'completed',
        outputText: 'raw text',
        completedAt: '2026-05-13T10:00:00Z',
        tasks: [{ id: 't1' }],
      });
    });

    it('returns the base response when output is an empty string', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'raw text' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
          output: { S: '' },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'completed',
        outputText: 'raw text',
        completedAt: '2026-05-13T10:00:00Z',
      });
    });

    it('returns the base response when output parses to null', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'raw text' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
          output: { S: 'null' },
        },
      });

      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1', agentType: 'inception' });

      expect(res).toEqual({
        status: 'completed',
        outputText: 'raw text',
        completedAt: '2026-05-13T10:00:00Z',
      });
    });

    it('takes the executionId+agentType path when sprintId is also present', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          status: { S: 'completed' },
          outputText: { S: 'from-execution' },
          completedAt: { S: '2026-05-13T10:00:00Z' },
        },
      });

      const handler = await loadHandler();
      const res = await handler({
        executionId: 'exec-1',
        agentType: 'inception',
        sprintId: 'sprint-1',
      });

      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 1);
      expect(res).toEqual({
        status: 'completed',
        outputText: 'from-execution',
        completedAt: '2026-05-13T10:00:00Z',
      });
    });
  });

  describe('sprintId only', () => {
    it('returns the empty placeholder and skips DynamoDB', async () => {
      const handler = await loadHandler();
      const res = await handler({ sprintId: 'sprint-1' });

      expect(res).toEqual({ tasks: [], outputText: '' });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
    });
  });

  describe('neither executionId+agentType nor sprintId', () => {
    it('returns the empty placeholder for an empty event', async () => {
      const handler = await loadHandler();
      const res = await handler({});

      expect(res).toEqual({ tasks: [], outputText: '' });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
    });

    it('returns the empty placeholder when only executionId is present', async () => {
      const handler = await loadHandler();
      const res = await handler({ executionId: 'exec-1' });

      expect(res).toEqual({ tasks: [], outputText: '' });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
    });

    it('returns the empty placeholder when only agentType is present', async () => {
      const handler = await loadHandler();
      const res = await handler({ agentType: 'inception' });

      expect(res).toEqual({ tasks: [], outputText: '' });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
    });
  });

  describe('error propagation', () => {
    it('rejects when DynamoDB GetItem fails', async () => {
      ddbMock.on(GetItemCommand).rejects(new Error('ProvisionedThroughputExceeded'));

      const handler = await loadHandler();

      await expect(
        handler({ executionId: 'exec-1', agentType: 'inception' }),
      ).rejects.toThrow('ProvisionedThroughputExceeded');
    });

    it('does not call DynamoDB on the placeholder paths even if it would reject', async () => {
      ddbMock.on(GetItemCommand).rejects(new Error('should-not-be-called'));

      const handler = await loadHandler();

      await expect(handler({ sprintId: 'sprint-1' })).resolves.toEqual({
        tasks: [],
        outputText: '',
      });
      await expect(handler({})).resolves.toEqual({ tasks: [], outputText: '' });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
    });
  });
});
