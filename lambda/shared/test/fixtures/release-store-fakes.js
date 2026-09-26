// In-memory S3 + DynamoDB fakes for the release registry, shared by the closure
// upgrade suites. The condition expressions are modelled faithfully on purpose:
// a CAS bug would otherwise pass against a store that ignores conditions.

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { releaseCatalogKey, releaseManifestKey } from '../../aidlc-release.js';

const awsError = (name, message, status) => {
  const error = new Error(message);
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
};

const keyOf = (pk, sk) => `${pk}|${sk}`;

const conditionHolds = (input, existing) => {
  const condition = input.ConditionExpression;
  const values = input.ExpressionAttributeValues ?? {};
  if (!condition) return true;
  if (condition === 'attribute_not_exists(pk)') return existing === undefined;
  if (condition === 'revision = :expected') {
    return existing !== undefined && existing.revision === values[':expected'];
  }
  if (condition === 'revision = :releaseRevision') {
    return existing !== undefined && existing.revision === values[':releaseRevision'];
  }
  if (condition === 'revision = :expected AND importerRevision = :fromImporter') {
    return (
      existing !== undefined &&
      existing.revision === values[':expected'] &&
      existing.importerRevision === values[':fromImporter']
    );
  }
  if (condition === 'attribute_not_exists(pk) OR releaseId <> :releaseId') {
    return existing === undefined || existing.releaseId !== values[':releaseId'];
  }
  throw new Error(`unmodelled ConditionExpression: ${condition}`);
};

const installReleaseStoreFakes = ({ s3Mock, ddbMock, objects, rows }) => {
  s3Mock.reset();
  ddbMock.reset();
  objects.clear();
  rows.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
      throw awsError('PreconditionFailed', 'precondition failed', 412);
    }
    objects.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!objects.has(input.Key)) throw awsError('NoSuchKey', 'missing', 404);
    return { Body: { transformToString: async () => objects.get(input.Key) } };
  });
  ddbMock.on(GetCommand).callsFake((input) => {
    const item = rows.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: item ? structuredClone(item) : undefined };
  });
  ddbMock.on(PutCommand).callsFake((input) => {
    const key = keyOf(input.Item.pk, input.Item.sk);
    if (!conditionHolds(input, rows.get(key))) {
      throw awsError('ConditionalCheckFailedException', 'conditional request failed', 400);
    }
    rows.set(key, structuredClone(input.Item));
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues?.[':pk'];
    const items = [...rows.values()].filter((row) =>
      input.IndexName === 'GSI1' ? row.GSI1PK === pk : row.pk === pk,
    );
    return { Items: items.map((row) => structuredClone(row)) };
  });
  ddbMock.on(DeleteCommand).callsFake((input) => {
    const key = keyOf(input.Key.pk, input.Key.sk);
    if (!conditionHolds(input, rows.get(key))) {
      throw awsError('ConditionalCheckFailedException', 'conditional request failed', 400);
    }
    rows.delete(key);
    return {};
  });
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const reasons = input.TransactItems.map((entry) => {
      const operation = entry.Put ?? entry.ConditionCheck ?? entry.Delete;
      const target = entry.Put ? entry.Put.Item : operation.Key;
      return conditionHolds(operation, rows.get(keyOf(target.pk, target.sk)))
        ? { Code: 'None' }
        : { Code: 'ConditionalCheckFailed' };
    });
    if (reasons.some((reason) => reason.Code !== 'None')) {
      const error = awsError('TransactionCanceledException', 'transaction cancelled', 400);
      error.CancellationReasons = reasons;
      throw error;
    }
    for (const entry of input.TransactItems) {
      if (entry.Put) {
        rows.set(keyOf(entry.Put.Item.pk, entry.Put.Item.sk), structuredClone(entry.Put.Item));
      }
      if (entry.Delete) rows.delete(keyOf(entry.Delete.Key.pk, entry.Delete.Key.sk));
    }
    return {};
  });
};

/**
 * Rewrites a registered record so it points at a revision-1 closure — the state
 * every record registered before the importer bump is in.
 */
const pointRecordAtLegacyClosure = (rows, legacyManifest) => {
  const key = keyOf(`AIDLC_RELEASE#${legacyManifest.releaseId}`, 'META');
  const record = rows.get(key);
  const args = { sha: legacyManifest.sourceSha, importerRevision: 1 };
  rows.set(key, {
    ...record,
    importerRevision: 1,
    closureDigest: legacyManifest.closureDigest,
    manifestKey: releaseManifestKey(args),
    catalogKey: releaseCatalogKey(args),
  });
};

export { installReleaseStoreFakes, keyOf, pointRecordAtLegacyClosure };
