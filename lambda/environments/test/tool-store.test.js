import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TOOL_TEMPLATE_REVISION, SYSTEM_TOOL_TEMPLATES } from '../tool-catalog.js';
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
      systemTemplateRevision: SYSTEM_TOOL_TEMPLATE_REVISION,
    });

    expect(created).toMatchObject({
      versionId: 'tv-java-21',
      status: 'DRAFT',
      definition: { version: '21.0.8' },
      systemTemplateRevision: SYSTEM_TOOL_TEMPLATE_REVISION,
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

  it('reconciles failed system versions once when the shipped template changes', async () => {
    const versions = new Map(
      SYSTEM_TOOL_TEMPLATES.map((template) => [
        template.toolId,
        {
          toolId: template.toolId,
          versionId: `tv-${template.toolId}`,
          status: template.toolId === 'rust' ? 'FAILED' : 'READY',
          definition: template.version,
          system: true,
          autoBuild: false,
          systemTemplateRevision: template.toolId === 'rust' ? 0 : SYSTEM_TOOL_TEMPLATE_REVISION,
        },
      ]),
    );
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        const { Key } = command.input;
        if (command.constructor.name === 'GetCommand') {
          const toolId = Key.pk.slice('TOOL#'.length);
          if (Key.sk === 'META') return { Item: { toolId } };
          if (Key.sk.startsWith('VERSION_NAME#')) {
            return { Item: { toolId, versionId: `tv-${toolId}` } };
          }
          if (Key.sk.startsWith('VERSION#')) return { Item: versions.get(toolId) };
        }
        if (command.constructor.name === 'UpdateCommand') {
          const toolId = Key.pk.slice('TOOL#'.length);
          const updated = {
            ...versions.get(toolId),
            definition: command.input.ExpressionAttributeValues[':definition'],
            autoBuild: command.input.ExpressionAttributeValues[':autoBuild'],
            systemTemplateRevision:
              command.input.ExpressionAttributeValues[':systemTemplateRevision'],
          };
          versions.set(toolId, updated);
          return { Attributes: updated };
        }
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const store = createToolStore({ ddb, tableName: 'registry' });

    const reconciled = await store.seedSystemTools();

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      toolId: 'rust',
      status: 'FAILED',
      autoBuild: true,
      systemTemplateRevision: SYSTEM_TOOL_TEMPLATE_REVISION,
      definition: {
        installer: {
          script: expect.stringContaining('--components="$components"'),
        },
      },
    });
    expect(
      ddb.send.mock.calls.filter(([command]) => command.constructor.name === 'UpdateCommand'),
    ).toHaveLength(1);
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

  it('aliases every updated field so DynamoDB reserved words remain valid', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Item: {
            toolId: 'java',
            versionId: 'tv-java-21',
            status: 'DRAFT',
            definition: java.version,
          },
        })
        .mockResolvedValueOnce({ Attributes: { status: 'QUEUED' } }),
    };
    const store = createToolStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-13T00:00:00.000Z',
    });

    await store.updateVersion(
      'java',
      'tv-java-21',
      {
        status: 'QUEUED',
        definition: java.version,
        source: { digest: 'sha256:source' },
      },
      { fromStatus: 'DRAFT' },
    );

    const update = ddb.send.mock.calls[1][0].input;
    expect(update.UpdateExpression).toContain('#definition = :definition');
    expect(update.UpdateExpression).toContain('#source = :source');
    expect(update.ExpressionAttributeNames).toMatchObject({
      '#status': 'status',
      '#definition': 'definition',
      '#source': 'source',
    });
    expect(update.UpdateExpression).not.toMatch(/(?:^|, )definition =/);
  });

  it('updates a version only while it still describes the same image', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockImplementation(async (command) =>
          command.input.Key ? { Item: { status: 'SECURITY_REVIEW' }, Attributes: {} } : {},
        ),
    };
    const store = createToolStore({ ddb, tableName: 'registry', clock: () => 'now' });

    await store.updateVersion(
      'go',
      'tv-go-1',
      { status: 'READY' },
      { fromStatus: 'SECURITY_REVIEW', imageDigest: 'sha256:abc' },
    );

    const update = ddb.send.mock.calls.at(-1)[0].input;
    expect(update.ConditionExpression).toBe(
      '#status = :fromStatus AND #expectedImageDigest = :expectedImageDigest',
    );
    expect(update.ExpressionAttributeNames['#expectedImageDigest']).toBe('imageDigest');
    expect(update.ExpressionAttributeValues[':expectedImageDigest']).toBe('sha256:abc');
  });

  it('updates a version only while it still holds the scan a decision was made on', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockImplementation(async (command) =>
          command.input.Key ? { Item: { status: 'SECURITY_REVIEW' }, Attributes: {} } : {},
        ),
    };
    const store = createToolStore({ ddb, tableName: 'registry', clock: () => 'now' });

    await store.updateVersion(
      'go',
      'tv-go-1',
      { status: 'READY' },
      {
        fromStatus: 'SECURITY_REVIEW',
        imageDigest: 'sha256:abc',
        scanEvaluatedAt: '2026-11-27T10:00:00.000Z',
      },
    );
    const update = ddb.send.mock.calls.at(-1)[0].input;
    expect(update.ConditionExpression).toBe(
      '#status = :fromStatus AND #expectedImageDigest = :expectedImageDigest AND #expectedScan.#expectedScanEvaluatedAt = :expectedScanEvaluatedAt',
    );
    expect(update.ExpressionAttributeNames).toMatchObject({
      '#expectedScan': 'scanFindings',
      '#expectedScanEvaluatedAt': 'evaluatedAt',
    });
    expect(update.ExpressionAttributeValues[':expectedScanEvaluatedAt']).toBe(
      '2026-11-27T10:00:00.000Z',
    );

    // A scan stored without a time: the decision holds only while none is recorded.
    await store.updateVersion(
      'go',
      'tv-go-1',
      { status: 'READY' },
      { fromStatus: 'SECURITY_REVIEW', scanEvaluatedAt: null },
    );
    const legacy = ddb.send.mock.calls.at(-1)[0].input;
    expect(legacy.ConditionExpression).toBe(
      '#status = :fromStatus AND attribute_not_exists(#expectedScan.#expectedScanEvaluatedAt)',
    );
    expect(legacy.ExpressionAttributeValues).not.toHaveProperty(':expectedScanEvaluatedAt');
  });

  it('claims the next scan check of a version under review once', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    const store = createToolStore({ ddb, tableName: 'registry' });

    await expect(
      store.claimScanRecheck('go', 'tv-go-1', { previous: null, at: '2026-11-25T12:00:00.000Z' }),
    ).resolves.toBe(true);
    const first = ddb.send.mock.calls[0][0].input;
    expect(first).toMatchObject({
      UpdateExpression: 'SET #recheckedAt = :at',
      ConditionExpression: '#status = :review AND attribute_not_exists(#recheckedAt)',
      ExpressionAttributeValues: {
        ':at': '2026-11-25T12:00:00.000Z',
        ':review': 'SECURITY_REVIEW',
      },
    });
    // The status index is not rewritten by a check.
    expect(first.UpdateExpression).not.toContain('GSI1');

    await store.claimScanRecheck('go', 'tv-go-1', {
      previous: '2026-11-25T12:00:00.000Z',
      at: '2026-11-25T12:15:00.000Z',
    });
    expect(ddb.send.mock.calls[1][0].input).toMatchObject({
      ConditionExpression: '#status = :review AND #recheckedAt = :previous',
      ExpressionAttributeValues: { ':previous': '2026-11-25T12:00:00.000Z' },
    });

    ddb.send.mockRejectedValueOnce(
      Object.assign(new Error('taken'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(store.claimScanRecheck('go', 'tv-go-1', { previous: null })).resolves.toBe(false);
    ddb.send.mockRejectedValueOnce(
      Object.assign(new Error('down'), { name: 'InternalServerError' }),
    );
    await expect(store.claimScanRecheck('go', 'tv-go-1', { previous: null })).rejects.toThrow(
      'down',
    );
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
