import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { serialFixture } from './execution-serial-fixtures.js';
import { createNativeExecutionStore, nativeResponseKey } from '../execution-store.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { buildNativePendingInput } from '../../shared/native-pending-input.js';

it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'retains transactional answer outcomes, publication history and losing-member isolation in DynamoDB Local',
  async () => {
    const f = serialFixture();
    await f.ready();
    const pendingInput = buildNativePendingInput({
      gate: { stage: 'requirements-analysis' },
      messagesText: 'Approve or Request Changes',
      spec: {
        version: 1,
        questions: [
          {
            prompt: 'Review the exact requirements',
            multiSelect: false,
            options: [{ label: 'Approve' }, { label: 'Request Changes' }],
          },
        ],
      },
    });
    const first = await f.publish({ pendingInput, text: 'Approve or Request Changes' });
    const tableName = `native-history-${randomUUID()}`;
    const raw = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const document = DynamoDBDocumentClient.from(raw);
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
    let loseAcknowledgement = false;
    const ddb = {
      async send(command) {
        const result = await document.send(command);
        if (loseAcknowledgement && command instanceof TransactWriteCommand) {
          loseAcknowledgement = false;
          throw new Error('Lost acknowledgement after commit');
        }
        return result;
      },
    };
    try {
      for (const Item of f.rows.values())
        await ddb.send(new PutCommand({ TableName: tableName, Item }));
      const store = createNativeExecutionStore({
        ddb,
        tableName,
        preparationStore: f.preparationStore,
        now: f.now,
      });
      const revisions = createNativeArtifactRevisions({
        ddb,
        nativeTable: tableName,
        publications: f.publications,
      });
      const api = createNativeExecutionApi({
        store,
        revisions,
        publications: f.publications,
        interactions: f.interactions,
      });
      const answers = await Promise.allSettled(
        ['member-one', 'member-two'].map((actorId) =>
          store.respond({
            ...f.bindingIdentity,
            actorId,
            request: f.replyRequest({
              text: 'Approve',
              selection: { answers: [{ selectedOptions: [0] }] },
            }),
            member: {
              membershipId: `edge-${actorId}`,
              projectIdentity: f.prepared.projectIdentity,
            },
          }),
        ),
      );
      expect(answers.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(answers.find((result) => result.status === 'rejected').reason.code).toBe(
        'NATIVE_EXECUTION_CONFLICT',
      );
      const accepted = answers.find((result) => result.status === 'fulfilled').value;
      let owner = (await store.claim(f.bindingIdentity)).row;
      loseAcknowledgement = true;
      owner = await store.dispatched({ row: owner });
      const second = await f.turn(2);
      owner = await store.publish({
        row: owner,
        publication: second.receipt,
        interaction: second.interactionReceipt,
        interactionContentSha256: second.body.contentSha256,
      });
      await store.release({ row: owner });
      await store.respond({
        ...f.bindingIdentity,
        actorId: 'member-three',
        request: {
          requestId: randomUUID(),
          interactionId: second.interactionReceipt.id,
          contentSha256: second.body.contentSha256,
          text: 'Third answer',
        },
      });
      const result = await api.revisionInteraction(
        f.prepared,
        {
          publicationId: first.receipt.id,
          publicationSequence: 1,
        },
        f.recheck,
      );
      expect(result.answer).toMatchObject({
        actorId: accepted.response.actorId,
        deliveryStatus: 'delivered',
        resultingPublication: { publicationId: second.receipt.id, publicationSequence: 2 },
      });
      const evidence = await api.revision(
        f.prepared,
        {
          publicationId: first.receipt.id,
          publicationSequence: 1,
          evidence: true,
        },
        f.recheck,
      );
      expect(evidence).toMatchObject({
        memberDecision: {
          actorId: accepted.response.actorId,
          label: 'Approve',
          commandId: accepted.response.commandId,
          contentSha256: first.body.contentSha256,
        },
        decisionDelivery: 'delivered',
        engineApplication: 'not_recorded',
        terminalOutcome: 'not_recorded',
        workflowCompletion: 'not_verified',
      });
      expect(
        (
          await api.revision(
            f.prepared,
            {
              publicationId: second.receipt.id,
              publicationSequence: 2,
              evidence: true,
            },
            f.recheck,
          )
        ).memberDecision,
      ).toBeNull();
      const { Item: immutable } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeResponseKey(f.identity, first.interactionReceipt.id),
          ConsistentRead: true,
        }),
      );
      expect(immutable).toEqual(accepted.response);
      expect(
        (await api.history(f.prepared, null, f.recheck)).items.map((item) => item.sequence),
      ).toEqual([2, 1]);
      expect(
        (await api.history(f.prepared, 2, f.recheck)).items.map((item) => item.sequence),
      ).toEqual([1]);
      for (let sequence = 3; sequence <= 35; sequence++) {
        if (sequence > 3)
          await store.respond({
            ...f.bindingIdentity,
            actorId: 'member-three',
            request: {
              requestId: randomUUID(),
              interactionId: owner.interaction.id,
              contentSha256: owner.interactionContentSha256,
              text: `Continue ${sequence}`,
            },
          });
        owner = (await store.claim(f.bindingIdentity)).row;
        owner = await store.dispatched({ row: owner });
        const next = await f.turn(sequence);
        owner = await store.publish({
          row: owner,
          publication: next.receipt,
          interaction: next.interactionReceipt,
          interactionContentSha256: next.body.contentSha256,
        });
        owner = await store.release({ row: owner });
      }
      const page = await api.history(f.prepared, null, f.recheck);
      expect(page.items).toHaveLength(32);
      expect(page.nextBefore).toBe(4);
      expect(
        (await api.history(f.prepared, page.nextBefore, f.recheck)).items.map(
          (item) => item.sequence,
        ),
      ).toEqual([3, 2, 1]);
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
      raw.destroy();
    }
  },
  30000, // 35 real publications plus answer transactions under the full-suite Docker load.
);
