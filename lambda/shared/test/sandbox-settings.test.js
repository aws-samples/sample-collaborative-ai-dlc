import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_SANDBOX_CONFIG,
  captureSandboxSettings,
  readSandboxSettings,
  writeSandboxSettings,
} from '../sandbox-settings.js';

let tableName;
let client;
let ddb;
beforeEach(async () => {
  tableName = `sandbox-${randomUUID()}`;
  client = new DynamoDBClient({ endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
  ddb = DynamoDBDocumentClient.from(client);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    }),
  );
});
afterEach(async () => {
  await client?.send(new DeleteTableCommand({ TableName: tableName }));
  client?.destroy();
});

describe('platform sandbox persistence', () => {
  it.each([false, true])(
    'first enable applies the starter and preserves an existing draft: %s',
    async (hasDraft) => {
      const draft = {
        ...DEFAULT_SANDBOX_CONFIG.settings,
        network: { ...DEFAULT_SANDBOX_CONFIG.settings.network, deniedDomains: ['example.com'] },
      };
      if (hasDraft) {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: 'SETTINGS#SANDBOX',
              sk: 'CURRENT',
              revision: 1,
              enabled: false,
              applied: null,
              draft,
            },
          }),
        );
      }
      const active = await writeSandboxSettings({
        ddb,
        tableName,
        actor: 'admin',
        expectedRevision: hasDraft ? 1 : 0,
        action: 'toggle',
        enabled: true,
      });
      expect(active.enabled).toBe(true);
      expect(active.applied.settings).toEqual(DEFAULT_SANDBOX_CONFIG.settings);
      expect(active.draft).toEqual(hasDraft ? draft : DEFAULT_SANDBOX_CONFIG.settings);
      const persisted = await readSandboxSettings({ ddb, tableName });
      expect(captureSandboxSettings(persisted)).toEqual({
        enabled: true,
        version: active.revision,
        settings: DEFAULT_SANDBOX_CONFIG.settings,
      });
      const version = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: 'SETTINGS#SANDBOX', sk: `V#${active.revision}` },
        }),
      );
      expect(version.Item).toMatchObject(active.applied);
    },
  );

  it('does not overwrite a concurrent first Apply with the starter', async () => {
    const config = {
      ...DEFAULT_SANDBOX_CONFIG.settings,
      network: { ...DEFAULT_SANDBOX_CONFIG.settings.network, deniedDomains: ['example.com'] },
    };
    const write = (update) =>
      writeSandboxSettings({ ddb, tableName, actor: 'admin', expectedRevision: 0, ...update });
    const outcomes = await Promise.allSettled([
      write({ action: 'toggle', enabled: true }),
      write({ action: 'apply', config }),
    ]);
    const completed = outcomes.filter((result) => result.status === 'fulfilled');
    expect(completed).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected').reason.code).toBe(
      'sandbox_conflict',
    );
    const current = await readSandboxSettings({ ddb, tableName });
    expect(current.applied).toEqual(completed[0].value.applied);
    expect(current.enabled).toBe(completed[0].value.enabled);
  });

  it('keeps draft, Apply, toggle and captured policies independent with atomic conflicts', async () => {
    const initial = await readSandboxSettings({ ddb, tableName });
    expect(initial).toMatchObject({ revision: 0, enabled: false, applied: null, draft: null });
    const write = (update) => writeSandboxSettings({ ddb, tableName, actor: 'admin', ...update });
    const settings = DEFAULT_SANDBOX_CONFIG.settings;
    const draft = await write({ expectedRevision: 0, action: 'draft', config: settings });
    expect(draft).toMatchObject({ revision: 1, enabled: false, applied: null, draft: settings });
    const applied = await write({ expectedRevision: 1, action: 'apply', config: settings });
    expect(applied.enabled).toBe(false);
    const active = await write({ expectedRevision: 2, action: 'toggle', enabled: true });
    const captured = captureSandboxSettings(active);
    expect(captured).toEqual({ version: 2, enabled: true, settings });

    const restricted = structuredClone(settings);
    restricted.network.deniedDomains = ['example.com'];
    const outcomes = await Promise.allSettled([
      write({ expectedRevision: 3, action: 'draft', config: restricted }),
      write({ expectedRevision: 3, action: 'toggle', enabled: false }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected').reason.code).toBe(
      'sandbox_conflict',
    );
    const current = await readSandboxSettings({ ddb, tableName });
    expect(current.revision).toBe(4);
    expect(current.applied.settings).toEqual(settings);
    expect(captured).toEqual({ version: 2, enabled: true, settings });
    const version = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk: 'SETTINGS#SANDBOX', sk: 'V#2' } }),
    );
    expect(version.Item.settings).toEqual(settings);
    await expect(
      write({ expectedRevision: 2, action: 'apply', config: restricted }),
    ).rejects.toMatchObject({ code: 'sandbox_conflict' });
  });

  it('never treats a failed read or an invalid enabled record as disabled', async () => {
    const broken = { send: vi.fn().mockRejectedValue(new Error('AccessDenied')) };
    await expect(readSandboxSettings({ ddb: broken, tableName })).rejects.toThrow('AccessDenied');
    expect(() => captureSandboxSettings({ enabled: true, applied: null })).toThrow();
  });
});
