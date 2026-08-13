import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TOOL_TEMPLATES } from '../tool-catalog.js';
import { createToolStore } from '../tool-store.js';

const java = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'java');

describe('managed tool registry store', () => {
  it('creates immutable version and version-name records atomically', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    const store = createToolStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-13T00:00:00.000Z',
      ids: () => 'java-21',
    });
    const tool = { toolId: 'java' };

    const created = await store.createVersion({
      tool,
      definition: java.version,
      createdBy: 'admin@example.com',
    });

    expect(created).toMatchObject({
      versionId: 'tv-java-21',
      status: 'DRAFT',
      definition: { version: '21.0.8' },
    });
    const transaction = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(transaction[0].Put.Item).toMatchObject({
      pk: 'TOOL#java',
      sk: 'VERSION#tv-java-21',
    });
    expect(transaction[1].Put.Item).toMatchObject({
      pk: 'TOOL#java',
      sk: 'VERSION_NAME#21.0.8',
      versionId: 'tv-java-21',
    });
  });

  it('rejects definition changes after a build starts', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({
        Item: {
          toolId: 'java',
          versionId: 'tv-java-21',
          status: 'BUILDING',
          definition: java.version,
        },
      }),
    };
    const store = createToolStore({ ddb, tableName: 'registry' });

    await expect(
      store.updateVersion('java', 'tv-java-21', { definition: java.version }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it('publishes only READY versions with an atomic status transition', async () => {
    const published = {
      toolId: 'java',
      versionId: 'tv-java-21',
      status: 'PUBLISHED',
      definition: java.version,
    };
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'TransactWriteCommand') return {};
        if (command.constructor.name === 'GetCommand') return { Item: published };
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const store = createToolStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-13T00:00:00.000Z',
    });

    await expect(
      store.publishVersion({
        tool: { toolId: 'java' },
        version: { ...published, status: 'FAILED' },
        actor: 'admin@example.com',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      store.publishVersion({
        tool: { toolId: 'java' },
        version: { ...published, status: 'READY' },
        actor: 'admin@example.com',
      }),
    ).resolves.toEqual(published);
    const transaction = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(transaction[0].Update).toMatchObject({
      ConditionExpression: '#status = :ready',
      ExpressionAttributeValues: expect.objectContaining({
        ':ready': 'READY',
        ':published': 'PUBLISHED',
      }),
    });
  });

  it('recommends only an already published version', async () => {
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'TransactWriteCommand') return {};
        if (command.constructor.name === 'GetCommand') {
          return {
            Item: {
              toolId: 'java',
              recommendedVersionId: 'tv-java-21',
            },
          };
        }
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const store = createToolStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-13T00:00:00.000Z',
    });

    await store.setRecommendedVersion({
      toolId: 'java',
      versionId: 'tv-java-21',
      actor: 'admin@example.com',
    });

    const transaction = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(transaction[0].ConditionCheck).toMatchObject({
      Key: { pk: 'TOOL#java', sk: 'VERSION#tv-java-21' },
      ConditionExpression: '#status = :published',
    });
    expect(transaction[1].Update.ExpressionAttributeValues).toMatchObject({
      ':versionId': 'tv-java-21',
      ':actor': 'admin@example.com',
    });
  });
});
