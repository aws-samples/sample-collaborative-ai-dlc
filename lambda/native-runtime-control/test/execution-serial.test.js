import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { executionIdentity } from '../execution-runtime.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeActivityStore } from '../activity-store.js';
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
      expect.stringMatching(/^EVENT#[0-9]{16}$/),
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
    await expect(
      f.api.respond(f.prepared, 'member-one', request, f.recheck),
    ).resolves.toMatchObject({ execution: { status: 'DISPATCHING' } });
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

  it('does not invent delivery confirmation when a later answer has replaced the delivery pointer', async () => {
    const f = await waiting();
    const first = f.replyRequest();
    await f.respond(first);
    await resume(f);
    await f.publish();
    await f.respond(f.replyRequest());
    const retried = await f.api.respond(f.prepared, 'responding-member', first, f.recheck);
    expect(retried.response.deliveryStatus).toBe('unknown');
    expect(retried.response.text).toBe(first.text);
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

  it('checks membership while admission shutdown preserves existing replies', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.authorization.member = false;
    await expect(f.api.respond(f.prepared, 'member-one', request, f.recheck)).rejects.toMatchObject(
      { code: 'NATIVE_PREPARATION_FORBIDDEN' },
    );
    f.authorization.member = true;
    await expect(
      f.makeApi(false).respond(f.prepared, 'member-one', request, f.recheck),
    ).resolves.toMatchObject({ execution: { status: 'DISPATCHING' } });
    expect((await f.makeApi(false).interaction(f.prepared, f.recheck)).id).toBe(
      request.interactionId,
    );
    expect(f.row().status).toBe('DISPATCHING');
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

describe('task-2 accepted answer attribution and revocation races', () => {
  const member = { membershipId: 'edge-accepting', projectIdentity: 'vertex-project' };

  it('freezes the accepting membership snapshot and presented publication with the answer', async () => {
    const f = await waiting();
    const presented = f.row().interaction.publicationId;
    const request = f.replyRequest({ text: 'Use green pipes.' });
    await f.api.respond(f.prepared, 'member-one', request, f.recheck, member);
    const ledger = await f.store.response(f.row(), request.interactionId);
    expect(ledger).toMatchObject({
      actorId: 'member-one',
      member,
      publicationId: presented,
      text: 'Use green pipes.',
    });
    // The execution pointer keeps its established shape for retained runs.
    expect(f.row().response).not.toHaveProperty('member');
    expect(f.row().response).not.toHaveProperty('publicationId');
    // The idempotent retry returns the same attributed command.
    const retry = await f.api.respond(f.prepared, 'member-one', request, f.recheck, member);
    expect(retry.response.id).toBe(ledger.commandId);
  });

  it('keeps earlier unattributed ledgers valid for retained runs', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    await f.respond(request);
    const ledger = await f.store.response(f.row(), request.interactionId);
    expect(ledger).not.toHaveProperty('member');
    expect(ledger.text).toBe(request.text);
  });

  it('rejects a malformed membership snapshot before writing anything', async () => {
    const f = await waiting();
    const writes = [];
    f.hooks.before = (command) => {
      if (command instanceof TransactWriteCommand) writes.push(command);
    };
    await expect(
      f.store.respond({
        ...f.bindingIdentity,
        actorId: 'member-one',
        request: f.replyRequest(),
        member: { membershipId: '', projectIdentity: 'v' },
      }),
    ).rejects.toBeTruthy();
    await expect(
      f.store.respond({
        ...f.bindingIdentity,
        actorId: 'member-one',
        request: f.replyRequest(),
        member: { membershipId: 'e', projectIdentity: 'v', role: 'owner' },
      }),
    ).rejects.toBeTruthy();
    expect(writes).toHaveLength(0);
    expect(f.row().status).toBe('AWAITING_USER');
  });

  it('queues the one continuation of an accepted answer even when membership is revoked mid-request', async () => {
    const f = await waiting();
    const request = f.replyRequest();
    f.hooks.after = (command) => {
      if (executionPut(command)?.response) {
        delete f.hooks.after;
        f.authorization.member = false;
      }
    };
    await expect(
      f.api.respond(f.prepared, 'member-one', request, f.recheck, member),
    ).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
    // Accepted exactly once; its continuation is queued, not stranded, and the
    // revoked caller receives no result.
    expect(f.row()).toMatchObject({ status: 'DISPATCHING', turnSequence: 2 });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.authorization.member = true;
    const ledger = await f.store.response(f.row(), request.interactionId);
    expect(ledger.member).toEqual(member);
  });
});

describe('task-3 structured answers', () => {
  const pendingInput = {
    schemaVersion: 1,
    kind: 'approval',
    source: 'engine-gate',
    stage: 'requirements-analysis',
    questions: [
      {
        id: 'q1',
        prompt: 'Requirements complete. How would you like to proceed?',
        header: 'Approval',
        multiSelect: false,
        options: [
          { label: 'Approve', description: 'Continue to user stories' },
          { label: 'Request Changes', description: 'Provide revision feedback' },
        ],
      },
    ],
  };
  const gated = () =>
    waiting({
      pendingInput,
      text: 'Requirements complete.\n1. **Approve**\n2. **Request Changes**',
    });

  it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
    'commits one structured member answer and command atomically in DynamoDB Local',
    async () => {
      const f = await gated();
      const tableName = `native-answers-${randomUUID()}`;
      const raw = new DynamoDBClient({
        endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      const ddb = DynamoDBDocumentClient.from(raw, {
        marshallOptions: { removeUndefinedValues: true },
      });
      await raw.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
          ],
        }),
      );
      try {
        // Reuse the admitted publication fixture, then cross the actual SDK and
        // transaction boundary for acceptance, losing races and replay.
        await ddb.send(new PutCommand({ TableName: tableName, Item: f.row() }));
        const store = createNativeExecutionStore({
          ddb,
          tableName,
          preparationStore: f.preparationStore,
          now: f.now,
        });
        const api = createNativeExecutionApi({
          enabled: true,
          store,
          publications: f.publications,
          interactions: f.interactions,
          configure: f.configure,
          enqueue: f.enqueue,
          authorizeSource: async () => {},
        });
        const members = new Set(['ada', 'grace']);
        const submit = (actorId, request) =>
          api.respond(
            f.prepared,
            actorId,
            request,
            async () => {
              if (!members.has(actorId))
                throw Object.assign(new Error('Revoked'), { code: 'NATIVE_PREPARATION_FORBIDDEN' });
            },
            { membershipId: `edge-${actorId}`, projectIdentity: f.prepared.projectIdentity },
          );
        const approve = f.replyRequest({
          text: 'Approve',
          selection: { answers: [{ selectedOptions: [0] }] },
        });
        const changes = f.replyRequest({
          text: 'Request Changes\n\nAdd offline mode.',
          selection: { answers: [{ selectedOptions: [1], freeText: 'Add offline mode.' }] },
        });
        const outcomes = await Promise.allSettled([
          submit('ada', approve),
          submit('grace', changes),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === 'rejected').reason.code).toBe(
          'NATIVE_EXECUTION_CONFLICT',
        );
        const accepted = outcomes.find((outcome) => outcome.status === 'fulfilled').value.response;
        const request = accepted.actorId === 'ada' ? approve : changes;
        expect((await submit(accepted.actorId, request)).response).toEqual(accepted);
        const row = await store.get(f.identity);
        const ledger = await store.response(row, request.interactionId);
        expect(row.response.commandId).toBe(ledger.commandId);
        expect(ledger).toMatchObject({
          actorId: accepted.actorId,
          requestId: request.requestId,
          text: request.text,
          contentSha256: request.contentSha256,
          selection: request.selection,
          member: { membershipId: `edge-${accepted.actorId}` },
          publicationId: f.first.receipt.id,
        });
        const { Items } = await ddb.send(
          new ScanCommand({ TableName: tableName, ConsistentRead: true }),
        );
        expect(Items.map((item) => item.sk).sort()).toEqual([
          expect.stringMatching(/^EVENT#[0-9]{16}$/),
          'EXECUTION',
          `RESPONSE#${request.interactionId}`,
          expect.stringMatching(/^RESPONSE_REQUEST#/),
        ]);
        const event = Items.find((item) => item.sk.startsWith('EVENT#'));
        expect(event).toMatchObject({ type: 'native.answer.accepted', actor: accepted.actorId });
        expect(event.summary).toContain('delivery pending');
        // The same table and real transaction conditions fence multi-batch
        // output, duplicate ACK recovery, and a cancellation racing an old writer.
        const activity = createNativeActivityStore({ ddb, tableName, now: f.now });
        const owner = (await store.claim(f.bindingIdentity)).row;
        for (let after = 0; after < 192; after += 64) {
          const batch = {
            ...executionIdentity(owner),
            writerGeneration: owner.writerGeneration,
            after,
            events: Array.from({ length: 64 }, (_, i) => ({
              index: after + i + 1,
              sequence: owner.turnSequence,
              writerGeneration: owner.writerGeneration,
              kind: 'stdout',
              capturedAt: f.now(),
              content: `Visible output ${after + i + 1}`,
              display: { type: 'message', level: 'info' },
            })),
          };
          expect(await activity.ingest(owner, batch)).toBe(after + 64);
          expect(await activity.ingest(owner, batch)).toBe(after + 64);
        }
        const seen = [];
        let after = 0;
        do {
          const page = await activity.history(f.identity, after);
          seen.push(...page.outputs);
          after = page.nextAfter;
        } while (after !== null);
        expect(seen.map((output) => output.seq)).toEqual(
          Array.from({ length: 192 }, (_, i) => i + 1),
        );
        expect((await activity.events(f.identity)).events).toHaveLength(1);
        await store.cancel(f.bindingIdentity);
        await expect(
          activity.ingest(owner, {
            ...executionIdentity(owner),
            writerGeneration: owner.writerGeneration,
            after: 192,
            events: [
              {
                index: 193,
                sequence: owner.turnSequence,
                writerGeneration: owner.writerGeneration,
                kind: 'stdout',
                capturedAt: f.now(),
                content: 'Stale output',
              },
            ],
          }),
        ).rejects.toThrow();
        expect(await activity.cursor(owner)).toBe(192);
        expect((await activity.events(f.identity)).events.map((entry) => entry.type)).toEqual([
          'native.answer.accepted',
          'native.cancel_requested',
        ]);
        members.delete(accepted.actorId);
        await expect(submit(accepted.actorId, request)).rejects.toMatchObject({
          code: 'NATIVE_PREPARATION_FORBIDDEN',
        });
        expect(await store.response(row, request.interactionId)).toEqual(ledger);
      } finally {
        await raw.send(new DeleteTableCommand({ TableName: tableName }));
        raw.destroy();
      }
    },
  );

  it('accepts a selection whose text is the exact label and records both', async () => {
    const f = await gated();
    const request = f.replyRequest({
      text: 'Approve',
      selection: { answers: [{ selectedOptions: [0] }] },
    });
    const accepted = await f.api.respond(f.prepared, 'member-one', request, f.recheck);
    expect(accepted.response.text).toBe('Approve');
    const ledger = await f.store.response(f.row(), request.interactionId);
    expect(ledger.selection).toEqual({ answers: [{ selectedOptions: [0] }] });
    // Same frozen request is idempotent; a different selection is a conflict.
    expect((await f.api.respond(f.prepared, 'member-one', request, f.recheck)).response.id).toBe(
      ledger.commandId,
    );
    await expect(
      f.api.respond(
        f.prepared,
        'member-one',
        { ...request, selection: { answers: [{ selectedOptions: [1], freeText: 'x' }] } },
        f.recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
  });

  it('accepts request-changes feedback rendered after the label', async () => {
    const f = await gated();
    const selection = { answers: [{ selectedOptions: [1], freeText: 'Add offline mode.' }] };
    const request = f.replyRequest({ text: 'Request Changes\n\nAdd offline mode.', selection });
    expect((await f.api.respond(f.prepared, 'member-one', request, f.recheck)).response.text).toBe(
      'Request Changes\n\nAdd offline mode.',
    );
  });

  it('rejects selections that disagree with the text or the presented question', async () => {
    const f = await gated();
    for (const [text, selection] of [
      ['1', { answers: [{ selectedOptions: [0] }] }],
      ['Approve', { answers: [{ selectedOptions: [1] }] }],
      ['Approve', { answers: [{ selectedOptions: [7] }] }],
      ['Approve', { answers: [{ selectedOptions: [0] }, { selectedOptions: [0] }] }],
    ]) {
      await expect(
        f.api.respond(f.prepared, 'member-one', f.replyRequest({ text, selection }), f.recheck),
      ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_INVALID' });
    }
    expect(f.row().status).toBe('AWAITING_USER');
    // Free text remains a valid reply to a structured question.
    const free = await f.api.respond(
      f.prepared,
      'member-one',
      f.replyRequest({ text: 'Please explain the scope first.' }),
      f.recheck,
    );
    expect(free.response.text).toBe('Please explain the scope first.');
  });

  it('rejects any selection on a free-text (v1) turn', async () => {
    const f = await waiting();
    await expect(
      f.api.respond(
        f.prepared,
        'member-one',
        f.replyRequest({ text: 'Approve', selection: { answers: [{ selectedOptions: [0] }] } }),
        f.recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_INVALID' });
  });
});
