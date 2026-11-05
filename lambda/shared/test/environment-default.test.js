import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENVIRONMENT_KEY,
  readDefaultEnvironment,
  resolveDefaultEnvironmentId,
  writeDefaultEnvironment,
} from '../environment-default.js';

const TABLE = 'registry';
const keyOf = (key) => `${key.pk}|${key.sk}`;

const published = (environmentId, revisionPatch = {}) => ({
  [`ENV#${environmentId}|META`]: {
    environmentId,
    name: 'Team Base',
    status: 'PUBLISHED',
    publishedRevisionId: 'r-1',
  },
  [`ENV#${environmentId}|REV#r-1`]: {
    environmentId,
    revisionId: 'r-1',
    status: 'PUBLISHED',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/base',
    runtimeCompatibilityVersion: '1',
    verification: { status: 'PASSED' },
    ...revisionPatch,
  },
});

// Registry fake: GetCommand reads `items`, Put/Delete record and mutate.
const registry = (items = {}) => {
  const store = new Map(Object.entries(items));
  const send = vi.fn(async (command) => {
    const name = command.constructor.name;
    const { Key, Item } = command.input;
    if (name === 'GetCommand') return { Item: store.get(keyOf(Key)) };
    if (name === 'PutCommand') store.set(keyOf(Item), Item);
    if (name === 'DeleteCommand') store.delete(keyOf(Key));
    return {};
  });
  return { send, store };
};

const setting = (environmentId) => ({
  [keyOf(DEFAULT_ENVIRONMENT_KEY)]: { ...DEFAULT_ENVIRONMENT_KEY, environmentId },
});

describe('default environment setting', () => {
  it('reads nothing without a registry table', async () => {
    const ddb = registry();
    expect(await readDefaultEnvironment({ ddb, tableName: '' })).toBeNull();
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('stores the default with who set it, and clears it for standard', async () => {
    const ddb = registry();
    const item = await writeDefaultEnvironment({
      ddb,
      tableName: TABLE,
      environmentId: 'team-base',
      actor: 'admin-1',
      now: '2026-10-23T00:00:00.000Z',
    });
    expect(item).toMatchObject({
      environmentId: 'team-base',
      updatedBy: 'admin-1',
      updatedAt: '2026-10-23T00:00:00.000Z',
    });
    expect(await readDefaultEnvironment({ ddb, tableName: TABLE })).toEqual(item);

    expect(
      await writeDefaultEnvironment({ ddb, tableName: TABLE, environmentId: 'standard' }),
    ).toBeNull();
    expect(await readDefaultEnvironment({ ddb, tableName: TABLE })).toBeNull();
  });
});

describe('resolveDefaultEnvironmentId', () => {
  it('is standard when unset or without a table', async () => {
    expect(await resolveDefaultEnvironmentId({ ddb: registry(), tableName: TABLE })).toBe(
      'standard',
    );
    expect(await resolveDefaultEnvironmentId({ ddb: registry(), tableName: '' })).toBe('standard');
  });

  it('returns a published default', async () => {
    const ddb = registry({ ...setting('team-base'), ...published('team-base') });
    expect(await resolveDefaultEnvironmentId({ ddb, tableName: TABLE })).toBe('team-base');
  });

  it.each([
    [
      'retired',
      {
        ...setting('team-base'),
        ...published('team-base'),
        'ENV#team-base|META': {
          environmentId: 'team-base',
          status: 'RETIRED',
          publishedRevisionId: 'r-1',
        },
      },
    ],
    ['missing', setting('gone')],
    [
      'unverified',
      {
        ...setting('team-base'),
        ...published('team-base', { verification: { status: 'FAILED' } }),
      },
    ],
  ])('falls back to standard when the default is %s, and reports it', async (_name, items) => {
    const onFallback = vi.fn();
    expect(
      await resolveDefaultEnvironmentId({ ddb: registry(items), tableName: TABLE, onFallback }),
    ).toBe('standard');
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), expect.any(String));
  });

  it('falls back to standard when the registry read fails', async () => {
    const ddb = { send: vi.fn().mockRejectedValue(new Error('AccessDenied')) };
    const onFallback = vi.fn();
    expect(await resolveDefaultEnvironmentId({ ddb, tableName: TABLE, onFallback })).toBe(
      'standard',
    );
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AccessDenied' }),
      null,
    );
  });
});
