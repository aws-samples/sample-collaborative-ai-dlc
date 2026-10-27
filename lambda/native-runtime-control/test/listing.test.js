import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi, nativeIntentView } from '../api.js';
import { createNativeIntentListing, NATIVE_DISCOVERY_INDEX } from '../listing.js';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import {
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  OTHER,
  PROJECT,
  TABLE,
  createInput,
  event,
  request,
  setup,
} from './fixtures.js';

const json = (response) => JSON.parse(response.body);
const listEvent = (query = { view: 'list' }, overrides = {}) =>
  event('capabilities', { queryStringParameters: query, ...overrides });
const hint = (row) =>
  Object.fromEntries(
    ['pk', 'sk', 'projectId', 'createdAt', 'executionId'].map((key) => [key, row[key]]),
  );
const lastKey = (row) =>
  Object.fromEntries(['pk', 'sk', 'projectId', 'createdAt'].map((key) => [key, row[key]]));
const token = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fixture = () => {
  const f = setup();
  const query = vi.fn(async () => ({ Items: [] }));
  const storageSend = f.ddb.send.getMockImplementation();
  f.ddb.send.mockImplementation((command) =>
    command instanceof QueryCommand ? query(command.input) : storageSend(command),
  );
  const listing = createNativeIntentListing({ ddb: f.ddb, tableName: TABLE, store: f.store });
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const enqueue = vi.fn();
  const sources = { getAuthorizedBinding: vi.fn() };
  const jobs = { get: vi.fn() };
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT, OTHER],
    store: f.store,
    getMembershipSnapshot: membership,
    listNativeIntents: (input) => listing.list(input),
    enqueue,
    workflowSources: sources,
    jobs,
    image: IMAGE,
  });
  let serial = 0;
  const seed = async (overrides = {}) => {
    serial++;
    const input = createInput({
      request: request({
        intentId: `10000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
        prompt: 'private prompt not for discovery',
      }),
      ...overrides,
    });
    return (await f.store.create(input)).row;
  };
  const noReadSideEffects = () => {
    expect(
      f.ddb.send.mock.calls.every(
        ([cmd]) => cmd instanceof QueryCommand || cmd instanceof GetCommand,
      ),
    ).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sources.getAuthorizedBinding).not.toHaveBeenCalled();
    expect(jobs.get).not.toHaveBeenCalled();
  };
  return { ...f, query, membership, enqueue, api, seed, noReadSideEffects };
};

describe('protected native discovery and public summaries', () => {
  it('preserves capability GET and uses one bounded descending Query for list GET', async () => {
    const f = fixture();
    const capabilities = await f.api(event('capabilities'));
    expect(json(capabilities)).toEqual({
      preparationEnabled: true,
      executionEnabled: false,
      unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
    });
    expect(f.ddb.send).not.toHaveBeenCalled();
    const response = await f.api(listEvent());
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ items: [], nextCursor: null });
    expect(f.query).toHaveBeenCalledExactlyOnceWith({
      TableName: TABLE,
      IndexName: NATIVE_DISCOVERY_INDEX,
      KeyConditionExpression: '#project = :project',
      ExpressionAttributeNames: { '#project': 'projectId' },
      ExpressionAttributeValues: { ':project': PROJECT },
      ScanIndexForward: false,
      Limit: 25,
    });
    expect(f.membership).toHaveBeenCalledTimes(4);
    f.noReadSideEffects();
  });

  it.each(['claude', 'codex', 'kiro', 'opencode'])(
    'returns the current public %s view minus prompt after a consistent, validated primary read',
    async (harness) => {
      const f = fixture();
      const row = await f.seed({
        request: request({ harness, prompt: 'private prompt not for discovery' }),
      });
      // The index predates this transition. Status must come from the source.
      f.query.mockResolvedValue({ Items: [hint(row)] });
      await f.store.prepare(IDENTITY);
      f.ddb.send.mockClear();
      const response = await f.api(listEvent());
      const expected = nativeIntentView(f.read());
      delete expected.prompt;
      delete expected.promptRevision;
      expect(response.statusCode).toBe(200);
      expect(json(response)).toEqual({ items: [expected], nextCursor: null });
      expect(json(response).items[0].status).toBe('PREPARING');
      const get = f.ddb.send.mock.calls.find(([cmd]) => cmd instanceof GetCommand)[0];
      expect(get.input).toEqual({
        TableName: TABLE,
        Key: nativeRuntimeBindingKey(IDENTITY),
        ConsistentRead: true,
      });
      for (const privateValue of [
        'private prompt',
        row.requestFingerprint,
        row.bindingId,
        row.imageUri,
        row.candidate.materializationId,
        MEMBERSHIP.projectIdentity,
      ]) {
        expect(response.body).not.toContain(privateValue);
      }
      expect(Object.keys(json(response).items[0]).toSorted()).toEqual(
        [
          'id',
          'projectId',
          'executionBackend',
          'title',
          'harness',
          'status',
          'package',
          'createdAt',
          'updatedAt',
        ].toSorted(),
      );
      f.noReadSideEffects();
    },
  );

  it('paginates equal createdAt values using the exact composite continuation key', async () => {
    const f = fixture();
    const first = await f.seed();
    const second = await f.seed();
    f.query
      .mockResolvedValueOnce({ Items: [hint(first)], LastEvaluatedKey: lastKey(first) })
      .mockResolvedValueOnce({ Items: [hint(second)] });
    f.ddb.send.mockClear();
    const page1 = json(await f.api(listEvent({ view: 'list', limit: '1' })));
    expect(page1.items.map((item) => item.id)).toEqual([first.executionId]);
    expect(typeof page1.nextCursor).toBe('string');
    const page2 = json(
      await f.api(listEvent({ view: 'list', limit: '1', cursor: page1.nextCursor })),
    );
    expect(page2.items.map((item) => item.id)).toEqual([second.executionId]);
    expect(page2.nextCursor).toBeNull();
    expect(f.query.mock.calls[1][0].ExclusiveStartKey).toEqual(lastKey(first));
    expect(f.query).toHaveBeenCalledTimes(2);
    f.noReadSideEffects();
  });

  it('skips an eventually stale deleted source without refilling or losing its cursor', async () => {
    const f = fixture();
    const removed = await f.seed();
    const retained = await f.seed();
    f.rows.delete(JSON.stringify([removed.pk, removed.sk]));
    f.query
      .mockResolvedValueOnce({ Items: [hint(removed)], LastEvaluatedKey: lastKey(removed) })
      .mockResolvedValueOnce({ Items: [hint(retained)] });
    f.ddb.send.mockClear();
    const first = json(await f.api(listEvent({ view: 'list', limit: '1' })));
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
    const second = json(await f.api(listEvent({ view: 'list', cursor: first.nextCursor })));
    expect(second.items[0].id).toBe(retained.executionId);
    f.noReadSideEffects();
  });

  it('does not trust an index hit when the source fingerprint is corrupt', async () => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue({ Items: [hint(row)] });
    f.write({ ...row, request: { ...row.request, title: 'injected private title' } });
    f.ddb.send.mockClear();
    const response = await f.api(listEvent());
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('injected');
    expect(json(response)).not.toHaveProperty('items');
    f.noReadSideEffects();
  });

  it.each([
    ['removed membership', null],
    ['replacement membership', { ...MEMBERSHIP, membershipId: 'new-edge' }],
    ['recreated project', { ...MEMBERSHIP, projectIdentity: 'new-vertex' }],
  ])('withholds the entire page after %s during its primary read', async (_label, changed) => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue({ Items: [hint(row)] });
    f.hooks.after = async (command) => {
      if (command instanceof GetCommand) f.membership.mockResolvedValue(changed);
    };
    f.ddb.send.mockClear();
    const response = await f.api(listEvent());
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(row.request.title);
    expect(json(response)).not.toHaveProperty('items');
    f.noReadSideEffects();
  });

  it('denies source rows belonging to an earlier physical project identity', async () => {
    const f = fixture();
    const row = await f.seed({ projectIdentity: 'deleted-project-vertex' });
    f.query.mockResolvedValue({ Items: [hint(row)] });
    const response = await f.api(listEvent());
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(row.request.title);
  });

  it('checks membership before querying and again even for an empty page', async () => {
    const f = fixture();
    f.membership.mockResolvedValueOnce(null);
    expect((await f.api(listEvent())).statusCode).toBe(403);
    expect(f.query).not.toHaveBeenCalled();
    f.membership.mockResolvedValueOnce(MEMBERSHIP).mockResolvedValueOnce(null);
    expect((await f.api(listEvent())).statusCode).toBe(403);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});

describe('native discovery HTTP query and cursor boundary', () => {
  it.each([
    { view: 'list', limit: '1' },
    { view: 'list', limit: '50' },
  ])('accepts valid limits %j', async (query) => {
    const f = fixture();
    expect((await f.api(listEvent(query))).statusCode).toBe(200);
    expect(f.query.mock.calls[0][0].Limit).toBe(Number(query.limit));
  });

  it.each([
    { view: 'all' },
    { limit: '25' },
    { view: 'list', actorId: 'other' },
    { view: 'list', projectId: OTHER },
    { view: 'list', index: 'agent-writable-META' },
    { view: 'list', cursor: '' },
    { view: 'list', cursor: 'a'.repeat(2049) },
    { view: 'list', cursor: 'not+base64' },
    {
      view: 'list',
      cursor: token({ v: 1, projectId: PROJECT, executionId: OTHER, createdAt: 1, pk: 'injected' }),
    },
    { view: 'list', cursor: token({ v: 2, projectId: PROJECT, executionId: OTHER, createdAt: 1 }) },
    { view: 'list', cursor: token({ v: 1, projectId: OTHER, executionId: OTHER, createdAt: 1 }) },
    {
      view: 'list',
      cursor: token({ v: 1, projectId: PROJECT, executionId: 'invalid', createdAt: 1 }),
    },
    {
      view: 'list',
      cursor: token({ v: 1, projectId: PROJECT, executionId: OTHER, createdAt: -1 }),
    },
    {
      view: 'list',
      cursor: token({ v: 1, projectId: PROJECT, executionId: OTHER, createdAt: '1000' }),
    },
    ...['0', '51', '01', '-1', '1.0', '1e1', ' 1', '1\n', '', 25, null].map((limit) => ({
      view: 'list',
      limit,
    })),
  ])('rejects malformed or cross-scope query before protected work: %j', async (query) => {
    const f = fixture();
    const response = await f.api(listEvent(query));
    expect(response.statusCode).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.ddb.send).not.toHaveBeenCalled();
  });

  it('accepts matching single/multivalue maps and multivalue-only requests', async () => {
    const f = fixture();
    for (const single of [{ view: 'list', limit: '1' }, undefined]) {
      expect(
        (
          await f.api(
            listEvent(single, {
              queryStringParameters: single,
              multiValueQueryStringParameters: { view: ['list'], limit: ['1'] },
            }),
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    { queryStringParameters: [] },
    { queryStringParameters: 'view=list' },
    { multiValueQueryStringParameters: [] },
    { multiValueQueryStringParameters: { view: ['list', 'list'] } },
    { multiValueQueryStringParameters: { view: [] } },
    { multiValueQueryStringParameters: { view: 'list' } },
    { multiValueQueryStringParameters: { view: ['other'] } },
    { multiValueQueryStringParameters: { view: ['list'], limit: ['1'] } },
    { multiValueQueryStringParameters: {} },
    { queryStringParameters: {}, multiValueQueryStringParameters: { view: ['list'] } },
  ])(
    'rejects malformed, duplicate, or conflicting query representations: %j',
    async (overrides) => {
      const f = fixture();
      expect((await f.api(listEvent({ view: 'list' }, overrides))).statusCode).toBe(400);
      expect(f.membership).not.toHaveBeenCalled();
      expect(f.ddb.send).not.toHaveBeenCalled();
    },
  );

  it.each(['get', 'prepare', 'create'])(
    'does not enable listing queries on %s',
    async (operation) => {
      const f = fixture();
      expect(
        (await f.api(event(operation, { queryStringParameters: { view: 'list' } }))).statusCode,
      ).toBe(400);
      expect(f.membership).not.toHaveBeenCalled();
      expect(f.ddb.send).not.toHaveBeenCalled();
    },
  );

  it('rejects replaying a genuine cursor under another project before querying', async () => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue({ Items: [hint(row)], LastEvaluatedKey: lastKey(row) });
    const { nextCursor } = json(await f.api(listEvent()));
    f.query.mockClear();
    f.membership.mockClear();
    const response = await f.api(
      listEvent(
        { view: 'list', cursor: nextCursor },
        {
          pathParameters: { projectId: OTHER },
          path: `/api/projects/${OTHER}/native-intents`,
        },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.membership).not.toHaveBeenCalled();
  });
});

describe('native discovery index hints never confer authority', () => {
  it.each([
    ['another project', (row) => ({ ...hint(row), projectId: OTHER })],
    [
      'another primary hash',
      (row) => ({
        ...hint(row),
        pk: nativeRuntimeBindingKey({ projectId: OTHER, executionId: row.executionId }).pk,
      }),
    ],
    ['another execution', (row) => ({ ...hint(row), executionId: OTHER })],
    ['another row kind', (row) => ({ ...hint(row), sk: 'META' })],
    [
      'missing execution',
      (row) => {
        const value = hint(row);
        delete value.executionId;
        return value;
      },
    ],
    ['invalid timestamp', (row) => ({ ...hint(row), createdAt: '1000' })],
    ['injected public data', (row) => ({ ...hint(row), title: 'injected' })],
  ])('fails closed before source reads for %s', async (_label, altered) => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue({ Items: [hint(row), altered(row)] });
    f.ddb.send.mockClear();
    const response = await f.api(listEvent());
    expect(response.statusCode).toBe(503);
    expect(f.ddb.send.mock.calls).toHaveLength(1);
    expect(json(response)).not.toHaveProperty('items');
  });

  it.each([
    ['missing Items', () => ({})],
    ['duplicate row', (row) => ({ Items: [hint(row), hint(row)] })],
    ['too many rows', (row) => ({ Items: [hint(row), hint(row)] })],
    [
      'foreign continuation',
      (row) => ({ Items: [hint(row)], LastEvaluatedKey: { ...lastKey(row), projectId: OTHER } }),
    ],
    [
      'injected continuation key',
      (row) => ({
        Items: [hint(row)],
        LastEvaluatedKey: { ...lastKey(row), runtimeArn: 'private' },
      }),
    ],
    ['continuation without hints', (row) => ({ Items: [], LastEvaluatedKey: lastKey(row) })],
  ])('does not return a successful partial page for %s', async (_label, response) => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue(response(row));
    f.ddb.send.mockClear();
    expect((await f.api(listEvent({ view: 'list', limit: '1' }))).statusCode).toBe(503);
    expect(f.ddb.send.mock.calls).toHaveLength(1);
  });

  it('rejects a validly shaped hint with a timestamp that disagrees with the source', async () => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockResolvedValue({ Items: [{ ...hint(row), createdAt: row.createdAt + 1 }] });
    expect((await f.api(listEvent())).statusCode).toBe(503);
  });

  it('redacts a failed query or primary read and never returns an advancing cursor on failure', async () => {
    const f = fixture();
    const row = await f.seed();
    f.query.mockRejectedValueOnce(new Error('private AWS details and credentials'));
    const queryFailure = await f.api(listEvent());
    expect(queryFailure.statusCode).toBe(503);
    expect(queryFailure.body).not.toContain('private');
    f.query.mockResolvedValue({ Items: [hint(row)], LastEvaluatedKey: lastKey(row) });
    f.hooks.before = async (command) => {
      if (command instanceof GetCommand) throw new Error('private primary read failure');
    };
    const sourceFailure = await f.api(listEvent());
    expect(sourceFailure.statusCode).toBe(503);
    expect(sourceFailure.body).not.toContain('private');
    expect(json(sourceFailure)).not.toHaveProperty('nextCursor');
  });
});
