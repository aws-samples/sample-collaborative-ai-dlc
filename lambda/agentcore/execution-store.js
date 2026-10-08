// Per-invocation DDB credentials. Other AWS clients retain the runtime identity,
// which has an explicit denial on the execution table. There is no default-chain
// fallback here, and neither credentials nor the lease are installed globally.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../shared/v2-process-store.js';
import { invokeCredentialBroker } from './clients.js';

export const EXECUTION_DATA_GRANT_ENV = 'V2_EXECUTION_DATA_GRANT';

export const executionDataEnv = (env) =>
  env[EXECUTION_DATA_GRANT_ENV]
    ? { [EXECUTION_DATA_GRANT_ENV]: env[EXECUTION_DATA_GRANT_ENV] }
    : {};

export const executionCredentials = ({
  executionId,
  grant,
  broker = invokeCredentialBroker,
  now = Date.now,
}) => {
  if (!executionId || !grant) throw new Error('Execution data grant is required');
  let cached;
  let pending;
  const refresh = async () => {
    const result = await broker({
      action: 'resolve-execution-data',
      executionId,
      grant,
    });
    const value = result?.credentials;
    const expiration = new Date(value?.expiration);
    if (
      result?.executionId !== executionId ||
      !value?.accessKeyId ||
      !value?.secretAccessKey ||
      !value?.sessionToken ||
      !(expiration.getTime() > now())
    ) {
      throw new Error('Execution data credentials are invalid');
    }
    cached = { ...value, expiration };
    return cached;
  };
  return async () => {
    if (cached && cached.expiration.getTime() - now() > 5 * 60_000) return cached;
    // Fail closed: a failed refresh never falls back to older or ambient credentials.
    pending ??= refresh()
      .catch((error) => {
        cached = undefined;
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
};

export const createExecutionStore = async ({
  executionId,
  grant,
  env = process.env,
  broker = invokeCredentialBroker,
}) => {
  const credentials = executionCredentials({ executionId, grant, broker });
  // Validate scope/issuance before accepting background jobs or opening MCP.
  await credentials();
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: env.AWS_REGION,
      credentials,
    }),
  );
  return createProcessStore({ ddb, tableName: env.V2_PROCESS_TABLE });
};
