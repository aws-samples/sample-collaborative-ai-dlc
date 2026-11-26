import { isDeepStrictEqual } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  appCredentialRef,
  bindingKeyFor,
  canonicalRepo,
  getBinding,
  invalidateBindingsByCredentialRef,
  invalidateProjectBindingsByDelegator,
  invalidationReasonForError,
  listBindingsByCredentialRef,
  loggableErrorCode,
  markBindingInvalid,
  oauthCredentialRef,
  prepareBinding,
  putBinding,
  replaceProjectBindings,
  sanitizeBinding,
} from '../source-control-bindings.js';
import {
  assertCurrentGitConnection,
  buildGitConnectionConditionCheck,
  deleteGitConnection,
  putGitConnection,
} from '../git-connection-store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  ddbMock.reset();
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'git-provider-connections');
  vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
});

describe('source-control bindings', () => {
  it('canonicalizes repository URLs and builds opaque credential references', () => {
    expect(canonicalRepo('github', 'https://github.com/Acme/API.git')).toBe('acme/api');
    // Bitbucket uses the same workspace/repo two-segment shape as GitHub's owner/repo.
    expect(canonicalRepo('bitbucket', 'https://bitbucket.org/Acme/API.git')).toBe('acme/api');
    expect(bindingKeyFor('bitbucket', 'Acme/API')).toBe('bitbucket#acme/api');
    expect(bindingKeyFor('gitlab', 'Group/Sub/Repo')).toBe('gitlab#group/sub/repo');
    expect(oauthCredentialRef('github', 'user-1')).toBe('oauth#github#user-1');
    expect(appCredentialRef('1234')).toBe('github-app#1234');
  });

  it('looks up a project-scoped repository binding consistently', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { projectId: 'p1', status: 'active' } });
    expect(await getBinding(ddb, 'p1', 'github', 'Acme/API')).toMatchObject({
      projectId: 'p1',
    });
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input).toMatchObject({
      TableName: 'bindings',
      Key: { projectId: 'p1', bindingKey: 'github#acme/api' },
      ConsistentRead: true,
    });
  });

  it('atomically replaces all bindings and deletes stale repositories', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { projectId: 'p1', bindingKey: 'github#acme/old' },
        { projectId: 'p1', bindingKey: 'github#acme/api' },
      ],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const saved = await replaceProjectBindings(
      ddb,
      'p1',
      [
        {
          provider: 'github',
          repo: 'Acme/API',
          authType: 'github-oauth',
          credentialRef: oauthCredentialRef('github', 'u1'),
          connectionUserId: 'u1',
          capabilities: { contents: 'write' },
        },
      ],
      { actor: 'u1', now: '2026-07-20T10:00:00.000Z' },
    );

    expect(saved[0]).not.toHaveProperty('parameterName');
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(tx).toHaveLength(2);
    expect(tx[0].Put.Item).toMatchObject({
      projectId: 'p1',
      bindingKey: 'github#acme/api',
      credentialBindingKey: 'p1#github#acme/api',
      status: 'active',
    });
    expect(tx[1].Delete.Key).toEqual({
      projectId: 'p1',
      bindingKey: 'github#acme/old',
    });
  });

  it('invalidates every binding that depends on a disconnected credential', async () => {
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [
        {
          projectId: 'p1',
          bindingKey: 'github#acme/a',
          credentialRef: oauthCredentialRef('github', 'u1'),
        },
        {
          projectId: 'p2',
          bindingKey: 'github#acme/b',
          credentialRef: oauthCredentialRef('github', 'u1'),
        },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    expect(
      await invalidateBindingsByCredentialRef(
        ddb,
        oauthCredentialRef('github', 'u1'),
        'oauth_disconnected',
        { actor: 'u1', now: '2026-07-20T10:00:00.000Z' },
      ),
    ).toBe(2);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).not.toHaveProperty(
      'credentialRef',
    );
  });

  it('never exposes credential references or user ids in member views', () => {
    const binding = {
      provider: 'github',
      repo: 'acme/api',
      authType: 'github-oauth',
      credentialRef: 'oauth#github#secret-user-id',
      connectionUserId: 'secret-user-id',
      connectionDisplayName: 'Owner',
      status: 'active',
      capabilities: { contents: 'write' },
    };
    const member = sanitizeBinding(binding);
    expect(JSON.stringify(member)).not.toContain('secret-user-id');
    expect(member).not.toHaveProperty('credentialRef');
    expect(sanitizeBinding(binding, { privileged: true }).delegatedBy).toBe('Owner');
  });
});

const FIXED_NOW = '2026-09-18T10:00:00.000Z';
const CREDENTIAL_REF = oauthCredentialRef('github', 'u1');
const oauthBinding = (overrides = {}) => ({
  projectId: 'p1',
  provider: 'github',
  repo: 'Acme/API',
  authType: 'github-oauth',
  credentialRef: CREDENTIAL_REF,
  connectionUserId: 'u1',
  capabilities: { contents: 'write' },
  ...overrides,
});
const savedBinding = (overrides = {}) =>
  prepareBinding(oauthBinding(overrides), {
    actor: 'u1',
    now: FIXED_NOW,
  });
const connection = (overrides = {}) => ({
  userId: 'u1',
  provider: 'github',
  providerInstance: 'github#public',
  parameterName: '/p/e/git-token/u1/github-generation-1',
  createdAt: FIXED_NOW,
  generation: 'generation-1',
  ...overrides,
});
const replacementConnection = () =>
  connection({
    generation: 'generation-2',
    parameterName: '/p/e/git-token/u1/github-generation-2',
  });
const awsError = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
const legacyBinding = () => {
  const item = savedBinding();
  delete item.revision;
  return item;
};

// Interpret the actual emitted conditions against live rows. Transactions
// check every condition before applying any write. A paused command allows a
// competing real store operation to commit, including connection tombstones.
const statefulStore = ({ bindings = [], currentConnection } = {}) => {
  const rows = new Map();
  const calls = [];
  const hooks = {};
  const keyFor = (table, key) =>
    JSON.stringify(
      table === 'bindings'
        ? [table, key.projectId, key.bindingKey]
        : [table, key.userId, key.providerInstance],
    );
  const read = (table, key) => structuredClone(rows.get(keyFor(table, key)));
  const write = (table, item) => rows.set(keyFor(table, item), structuredClone(item));
  bindings.forEach((binding) => write('bindings', binding));
  if (currentConnection) write('git-provider-connections', currentConnection);
  const satisfies = (input) => {
    if (!input.ConditionExpression) return true;
    const row = read(input.TableName, input.Key ?? input.Item);
    return input.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[\w]+)\)$/.exec(clause);
      const present = /^attribute_exists\((#[\w]+)\)$/.exec(clause);
      const equal = /^(#[\w]+) = (:[\w]+)$/.exec(clause);
      if (absent) return row?.[input.ExpressionAttributeNames[absent[1]]] === undefined;
      if (present) return row?.[input.ExpressionAttributeNames[present[1]]] !== undefined;
      if (equal)
        return isDeepStrictEqual(
          row?.[input.ExpressionAttributeNames[equal[1]]],
          input.ExpressionAttributeValues[equal[2]],
        );
      throw new Error(`Unsupported test condition: ${clause}`);
    });
  };
  const mutate = (kind, input) => {
    if (kind === 'ConditionCheck') return;
    if (kind === 'Put') write(input.TableName, input.Item);
    else if (kind === 'Delete') rows.delete(keyFor(input.TableName, input.Key));
    else if (kind === 'Update') {
      const item = read(input.TableName, input.Key) ?? { ...input.Key };
      for (const assignment of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
        const [name, value] = assignment.split(' = ');
        item[name.startsWith('#') ? input.ExpressionAttributeNames[name] : name] =
          input.ExpressionAttributeValues[value];
      }
      write(input.TableName, item);
    } else throw new Error(`Unsupported test mutation: ${kind}`);
  };
  const client = {
    send: async (command) => {
      calls.push(command);
      await hooks.before?.(command);
      const input = command.input;
      let result = {};
      if (command instanceof GetCommand) {
        result = { Item: read(input.TableName, input.Key) };
      } else if (command instanceof QueryCommand) {
        const items = [...rows.entries()].filter(
          ([key, item]) =>
            JSON.parse(key)[0] === input.TableName &&
            (input.IndexName
              ? item.credentialRef === input.ExpressionAttributeValues[':credentialRef']
              : item.projectId === input.ExpressionAttributeValues[':projectId']),
        );
        result = { Items: structuredClone(items.map(([, item]) => item)) };
      } else if (command instanceof TransactWriteCommand) {
        const operations = input.TransactItems.map((item) => Object.entries(item)[0]);
        const reasons = operations.map(([, operation]) => ({
          Code: satisfies(operation) ? 'None' : 'ConditionalCheckFailed',
        }));
        if (reasons.some((reason) => reason.Code !== 'None')) {
          throw awsError('TransactionCanceledException', { CancellationReasons: reasons });
        }
        operations.forEach(([kind, operation]) => mutate(kind, operation));
      } else {
        if (!satisfies(input)) throw awsError('ConditionalCheckFailedException');
        mutate(
          command instanceof PutCommand
            ? 'Put'
            : command instanceof UpdateCommand
              ? 'Update'
              : 'Unknown',
          input,
        );
      }
      await hooks.after?.(command, result);
      return result;
    },
  };
  return {
    client,
    calls,
    hooks,
    read,
    write,
    binding: (item = { projectId: 'p1', bindingKey: 'github#acme/api' }) => read('bindings', item),
    removeBinding: (item) => rows.delete(keyFor('bindings', item)),
  };
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

describe('binding invalidation CAS', () => {
  it('mints a new UUID for every preparation, ignoring supplied revisions and identical times', () => {
    const first = savedBinding({ revision: 'caller-selected' });
    const second = prepareBinding(first, { now: FIXED_NOW, actor: 'u1' });
    expect(first.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.revision).not.toBe(first.revision);
    expect(second).toEqual({ ...first, revision: second.revision });
  });

  it('assigns fresh revisions through both put and project replacement', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    const next = await putBinding(store.client, original, { now: FIXED_NOW, actor: 'u1' });
    const [replacement] = await replaceProjectBindings(store.client, 'p1', [next], {
      now: FIXED_NOW,
      actor: 'u1',
    });
    expect(new Set([original.revision, next.revision, replacement.revision]).size).toBe(3);
    expect(store.binding()).toEqual(replacement);
  });

  it('invalidates the inspected revision once using conditional Update, without a connection read', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    expect(
      await markBindingInvalid(store.client, original, 'oauth_refresh_failed', {
        actor: 'u1',
        now: FIXED_NOW,
      }),
    ).toBe(true);
    expect(store.binding()).toMatchObject({
      status: 'invalid',
      invalidReason: 'oauth_refresh_failed',
      invalidatedAt: FIXED_NOW,
      invalidatedBy: 'u1',
    });
    expect(store.binding().revision).not.toBe(original.revision);
    expect(await markBindingInvalid(store.client, original, 'different_reason')).toBe(false);
    expect(store.binding().invalidReason).toBe('oauth_refresh_failed');
    expect(store.calls.every((cmd) => cmd instanceof UpdateCommand)).toBe(true);
  });

  it('does not invalidate a binding reverified after the original operation inspected it', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof UpdateCommand);
    const pending = markBindingInvalid(store.client, original, 'old_failure');
    await pause.paused;
    const next = await putBinding(store.client, original, { now: FIXED_NOW, actor: 'u1' });
    pause.resume();
    expect(await pending).toBe(false);
    expect(store.binding()).toEqual(next);
  });

  it.each([false, true])(
    'does not upsert a deleted binding or invalidate its re-add (%s)',
    async (readd) => {
      const original = savedBinding();
      const store = statefulStore({ bindings: [original] });
      store.removeBinding(original);
      const replacement = readd
        ? await putBinding(store.client, original, { now: FIXED_NOW, actor: 'u1' })
        : undefined;
      expect(await markBindingInvalid(store.client, original, 'old_failure')).toBe(false);
      expect(store.binding()).toEqual(replacement);
    },
  );

  it('invalidates unchanged legacy data and assigns its first revision', async () => {
    const original = legacyBinding();
    const store = statefulStore({ bindings: [original] });
    expect(await markBindingInvalid(store.client, original, 'old_failure')).toBe(true);
    expect(store.binding().revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(store.binding().status).toBe('invalid');
    expect(await markBindingInvalid(store.client, original, 'retry')).toBe(false);
  });

  it.each([
    { credentialRef: 'oauth#github#another' },
    { authType: 'github-app' },
    { connectionUserId: 'another' },
    { installationId: 'replacement' },
    { verifiedAt: 'later' },
    { updatedAt: 'later' },
    { status: 'invalid' },
    { capabilities: { contents: 'read' } },
    { connectionIdentity: 'replacement-identity' },
  ])('preserves a legacy row whose fingerprint changed: %j', async (changes) => {
    const original = legacyBinding();
    const replacement = { ...original, ...changes };
    const store = statefulStore({ bindings: [replacement] });
    expect(await markBindingInvalid(store.client, original, 'old_failure')).toBe(false);
    expect(store.binding()).toEqual(replacement);
  });

  it('requires absent legacy fingerprint fields to remain absent', async () => {
    const original = legacyBinding();
    delete original.verifiedAt;
    const replacement = { ...original, verifiedAt: FIXED_NOW };
    const store = statefulStore({ bindings: [replacement] });
    expect(await markBindingInvalid(store.client, original, 'old_failure')).toBe(false);
    expect(store.binding()).toEqual(replacement);
  });

  it('does not overwrite a newly assigned revision even if every legacy field is unchanged', async () => {
    const original = legacyBinding();
    const replacement = { ...original, revision: 'new-revision' };
    const store = statefulStore({ bindings: [replacement] });
    expect(await markBindingInvalid(store.client, original, 'old_failure')).toBe(false);
    expect(store.binding()).toEqual(replacement);
  });

  it('never upserts a deleted legacy row', async () => {
    const store = statefulStore();
    expect(await markBindingInvalid(store.client, legacyBinding(), 'old_failure')).toBe(false);
    expect(store.binding()).toBeUndefined();
  });

  it('counts only successful invalidations when a GSI result contains a stale revision', async () => {
    const original = savedBinding();
    const other = savedBinding({ repo: 'Acme/Other' });
    const store = statefulStore({ bindings: [original, other] });
    const pause = pauseOnce(store, 'after', (cmd) => cmd instanceof QueryCommand);
    const pending = invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure');
    await pause.paused;
    const next = await putBinding(store.client, original);
    pause.resume();
    expect(await pending).toBe(1);
    expect(store.binding()).toEqual(next);
    expect(store.binding(other).status).toBe('invalid');
  });

  it('also counts CAS successes for delegator invalidation', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    const pause = pauseOnce(store, 'after', (cmd) => cmd instanceof QueryCommand);
    const pending = invalidateProjectBindingsByDelegator(store.client, 'p1', 'u1');
    await pause.paused;
    const next = await putBinding(store.client, original);
    pause.resume();
    expect(await pending).toBe(0);
    expect(store.binding()).toEqual(next);
  });

  it('does not mutate an inspected soft deletion', async () => {
    const deleted = savedBinding({ status: 'deleted' });
    const store = statefulStore({ bindings: [deleted] });
    expect(await markBindingInvalid(store.client, deleted, 'failure')).toBe(false);
    expect(store.binding()).toEqual(deleted);
    expect(store.calls).toHaveLength(0);
  });
});

describe('disconnect invalidation from captured bindings', () => {
  it.each([false, true])(
    'uses only the provided snapshot without querying, including an empty snapshot (%s)',
    async (includeBinding) => {
      const original = savedBinding();
      const store = statefulStore({ bindings: [original] });
      const count = await invalidateBindingsByCredentialRef(
        store.client,
        CREDENTIAL_REF,
        'oauth_disconnected',
        { inspectedBindings: includeBinding ? [original] : [] },
      );
      expect(count).toBe(includeBinding ? 1 : 0);
      expect(store.binding().status).toBe(includeBinding ? 'invalid' : 'active');
      expect(store.calls.every((cmd) => cmd instanceof UpdateCommand)).toBe(true);
      expect(store.calls).toHaveLength(includeBinding ? 1 : 0);
    },
  );

  it.each([
    ['versioned', savedBinding],
    ['legacy', legacyBinding],
  ])(
    'revokes an unchanged captured %s binding even after reconnect',
    async (_kind, createBinding) => {
      const original = createBinding();
      const snapshot = connection();
      const store = statefulStore({ bindings: [original], currentConnection: snapshot });
      const inspectedBindings = await listBindingsByCredentialRef(store.client, CREDENTIAL_REF);
      const revoked = await deleteGitConnection(store.client, 'u1', 'github', {
        expectedItem: snapshot,
      });
      const replacement = replacementConnection();
      await putGitConnection(store.client, replacement, { expectedItem: revoked });
      const beforeInvalidation = store.calls.length;

      expect(
        await invalidateBindingsByCredentialRef(
          store.client,
          CREDENTIAL_REF,
          'oauth_disconnected',
          { actor: 'u1', now: FIXED_NOW, inspectedBindings },
        ),
      ).toBe(1);

      expect(store.binding()).toMatchObject({
        status: 'invalid',
        invalidReason: 'oauth_disconnected',
        invalidatedBy: 'u1',
        invalidatedAt: FIXED_NOW,
      });
      expect(store.binding().revision).not.toBe(original.revision);
      expect(store.read('git-provider-connections', replacement)).toEqual(replacement);
      const invalidationCalls = store.calls.slice(beforeInvalidation);
      expect(invalidationCalls).toHaveLength(1);
      expect(invalidationCalls[0]).toBeInstanceOf(UpdateCommand);
    },
  );

  it('protects a reverified revision after reconnect instead of querying and invalidating it', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    const inspectedBindings = await listBindingsByCredentialRef(store.client, CREDENTIAL_REF);
    const revoked = await deleteGitConnection(store.client, 'u1', 'github', {
      expectedItem: snapshot,
    });
    await putGitConnection(store.client, replacementConnection(), { expectedItem: revoked });
    const reverified = await putBinding(store.client, original, { actor: 'u1', now: FIXED_NOW });
    expect(reverified.revision).not.toBe(original.revision);
    const beforeInvalidation = store.calls.length;

    expect(
      await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'oauth_disconnected', {
        inspectedBindings,
      }),
    ).toBe(0);

    expect(store.binding()).toEqual(reverified);
    const invalidationCalls = store.calls.slice(beforeInvalidation);
    expect(invalidationCalls).toHaveLength(1);
    expect(invalidationCalls[0]).toBeInstanceOf(UpdateCommand);
  });

  it.each(['oauth#github#another', 'oauth#gitlab#u1', 'github-app#123'])(
    'filters the foreign credential %s from provided snapshots',
    async (credentialRef) => {
      const original = savedBinding();
      const foreign = savedBinding({ projectId: 'p2', credentialRef });
      const store = statefulStore({ bindings: [original, foreign] });
      expect(
        await invalidateBindingsByCredentialRef(
          store.client,
          CREDENTIAL_REF,
          'oauth_disconnected',
          { inspectedBindings: [foreign, original] },
        ),
      ).toBe(1);
      expect(store.binding().status).toBe('invalid');
      expect(store.binding(foreign)).toEqual(foreign);
      expect(store.calls).toHaveLength(1);
      expect(store.calls[0].input.Key).toEqual({
        projectId: original.projectId,
        bindingKey: original.bindingKey,
      });
    },
  );

  it.each([undefined, null, {}, 'not-an-array', false, 123])(
    'rejects an explicitly supplied non-array snapshot without querying or writing: %j',
    async (inspectedBindings) => {
      const original = savedBinding();
      const store = statefulStore({ bindings: [original] });
      await expect(
        invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'oauth_disconnected', {
          inspectedBindings,
        }),
      ).rejects.toThrow('Inspected bindings must be an array');
      expect(store.calls).toHaveLength(0);
      expect(store.binding()).toEqual(original);
    },
  );
});

describe('connection-guarded binding invalidation', () => {
  it('atomically checks the connection and invalidates the inspected binding', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    expect(
      await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
        connectionSnapshot: snapshot,
      }),
    ).toBe(1);
    expect(store.binding().status).toBe('invalid');
    const transactions = store.calls.filter((cmd) => cmd instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    const actions = transactions[0].input.TransactItems;
    expect(actions).toHaveLength(2);
    expect(actions[0].ConditionCheck).toMatchObject({
      TableName: 'git-provider-connections',
      Key: { userId: 'u1', providerInstance: 'github#public' },
    });
    expect(actions[1].Update.ConditionExpression).toContain('#revision = :observedRevision');
    expect(
      store.calls.some((cmd) => cmd instanceof UpdateCommand || cmd instanceof GetCommand),
    ).toBe(false);
  });

  it('rejects an old refresh failure even when its GSI query fetches the replacement binding revision', async () => {
    const old = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [old], currentConnection: snapshot });
    await putGitConnection(store.client, replacementConnection(), { expectedItem: snapshot });
    const verified = await putBinding(store.client, old, { now: FIXED_NOW, actor: 'u1' });
    expect(
      await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'old_failure', {
        connectionSnapshot: snapshot,
      }),
    ).toBe(0);
    expect(store.binding()).toEqual(verified);
  });

  it('rejects reconnect between the GSI query and the invalidation transaction', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const pending = invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
      connectionSnapshot: snapshot,
    });
    await pause.paused;
    await putGitConnection(store.client, replacementConnection(), { expectedItem: snapshot });
    pause.resume();
    expect(await pending).toBe(0);
    expect(store.binding()).toEqual(original);
  });

  it('checks binding revision even while the same connection is still active', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    const pause = pauseOnce(store, 'before', (cmd) => cmd instanceof TransactWriteCommand);
    const pending = invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
      connectionSnapshot: snapshot,
    });
    await pause.paused;
    const next = await putBinding(store.client, original, { now: FIXED_NOW, actor: 'u1' });
    pause.resume();
    expect(await pending).toBe(0);
    expect(store.binding()).toEqual(next);
  });

  it('uses the returned disconnect tombstone without authorizing token use', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    const revoked = await deleteGitConnection(store.client, 'u1', 'github', {
      expectedItem: snapshot,
    });
    await expect(assertCurrentGitConnection(store.client, revoked)).rejects.toMatchObject({
      code: 'CONNECTION_CHANGED',
    });
    expect(
      await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'disconnected', {
        connectionSnapshot: revoked,
      }),
    ).toBe(1);
    expect(store.binding().status).toBe('invalid');
  });

  it.each(['reconnect', 'another disconnect'])(
    'preserves bindings when %s supersedes the tombstone',
    async (action) => {
      const original = savedBinding();
      const store = statefulStore({ bindings: [original], currentConnection: connection() });
      const revoked = await deleteGitConnection(store.client, 'u1', 'github');
      if (action === 'reconnect') {
        await putGitConnection(store.client, replacementConnection(), { expectedItem: revoked });
      } else {
        await deleteGitConnection(store.client, 'u1', 'github', { expectedItem: revoked });
      }
      const next = await putBinding(store.client, original);
      expect(
        await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'disconnected', {
          connectionSnapshot: revoked,
        }),
      ).toBe(0);
      expect(store.binding()).toEqual(next);
    },
  );

  it.each(['parameterName', 'createdAt', 'generation', 'status', 'provider'])(
    'guards the complete tombstone fingerprint, including %s',
    async (field) => {
      const original = savedBinding();
      const store = statefulStore({ bindings: [original], currentConnection: connection() });
      const revoked = await deleteGitConnection(store.client, 'u1', 'github');
      store.write('git-provider-connections', { ...revoked, [field]: 'replacement' });
      expect(
        await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
          connectionSnapshot: revoked,
        }),
      ).toBe(0);
      expect(store.binding()).toEqual(original);
    },
  );

  it.each(['createdAt', 'generation'])('guards absence of legacy connection %s', async (field) => {
    const original = savedBinding();
    const snapshot = connection();
    delete snapshot.createdAt;
    delete snapshot.generation;
    const store = statefulStore({
      bindings: [original],
      currentConnection: { ...snapshot, [field]: 'new-identity' },
    });
    expect(
      await invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
        connectionSnapshot: snapshot,
      }),
    ).toBe(0);
    expect(store.binding()).toEqual(original);
  });

  it('accepts an unchanged generation-less legacy connection', async () => {
    const original = legacyBinding();
    const snapshot = connection();
    delete snapshot.createdAt;
    delete snapshot.generation;
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    expect(
      await markBindingInvalid(store.client, original, 'failure', {
        connectionSnapshot: snapshot,
      }),
    ).toBe(true);
  });

  it('does not upsert a binding deleted before its guarded transaction', async () => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ currentConnection: snapshot });
    expect(
      await markBindingInvalid(store.client, original, 'failure', {
        connectionSnapshot: snapshot,
      }),
    ).toBe(false);
    expect(store.binding()).toBeUndefined();
  });

  it('does not invalidate when the authoritative connection is absent', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    expect(
      await markBindingInvalid(store.client, original, 'failure', {
        connectionSnapshot: connection(),
      }),
    ).toBe(false);
    expect(store.binding()).toEqual(original);
  });

  it.each(['oauth#github#another', 'oauth#gitlab#u1', 'github-app#123'])(
    'rejects a guard for unrelated credential %s before querying',
    async (credentialRef) => {
      const store = statefulStore({ bindings: [savedBinding()], currentConnection: connection() });
      await expect(
        invalidateBindingsByCredentialRef(store.client, credentialRef, 'failure', {
          connectionSnapshot: connection(),
        }),
      ).rejects.toThrow(/does not match/);
      expect(store.calls).toHaveLength(0);
    },
  );

  it('also rejects an unrelated snapshot on direct markBindingInvalid', async () => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original] });
    await expect(
      markBindingInvalid(store.client, original, 'failure', {
        connectionSnapshot: connection({ userId: 'another' }),
      }),
    ).rejects.toThrow(/does not match/);
    expect(store.calls).toHaveLength(0);
  });

  it.each([null, undefined])(
    'does not silently omit an explicit invalid snapshot: %s',
    async (snapshot) => {
      const store = statefulStore({ bindings: [savedBinding()] });
      await expect(
        invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure', {
          connectionSnapshot: snapshot,
        }),
      ).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
      expect(store.calls).toHaveLength(0);
    },
  );

  it.each([
    connection({ userId: 123 }),
    connection({ providerInstance: 'gitlab#public' }),
    connection({ provider: {} }),
    connection({ status: 'deleted', generation: undefined, parameterName: undefined }),
    connection({ status: 'deleted' }),
  ])('rejects malformed keys or credential-bearing tombstones: %j', (snapshot) => {
    expect(() => buildGitConnectionConditionCheck(snapshot)).toThrow('Git connection changed');
  });
});

describe('invalidation storage failures', () => {
  it('logs CONNECTION_CHANGED safely without turning it into an invalidation reason', () => {
    expect(loggableErrorCode({ code: 'CONNECTION_CHANGED' })).toBe('CONNECTION_CHANGED');
    expect(invalidationReasonForError({ code: 'CONNECTION_CHANGED' })).toBeNull();
    expect(invalidationReasonForError({ code: 'CONNECTION_CHANGED', status: 401 })).toBeNull();
    expect(invalidationReasonForError({ code: 'CONNECTION_CHANGED', statusCode: 403 })).toBeNull();
    expect(invalidationReasonForError({ code: 'CREDENTIAL_REFRESH_FAILED' })).toBe(
      'oauth_refresh_failed',
    );
  });

  it.each([false, true])('propagates storage errors with connection guard %s', async (guarded) => {
    const original = savedBinding();
    const snapshot = connection();
    const store = statefulStore({ bindings: [original], currentConnection: snapshot });
    store.hooks.before = () => {
      throw awsError('AccessDeniedException');
    };
    await expect(
      markBindingInvalid(
        store.client,
        original,
        'failure',
        guarded ? { connectionSnapshot: snapshot } : {},
      ),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    expect(store.binding()).toEqual(original);
  });

  it.each(
    [
      undefined,
      [{ Code: 'TransactionConflict' }, { Code: 'None' }],
      [{ Code: 'ConditionalCheckFailed' }, { Code: 'ValidationError' }],
      [{ Code: 'ProvisionedThroughputExceeded' }, { Code: 'None' }],
    ].map((reasons) => [reasons]),
  )('does not hide non-conditional or mixed transaction errors: %j', async (reasons) => {
    const original = savedBinding();
    const store = statefulStore({ bindings: [original], currentConnection: connection() });
    store.hooks.before = () => {
      throw awsError('TransactionCanceledException', { CancellationReasons: reasons });
    };
    await expect(
      markBindingInvalid(store.client, original, 'failure', {
        connectionSnapshot: connection(),
      }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(store.binding()).toEqual(original);
  });

  it('propagates a failed GSI query rather than reporting zero invalidations', async () => {
    const store = statefulStore();
    store.hooks.before = () => {
      throw awsError('InternalServerError');
    };
    await expect(
      invalidateBindingsByCredentialRef(store.client, CREDENTIAL_REF, 'failure'),
    ).rejects.toMatchObject({ name: 'InternalServerError' });
  });
});
