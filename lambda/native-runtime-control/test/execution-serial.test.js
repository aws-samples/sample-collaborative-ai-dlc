import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { executionIdentity } from '../execution-runtime.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';

const waiting = async (options) => {
  const f = serialFixture();
  await f.ready();
  const first = await f.publish(options);
  return { ...f, first };
};
const executionPut = (command) =>
  command instanceof TransactWriteCommand
    ? command.input.TransactItems.find((item) => item.Put?.Item.sk === 'EXECUTION')?.Put.Item
    : null;
const resume = async (f) => {
  const claim = await f.store.claim(f.bindingIdentity);
  return f.store.release({ row: await f.store.dispatched({ row: claim.row }) });
};

describe('serial native interaction authority', () => {
  it('accepts a real assistant interaction without inventing native question files or approvals', async () => {
    const f = await waiting();
    expect(f.row()).toMatchObject({
      status: 'AWAITING_USER',
      turnSequence: 1,
      interactionEpoch: 1,
      publication: { outcome: 'STOPPED', question: null, filesCount: 1 },
    });
    const view = await f.api.interaction(f.prepared, f.recheck);
    expect(view).toMatchObject({
      kind: 'assistant_turn',
      sequence: 1,
      response: null,
      messages: [{ type: 'text', text: 'Question 1: what should change?' }],
    });
    expect(view.contentSha256).not.toBe(view.id);
    expect(JSON.stringify(view)).not.toMatch(/approved|authority|credentials|runtimeSessionId/);
    const files = await f.api.publication(f.prepared, f.recheck);
    expect(files.files.map((file) => file.path)).toEqual(['src/game.js']);
    expect(files.question).toBeNull();
  });

  it('atomically accepts one member response, preserving exact text and the original identity', async () => {
    const f = await waiting();
    const original = f.row();
    const request = f.replyRequest({ text: '  A literal answer.\r\nSecond line 🐦  ' });
    const writes = [];
    f.hooks.before = (command) => {
      if (command instanceof TransactWriteCommand) writes.push(command.input.TransactItems);
    };
    const accepted = await f.respond(request);
    expect(accepted.created).toBe(true);
    expect(accepted.row).toMatchObject({
      status: 'DISPATCHING',
      turnSequence: 2,
      epoch: 1,
      attemptId: original.attemptId,
      runtimeSessionId: original.runtimeSessionId,
      startedBy: original.startedBy,
      configuration: original.configuration,
      response: { actorId: 'responding-member', deliveryStatus: 'pending' },
    });
    expect(accepted.response.text).toBe(request.text);
    expect(accepted.response.commandId).not.toBe(request.requestId);
    expect(accepted.row).not.toHaveProperty('leaseToken');
    expect(accepted.row.response).not.toHaveProperty('text');
    expect(writes).toHaveLength(1);
    expect(writes[0].map((item) => item.Put.Item.sk)).toEqual([
      'EXECUTION',
      `RESPONSE#${request.interactionId}`,
      expect.stringMatching(/^RESPONSE_REQUEST#[a-f0-9]{64}$/),
    ]);
    expect(await f.respond(request)).toMatchObject({
      created: false,
      response: { commandId: accepted.response.commandId, text: request.text },
    });
  });

  it('allows exactly one of two members racing the same interaction to accept a response', async () => {
    const f = await waiting();
    const outcomes = await Promise.allSettled([
      f.respond(f.replyRequest({ text: 'First member' }), 'member-one'),
      f.respond(f.replyRequest({ text: 'Second member' }), 'member-two'),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((item) => item.status === 'rejected').reason.code).toBe(
      'NATIVE_EXECUTION_CONFLICT',
    );
    expect(f.row().turnSequence).toBe(2);
    const ledger = await f.store.response(f.row(), f.first.interactionReceipt.id);
    expect(ledger.actorId).toBe(f.row().response.actorId);
    expect(['First member', 'Second member']).toContain(ledger.text);
  });

  it('recovers the same accepted command after the atomic transaction reply is lost', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.hooks.after = (command) => {
      if (executionPut(command)?.response) {
        delete f.hooks.after;
        throw new Error('Lost transaction acknowledgement');
      }
    };
    const accepted = await f.respond(request);
    const retry = await f.respond(request);
    expect(retry.response.commandId).toBe(accepted.response.commandId);
    expect(retry.created).toBe(false);
    expect(f.row().turnSequence).toBe(2);
  });

  it('reads a response accepted between the interaction read and its ledger lookup', async () => {
    const f = await waiting();
    const stale = f.row();
    const request = f.replyRequest();
    await f.respond(request);
    const response = await f.store.response(stale, request.interactionId);
    expect(response.text).toBe(request.text);
    const view = await f.api.interaction(f.prepared, f.recheck);
    expect(view.response).toMatchObject({ text: request.text, deliveryStatus: 'pending' });
  });

  it('repairs a lost queue send by retrying acceptance without duplicating the command', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.enqueue.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(f.api.respond(f.prepared, 'member-one', request, f.recheck)).rejects.toThrow(
      'Queue',
    );
    const commandId = f.row().response.commandId;
    const retry = await f.api.respond(f.prepared, 'member-one', request, f.recheck);
    expect(retry).toMatchObject({
      execution: { sequence: 2, status: 'DISPATCHING', responsePending: true },
      response: {
        id: commandId,
        kind: 'user_reply',
        deliveryStatus: 'pending',
        text: request.text,
      },
    });
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect(f.configure).not.toHaveBeenCalled();
  });

  it.each([
    ['extra approval', { approved: true }],
    ['extra actor', { actorId: 'forged-member' }],
    ['action authority', { action: 'approve' }],
    ['empty', { text: ' \n\t' }],
    ['oversized UTF-8', { text: '🐦'.repeat(4097) }],
    ['invalid UTF-16', { text: '\ud800' }],
    ['NUL', { text: 'answer\0hidden' }],
  ])('rejects response input: %s', async (_name, changes) => {
    const f = await waiting();
    const before = f.row();
    await expect(f.respond({ ...f.replyRequest(), ...changes })).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_INVALID',
    });
    expect(f.row()).toEqual(before);
  });

  it('rejects stale content, changed idempotent text, and reuse of a request ID for another turn', async () => {
    const f = await waiting();
    await expect(
      f.respond(f.replyRequest({ contentSha256: 'f'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    const request = f.replyRequest();
    const first = await f.respond(request);
    await expect(f.respond({ ...request, text: 'Changed retry' })).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_CONFLICT',
    });
    await resume(f);
    const second = await f.publish();
    expect(second.row.turnSequence).toBe(2);
    await expect(f.respond(f.replyRequest({ requestId: request.requestId }))).rejects.toMatchObject(
      { code: 'NATIVE_EXECUTION_CONFLICT' },
    );
    const retry = await f.respond(request);
    expect(retry.response.commandId).toBe(first.response.commandId);
    expect(retry.row.status).toBe('AWAITING_USER');
    expect(retry.row.interaction.id).toBe(second.interactionReceipt.id);
    const history = await f.ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: f.row().pk, sk: 'PUBLICATION#0000000000000001' },
        ConsistentRead: true,
      }),
    );
    expect(history.Item.publication).toEqual(f.first.receipt);
    const old = await f.publications.read(executionIdentity(f.row()), history.Item.publication, {
      verifyFiles: true,
    });
    expect(old.sequence).toBe(1);
  });

  it('cancellation wins a response transaction race and leaves no accepted ledger entry', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.hooks.before = async (command) => {
      if (executionPut(command)?.response) {
        delete f.hooks.before;
        await f.store.cancel(f.bindingIdentity);
      }
    };
    await expect(f.respond(request)).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CANCELLED' });
    expect(f.row()).toMatchObject({ status: 'CANCEL_REQUESTED', epoch: 2, turnSequence: 1 });
    expect(await f.store.response(f.row(), request.interactionId)).toBeNull();
  });

  it('keeps historical interaction and response readable after cancel, but rejects further replies', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    await f.respond(request);
    await f.store.cancel(f.bindingIdentity);
    const view = await f.api.interaction(f.prepared, f.recheck);
    expect(view).toMatchObject({ id: request.interactionId, response: { text: request.text } });
    expect(f.reads.at(-1).Key).toContain('/1/interactions/');
    await expect(
      f.api.respond(f.prepared, 'responding-member', request, f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CANCELLED' });
    expect(f.row().interactionEpoch).toBe(1);
  });

  it('checks membership and the execution opt-in before accepting input', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.authorization.member = false;
    await expect(f.api.respond(f.prepared, 'member-one', request, f.recheck)).rejects.toMatchObject(
      { code: 'NATIVE_PREPARATION_FORBIDDEN' },
    );
    f.authorization.member = true;
    await expect(
      f.makeApi(false).respond(f.prepared, 'member-one', request, f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_DISABLED' });
    expect((await f.makeApi(false).interaction(f.prepared, f.recheck)).id).toBe(
      request.interactionId,
    );
    expect(f.row().status).toBe('AWAITING_USER');
  });

  it('does not accept a second command while the first continuation is pending', async () => {
    const f = await waiting({ project: false });
    await f.respond();
    await expect(
      f.respond(f.replyRequest({ requestId: randomUUID(), text: 'Another reply' })),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    expect(f.row()).toMatchObject({
      status: 'DISPATCHING',
      turnSequence: 2,
      projectionStatus: 'pending',
    });
  });
});
