import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  deleteGitConnection,
  getGitConnectionSnapshot,
  putGitConnection,
} from '../git-connection-store.js';
import { ensureFreshGitToken } from '../git-token.js';

const OLD_GENERATION = '3b514af2-c2ea-4321-a98b-8e25f42a7761';
const NEW_GENERATION = '48351862-7023-4e81-ac57-238d312bcfee';
const CREATED = '2026-09-18T09:00:00.000Z';
const conditionalFailure = () =>
  Object.assign(new Error('Condition failed'), { name: 'ConditionalCheckFailedException' });

// Evaluate the store's small equality/existence condition language against
// mutable rows. This lets a test revoke real store authority at each async
// boundary instead of teaching mocks to return success for conditional writes.
const conditionMatches = (input, row) => {
  if (!input.ConditionExpression) return true;
  const names = input.ExpressionAttributeNames;
  const values = input.ExpressionAttributeValues;
  return input.ConditionExpression.split(' AND ').every((clause) => {
    const exists = clause.match(/^attribute_(not_)?exists\((#\w+)\)$/);
    if (exists) {
      const present = row?.[names[exists[2]]] !== undefined;
      return exists[1] ? !present : present;
    }
    const equal = clause.match(/^(#\w+) = (:\w+)$/);
    if (!equal) throw new Error(`Unexpected condition: ${clause}`);
    return row?.[names[equal[1]]] === values[equal[2]];
  });
};

const fixture = (provider, { legacy = false } = {}) => {
  const item = {
    userId: 'user-1',
    provider,
    providerInstance: `${provider}#public`,
    createdAt: CREATED,
    parameterName: `/project/dev/git-token/user-1/${legacy ? provider : `${provider}-${OLD_GENERATION}`}`,
    ...(legacy ? {} : { generation: OLD_GENERATION }),
  };
  const replacement = {
    ...item,
    generation: NEW_GENERATION,
    parameterName: `/project/dev/git-token/user-1/${provider}-${NEW_GENERATION}`,
  };
  const state = {
    current: structuredClone(item),
    afterTokenRead: null,
    afterTokenWrite: null,
    afterMetadataWrite: null,
  };
  const parameters = new Map([
    [item.parameterName, { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }],
    [replacement.parameterName, { accessToken: 'new-connection-access' }],
  ]);
  const ddb = {
    send: vi.fn(async (command) => {
      const input = command.input;
      if (command instanceof GetCommand) {
        expect(input.ConsistentRead).toBe(true);
        return { Item: structuredClone(state.current) };
      }
      if (!conditionMatches(input, state.current)) throw conditionalFailure();
      if (command instanceof PutCommand) {
        state.current = structuredClone(input.Item);
        return {};
      }
      if (command instanceof UpdateCommand) {
        for (const assignment of input.UpdateExpression.slice(4).split(', ')) {
          const [name, value] = assignment.split(' = ');
          state.current[input.ExpressionAttributeNames[name]] =
            input.ExpressionAttributeValues[value];
        }
        await state.afterMetadataWrite?.();
        return { Attributes: structuredClone(state.current) };
      }
      throw new Error('Unexpected connection command');
    }),
  };
  const ssm = {
    send: vi.fn(async (command) => {
      const { Name, Value } = command.input;
      if (command instanceof GetParameterCommand) {
        const result = { Parameter: { Value: JSON.stringify(parameters.get(Name)) } };
        await state.afterTokenRead?.();
        return result;
      }
      if (command instanceof PutParameterCommand) {
        parameters.set(Name, JSON.parse(Value));
        await state.afterTokenWrite?.();
        return {};
      }
      throw new Error('Unexpected token command');
    }),
  };
  const secrets = {
    send: vi.fn(async () => ({
      SecretString: JSON.stringify({ client_id: 'client', client_secret: 'secret' }),
    })),
  };
  const changeConnection = async (change) => {
    await deleteGitConnection(ddb, item.userId, provider, { expectedItem: item });
    if (change === 'reconnect') {
      await putGitConnection(ddb, replacement, {
        expectedItem: await getGitConnectionSnapshot(ddb, item.userId, provider),
      });
    }
  };
  const refresh = () => ensureFreshGitToken({ ddb, ssm, secrets, item, gitProvider: provider });
  return { state, parameters, item, replacement, ddb, ssm, secrets, changeConnection, refresh };
};

beforeEach(() => {
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'connections');
  vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
  vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', 'gitlab-secret');
  vi.stubEnv('BITBUCKET_OAUTH_SECRET_NAME', 'bitbucket-secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'rotated-old-access',
        refresh_token: 'rotated-old-refresh',
        expires_in: 7200,
        scope: 'read_repository',
      }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(['gitlab', 'bitbucket'])('%s refresh revocation', (provider) => {
  it.each(['disconnect', 'reconnect'])(
    'reports %s instead of a late provider failure against the old connection',
    async (change) => {
      const f = fixture(provider);
      fetch.mockImplementationOnce(async () => {
        await f.changeConnection(change);
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
        };
      });
      await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
      expect(f.ssm.send.mock.calls.filter(([c]) => c instanceof PutParameterCommand)).toHaveLength(
        0,
      );
    },
  );

  it.each(['disconnect', 'reconnect'])(
    'rejects %s while the provider response is pending, before writing SSM',
    async (change) => {
      const f = fixture(provider);
      fetch.mockImplementationOnce(async () => {
        await f.changeConnection(change);
        return {
          ok: true,
          json: async () => ({ access_token: 'late-access', refresh_token: 'late-refresh' }),
        };
      });
      await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
      expect(f.ssm.send.mock.calls.filter(([c]) => c instanceof PutParameterCommand)).toHaveLength(
        0,
      );
      expect(f.state.current).toMatchObject(
        change === 'reconnect' ? f.replacement : { status: 'deleted' },
      );
    },
  );

  it.each(['disconnect', 'reconnect'])(
    'rejects %s during token persistence without restoring the old connection',
    async (change) => {
      const f = fixture(provider);
      f.state.afterTokenWrite = () => f.changeConnection(change);
      await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
      expect(f.state.current).toMatchObject(
        change === 'reconnect' ? f.replacement : { status: 'deleted' },
      );
      expect(f.parameters.get(f.replacement.parameterName)).toEqual({
        accessToken: 'new-connection-access',
      });
      // A late write may leave old unreferenced bytes; it cannot publish an
      // active row or return the old token to its caller.
      expect(f.state.current.parameterName).not.toBe(f.item.parameterName);
    },
  );

  it('rejects revocation after metadata persistence but before returning the token', async () => {
    const f = fixture(provider);
    f.state.afterMetadataWrite = () => f.changeConnection('disconnect');
    await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(f.state.current.status).toBe('deleted');
  });

  it('does not reuse a reconnect created in the same millisecond', async () => {
    const f = fixture(provider);
    f.parameters.set(f.item.parameterName, { accessToken: 'old-unexpired-token' });
    f.state.afterTokenRead = () => f.changeConnection('reconnect');
    await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(f.state.current.createdAt).toBe(f.item.createdAt);
    expect(f.state.current.generation).toBe(NEW_GENERATION);
  });

  it('keeps a legacy parameter refresh separate from a new connection', async () => {
    const f = fixture(provider, { legacy: true });
    f.state.afterTokenWrite = () => f.changeConnection('reconnect');
    await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(f.parameters.get(f.replacement.parameterName).accessToken).toBe('new-connection-access');
  });

  it('fails closed when conditional metadata persistence is unavailable', async () => {
    const f = fixture(provider);
    const send = f.ddb.send.getMockImplementation();
    f.ddb.send.mockImplementation(async (command) => {
      if (command instanceof UpdateCommand) throw new Error('Storage unavailable');
      return send(command);
    });
    await expect(f.refresh()).rejects.toThrow('Storage unavailable');
    expect(f.state.current).toEqual(f.item);
  });

  it('rejects an already revoked snapshot without reading the old secret', async () => {
    const f = fixture(provider);
    await f.changeConnection('disconnect');
    await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(f.ssm.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('rejects a GitLab losing-refresh fallback if the connection was replaced', async () => {
  const f = fixture('gitlab');
  fetch.mockImplementationOnce(async () => {
    await f.changeConnection('reconnect');
    f.parameters.set(f.item.parameterName, {
      accessToken: 'winner-from-old-connection',
      refreshToken: 'winner-refresh',
    });
    return { status: 400, json: async () => ({ error: 'invalid_grant' }) };
  });
  await expect(f.refresh()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
});
