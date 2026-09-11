import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { isTransientTransactionCancellation, scopeKey, snapshotPrefix } from './cluster.js';

export class AwsStore {
  constructor({
    documentsTable,
    membersTable,
    bucket,
    ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    ),
    s3 = new S3Client({
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    }),
    logger = console,
  }) {
    if (!documentsTable || !membersTable || !bucket)
      throw new Error('Incomplete Yjs cluster storage');
    Object.assign(this, { documentsTable, membersTable, bucket, ddb, s3, logger });
    this.transactions = new Map();
  }

  transact(documentId, input) {
    // DynamoDB conflicts even when transactions only share a ConditionCheck.
    // Serialize this worker's transactions on each parent scope; other workers
    // can still contend, so retry explicitly transient cancellations with jitter.
    const scope = scopeKey(documentId);
    const previous = this.transactions.get(scope) ?? Promise.resolve();
    const command = new TransactWriteCommand({ ClientRequestToken: randomUUID(), ...input });
    const operation = previous
      .catch(() => {})
      .then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.ddb.send(command);
          } catch (error) {
            if (attempt >= 3 || !isTransientTransactionCancellation(error)) throw error;
            await sleep(25 * 2 ** attempt * (0.5 + Math.random()));
          }
        }
      });
    this.transactions.set(scope, operation);
    return operation.finally(() => {
      if (this.transactions.get(scope) === operation) this.transactions.delete(scope);
    });
  }

  register(member) {
    return this.ddb.send(new PutCommand({ TableName: this.membersTable, Item: member }));
  }

  unregister(id) {
    return this.ddb.send(new DeleteCommand({ TableName: this.membersTable, Key: { id } }));
  }

  async members(now) {
    const result = [];
    let ExclusiveStartKey;
    do {
      const page = await this.ddb.send(
        new ScanCommand({
          TableName: this.membersTable,
          ConsistentRead: true,
          ExclusiveStartKey,
          FilterExpression: 'expiresAt > :now',
          ExpressionAttributeValues: { ':now': now / 1000 },
        }),
      );
      result.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return result;
  }

  async get(documentId) {
    const result = await this.ddb.send(
      new GetCommand({ TableName: this.documentsTable, Key: { documentId }, ConsistentRead: true }),
    );
    return result.Item;
  }

  scopeCondition(documentId) {
    return {
      ConditionCheck: {
        TableName: this.documentsTable,
        Key: { documentId: scopeKey(documentId) },
        ConditionExpression: 'attribute_not_exists(deletedAt)',
      },
    };
  }

  async claim(lease, now) {
    await this.transact(lease.documentId, {
      TransactItems: [
        this.scopeCondition(lease.documentId),
        {
          Update: {
            TableName: this.documentsTable,
            Key: { documentId: lease.documentId },
            UpdateExpression:
              'SET ownerId = :owner, ownerAddress = :address, leaseToken = :token, leaseUntil = :until',
            ConditionExpression: 'attribute_not_exists(leaseUntil) OR leaseUntil <= :now',
            ExpressionAttributeValues: {
              ':owner': lease.ownerId,
              ':address': lease.ownerAddress,
              ':token': lease.leaseToken,
              ':until': lease.leaseUntil,
              ':now': now,
            },
          },
        },
      ],
    });
    return this.get(lease.documentId);
  }

  renew(lease, until, now) {
    return this.transact(lease.documentId, {
      TransactItems: [
        this.scopeCondition(lease.documentId),
        {
          Update: {
            TableName: this.documentsTable,
            Key: { documentId: lease.documentId },
            UpdateExpression: 'SET leaseUntil = :until',
            ConditionExpression: 'leaseToken = :token AND leaseUntil > :now',
            ExpressionAttributeValues: {
              ':until': until,
              ':token': lease.leaseToken,
              ':now': now,
            },
          },
        },
      ],
    });
  }

  async load(lease) {
    if (!lease.snapshotKey) return null;
    if (!lease.snapshotKey.startsWith(snapshotPrefix(lease.documentId))) {
      throw new Error('Invalid snapshot reference');
    }
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: lease.snapshotKey,
        ...(lease.snapshotVersion ? { VersionId: lease.snapshotVersion } : {}),
      }),
    );
    return result.Body.transformToByteArray();
  }

  async save(lease, snapshot, now) {
    // Re-read the sequence after uncertain write responses. The sequence CAS
    // prevents a delayed old request from replacing a newer checkpoint under
    // the same ownership token.
    const previous = await this.get(lease.documentId);
    if (previous?.leaseToken !== lease.leaseToken) throw new Error('Document ownership changed');
    const previousSequence = previous.snapshotSequence ?? 0;
    const key = `${snapshotPrefix(lease.documentId)}${randomUUID()}.bin`;
    const object = await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: snapshot,
        ContentType: 'application/octet-stream',
      }),
    );
    try {
      await this.transact(lease.documentId, {
        ClientRequestToken: randomUUID(),
        TransactItems: [
          this.scopeCondition(lease.documentId),
          {
            Update: {
              TableName: this.documentsTable,
              Key: { documentId: lease.documentId },
              UpdateExpression:
                'SET snapshotKey = :key, snapshotVersion = :version, snapshotBytes = :bytes, snapshotSequence = :sequence',
              ConditionExpression:
                'leaseToken = :token AND leaseUntil > :now AND (attribute_not_exists(snapshotSequence) OR snapshotSequence = :previous)',
              ExpressionAttributeValues: {
                ':key': key,
                ':version': object.VersionId ?? null,
                ':bytes': snapshot.byteLength,
                ':token': lease.leaseToken,
                ':now': now,
                ':previous': previousSequence,
                ':sequence': previousSequence + 1,
              },
            },
          },
        ],
      });
    } catch (error) {
      // A timeout may mean the transaction committed but its response was
      // lost. Never delete the object unless cancellation is definitive.
      if (error.name === 'TransactionCanceledException') {
        await this.removeSnapshot(key, object.VersionId);
        throw error;
      }
      const committed = await this.get(lease.documentId).catch(() => null);
      if (committed?.snapshotKey !== key) throw error;
    }
    if (previous.snapshotKey)
      await this.removeSnapshot(previous.snapshotKey, previous.snapshotVersion);
    return {
      snapshotKey: key,
      snapshotVersion: object.VersionId ?? null,
      snapshotSequence: previousSequence + 1,
    };
  }

  async removeSnapshot(key, version) {
    try {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(version ? { VersionId: version } : {}),
        }),
      );
    } catch (error) {
      // The committed manifest remains authoritative if old-version cleanup
      // fails. The scope deletion cascade purges all versions under its prefix.
      this.logger.warn('Yjs snapshot cleanup failed:', error.name);
    }
  }

  release(lease) {
    return this.ddb.send(
      new UpdateCommand({
        TableName: this.documentsTable,
        Key: { documentId: lease.documentId },
        UpdateExpression: 'REMOVE ownerId, ownerAddress, leaseToken, leaseUntil',
        ConditionExpression: 'leaseToken = :token',
        ExpressionAttributeValues: { ':token': lease.leaseToken },
      }),
    );
  }
}
