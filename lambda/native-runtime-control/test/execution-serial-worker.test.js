import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createNativeExecutionSupervisor, readNativeRuntimeReport } from '../execution-worker.js';
import { executionIdentity } from '../execution-runtime.js';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';

const fixture = async () => {
  const f = serialFixture();
  await f.start();
  const turns = new Map();
  const acceptedCommands = new Set();
  let acceptedSequence = 1;
  let acceptedRequest;
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    publications: f.publications,
    interactions: f.interactions,
    authorize: vi.fn(async () => {}),
    fence: {
      ensureActive: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      suspend: vi.fn(async () => {}),
    },
    upgrade: vi.fn(async ({ execution }) => ({ ready: true, target: f.target(execution) })),
    credentials: vi.fn(async (row) => ({
      ok: true,
      ...executionIdentity(row),
      source: SERIAL_SOURCE,
      model: { provider: 'bedrock', value: 'original-starter-model-secret' },
      git: { username: 'git', password: 'source-secret' },
    })),
    stop: vi.fn(async ({ execution }) => ({
      confirmed: true,
      runtimeSessionId: execution.runtimeSessionId,
    })),
    project: vi.fn(async () => {}),
    invoke: vi.fn(async ({ execution, payload }) => {
      if (['native-start', 'native-continue'].includes(payload.command)) {
        acceptedSequence = payload.sequence;
        acceptedRequest = payload.requestId;
        if (payload.command === 'native-continue') acceptedCommands.add(payload.requestId);
        return {
          ...executionIdentity(execution),
          writerGeneration: 1,
          sequence: payload.sequence,
          status: 'preparing',
          ...(payload.requestId ? { requestId: payload.requestId } : {}),
        };
      }
      expect(payload.command).toBe('native-status');
      const sequence = acceptedSequence;
      if (!turns.has(sequence)) turns.set(sequence, await f.turn(sequence));
      const turn = turns.get(sequence);
      return {
        ...executionIdentity(execution),
        writerGeneration: 1,
        sequence,
        ...(acceptedRequest ? { requestId: acceptedRequest } : {}),
        status: 'publication_ready',
        nativeSessionId: turn.receipt.nativeSessionId,
        receipt: turn.receipt,
        interaction: turn.interactionReceipt,
      };
    }),
  };
  const run = createNativeExecutionSupervisor(ports);
  const firstTurn = async ({ project = true } = {}) => {
    for (let i = 0; i < 5; i++) await run(f.identity);
    expect(f.row().status).toBe('AWAITING_USER');
    if (project) await run(f.identity);
  };
  return { ...f, ports, run, firstTurn, turns, acceptedCommands };
};

describe('serial controller publication and continuation', () => {
  it('connects two real publications with one Start and one authenticated serial continuation', async () => {
    const f = await fixture();
    await f.firstTurn();
    const original = f.row();
    const request = f.replyRequest();
    const accepted = await f.api.respond(f.prepared, 'another-member', request, f.recheck);
    await f.run(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      turnSequence: 2,
      epoch: 1,
      response: { deliveryStatus: 'delivered' },
      startedBy: original.startedBy,
      runtimeSessionId: original.runtimeSessionId,
    });
    const calls = f.ports.invoke.mock.calls.map(([call]) => call.payload);
    expect(calls.filter((call) => call.command === 'native-start')).toHaveLength(1);
    const continuation = calls.find((call) => call.command === 'native-continue');
    expect(continuation).toEqual({
      command: 'native-continue',
      schemaVersion: 1,
      ...executionIdentity(original),
      writerGeneration: 1,
      sequence: 2,
      requestId: accepted.response.id,
      priorInteractionId: original.interaction.id,
      priorPublicationId: original.publication.id,
      text: request.text,
      configuration: calls[0].configuration,
      credentials: {
        model: { provider: 'bedrock', value: 'original-starter-model-secret' },
        git: { username: 'git', password: 'source-secret' },
      },
    });
    expect(continuation).not.toHaveProperty('package');
    await f.run(f.identity);
    expect(f.row()).toMatchObject({
      status: 'AWAITING_USER',
      turnSequence: 2,
      projectionStatus: 'pending',
      publication: { sequence: 2 },
      interaction: { sequence: 2 },
    });
    await f.run(f.identity);
    expect(f.ports.project).toHaveBeenCalledTimes(2);
    expect((await f.api.interaction(f.prepared, f.recheck)).messages[0].text).toBe(
      'Question 2: what should change?',
    );
    expect((await f.api.publication(f.prepared, f.recheck)).sequence).toBe(2);
    expect(f.acceptedCommands.size).toBe(1);
    expect(JSON.stringify(f.row())).not.toMatch(
      /original-starter-model-secret|source-secret|approved/,
    );
  });

  it('projects the previous snapshot before delivering a response accepted during graph lag', async () => {
    const f = await fixture();
    await f.firstTurn({ project: false });
    await f.respond();
    const before = f.ports.invoke.mock.calls.length;
    expect(await f.run(f.identity)).toMatchObject({ pending: true, status: 'DISPATCHING' });
    expect(f.ports.invoke).toHaveBeenCalledTimes(before);
    expect(f.row().projectionStatus).toBe('complete');
    await f.run(f.identity);
    expect(f.row().status).toBe('RUNNING');
    expect(f.ports.invoke.mock.calls.at(-1)[0].payload.command).toBe('native-continue');
  });

  it('reconciles a lost continuation ACK without replaying its model command', async () => {
    const f = await fixture();
    await f.firstTurn();
    await f.respond();
    const actualInvoke = f.ports.invoke.getMockImplementation();
    let lost = false;
    f.ports.invoke.mockImplementation(async (call) => {
      const report = await actualInvoke(call);
      if (!lost && call.payload.command === 'native-continue') {
        lost = true;
        throw Object.assign(new Error('Lost continuation ACK'), { name: 'TimeoutError' });
      }
      return report;
    });
    expect(await f.run(f.identity)).toMatchObject({ pending: true, status: 'DISPATCHING' });
    const first = f.ports.invoke.mock.calls.at(-1)[0].payload;
    await f.run(f.identity);
    const retry = f.ports.invoke.mock.calls.at(-1)[0].payload;
    expect(retry.command).toBe('native-status');
    expect(retry.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(
      f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-continue'),
    ).toHaveLength(1);
    expect(f.acceptedCommands.size).toBe(1);
    expect(f.row().response.deliveryStatus).toBe('delivered');
  });

  it.each(['missing-owner', 'wrong-command', 'wrong-sequence'])(
    'fails closed on continuation ACK %s without starting a new owner',
    async (kind) => {
      const f = await fixture();
      await f.firstTurn();
      await f.respond();
      const actualInvoke = f.ports.invoke.getMockImplementation();
      f.ports.invoke.mockImplementation(async (call) =>
        call.payload.command !== 'native-continue'
          ? actualInvoke(call)
          : {
              ...executionIdentity(call.execution),
              writerGeneration: 1,
              sequence: call.payload.sequence + (kind === 'wrong-sequence' ? 1 : 0),
              requestId: kind === 'wrong-command' ? 'unrelated-command' : call.payload.requestId,
              status: kind === 'missing-owner' ? 'idle' : 'preparing',
            },
      );
      await f.run(f.identity);
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: false },
        turnSequence: 2,
      });
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(
        f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-start'),
      ).toHaveLength(1);
    },
  );

  it.each(['native_execution_existing_owner', 'native_execution_reply_admission_unconfirmed'])(
    'treats HTTP 409 %s as terminal without auto Start',
    async (code) => {
      const f = await fixture();
      await f.firstTurn();
      await f.respond();
      const stream = Readable.from([
        Buffer.from(
          JSON.stringify({
            ok: false,
            code,
          }),
        ),
      ]);
      const actualInvoke = f.ports.invoke.getMockImplementation();
      f.ports.invoke.mockImplementation((call) =>
        call.payload.command !== 'native-continue'
          ? actualInvoke(call)
          : readNativeRuntimeReport({
              statusCode: 409,
              contentType: 'application/json',
              response: stream,
            }),
      );
      await f.run(f.identity);
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: false },
      });
      expect(stream.destroyed).toBe(true);
      expect(
        f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-start'),
      ).toHaveLength(1);
    },
  );

  it('rejects an otherwise valid interaction from another configured harness before committing it', async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.run(f.identity);
    f.turns.set(1, await f.turn(1, { harness: 'claude' }));
    await f.run(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_publication_invalid',
    });
    expect(f.row().interaction).toBeUndefined();
    expect(f.row().publication).toBeUndefined();
  });

  it('cancellation while credentials are resolving prevents the continuation invocation', async () => {
    const f = await fixture();
    await f.firstTurn();
    await f.respond();
    const credentials = f.ports.credentials.getMockImplementation();
    f.ports.credentials.mockImplementationOnce(async (row) => {
      await f.store.cancel(f.bindingIdentity);
      return credentials(row);
    });
    await expect(f.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_LEASE_LOST' });
    expect(
      f.ports.invoke.mock.calls.some(([call]) => call.payload.command === 'native-continue'),
    ).toBe(false);
    await f.run(f.identity);
    expect(f.row()).toMatchObject({ status: 'CANCELLED', epoch: 2 });
  });
});
