import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createGitHandler } from '../git-handler.js';
import { createSignedState } from '../git-oauth.js';
import { getProvider } from '../git-providers.js';
import { putBinding, oauthCredentialRef } from '../source-control-bindings.js';

const TABLE = 'handler-provider-connections';
const LEGACY_TABLE = 'handler-legacy-connections';
const BINDINGS_TABLE = 'handler-bindings';
const PROJECT = 'project-1';
const REPOSITORY = 'org/repo';
const USER = 'user-1';
const PREFIX = 'test/git/tokens';
const SECRET = 'handler-test-secret';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = (name) => Object.assign(new Error(name), { name });
let emulatorErrors = [];
const unsupported = (message) => {
  emulatorErrors.push(message);
  return new Error(message);
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Only AWS transport is replaced. The handler, connection store, token reader,
// and refresh coordinator remain real. Conditions are evaluated against live
// rows at the write boundary, not replaced with canned conflict responses.
const statefulAws = () => {
  const rows = new Map();
  const parameters = new Map();
  const calls = [];
  const hooks = {};
  const key = (table, item) => {
    if (table === BINDINGS_TABLE) return JSON.stringify([table, item.projectId, item.bindingKey]);
    if (table === TABLE) return JSON.stringify([table, item.userId, item.providerInstance]);
    if (table === LEGACY_TABLE) return JSON.stringify([table, item.userId]);
    throw unsupported(`Unexpected test table: ${table}`);
  };
  const read = (table, item) => structuredClone(rows.get(key(table, item)));
  const write = (table, item) => rows.set(key(table, item), structuredClone(item));
  const checkCondition = (input) => {
    if (!input.ConditionExpression) return;
    const row = read(input.TableName, input.Key ?? input.Item);
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const attribute = (name) => (name.startsWith('#') ? names[name] : name);
    const clauses = input.ConditionExpression.split(' AND ').map((clause) => {
      const absent = /^attribute_not_exists\((#?\w+)\)$/.exec(clause);
      const present = /^attribute_exists\((#?\w+)\)$/.exec(clause);
      const equal = /^(#?\w+) = (:\w+)$/.exec(clause);
      if (absent) return row?.[attribute(absent[1])] === undefined;
      if (present) return row?.[attribute(present[1])] !== undefined;
      if (equal) return isDeepStrictEqual(row?.[attribute(equal[1])], values[equal[2]]);
      throw unsupported(`Unsupported test condition: ${clause}`);
    });
    const matches = clauses.every(Boolean);
    if (!matches) throw failure('ConditionalCheckFailedException');
  };
  const mutate = (kind, input) => {
    if (kind === 'ConditionCheck') return {};
    if (kind === 'Put') {
      write(input.TableName, input.Item);
      return {};
    }
    if (kind === 'Delete') {
      rows.delete(key(input.TableName, input.Key));
      return {};
    }
    if (kind !== 'Update') throw unsupported(`Unexpected test mutation: ${kind}`);
    if (!input.UpdateExpression.startsWith('SET ')) {
      throw unsupported(`Unsupported test update: ${input.UpdateExpression}`);
    }
    const row = read(input.TableName, input.Key) ?? { ...input.Key };
    for (const assignment of input.UpdateExpression.slice(4).split(', ')) {
      const [name, value] = assignment.split(' = ');
      const field = name.startsWith('#') ? input.ExpressionAttributeNames[name] : name;
      row[field] = input.ExpressionAttributeValues[value];
    }
    write(input.TableName, row);
    return { Attributes: structuredClone(row) };
  };
  const send = async (command) => {
    calls.push(command);
    await hooks.before?.(command);
    const input = command.input;
    let result = {};
    if (command instanceof GetCommand) {
      result = { Item: read(input.TableName, input.Key) };
    } else if (command instanceof QueryCommand) {
      if (
        input.TableName !== BINDINGS_TABLE ||
        input.KeyConditionExpression !== 'credentialRef = :credentialRef'
      ) {
        throw unsupported(`Unexpected test query: ${input.KeyConditionExpression}`);
      }
      result = {
        Items: [...rows.entries()]
          .filter(
            ([rowKey, row]) =>
              JSON.parse(rowKey)[0] === BINDINGS_TABLE &&
              row.credentialRef === input.ExpressionAttributeValues[':credentialRef'],
          )
          .map(([, row]) => structuredClone(row)),
      };
    } else if (command instanceof TransactWriteCommand) {
      const actions = input.TransactItems.map((item) => Object.entries(item)[0]);
      // DynamoDB evaluates all conditions against one snapshot before applying
      // any writes, even when an Update precedes a failing ConditionCheck.
      const reasons = actions.map(([, action]) => {
        try {
          checkCondition(action);
          return { Code: 'None' };
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException') throw error;
          return { Code: 'ConditionalCheckFailed' };
        }
      });
      if (reasons.some(({ Code }) => Code !== 'None')) {
        throw Object.assign(failure('TransactionCanceledException'), {
          CancellationReasons: reasons,
        });
      }
      actions.forEach(([kind, action]) => mutate(kind, action));
    } else if (
      command instanceof PutCommand ||
      command instanceof DeleteCommand ||
      command instanceof UpdateCommand
    ) {
      checkCondition(input);
      result = mutate(command.constructor.name.replace(/Command$/, ''), input);
    } else if (command instanceof GetParameterCommand) {
      if (!parameters.has(input.Name)) throw failure('ParameterNotFound');
      result = { Parameter: { Value: parameters.get(input.Name) } };
    } else if (command instanceof PutParameterCommand) {
      if (parameters.has(input.Name) && !input.Overwrite) throw failure('ParameterAlreadyExists');
      parameters.set(input.Name, input.Value);
    } else if (command instanceof DeleteParameterCommand) {
      parameters.delete(input.Name);
    } else {
      throw unsupported(`Unexpected test command: ${command.constructor.name}`);
    }
    await hooks.after?.(command, result);
    return result;
  };
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(send);
  vi.spyOn(SSMClient.prototype, 'send').mockImplementation(send);
  vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({
    SecretString: JSON.stringify({ client_id: 'client-id', client_secret: SECRET }),
  });
  return {
    calls,
    hooks,
    parameters,
    ddb: { send },
    connection: (provider) => read(TABLE, { userId: USER, providerInstance: `${provider}#public` }),
    binding: (provider) =>
      read(BINDINGS_TABLE, {
        projectId: PROJECT,
        bindingKey: `${provider}#${REPOSITORY}`,
      }),
    token: (parameterName) => JSON.parse(parameters.get(parameterName)),
  };
};

const pauseOnce = (aws, phase, predicate) => {
  const entered = deferred();
  const released = deferred();
  aws.hooks[phase] = async (command) => {
    if (!predicate(command)) return;
    delete aws.hooks[phase];
    entered.resolve();
    await released.promise;
  };
  return { entered: entered.promise, release: released.resolve };
};

const tokenPair = (provider, code) => ({
  accessToken: `${provider}-${code}-access`,
  tokenType: 'bearer',
  scope: getProvider(provider).oauth.requiredConnectionScopes.join(' '),
  ...(provider === 'github'
    ? {}
    : { refreshToken: `${provider}-${code}-refresh`, expiresIn: 7200 }),
});

const fixture = (id) => {
  const aws = statefulAws();
  const original = getProvider(id);
  const provider = {
    ...original,
    oauth: {
      ...original.oauth,
      exchangeCode: vi.fn(async ({ code }) => tokenPair(id, code)),
      ...(original.oauth.refreshAccessToken
        ? {
            // The handler must use the shared, guarded coordinator, not its
            // previous unconditional provider refresh-and-write implementation.
            refreshAccessToken: vi.fn(async () => {
              throw new Error('Direct provider refresh bypassed the coordinator');
            }),
          }
        : {}),
    },
    getAuthenticatedUser: vi.fn(async () => ({
      login: 'developer',
      authorName: 'Developer',
      authorEmail: 'developer@example.test',
    })),
    listRepos: vi.fn(async () => []),
  };
  vi.stubEnv(provider.oauth.secretEnvName, `${id}-oauth`);
  vi.stubEnv(provider.oauth.redirectUriEnvName, `https://app.example.test/${id}/callback`);
  const handler = createGitHandler(provider, {});
  const event = (httpMethod, route, queryStringParameters = null) => ({
    httpMethod,
    path: `/${id}/${route}`,
    headers: { origin: 'https://app.example.test' },
    requestContext: { authorizer: { claims: { sub: USER } } },
    queryStringParameters,
  });
  return {
    aws,
    provider,
    current: () => aws.connection(id),
    binding: () => aws.binding(id),
    deleteBinding: () =>
      aws.ddb.send(
        new DeleteCommand({
          TableName: BINDINGS_TABLE,
          Key: { projectId: PROJECT, bindingKey: `${id}#${REPOSITORY}` },
        }),
      ),
    verifyBinding: () =>
      putBinding(
        aws.ddb,
        {
          projectId: PROJECT,
          provider: id,
          repo: REPOSITORY,
          authType: `${id}-oauth`,
          credentialRef: oauthCredentialRef(id, USER),
          connectionUserId: USER,
          capabilities: { repositoryWrite: true },
        },
        { actor: 'project-admin' },
      ),
    callback: (code) =>
      handler(
        event('GET', 'callback', {
          code,
          state: createSignedState({ userId: USER, ts: Date.now() }, SECRET),
        }),
      ),
    disconnect: () => handler(event('DELETE', 'disconnect')),
    repos: () => handler(event('GET', 'repos')),
  };
};

const pauseExchange = (provider) => {
  const entered = deferred();
  const released = deferred();
  provider.oauth.exchangeCode.mockImplementationOnce(async ({ code }) => {
    entered.resolve();
    await released.promise;
    return tokenPair(provider.id, code);
  });
  return { entered: entered.promise, release: released.resolve };
};

const connectionChanged = (response) => {
  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toEqual({
    error: 'Git connection changed; reload before retrying',
    code: 'CONNECTION_CHANGED',
  });
};
const commands = (aws, type) => aws.calls.filter((command) => command instanceof type);
const refreshResponse = (id) => ({
  ok: true,
  status: 200,
  json: async () => ({
    access_token: `${id}-rotated-access`,
    refresh_token: `${id}-rotated-refresh`,
    token_type: 'bearer',
    expires_in: 7200,
    scope: getProvider(id).oauth.requiredConnectionScopes.join(' '),
  }),
});
const failedRefreshResponse = () => ({
  ok: false,
  status: 400,
  json: async () => ({ error: 'invalid_grant', error_description: 'Refresh grant revoked' }),
});
const invalidationTransaction = (command) =>
  command instanceof TransactWriteCommand &&
  command.input.TransactItems.some((item) => item.Update?.TableName === BINDINGS_TABLE);
const invalidationUpdate = (command) =>
  command instanceof UpdateCommand && command.input.TableName === BINDINGS_TABLE;

beforeEach(() => {
  emulatorErrors = [];
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', TABLE);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', LEGACY_TABLE);
  vi.stubEnv('GIT_TOKEN_SSM_PREFIX', PREFIX);
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', BINDINGS_TABLE);
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network request in pure handler test');
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // Handler best-effort catches must never hide an unimplemented emulator
  // operation and accidentally make an invalidation regression pass.
  expect(emulatorErrors).toEqual([]);
});

describe.each(['github', 'gitlab', 'bitbucket'])('%s handler connection races', (id) => {
  it('gives every reconnect a distinct token path tied to its row generation', async () => {
    const h = fixture(id);
    expect((await h.callback('first')).statusCode).toBe(200);
    const first = h.current();
    expect((await h.callback('second')).statusCode).toBe(200);
    const second = h.current();

    expect(first.generation).toMatch(UUID);
    expect(second.generation).toMatch(UUID);
    expect(second.generation).not.toBe(first.generation);
    for (const [row, code] of [
      [first, 'first'],
      [second, 'second'],
    ]) {
      expect(row.parameterName).toBe(`/${PREFIX}/${USER}/${id}-${row.generation}`);
      expect(h.aws.token(row.parameterName).accessToken).toBe(`${id}-${code}-access`);
    }
    expect(commands(h.aws, PutParameterCommand).map((command) => command.input.Overwrite)).toEqual([
      false,
      false,
    ]);
  });

  it('rejects a delayed callback after another callback commits, cleaning only its own token', async () => {
    const h = fixture(id);
    const exchange = pauseExchange(h.provider);
    const delayed = h.callback('delayed');
    await exchange.entered;
    expect((await h.callback('winner')).statusCode).toBe(200);
    const winner = h.current();
    exchange.release();
    connectionChanged(await delayed);

    expect(h.current()).toEqual(winner);
    expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-winner-access`);
    const puts = commands(h.aws, PutParameterCommand);
    expect(puts).toHaveLength(2);
    const unpublished = puts.find((command) => command.input.Name !== winner.parameterName);
    expect(h.aws.parameters.has(unpublished.input.Name)).toBe(false);
    expect(commands(h.aws, DeleteParameterCommand).map((command) => command.input.Name)).toEqual([
      unpublished.input.Name,
    ]);
  });

  it('disconnects an absent connection while its first callback is still exchanging', async () => {
    const h = fixture(id);
    const exchange = pauseExchange(h.provider);
    const delayed = h.callback('delayed');
    await exchange.entered;
    expect((await h.disconnect()).statusCode).toBe(200);
    const tombstone = h.current();
    expect(tombstone).toMatchObject({ provider: id, status: 'deleted' });
    expect(tombstone).not.toHaveProperty('parameterName');
    exchange.release();
    connectionChanged(await delayed);

    expect(h.current()).toEqual(tombstone);
    expect(h.aws.parameters.size).toBe(0);
    expect((await h.repos()).statusCode).toBe(400);
    expect(h.provider.listRepos).not.toHaveBeenCalled();
  });

  it('lets reconnect replace a tombstone but prevents a pre-disconnect callback from winning', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const exchange = pauseExchange(h.provider);
    const delayed = h.callback('delayed');
    await exchange.entered;
    expect((await h.disconnect()).statusCode).toBe(200);
    expect((await h.callback('reconnected')).statusCode).toBe(200);
    const winner = h.current();
    exchange.release();
    connectionChanged(await delayed);

    expect(h.current()).toEqual(winner);
    expect(h.aws.parameters.size).toBe(1);
    expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
  });

  it('a delayed disconnect cannot tombstone or clean up a newer connection', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const pause = pauseOnce(
      h.aws,
      'before',
      (command) => command instanceof PutCommand && command.input.Item.status === 'deleted',
    );
    const disconnecting = h.disconnect();
    await pause.entered;
    expect((await h.callback('reconnected')).statusCode).toBe(200);
    const winner = h.current();
    pause.release();
    connectionChanged(await disconnecting);

    expect(h.current()).toEqual(winner);
    expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
    expect(commands(h.aws, DeleteParameterCommand)).toHaveLength(0);
    expect(commands(h.aws, QueryCommand)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(0);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it.each(['absent', 'tombstone'])(
    'a disconnect that observed %s cannot revoke a callback winning before its binding query',
    async (initialState) => {
      const h = fixture(id);
      if (initialState === 'tombstone') {
        expect((await h.disconnect()).statusCode).toBe(200);
        expect(h.current().status).toBe('deleted');
      } else {
        expect(h.current()).toBeUndefined();
      }
      const snapshot = h.current();
      const earlierQueries = commands(h.aws, QueryCommand).length;
      const pause = pauseOnce(h.aws, 'before', (command) => command instanceof QueryCommand);
      const disconnecting = h.disconnect();
      await pause.entered;
      expect(h.current()).toEqual(snapshot);

      expect((await h.callback('winner')).statusCode).toBe(200);
      const winner = h.current();
      const binding = await h.verifyBinding();
      pause.release();
      connectionChanged(await disconnecting);

      expect(h.current()).toEqual(winner);
      expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-winner-access`);
      expect(h.aws.parameters.size).toBe(1);
      expect(h.binding()).toEqual(binding);
      expect(h.binding().status).toBe('active');
      expect(commands(h.aws, QueryCommand)).toHaveLength(earlierQueries + 1);
      expect(commands(h.aws, DeleteParameterCommand)).toHaveLength(0);
      expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(0);
      expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
      expect((await h.repos()).statusCode).toBe(200);
      expect(h.provider.listRepos).toHaveBeenCalledWith(
        expect.objectContaining({ token: `${id}-winner-access` }),
      );
    },
  );

  it('revokes authority before token cleanup and cleanup cannot delete a reconnect token', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const originalBinding = await h.verifyBinding();
    const original = h.current();
    const pause = pauseOnce(
      h.aws,
      'before',
      (command) => command instanceof DeleteParameterCommand,
    );
    const disconnecting = h.disconnect();
    await pause.entered;
    expect(h.current().status).toBe('deleted');
    expect(h.aws.parameters.has(original.parameterName)).toBe(true);
    expect((await h.repos()).statusCode).toBe(400);
    expect(h.provider.listRepos).not.toHaveBeenCalled();
    expect((await h.callback('reconnected')).statusCode).toBe(200);
    const winner = h.current();
    const replacementBinding = await h.verifyBinding();
    expect(replacementBinding.revision).not.toBe(originalBinding.revision);
    pause.release();
    expect((await disconnecting).statusCode).toBe(200);

    expect(h.current()).toEqual(winner);
    expect(h.aws.parameters.has(original.parameterName)).toBe(false);
    expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
    expect(h.binding()).toEqual(replacementBinding);
    expect(h.binding().status).toBe('active');
    expect(commands(h.aws, QueryCommand)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it.each(['connection read', 'token read'])(
    'refuses to pass stale credentials to a provider after reconnect during %s',
    async (boundary) => {
      const h = fixture(id);
      expect((await h.callback('original')).statusCode).toBe(200);
      const pause = pauseOnce(h.aws, 'after', (command) =>
        boundary === 'connection read'
          ? command instanceof GetCommand && command.input.TableName === TABLE
          : command instanceof GetParameterCommand,
      );
      const request = h.repos();
      await pause.entered;
      expect((await h.disconnect()).statusCode).toBe(200);
      expect((await h.callback('reconnected')).statusCode).toBe(200);
      const winner = h.current();
      pause.release();
      connectionChanged(await request);

      expect(h.current()).toEqual(winner);
      expect(h.provider.listRepos).not.toHaveBeenCalled();
      expect(commands(h.aws, GetParameterCommand)).toHaveLength(
        boundary === 'connection read' ? 0 : 1,
      );
    },
  );

  it('does not delete a published token when the DynamoDB commit response is lost', async () => {
    const h = fixture(id);
    h.aws.hooks.after = async (command) => {
      if (!(command instanceof PutCommand)) return;
      delete h.aws.hooks.after;
      throw new Error('Commit response lost');
    };
    expect((await h.callback('committed')).statusCode).toBe(500);

    const committed = h.current();
    expect(h.aws.token(committed.parameterName).accessToken).toBe(`${id}-committed-access`);
    expect(commands(h.aws, DeleteParameterCommand)).toHaveLength(0);
    expect((await h.repos()).statusCode).toBe(200);
  });
});

describe.each(['gitlab', 'bitbucket'])('%s handler refresh races', (id) => {
  it('invalidates a current binding after an authentication failure through a guarded transaction', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const current = h.current();
    const binding = await h.verifyBinding();
    globalThis.fetch.mockResolvedValue(failedRefreshResponse());
    h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);

    expect((await h.repos()).statusCode).toBeGreaterThanOrEqual(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(h.current()).toEqual(current);
    expect(h.binding()).toMatchObject({
      status: 'invalid',
      invalidReason: 'oauth_refresh_failed',
    });
    expect(h.binding().revision).not.toBe(binding.revision);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(1);
  });

  it('keeps a current binding active when refresh fails with a transport error', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const binding = await h.verifyBinding();
    globalThis.fetch.mockRejectedValue(new Error('Transport unavailable'));
    h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);

    expect((await h.repos()).statusCode).toBe(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(h.binding()).toEqual(binding);
    expect(h.binding().status).toBe('active');
    expect(commands(h.aws, QueryCommand)).toHaveLength(0);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it('returns 409 without invalidating a reverified binding when an old refresh fails after reconnect', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const originalBinding = await h.verifyBinding();
    const entered = deferred();
    const release = deferred();
    globalThis.fetch.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return failedRefreshResponse();
    });
    h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);
    const request = h.repos();
    await entered.promise;
    expect((await h.callback('reconnected')).statusCode).toBe(200);
    const winner = h.current();
    const replacementBinding = await h.verifyBinding();
    expect(replacementBinding.revision).not.toBe(originalBinding.revision);
    release.resolve();
    connectionChanged(await request);

    expect(h.current()).toEqual(winner);
    expect(h.binding()).toEqual(replacementBinding);
    expect(h.binding().status).toBe('active');
    expect(commands(h.aws, QueryCommand)).toHaveLength(0);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it.each(['invalidation query', 'invalidation transaction'])(
    'an old failure cannot invalidate a replacement binding after reconnect during %s',
    async (boundary) => {
      const h = fixture(id);
      expect((await h.callback('original')).statusCode).toBe(200);
      const originalBinding = await h.verifyBinding();
      globalThis.fetch.mockResolvedValue(failedRefreshResponse());
      h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);
      const pause = pauseOnce(h.aws, 'before', (command) =>
        boundary === 'invalidation query'
          ? command instanceof QueryCommand
          : invalidationTransaction(command),
      );
      const request = h.repos();
      await pause.entered;
      expect((await h.callback('reconnected')).statusCode).toBe(200);
      const winner = h.current();
      const replacementBinding = await h.verifyBinding();
      expect(replacementBinding.revision).not.toBe(originalBinding.revision);
      pause.release();
      expect((await request).statusCode).toBeGreaterThanOrEqual(400);

      expect(h.current()).toEqual(winner);
      expect(h.binding()).toEqual(replacementBinding);
      expect(h.binding().status).toBe('active');
      // Pausing BEFORE the query makes it return the NEW binding revision.
      // Only the transaction's old connection condition can reject that write.
      expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(1);
    },
  );

  it('cannot invalidate a reverified binding from a stale query even when the connection is unchanged', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const current = h.current();
    const originalBinding = await h.verifyBinding();
    globalThis.fetch.mockResolvedValue(failedRefreshResponse());
    h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);
    const pause = pauseOnce(h.aws, 'after', (command) => command instanceof QueryCommand);
    const request = h.repos();
    await pause.entered;
    const replacementBinding = await h.verifyBinding();
    expect(replacementBinding.revision).not.toBe(originalBinding.revision);
    pause.release();
    expect((await request).statusCode).toBeGreaterThanOrEqual(400);

    expect(h.current()).toEqual(current);
    expect(h.binding()).toEqual(replacementBinding);
    expect(h.binding().status).toBe('active');
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(1);
  });

  it('shares a guarded refresh across concurrent rejected-token requests', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const original = h.current();
    const entered = deferred();
    const release = deferred();
    globalThis.fetch.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return refreshResponse(id);
    });
    const bothRequests = deferred();
    let requests = 0;
    h.provider.listRepos.mockImplementation(async (ctx) => {
      if (++requests === 2) bothRequests.resolve();
      return [{ token: await ctx.onRefresh() }];
    });
    const first = h.repos();
    await entered.promise;
    const second = h.repos();
    await bothRequests.promise;
    release.resolve();
    const results = await Promise.all([first, second]);

    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
    for (const response of results) {
      expect(JSON.parse(response.body)).toEqual([{ token: `${id}-rotated-access` }]);
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(h.provider.oauth.refreshAccessToken).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject(original);
    expect(h.aws.token(original.parameterName).accessToken).toBe(`${id}-rotated-access`);
    expect(commands(h.aws, UpdateCommand)).toHaveLength(1);
    expect(commands(h.aws, PutCommand)).toHaveLength(1);
  });

  it.each(['provider refresh', 'token write'])(
    'rejects refresh after reconnect during %s without changing the new row or token',
    async (boundary) => {
      const h = fixture(id);
      expect((await h.callback('original')).statusCode).toBe(200);
      globalThis.fetch.mockResolvedValue(refreshResponse(id));
      let pause;
      if (boundary === 'provider refresh') {
        const entered = deferred();
        const released = deferred();
        globalThis.fetch.mockImplementationOnce(async () => {
          entered.resolve();
          await released.promise;
          return refreshResponse(id);
        });
        pause = { entered: entered.promise, release: released.resolve };
      } else {
        pause = pauseOnce(
          h.aws,
          'before',
          (command) => command instanceof PutParameterCommand && command.input.Overwrite === true,
        );
      }
      h.provider.listRepos.mockImplementation(async (ctx) => [{ token: await ctx.onRefresh() }]);
      const request = h.repos();
      await pause.entered;
      expect((await h.disconnect()).statusCode).toBe(200);
      expect((await h.callback('reconnected')).statusCode).toBe(200);
      const winner = h.current();
      const invalidations = commands(h.aws, QueryCommand).length;
      pause.release();
      connectionChanged(await request);

      expect(h.current()).toEqual(winner);
      expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
      expect(h.provider.oauth.refreshAccessToken).not.toHaveBeenCalled();
      expect(commands(h.aws, QueryCommand)).toHaveLength(invalidations);
      const writes = commands(h.aws, PutParameterCommand).filter(
        (command) => command.input.Name === winner.parameterName,
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].input.Overwrite).toBe(false);
    },
  );
});

describe.each(['github', 'gitlab', 'bitbucket'])('%s disconnect binding invalidation', (id) => {
  it('captures bindings before the tombstone and invalidates their inspected revisions', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const binding = await h.verifyBinding();

    expect((await h.disconnect()).statusCode).toBe(200);
    expect(h.current().status).toBe('deleted');
    expect(h.binding()).toMatchObject({
      status: 'invalid',
      invalidReason: 'oauth_disconnected',
      invalidatedBy: USER,
    });
    expect(h.binding().revision).not.toBe(binding.revision);
    expect(commands(h.aws, QueryCommand)).toHaveLength(1);
    const queryIndex = h.aws.calls.findIndex((command) => command instanceof QueryCommand);
    const tombstoneIndex = h.aws.calls.findIndex(
      (command) => command instanceof PutCommand && command.input.Item.status === 'deleted',
    );
    expect(queryIndex).toBeLessThan(tombstoneIndex);
    expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it('revokes an unchanged captured binding even when reconnect wins during secret cleanup', async () => {
    const h = fixture(id);
    expect((await h.callback('original')).statusCode).toBe(200);
    const originalBinding = await h.verifyBinding();
    const originalConnection = h.current();
    const pause = pauseOnce(
      h.aws,
      'before',
      (command) => command instanceof DeleteParameterCommand,
    );
    const disconnecting = h.disconnect();
    await pause.entered;
    expect(h.current().status).toBe('deleted');
    expect(h.binding()).toEqual(originalBinding);
    expect((await h.callback('reconnected')).statusCode).toBe(200);
    const winner = h.current();
    // Reconnect alone must not cause the old application grant to inherit
    // the replacement connection's token. No binding re-verification occurs.
    expect(h.binding()).toEqual(originalBinding);
    pause.release();

    expect((await disconnecting).statusCode).toBe(200);
    expect(h.current()).toEqual(winner);
    expect(h.binding()).toMatchObject({
      status: 'invalid',
      invalidReason: 'oauth_disconnected',
      invalidatedBy: USER,
    });
    expect(h.binding().revision).not.toBe(originalBinding.revision);
    expect(h.aws.parameters.has(originalConnection.parameterName)).toBe(false);
    expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
    expect(commands(h.aws, QueryCommand)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(1);
    expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
  });

  it.each(['reverify', 'delete and recreate'])(
    'a delayed disconnect update cannot revoke a binding after %s at the same key',
    async (change) => {
      const h = fixture(id);
      expect((await h.callback('original')).statusCode).toBe(200);
      const originalBinding = await h.verifyBinding();
      const pause = pauseOnce(h.aws, 'before', invalidationUpdate);
      const disconnecting = h.disconnect();
      await pause.entered;
      expect(h.current().status).toBe('deleted');
      expect((await h.callback('reconnected')).statusCode).toBe(200);
      const winner = h.current();
      if (change === 'delete and recreate') {
        await h.deleteBinding();
        expect(h.binding()).toBeUndefined();
      }
      const replacementBinding = await h.verifyBinding();
      expect(replacementBinding.bindingKey).toBe(originalBinding.bindingKey);
      expect(replacementBinding.revision).not.toBe(originalBinding.revision);
      pause.release();

      expect((await disconnecting).statusCode).toBe(200);
      expect(h.current()).toEqual(winner);
      expect(h.binding()).toEqual(replacementBinding);
      expect(h.binding().status).toBe('active');
      expect(h.aws.token(winner.parameterName).accessToken).toBe(`${id}-reconnected-access`);
      expect(commands(h.aws, QueryCommand)).toHaveLength(1);
      expect(h.aws.calls.filter(invalidationUpdate)).toHaveLength(1);
      expect(h.aws.calls.filter(invalidationTransaction)).toHaveLength(0);
    },
  );
});
