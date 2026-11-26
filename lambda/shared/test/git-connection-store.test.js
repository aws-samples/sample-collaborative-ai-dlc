import { isDeepStrictEqual } from 'node:util';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  getGitConnection,
  getGitConnectionSnapshot,
  putGitConnection,
  assertCurrentGitConnection,
  updateGitConnectionMetadata,
  deleteGitConnection,
} from '../git-connection-store.js';

const NEW_TABLE = 'git-provider-connections';
const LEGACY_TABLE = 'git-connections';
const USER = 'user-1';
const KEY = { userId: USER, providerInstance: 'github#public' };
const connection = (overrides = {}) => ({
  ...KEY,
  provider: 'github',
  parameterName: '/p/e/git-token/user-1/github-generation-1',
  createdAt: '2026-09-18T10:00:00.000Z',
  generation: 'generation-1',
  scope: 'repo',
  authorName: 'Original author',
  ...overrides,
});
const legacyConnection = (overrides = {}) => ({
  userId: USER,
  parameterName: '/p/e/git-token/user-1',
  createdAt: '2026-09-17T10:00:00.000Z',
  scope: 'repo',
  ...overrides,
});
const reconnected = () =>
  connection({
    parameterName: '/p/e/git-token/user-1/github-generation-2',
    generation: 'generation-2',
    createdAt: '2026-09-18T11:00:00.000Z',
  });
const failure = (name) => Object.assign(new Error(name), { name });

// Evaluate emitted conditions against live state; a transaction checks ALL
// conditions before mutating either table. Hooks pause real command boundaries
// to exercise interleavings, rather than supplying canned conflict responses.
const statefulStore = ({ current, legacy } = {}) => {
  const rows = new Map();
  const calls = [];
  const hooks = {};
  const keyFor = (table, key) =>
    JSON.stringify([table, key.userId, table === NEW_TABLE ? key.providerInstance : null]);
  const read = (table = NEW_TABLE, key = KEY) => structuredClone(rows.get(keyFor(table, key)));
  const write = (table, item) => rows.set(keyFor(table, item), structuredClone(item));
  if (current) write(NEW_TABLE, current);
  if (legacy) write(LEGACY_TABLE, legacy);
  const satisfies = (input) => {
    if (!input.ConditionExpression) return true;
    const row = read(input.TableName, input.Key ?? input.Item);
    return input.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[\w]+)\)$/.exec(clause);
      const present = /^attribute_exists\((#[\w]+)\)$/.exec(clause);
      const equality = /^(#[\w]+) = (:[\w]+)$/.exec(clause);
      if (absent) return row?.[input.ExpressionAttributeNames[absent[1]]] === undefined;
      if (present) return row?.[input.ExpressionAttributeNames[present[1]]] !== undefined;
      if (equality)
        return isDeepStrictEqual(
          row?.[input.ExpressionAttributeNames[equality[1]]],
          input.ExpressionAttributeValues[equality[2]],
        );
      throw new Error(`Unsupported test condition: ${clause}`);
    });
  };
  const mutate = (kind, input) => {
    if (kind === 'Put') write(input.TableName, input.Item);
    else if (kind === 'Delete') rows.delete(keyFor(input.TableName, input.Key));
    else if (kind === 'Update') {
      const row = read(input.TableName, input.Key) ?? { ...input.Key };
      for (const assignment of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
        const [name, value] = assignment.split(' = ');
        row[input.ExpressionAttributeNames[name]] = input.ExpressionAttributeValues[value];
      }
      write(input.TableName, row);
      return { Attributes: row };
    } else throw new Error(`Unsupported test mutation: ${kind}`);
    return {};
  };
  const ddb = {
    send: async (command) => {
      calls.push(command);
      await hooks.before?.(command);
      const input = command.input;
      let result;
      if (command instanceof GetCommand) {
        result = { Item: read(input.TableName, input.Key) };
      } else if (command instanceof TransactWriteCommand) {
        const operations = input.TransactItems.map((item) => Object.entries(item)[0]);
        const reasons = operations.map(([, operation]) => ({
          Code: satisfies(operation) ? 'None' : 'ConditionalCheckFailed',
        }));
        if (reasons.some((reason) => reason.Code !== 'None')) {
          throw Object.assign(failure('TransactionCanceledException'), {
            CancellationReasons: reasons,
          });
        }
        operations.forEach(([kind, operation]) => mutate(kind, operation));
        result = {};
      } else {
        if (!satisfies(input)) throw failure('ConditionalCheckFailedException');
        const kind =
          command instanceof PutCommand
            ? 'Put'
            : command instanceof DeleteCommand
              ? 'Delete'
              : command instanceof UpdateCommand
                ? 'Update'
                : 'Unknown';
        result = mutate(kind, input);
      }
      await hooks.after?.(command, result);
      return result;
    },
  };
  return { ddb, read, write, calls, hooks };
};

const pauseOnce = (store, phase, predicate) => {
  let resume;
  let reached;
  const paused = new Promise((resolve) => {
    reached = resolve;
  });
  const released = new Promise((resolve) => {
    resume = resolve;
  });
  store.hooks[phase] = async (command) => {
    if (!predicate(command)) return;
    delete store.hooks[phase];
    reached();
    await released;
  };
  return { paused, resume };
};

beforeEach(() => {
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', NEW_TABLE);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', LEGACY_TABLE);
});

describe('getGitConnection and getGitConnectionSnapshot', () => {
  it('reads the authoritative row consistently without touching legacy', async () => {
    const current = connection();
    const store = statefulStore({ current, legacy: legacyConnection() });
    expect(await getGitConnection(store.ddb, USER, 'github')).toEqual(current);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].input).toEqual({
      TableName: NEW_TABLE,
      Key: KEY,
      ConsistentRead: true,
    });
  });

  it.each([undefined, 'github', 'gitlab'])(
    'atomically migrates legacy provider %s, preserving path and creation time',
    async (provider) => {
      const legacy = legacyConnection(provider ? { provider } : {});
      const store = statefulStore({ legacy });
      const expected = {
        ...legacy,
        provider: provider ?? 'github',
        providerInstance: `${provider ?? 'github'}#public`,
      };
      expect(await getGitConnection(store.ddb, USER, provider ?? 'github')).toEqual(expected);
      expect(store.read(NEW_TABLE, expected)).toEqual(expected);
      expect(store.read(LEGACY_TABLE)).toBeUndefined();
      expect(store.calls.filter((cmd) => cmd instanceof TransactWriteCommand)).toHaveLength(1);
      expect(
        store.calls.filter((cmd) => cmd instanceof PutCommand || cmd instanceof DeleteCommand),
      ).toHaveLength(0);
      expect(
        store.calls
          .filter((cmd) => cmd instanceof GetCommand)
          .every((cmd) => cmd.input.ConsistentRead === true),
      ).toBe(true);
    },
  );

  it('does not migrate another provider or default provider-less legacy rows to gitlab', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    expect(await getGitConnection(store.ddb, USER, 'gitlab')).toBeNull();
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(store.calls).toHaveLength(2);
  });

  it('hides authoritative tombstones without falling back, but exposes raw lifecycle snapshots', async () => {
    const tombstone = { ...KEY, provider: 'github', status: 'deleted', generation: 'deleted-1' };
    const store = statefulStore({ current: tombstone, legacy: legacyConnection() });
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
    expect(await getGitConnectionSnapshot(store.ddb, USER, 'github')).toEqual(tombstone);
    expect(store.calls).toHaveLength(2);
    expect(
      store.calls.every(
        (cmd) => cmd.input.TableName === NEW_TABLE && cmd.input.ConsistentRead === true,
      ),
    ).toBe(true);
  });

  it('raw snapshots never authorize or migrate legacy credentials', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    expect(await getGitConnectionSnapshot(store.ddb, USER, 'github')).toBeNull();
    expect(store.calls).toHaveLength(1);
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
  });

  it('does not migrate a legacy tombstone', async () => {
    const store = statefulStore({
      legacy: { userId: USER, provider: 'github', status: 'deleted', generation: 'deleted-1' },
    });
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
    expect(store.calls).toHaveLength(2);
  });

  it('returns null when neither table contains the connection', async () => {
    expect(await getGitConnection(statefulStore().ddb, USER, 'github')).toBeNull();
  });

  it('retains legacy read compatibility without an authoritative table', async () => {
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', '');
    const store = statefulStore({ legacy: legacyConnection() });
    expect(await getGitConnection(store.ddb, USER, 'github')).toEqual({
      ...legacyConnection(),
      provider: 'github',
      providerInstance: 'github#public',
    });
    expect(store.calls).toHaveLength(1);
  });

  it('does not read an unconfigured legacy table', async () => {
    vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
    const store = statefulStore();
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
    expect(store.calls).toHaveLength(1);
  });

  it.each(['AccessDeniedException', 'InternalServerError'])(
    'does not return captured legacy credentials when migration fails with %s',
    async (name) => {
      const store = statefulStore({ legacy: legacyConnection() });
      store.hooks.before = (command) => {
        if (command instanceof TransactWriteCommand) throw failure(name);
      };
      await expect(getGitConnection(store.ddb, USER, 'github')).rejects.toMatchObject({ name });
      expect(store.read()).toBeUndefined();
      expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    },
  );

  it('does not mistake a transaction conflict for a conditional race', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    store.hooks.before = (command) => {
      if (command instanceof TransactWriteCommand) {
        throw Object.assign(failure('TransactionCanceledException'), {
          CancellationReasons: [{ Code: 'TransactionConflict' }],
        });
      }
    };
    await expect(getGitConnection(store.ddb, USER, 'github')).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(store.calls).toHaveLength(3);
  });

  it('returns the winner when a connect beats pending legacy migration', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const pending = getGitConnection(store.ddb, USER, 'github');
    await pause.paused;
    await putGitConnection(store.ddb, reconnected(), { expectedItem: null });
    pause.resume();
    expect(await pending).toEqual(reconnected());
    expect(store.read()).toEqual(reconnected());
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
  });

  it('fences migration ABA: pending A read, B connect and disconnect, A resumes', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const pending = getGitConnection(store.ddb, USER, 'github');
    await pause.paused;
    await putGitConnection(store.ddb, reconnected(), { expectedItem: null });
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github', {
      expectedItem: reconnected(),
    });
    pause.resume();
    expect(await pending).toBeNull();
    expect(store.read()).toEqual(tombstone);
    expect(store.read(LEGACY_TABLE)).toBeUndefined();
    expect(store.calls.filter((cmd) => cmd instanceof TransactWriteCommand)).toHaveLength(1);
  });

  it.each([
    { parameterName: '/p/e/git-token/replacement', createdAt: 'later' },
    { scope: 'repo workflow', updatedAt: 'later' },
    { generation: 'new-generation' },
    { provider: 'gitlab' },
  ])('does not publish or delete a changed legacy snapshot: %j', async (changes) => {
    const store = statefulStore({ legacy: legacyConnection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const pending = getGitConnection(store.ddb, USER, 'github');
    await pause.paused;
    const replacement = legacyConnection(changes);
    store.write(LEGACY_TABLE, replacement);
    pause.resume();
    expect(await pending).toBeNull();
    expect(store.read()).toBeUndefined();
    expect(store.read(LEGACY_TABLE)).toEqual(replacement);
  });

  it('bounds competing migrations and returns the authoritative winner', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const first = getGitConnection(store.ddb, USER, 'github');
    await pause.paused;
    const winner = await getGitConnection(store.ddb, USER, 'github');
    pause.resume();
    expect(await first).toEqual(winner);
    expect(store.read()).toEqual(winner);
    expect(store.read(LEGACY_TABLE)).toBeUndefined();
    expect(store.calls.filter((cmd) => cmd instanceof TransactWriteCommand)).toHaveLength(2);
  });

  it.each([getGitConnection, getGitConnectionSnapshot])(
    '%s returns null for missing userId or provider without reading',
    async (get) => {
      const store = statefulStore();
      expect(await get(store.ddb, '', 'github')).toBeNull();
      expect(await get(store.ddb, USER, '')).toBeNull();
      expect(store.calls).toHaveLength(0);
    },
  );
});

describe('putGitConnection', () => {
  it('conditionally replaces the observed connection and stamps the authoritative key', async () => {
    const store = statefulStore({ current: connection(), legacy: legacyConnection() });
    await putGitConnection(
      store.ddb,
      { ...reconnected(), providerInstance: 'wrong#instance' },
      { expectedItem: connection() },
    );
    expect(store.read()).toEqual(reconnected());
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].input.ConditionExpression).toBeTruthy();
  });

  it.each([
    ['omitted options', undefined],
    ['empty options', {}],
    ['null options', null],
    ['array options', []],
    ['undefined snapshot', { expectedItem: undefined }],
    ['false snapshot', { expectedItem: false }],
    ['zero snapshot', { expectedItem: 0 }],
    ['empty string snapshot', { expectedItem: '' }],
    ['array snapshot', { expectedItem: [] }],
    ['inherited snapshot', Object.create({ expectedItem: null })],
  ])('rejects %s before any read or write', async (_label, options) => {
    const store = statefulStore({ current: connection() });
    await expect(putGitConnection(store.ddb, reconnected(), options)).rejects.toThrow(
      /requires explicit expectedItem/,
    );
    expect(store.calls).toHaveLength(0);
    expect(store.read()).toEqual(connection());
  });

  it('supports expected absence but requires an observed tombstone to reconnect after deletion', async () => {
    const store = statefulStore();
    const absent = await getGitConnectionSnapshot(store.ddb, USER, 'github');
    await putGitConnection(store.ddb, connection(), { expectedItem: absent });
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github', {
      expectedItem: connection(),
    });
    await expect(
      putGitConnection(store.ddb, reconnected(), { expectedItem: absent }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(tombstone);
    const snapshot = await getGitConnectionSnapshot(store.ddb, USER, 'github');
    await putGitConnection(store.ddb, reconnected(), { expectedItem: snapshot });
    expect(store.read()).toEqual(reconnected());
  });

  it('rejects a stale raw snapshot after another connect', async () => {
    const store = statefulStore({ current: connection() });
    await putGitConnection(store.ddb, reconnected(), { expectedItem: connection() });
    await expect(
      putGitConnection(store.ddb, connection(), { expectedItem: connection() }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(reconnected());
  });

  it('fences a callback which observed a tombstone before another disconnect', async () => {
    const store = statefulStore({ current: connection() });
    const first = await deleteGitConnection(store.ddb, USER, 'github');
    const snapshot = await getGitConnectionSnapshot(store.ddb, USER, 'github');
    const second = await deleteGitConnection(store.ddb, USER, 'github');
    expect(second.generation).not.toBe(first.generation);
    await expect(
      putGitConnection(store.ddb, reconnected(), { expectedItem: snapshot }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(second);
  });

  it.each([{ userId: USER }, { provider: 'github' }])(
    'rejects missing connect keys: %j',
    async (item) => {
      const store = statefulStore();
      await expect(putGitConnection(store.ddb, item, { expectedItem: null })).rejects.toThrow(
        /requires userId and provider/,
      );
      expect(store.calls).toHaveLength(0);
    },
  );

  it('rejects a snapshot belonging to another identity', async () => {
    const store = statefulStore({ current: connection() });
    await expect(
      putGitConnection(store.ddb, reconnected(), {
        expectedItem: connection({ userId: 'other' }),
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.calls).toHaveLength(0);
  });

  it('does not accept a tombstone as a connect item', async () => {
    const store = statefulStore();
    await expect(
      putGitConnection(store.ddb, connection({ status: 'deleted' }), { expectedItem: null }),
    ).rejects.toThrow(/deleteGitConnection/);
    expect(store.calls).toHaveLength(0);
  });

  it('does not translate service failures into conditional mismatches', async () => {
    const store = statefulStore();
    store.hooks.before = () => {
      throw failure('AccessDeniedException');
    };
    await expect(
      putGitConnection(store.ddb, connection(), { expectedItem: null }),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });
});

describe('assertCurrentGitConnection', () => {
  it('returns current metadata after a strongly consistent authoritative read', async () => {
    const current = connection({ scope: 'repo workflow', authorName: 'Changed author' });
    const store = statefulStore({ current });
    expect(await assertCurrentGitConnection(store.ddb, connection())).toEqual(current);
    expect(store.calls[0].input.ConsistentRead).toBe(true);
    expect(store.calls).toHaveLength(1);
  });

  it.each([
    null,
    { status: 'deleted' },
    { generation: 'different' },
    { parameterName: '/p/e/git-token/other' },
    { createdAt: 'later' },
    { provider: 'gitlab' },
  ])('rejects missing, revoked, or changed authority %j', async (changes) => {
    const store = statefulStore({
      current: changes === null ? undefined : connection(changes),
      legacy: legacyConnection(),
    });
    await expect(assertCurrentGitConnection(store.ddb, connection())).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].input.TableName).toBe(NEW_TABLE);
  });

  it('accepts generation-less legacy snapshots but rejects gaining a generation', async () => {
    const legacy = { ...KEY, ...legacyConnection(), provider: 'github' };
    const store = statefulStore({ current: legacy });
    expect(await assertCurrentGitConnection(store.ddb, legacy)).toEqual(legacy);
    store.write(NEW_TABLE, { ...legacy, generation: 'new-generation' });
    await expect(assertCurrentGitConnection(store.ddb, legacy)).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    });
  });

  it.each([
    null,
    { ...KEY },
    connection({ status: 'deleted' }),
    connection({ providerInstance: 'github#private' }),
  ])('rejects invalid snapshots before reading: %j', async (snapshot) => {
    const store = statefulStore({ current: connection() });
    await expect(assertCurrentGitConnection(store.ddb, snapshot)).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    });
    expect(store.calls).toHaveLength(0);
  });

  it('fails closed without an authoritative table instead of authorizing legacy', async () => {
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', '');
    const store = statefulStore({ legacy: legacyConnection() });
    await expect(assertCurrentGitConnection(store.ddb, connection())).rejects.toThrow(
      'GIT_PROVIDER_CONNECTIONS_TABLE is required',
    );
    expect(store.calls).toHaveLength(0);
  });
});

describe('updateGitConnectionMetadata', () => {
  it('updates allowed metadata while preserving concurrently changed attribution', async () => {
    const current = connection({ authorName: 'New author', authorEmail: 'new@example.test' });
    const store = statefulStore({ current });
    const result = await updateGitConnectionMetadata(store.ddb, connection(), {
      scope: 'repo workflow',
      updatedAt: '2026-09-18T12:00:00.000Z',
    });
    expect(result).toEqual({
      ...current,
      scope: 'repo workflow',
      updatedAt: '2026-09-18T12:00:00.000Z',
    });
    expect(store.read()).toEqual(result);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toBeInstanceOf(UpdateCommand);
  });

  it.each([
    'parameterName',
    'createdAt',
    'generation',
    'userId',
    'provider',
    'status',
    'authorName',
  ])('rejects attempted %s mutation before writing', async (field) => {
    const store = statefulStore({ current: connection() });
    await expect(
      updateGitConnectionMetadata(store.ddb, connection(), { [field]: 'changed' }),
    ).rejects.toThrow(/Only scope and updatedAt/);
    expect(store.read()).toEqual(connection());
    expect(store.calls).toHaveLength(0);
  });

  it.each([null, 'metadata', []])('rejects non-object metadata %j', async (metadata) => {
    const store = statefulStore({ current: connection() });
    await expect(updateGitConnectionMetadata(store.ddb, connection(), metadata)).rejects.toThrow();
    expect(store.calls).toHaveLength(0);
  });

  it('checks authority even when all metadata fields are omitted', async () => {
    const store = statefulStore({ current: connection() });
    expect(
      await updateGitConnectionMetadata(store.ddb, connection(), { scope: undefined }),
    ).toEqual(connection());
    await deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() });
    await expect(updateGitConnectionMetadata(store.ddb, connection(), {})).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    });
  });

  it('updates legacy rows missing generation and createdAt without minting identity', async () => {
    const legacy = { ...KEY, provider: 'github', parameterName: '/p/e/git-token/user-1' };
    const store = statefulStore({ current: legacy });
    await updateGitConnectionMetadata(store.ddb, legacy, { scope: 'repo', updatedAt: 'later' });
    expect(store.read()).toEqual({ ...legacy, scope: 'repo', updatedAt: 'later' });
  });

  it.each([
    null,
    { status: 'deleted' },
    { generation: 'generation-2' },
    { parameterName: '/p/e/git-token/different' },
    { createdAt: 'later' },
  ])('never upserts or updates changed authority %j', async (changes) => {
    const current = changes === null ? undefined : connection(changes);
    const store = statefulStore({ current });
    await expect(
      updateGitConnectionMetadata(store.ddb, connection(), { scope: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(current);
  });

  it.each(['generation', 'createdAt'])('requires legacy %s to remain absent', async (field) => {
    const legacy = { ...KEY, provider: 'github', parameterName: '/p/e/git-token/user-1' };
    const current = { ...legacy, [field]: 'new-identity' };
    const store = statefulStore({ current });
    await expect(
      updateGitConnectionMetadata(store.ddb, legacy, { scope: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(current);
  });

  it('rejects a refresh that passed preflight before disconnect committed', async () => {
    const store = statefulStore({ current: connection() });
    await assertCurrentGitConnection(store.ddb, connection());
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof UpdateCommand);
    const pending = updateGitConnectionMetadata(store.ddb, connection(), { scope: 'stale' });
    await pause.paused;
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github', {
      expectedItem: connection(),
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    pause.resume();
    await rejected;
    expect(store.read()).toEqual(tombstone);
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
  });

  it('rejects pending refresh after reconnect even if createdAt is unchanged', async () => {
    const store = statefulStore({ current: connection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof UpdateCommand);
    const pending = updateGitConnectionMetadata(store.ddb, connection(), { scope: 'stale' });
    await pause.paused;
    const replacement = { ...reconnected(), createdAt: connection().createdAt };
    await putGitConnection(store.ddb, replacement, { expectedItem: connection() });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    pause.resume();
    await rejected;
    expect(store.read()).toEqual(replacement);
  });

  it('propagates service failures instead of reporting a successful update', async () => {
    const store = statefulStore({ current: connection() });
    store.hooks.before = (cmd) => {
      if (cmd instanceof UpdateCommand) throw failure('AccessDeniedException');
    };
    await expect(
      updateGitConnectionMetadata(store.ddb, connection(), { scope: 'new' }),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    expect(store.read()).toEqual(connection());
  });
});

describe('deleteGitConnection', () => {
  it('stores a credential-free tombstone before conditionally deleting matching legacy', async () => {
    const current = connection({ accessToken: 'must-not-copy', refreshToken: 'must-not-copy' });
    const store = statefulStore({ current, legacy: legacyConnection() });
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github', {
      expectedItem: current,
    });
    expect(tombstone).toEqual({
      ...KEY,
      provider: 'github',
      status: 'deleted',
      generation: expect.stringMatching(/^[a-f0-9-]{36}$/),
      updatedAt: expect.any(String),
    });
    expect(store.read()).toEqual(tombstone);
    expect(store.read(LEGACY_TABLE)).toBeUndefined();
    const writes = store.calls.filter((cmd) => !(cmd instanceof GetCommand));
    expect(writes.map((cmd) => cmd.constructor.name)).toEqual(['PutCommand', 'DeleteCommand']);
    expect(writes[1].input.ConditionExpression).toBeTruthy();
  });

  it('preserves another provider in both tables', async () => {
    const store = statefulStore({ current: connection(), legacy: legacyConnection() });
    const tombstone = await deleteGitConnection(store.ddb, USER, 'gitlab', { expectedItem: null });
    expect(tombstone.providerInstance).toBe('gitlab#public');
    expect(store.read()).toEqual(connection());
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(store.calls.filter((cmd) => cmd instanceof DeleteCommand)).toHaveLength(0);
  });

  it('revokes a legacy-only connection and fences subsequent fallback', async () => {
    const store = statefulStore({ legacy: legacyConnection() });
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github');
    expect(store.read()).toEqual(tombstone);
    expect(store.read(LEGACY_TABLE)).toBeUndefined();
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
  });

  it('writes a tombstone even for absence, fencing a pending callback', async () => {
    const store = statefulStore();
    const tombstone = await deleteGitConnection(store.ddb, USER, 'github', { expectedItem: null });
    await expect(
      putGitConnection(store.ddb, connection(), { expectedItem: null }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(tombstone);
  });

  it('rejects a stale caller snapshot before cleaning up legacy or revoking reconnect', async () => {
    const store = statefulStore({ current: reconnected(), legacy: legacyConnection() });
    await expect(
      deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(store.read()).toEqual(reconnected());
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(store.calls.filter((cmd) => cmd instanceof DeleteCommand)).toHaveLength(0);
  });

  it('does not revoke a reconnect which wins after its implicit snapshot read', async () => {
    const store = statefulStore({ current: connection() });
    const pause = pauseOnce(
      store,
      'after',
      (cmd) => cmd instanceof GetCommand && cmd.input.TableName === NEW_TABLE,
    );
    const pending = deleteGitConnection(store.ddb, USER, 'github');
    await pause.paused;
    await putGitConnection(store.ddb, reconnected(), { expectedItem: connection() });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    pause.resume();
    await rejected;
    expect(store.read()).toEqual(reconnected());
  });

  it.each([
    { provider: 'gitlab', parameterName: '/p/e/git-token/replacement/gitlab' },
    { generation: 'new-generation' },
    { createdAt: 'later' },
  ])('does not delete replacement legacy credentials during cleanup: %j', async (changes) => {
    const store = statefulStore({ current: connection(), legacy: legacyConnection() });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof DeleteCommand);
    const pending = deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() });
    await pause.paused;
    const replacement = legacyConnection(changes);
    store.write(LEGACY_TABLE, replacement);
    await putGitConnection(store.ddb, reconnected(), { expectedItem: store.read() });
    pause.resume();
    await pending;
    expect(store.read()).toEqual(reconnected());
    expect(store.read(LEGACY_TABLE)).toEqual(replacement);
  });

  it('reports legacy cleanup errors but keeps the authoritative revocation', async () => {
    const store = statefulStore({ current: connection(), legacy: legacyConnection() });
    store.hooks.before = (cmd) => {
      if (cmd instanceof DeleteCommand) throw failure('AccessDeniedException');
    };
    await expect(
      deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() }),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    expect(store.read().status).toBe('deleted');
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(await getGitConnection(store.ddb, USER, 'github')).toBeNull();
  });

  it('propagates tombstone failures without deleting legacy first', async () => {
    const store = statefulStore({ current: connection(), legacy: legacyConnection() });
    store.hooks.before = (cmd) => {
      if (cmd instanceof PutCommand) throw failure('AccessDeniedException');
    };
    await expect(
      deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() }),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    expect(store.read()).toEqual(connection());
    expect(store.read(LEGACY_TABLE)).toEqual(legacyConnection());
    expect(store.calls.filter((cmd) => cmd instanceof DeleteCommand)).toHaveLength(0);
  });

  it('works without a legacy table', async () => {
    vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
    const store = statefulStore({ current: connection() });
    await deleteGitConnection(store.ddb, USER, 'github', { expectedItem: connection() });
    expect(store.calls).toHaveLength(1);
    expect(store.read().status).toBe('deleted');
  });

  it('no-ops for missing userId or provider', async () => {
    const store = statefulStore();
    await deleteGitConnection(store.ddb, '', 'github');
    await deleteGitConnection(store.ddb, USER, '');
    expect(store.calls).toHaveLength(0);
  });
});
