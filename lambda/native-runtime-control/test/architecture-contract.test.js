import { describe, it, expect, vi } from 'vitest';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createNativeAuthority } from '../authority.js';
import { createNativeWakeupBridge, nativeWakeupTargets } from '../wakeup.js';
import { createNativeProjectionStore, nativeProjectionStatus } from '../projection-store.js';
import { createNativeProjector } from '../projection-worker.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { memoryGraph } from './native-graph-fixture.js';
import {
  projectNativePublication,
  readNativePublicationInteraction,
} from '../publication-graph.js';
import { executionIdentity } from '../execution-runtime.js';
import { TABLE } from './fixtures.js';

const projection = (f, overrides = {}) => {
  const graph = memoryGraph();
  const store = createNativeProjectionStore({
    ddb: f.ddb,
    tableName: TABLE,
    execution: f.store,
    preparation: f.preparationStore,
    now: f.now,
    leaseMs: 120000,
  });
  const project = vi.fn((input) => projectNativePublication({ ...input, g: graph.g }));
  const run = createNativeProjector({
    store,
    publications: f.publications,
    interactions: f.interactions,
    authorize: f.recheck,
    project,
    ...overrides,
  });
  return { store, graph, project, run };
};
const secondPublication = async (f) => {
  await f.respond();
  const { row } = await f.store.claim(f.bindingIdentity);
  const running = await f.store.dispatched({ row });
  await f.store.release({ row: running });
  await f.publish({ project: false });
};

describe('committed native work delivery', () => {
  it('repairs a failed first notification after restart without any client retry', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish();
    f.enqueue.mockRejectedValueOnce(new Error('lost SQS'));
    const request = f.replyRequest();
    const accepted = await f.api.respond(f.prepared, 'member', request, f.recheck);
    const send = vi.fn().mockRejectedValueOnce(new Error('consumer unavailable'));
    const create = () =>
      createNativeWakeupBridge({
        ddb: f.ddb,
        sqs: { send },
        tableName: TABLE,
        queues: { execution: 'execution', projection: 'projection' },
      });
    await expect(create()({ source: 'aws.events' })).rejects.toThrow();
    send.mockResolvedValue({ MessageId: 'delivered' });
    await create()({ source: 'aws.events' });
    await create()({ source: 'aws.events' }); // duplicate delivery
    expect(send.mock.calls.filter(([c]) => c.input.QueueUrl === 'execution').length).toBe(3);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect((await f.store.response(f.row(), request.interactionId)).commandId).toBe(
      accepted.response.id,
    );
    expect(f.row().turnSequence).toBe(2);
    const first = await f.store.claim(f.bindingIdentity);
    expect(first.kind).toBe('claimed');
    expect((await f.store.claim(f.bindingIdentity)).kind).toBe('busy');
  });

  it('repairs all pages and routes cancellation independently of ordinary work', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [{ sk: 'RUNTIME', status: 'PREPARING', projectId: 'p', executionId: 'e' }],
          LastEvaluatedKey: { pk: 'last', sk: 'RUNTIME' },
        })
        .mockResolvedValueOnce({
          Items: [
            {
              sk: 'EXECUTION',
              status: 'CANCEL_REQUESTED',
              scope: { projectId: 'p', executionId: 'e' },
            },
          ],
        }),
    };
    const sqs = { send: vi.fn(async () => ({ MessageId: 'ack' })) };
    await createNativeWakeupBridge({
      ddb,
      sqs,
      tableName: TABLE,
      queues: { preparation: 'prepare', cancellation: 'urgent' },
    })({ source: 'aws.events' });
    expect(ddb.send.mock.calls[1][0]).toBeInstanceOf(ScanCommand);
    expect(ddb.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: 'last',
      sk: 'RUNTIME',
    });
    expect(sqs.send.mock.calls.map(([c]) => c.input.QueueUrl)).toEqual(['prepare', 'urgent']);
    const row = { sk: 'EXECUTION', status: 'RUNNING', version: 2, leaseToken: 'a' };
    expect(nativeWakeupTargets(row, { ...row, version: 1, leaseToken: 'b' })).toEqual([]);
  });

  it('repairs an expired image-revocation event for a quiet waiting execution', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const row = {
      sk: 'EXECUTION',
      status: 'AWAITING_USER',
      scope: { projectId: 'project', executionId: 'execution' },
      configuration: { image: { digest } },
    };
    const ddb = {
      send: vi.fn(async (command) =>
        command instanceof ScanCommand
          ? { Items: [row] }
          : { Item: { pk: `NATIVE_RUNTIME_IMAGE#${digest}`, sk: 'REVOCATION' } },
      ),
    };
    const sqs = { send: vi.fn(async () => ({ MessageId: 'urgent' })) };
    await createNativeWakeupBridge({
      ddb,
      sqs,
      tableName: TABLE,
      queues: { cancellation: 'urgent' },
    })({ source: 'aws.events' });
    expect(ddb.send.mock.calls[1][0]).toBeInstanceOf(GetCommand);
    expect(sqs.send.mock.calls[0][0].input.QueueUrl).toBe('urgent');
  });

  it('keeps reads, accepted replies, cancellation and pinned configuration during admission shutdown', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish();
    const original = structuredClone(f.row().configuration);
    const disabled = f.makeApi(false);
    expect((await disabled.status(f.prepared, f.recheck)).executionAvailable).toBe(true);
    const request = f.replyRequest();
    await disabled.respond(f.prepared, 'member', request, f.recheck);
    expect((await disabled.publication(f.prepared, f.recheck)).sequence).toBe(1);
    await disabled.start(f.prepared, 'member', 'idempotent-start', f.recheck);
    await disabled.cancel(f.prepared, f.recheck);
    expect(f.row().configuration).toEqual(original);
    expect(f.row().cancelRequested).toBe(true);
  });
});

describe('independent immutable projection', () => {
  it('publishes the next turn during graph failure, then catches up in exact order', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const p = projection(f);
    p.project.mockRejectedValueOnce(new Error('graph unavailable'));
    await expect(p.run(f.identity)).rejects.toThrow('graph unavailable');
    await secondPublication(f);
    expect(f.row().publication.sequence).toBe(2);
    const executionBefore = f.row();
    await p.run(f.identity);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
    await p.run(f.identity);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    expect(p.project.mock.calls.map(([call]) => call.publication.sequence)).toEqual([1, 1, 2]);
    expect(f.row()).toEqual(executionBefore); // projector never mutates EXECUTION
    expect(await p.run(f.identity)).toEqual({ pending: false });
  });

  it('rejects stale progress acknowledgements and an old graph replay after a newer revision', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const p = projection(f);
    const stale = await p.store.claim(f.identity);
    const manifest = await f.publications.read(executionIdentity(stale.row), stale.row.publication);
    const interaction = await readNativePublicationInteraction({
      draft: stale.draft,
      row: stale.row,
      manifest,
      interactions: f.interactions,
    });
    f.tick();
    await p.run(f.identity);
    await expect(p.store.acknowledge(stale)).rejects.toMatchObject({
      code: 'NATIVE_PROJECTION_CONFLICT',
    });
    await secondPublication(f);
    await p.run(f.identity);
    const before = structuredClone([...p.graph.vertices]);
    await expect(
      projectNativePublication({
        g: p.graph.g,
        draft: stale.draft,
        publication: stale.row.publication,
        manifest,
        interaction,
        authorize: f.recheck,
      }),
    ).rejects.toThrow();
    expect([...p.graph.vertices]).toEqual(before);
  });

  it('does not bypass revoked membership during graph catch-up', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const p = projection(f);
    f.authorization.member = false;
    await expect(p.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_FORBIDDEN' });
    expect(p.graph.writes).toEqual([]);
    expect(f.row().publication.sequence).toBe(1);
  });

  it('adopts the exact first-turn legacy head when immutable history predates storage', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const send = f.ddb.send.bind(f.ddb);
    f.ddb.send = (command) =>
      command.constructor.name === 'QueryCommand' ? Promise.resolve({ Items: [] }) : send(command);
    const p = projection(f);
    await p.run(f.identity);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    expect(p.project.mock.calls[0][0].publication).toEqual(f.row().publication);
  });

  it('rejects a forged acknowledgement that skips the admitted target sequence', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const p = projection(f);
    const claim = await p.store.claim(f.identity);
    const forged = structuredClone(claim);
    forged.row.publication.sequence++;
    await expect(p.store.acknowledge(forged)).rejects.toMatchObject({
      code: 'NATIVE_PROJECTION_CONFLICT',
    });
    await p.store.acknowledge(claim);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
  });
});

describe('native mutation authority callers', () => {
  const arn = 'arn:aws:lambda:us-east-1:123456789012:function:native-authority';
  const setup = () => {
    const stores = {
      execution: { respond: vi.fn(), advance: vi.fn(async () => 'observed') },
      preparation: { ready: vi.fn() },
    };
    const commands = vi.fn(async (event) => event.requestContext.authorizer.claims.sub);
    const verify = vi.fn(async () => ({ sub: 'verified-member' }));
    return {
      stores,
      commands,
      verify,
      run: createNativeAuthority({ stores, commands, verify, functionName: arn }),
    };
  };
  it.each([
    ['execution', 'execution', 'respond'],
    ['preparation', 'execution', 'advance'],
    ['projection', 'preparation', 'ready'],
    ['preparation', 'preparation', 'savePrompt'],
    ['execution', 'preparation', 'savePrompt'],
    ['projection', 'preparation', 'savePrompt'],
    ['operator', 'execution', 'advance'],
    ['', 'execution', 'advance'],
  ])('denies %s calling %s.%s', async (caller, aggregate, operation) => {
    const f = setup();
    expect(
      await f.run({ aggregate, operation, args: [] }, { invokedFunctionArn: `${arn}:${caller}` }),
    ).toEqual({ ok: false, code: 'NATIVE_AUTHORITY_FORBIDDEN' });
    expect(f.stores.execution.advance).not.toHaveBeenCalled();
    expect(f.stores.execution.respond).not.toHaveBeenCalled();
  });
  it('accepts a fenced observation only through its IAM-restricted alias', async () => {
    const f = setup();
    expect(
      await f.run(
        { aggregate: 'execution', operation: 'advance', args: [{}] },
        { invokedFunctionArn: `${arn}:execution` },
      ),
    ).toEqual({ ok: true, value: 'observed' });
    expect(
      await f.run(
        { aggregate: 'execution', operation: 'advance', args: [{}], caller: 'execution' },
        { invokedFunctionArn: arn },
      ),
    ).toMatchObject({ ok: false });
  });
  it('re-verifies the original token and replaces forged transport identity', async () => {
    const f = setup();
    const result = await f.run(
      {
        headers: { Authorization: 'Bearer synthetic-test-token' },
        requestContext: { authorizer: { claims: { sub: 'forged' } } },
      },
      { invokedFunctionArn: `${arn}:commands` },
    );
    expect(result).toEqual({ ok: true, value: 'verified-member' });
    expect(f.verify).toHaveBeenCalledWith('synthetic-test-token');
    await f.run(
      { requestContext: { authorizer: { claims: { sub: 'forged' } } } },
      { invokedFunctionArn: `${arn}:commands` },
    );
    expect(f.commands).toHaveBeenCalledTimes(1);
  });
});
