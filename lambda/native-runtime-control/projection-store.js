import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { nativeExecutionKey, publicationHistoryKey } from './execution-store.js';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';

const key = (scope) => ({ ...nativeExecutionKey(scope), sk: 'PROJECTION' });
const PROJECTION_VERSION = 2;
const conflict = () => {
  throw Object.assign(new Error('Native projection ownership changed'), {
    code: 'NATIVE_PROJECTION_CONFLICT',
  });
};
const read = async (ddb, tableName, Key) =>
  (await ddb.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;

export const nativeProjectionStatus = async (ddb, tableName, row) => {
  if (!row.publication) return null;
  const progress = await read(ddb, tableName, key(row.scope));
  // Older generic projections must rebuild under the current extraction contract.
  if (progress?.projectionVersion !== PROJECTION_VERSION) return 'pending';
  return progress.sequence >= row.publication.sequence ? 'complete' : 'pending';
};

const revisionRow = (head, revision) => ({
  ...head,
  epoch: revision.epoch,
  publication: revision.publication,
  publicationEpoch: revision.epoch,
  interaction: revision.interaction,
  interactionEpoch: revision.epoch,
  interactionContentSha256: revision.interactionContentSha256,
});

export const createNativeProjectionStore = ({
  ddb,
  tableName,
  execution,
  preparation,
  now = Date.now,
  leaseMs = 180000,
}) => {
  const get = (Key) => read(ddb, tableName, Key);
  const commit = async (prior, next, row) => {
    const condition = prior
      ? {
          ConditionExpression: '#version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': prior.version },
        }
      : { ConditionExpression: 'attribute_not_exists(pk)' };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: next, ...condition } },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: nativeExecutionKey(row.scope),
              ConditionExpression: 'bindingId = :binding AND attemptId = :attempt',
              ExpressionAttributeValues: { ':binding': row.bindingId, ':attempt': row.attemptId },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: nativeRuntimeBindingKey(row.scope),
              ConditionExpression: 'bindingId = :binding',
              ExpressionAttributeValues: { ':binding': row.bindingId },
            },
          },
        ],
      }),
    );
    return next;
  };
  const nextRevision = async (row, sequence) => {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :after AND :end',
        ExpressionAttributeValues: {
          ':pk': row.pk,
          ':after': publicationHistoryKey(row.scope, sequence + 1).sk,
          ':end': 'PUBLICATION$',
        },
        Limit: 1,
      }),
    );
    const revision = page.Items?.[0];
    if (revision) {
      if (
        revision.bindingId !== row.bindingId ||
        revision.attemptId !== row.attemptId ||
        revision.publication.sequence !== sequence + 1
      )
        conflict();
      return revisionRow(row, revision);
    }
    // First-generation rows predate immutable history. Adopt their exact head
    // only when no earlier history exists; never invent missing revisions.
    if (sequence === 0 && row.publication.sequence === 1) return { ...row };
    conflict();
  };
  const owned = async (claim) => {
    const saved = await get(key(claim.row.scope));
    if (
      !saved ||
      saved.leaseToken !== claim.progress.leaseToken ||
      saved.version !== claim.progress.version ||
      saved.leaseExpiresAt <= now() ||
      saved.publicationId !== claim.row.publication.id ||
      saved.targetSequence !== claim.row.publication.sequence ||
      saved.targetEpoch !== claim.row.publicationEpoch ||
      saved.bindingId !== claim.row.bindingId
    )
      conflict();
    return saved;
  };
  return {
    async claim(scope) {
      const row = await execution.get(scope);
      const draft = await preparation.get(scope);
      if (!row?.publication || !draft || draft.bindingId !== row.bindingId)
        return { kind: 'missing' };
      const prior = await get(key(scope));
      if (prior?.bindingId && prior.bindingId !== row.bindingId) conflict();
      if (prior?.leaseExpiresAt > now()) return { kind: 'busy' };
      // Upgrade a completed old projection by rebuilding its current immutable
      // head. Replaying old history into a newer graph head would correctly be
      // rejected by the graph's publication-sequence fence.
      const rebuild =
        prior?.projectionVersion !== PROJECTION_VERSION &&
        ((prior?.sequence ?? 0) > 0 || row.projectionStatus === 'complete');
      const sequence = rebuild ? row.publication.sequence - 1 : (prior?.sequence ?? 0);
      if (sequence >= row.publication.sequence) return { kind: 'complete' };
      const revision = rebuild ? { ...row } : await nextRevision(row, sequence);
      const progress = await commit(
        prior,
        {
          ...key(scope),
          schemaVersion: 1,
          projectionVersion: PROJECTION_VERSION,
          bindingId: row.bindingId,
          version: (prior?.version ?? 0) + 1,
          sequence,
          publicationId: revision.publication.id,
          targetSequence: revision.publication.sequence,
          targetEpoch: revision.publicationEpoch,
          leaseToken: randomUUID(),
          leaseExpiresAt: now() + leaseMs,
        },
        row,
      );
      return { kind: 'claimed', row: revision, draft, progress };
    },
    async acknowledge(claim) {
      const prior = await owned(claim);
      return commit(
        prior,
        {
          ...prior,
          version: prior.version + 1,
          sequence: claim.row.publication.sequence,
          leaseExpiresAt: 0,
        },
        claim.row,
      );
    },
    async release(claim) {
      const prior = await owned(claim);
      return commit(prior, { ...prior, version: prior.version + 1, leaseExpiresAt: 0 }, claim.row);
    },
  };
};
