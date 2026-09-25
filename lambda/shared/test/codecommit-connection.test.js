import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureCodeCommitConnection,
  getCodeCommitConnection,
  resolveCodeCommitExternalId,
} from '../codecommit-connection.js';
import { verifyCodeCommitRoleBinding } from '../source-control-credentials.js';

const TABLE = 'git-provider-connections-test';
const ROLE_A = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';
const ID_A = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
const ID_B = 'aidlc:7c9e6679-7425-40de-944b-e07fc1f90ae7';

// In-memory stand-in for the composite-key connections table. Enforces the
// conditional put so the get-or-create race is exercised for real.
const fakeDdb = (rows = []) => {
  const items = new Map(rows.map((row) => [`${row.userId}|${row.providerInstance}`, row]));
  const calls = [];
  return {
    items,
    calls,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      calls.push(name);
      const id = (k) => `${k.userId}|${k.providerInstance}`;
      if (name === 'GetCommand') return { Item: items.get(id(input.Key)) };
      if (name === 'PutCommand') {
        const k = id(input.Item);
        if (input.ConditionExpression && items.has(k)) {
          throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        }
        items.set(k, input.Item);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
};

const connectionRow = (userId, externalId) => ({
  userId,
  providerInstance: 'codecommit#public',
  provider: 'codecommit',
  externalId,
});

// STS double that records every AssumeRole and then returns an incomplete
// credential, so a test can see exactly what was presented without the
// provider probe running.
const recordingSts = () => {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input);
      return { Credentials: {} };
    },
  };
};

describe('codecommit connection', () => {
  let env;
  beforeEach(() => {
    env = { ...process.env };
    process.env.GIT_PROVIDER_CONNECTIONS_TABLE = TABLE;
  });
  afterEach(() => {
    process.env = env;
  });

  it('mints one external id per user and returns the same one on every call', async () => {
    const ddb = fakeDdb();
    const first = await ensureCodeCommitConnection(ddb, 'user-a');
    expect(first.externalId).toMatch(/^aidlc:[0-9a-f-]{36}$/);
    expect(first).toMatchObject({ providerInstance: 'codecommit#public', provider: 'codecommit' });
    const again = await ensureCodeCommitConnection(ddb, 'user-a');
    expect(again.externalId).toBe(first.externalId);
    const other = await ensureCodeCommitConnection(ddb, 'user-b');
    expect(other.externalId).not.toBe(first.externalId);
  });

  it('keeps the winner when two first calls race', async () => {
    const ddb = fakeDdb();
    const original = ddb.send.bind(ddb);
    let raced = false;
    // The first read misses, then a concurrent request wins the put.
    ddb.send = async (command) => {
      if (!raced && command.constructor.name === 'PutCommand') {
        raced = true;
        ddb.items.set('user-a|codecommit#public', connectionRow('user-a', ID_A));
      }
      return original(command);
    };
    const result = await ensureCodeCommitConnection(ddb, 'user-a');
    expect(result.externalId).toBe(ID_A);
  });

  it('refuses to operate without the connections table', async () => {
    delete process.env.GIT_PROVIDER_CONNECTIONS_TABLE;
    await expect(getCodeCommitConnection(fakeDdb(), 'user-a')).rejects.toMatchObject({
      code: 'CODECOMMIT_NOT_CONFIGURED',
    });
  });

  describe('resolveCodeCommitExternalId', () => {
    it('resolves the caller connection', async () => {
      const ddb = fakeDdb([connectionRow('user-a', ID_A)]);
      await expect(
        resolveCodeCommitExternalId({ ddb, userId: 'user-a', roleArn: ROLE_A }),
      ).resolves.toBe(ID_A);
    });

    it('rejects an external id that is not the caller own', async () => {
      const ddb = fakeDdb([connectionRow('user-a', ID_A), connectionRow('user-b', ID_B)]);
      await expect(
        resolveCodeCommitExternalId({ ddb, userId: 'user-b', roleArn: ROLE_A, requested: ID_A }),
      ).rejects.toMatchObject({ code: 'EXTERNAL_ID_NOT_OWNED', status: 403 });
    });

    it('requires a connection when the caller never opened the flow', async () => {
      await expect(
        resolveCodeCommitExternalId({ ddb: fakeDdb(), userId: 'user-b', roleArn: ROLE_A }),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED', status: 409 });
    });

    it('keeps the external id a project binding already uses for the same role', async () => {
      const ddb = fakeDdb([connectionRow('user-b', ID_B)]);
      const projectBindings = [{ authType: 'codecommit-role', roleArn: ROLE_A, externalId: ID_A }];
      await expect(
        resolveCodeCommitExternalId({ ddb, userId: 'user-b', roleArn: ROLE_A, projectBindings }),
      ).resolves.toBe(ID_A);
      // A binding for a different role grants nothing for this one.
      await expect(
        resolveCodeCommitExternalId({
          ddb,
          userId: 'user-b',
          roleArn: 'arn:aws:iam::123456789012:role/other',
          projectBindings,
        }),
      ).resolves.toBe(ID_B);
    });
  });

  describe('binding verification', () => {
    it('refuses another user external id before STS is called', async () => {
      // User B learned user A's role ARN and external ID.
      for (const rows of [
        [connectionRow('user-a', ID_A)],
        [connectionRow('user-a', ID_A), connectionRow('user-b', ID_B)],
      ]) {
        const ddb = fakeDdb(rows);
        const sts = recordingSts();
        await expect(
          verifyCodeCommitRoleBinding({
            ddb,
            sts,
            repo: REPO,
            userId: 'user-b',
            selection: { roleArn: ROLE_A, externalId: ID_A },
          }),
        ).rejects.toMatchObject({
          code: rows.length === 1 ? 'CONNECTION_REQUIRED' : 'EXTERNAL_ID_NOT_OWNED',
        });
        expect(sts.calls).toHaveLength(0);
      }
    });

    it('presents only the resolved external id to STS', async () => {
      const ddb = fakeDdb([connectionRow('user-a', ID_A), connectionRow('user-b', ID_B)]);
      const sts = recordingSts();
      await expect(
        verifyCodeCommitRoleBinding({
          ddb,
          sts,
          repo: REPO,
          userId: 'user-b',
          selection: { roleArn: ROLE_A },
        }),
      ).rejects.toMatchObject({ code: 'ROLE_ASSUMPTION_FAILED' });
      expect(sts.calls.map((call) => call.ExternalId)).toEqual([ID_B]);
    });

    it('lets a project admin re-verify a role with the external id the project already uses', async () => {
      const ddb = fakeDdb([connectionRow('user-b', ID_B)]);
      const sts = recordingSts();
      await expect(
        verifyCodeCommitRoleBinding({
          ddb,
          sts,
          repo: REPO,
          userId: 'user-b',
          selection: { roleArn: ROLE_A },
          projectBindings: [{ authType: 'codecommit-role', roleArn: ROLE_A, externalId: ID_A }],
        }),
      ).rejects.toMatchObject({ code: 'ROLE_ASSUMPTION_FAILED' });
      expect(sts.calls.map((call) => call.ExternalId)).toEqual([ID_A]);
    });
  });
});
