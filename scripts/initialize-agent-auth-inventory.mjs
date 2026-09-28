// Explicit additive index backfill for existing installations. Run after all
// credential-selection and process writers have been deployed.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAgentConnectionRepository } from '../lambda/shared/agent-connection-repository.js';

const tableName = process.env.V2_PROCESS_TABLE;
if (!tableName) throw new Error('V2_PROCESS_TABLE is required');
const client = new DynamoDBClient({});
try {
  const repository = createAgentConnectionRepository({
    ddb: DynamoDBDocumentClient.from(client),
    tableName,
  });
  console.log(JSON.stringify({ tableName, ...(await repository.initializeInventory()) }));
} finally {
  client.destroy();
}
