import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});
const ddb = DynamoDBDocumentClient.from(client);

const seedMembership = async (spaceId, userId, membershipRole = 'member') =>
  ddb.send(
    new PutCommand({
      TableName: process.env.ACCESS_TABLE || 'access-test',
      Item: {
        pk: `SPACE#${spaceId}`,
        sk: `MEMBER#${userId}`,
        spaceId,
        userId,
        membershipRole: membershipRole === 'admin' ? 'owner' : membershipRole,
      },
    }),
  );

const removeMembershipFixture = async (spaceId, userId) =>
  ddb.send(
    new DeleteCommand({
      TableName: process.env.ACCESS_TABLE || 'access-test',
      Key: { pk: `SPACE#${spaceId}`, sk: `MEMBER#${userId}` },
    }),
  );

export { removeMembershipFixture, seedMembership };
