// Idempotent additive index backfill for fresh and existing installations.
// deploy-terraform.sh runs this after all credential-selection and process
// writers have been deployed; direct Terraform users run it after apply.
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
