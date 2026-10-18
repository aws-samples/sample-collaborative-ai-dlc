import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const dynamoEndpoint = process.env.DYNAMODB_LOCAL_ENDPOINT || undefined;
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
);
