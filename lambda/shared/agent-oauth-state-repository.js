import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { assertIdentifier } from './agent-auth-catalog.js';

const key = (id) => ({ pk: `AGENTAUTH#OAUTH#${assertIdentifier(id, 'connectionId')}`, sk: 'META' });

export const createOAuthStateRepository = ({ ddb, tableName }) => {
  const conditional = async (command) => {
    try {
      await ddb.send(command);
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  };
  return {
    async read(id) {
      return (
        (
          await ddb.send(
            new GetCommand({ TableName: tableName, Key: key(id), ConsistentRead: true }),
          )
        ).Item ?? null
      );
    },
    async establish(id, { identity, subject, secretReference, credentialExpiresAt }) {
      return conditional(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...key(id),
            identity,
            subject,
            secretReference,
            credentialExpiresAt,
            version: 1,
            status: 'ready',
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    },
    async claim(id, version, owner, leaseUntil) {
      return conditional(
        new UpdateCommand({
          TableName: tableName,
          Key: key(id),
          UpdateExpression: 'SET #owner = :owner, leaseUntil = :until',
          ConditionExpression:
            '#version = :version AND attribute_not_exists(#owner) AND #status = :ready',
          ExpressionAttributeNames: {
            '#version': 'version',
            '#owner': 'owner',
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':version': version,
            ':owner': owner,
            ':until': leaseUntil,
            ':ready': 'ready',
          },
        }),
      );
    },
    async commit(
      id,
      { expectedVersion, ownerId, now, secretReference, credentialExpiresAt, subject, identity },
    ) {
      return conditional(
        new UpdateCommand({
          TableName: tableName,
          Key: key(id),
          UpdateExpression:
            'SET secretReference = :reference, credentialExpiresAt = :expires, #version = :next REMOVE #owner, leaseUntil',
          ConditionExpression:
            '#version = :version AND #owner = :owner AND leaseUntil > :now AND #status = :ready AND #subject = :subject AND #identity = :identity',
          ExpressionAttributeNames: {
            '#version': 'version',
            '#owner': 'owner',
            '#status': 'status',
            '#subject': 'subject',
            '#identity': 'identity',
          },
          ExpressionAttributeValues: {
            ':version': expectedVersion,
            ':next': expectedVersion + 1,
            ':owner': ownerId,
            ':now': now,
            ':reference': secretReference,
            ':expires': credentialExpiresAt,
            ':ready': 'ready',
            ':subject': subject,
            ':identity': identity,
          },
        }),
      );
    },
    async invalidate(id, version, status, ownerId) {
      return conditional(
        new UpdateCommand({
          TableName: tableName,
          Key: key(id),
          UpdateExpression: 'SET #status = :status, #version = :next REMOVE #owner, leaseUntil',
          ConditionExpression: `#version = :version${ownerId ? ' AND #owner = :owner' : ''}`,
          ExpressionAttributeNames: {
            '#version': 'version',
            '#owner': 'owner',
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':version': version,
            ':next': version + 1,
            ':status': status,
            ...(ownerId ? { ':owner': ownerId } : {}),
          },
        }),
      );
    },
  };
};
