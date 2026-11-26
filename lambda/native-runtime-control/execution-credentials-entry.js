// Deploy as its OWN Lambda entry, never as a new legacy credential-broker
// action. Only the trusted native dispatch worker receives InvokeFunction on
// its exact ARN. No Function URL, API route, runtime grant or resource policy.
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createNativeRuntimeStore } from './store.js';
import { createNativeExecutionStore } from './execution-store.js';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const unavailable = () => ({ ok: false, code: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE' });
const openNeptune = async (env) => {
  const credentials = await fromNodeProviderChain()();
  const { url, headers } = getUrlAndHeaders(
    env.NEPTUNE_ENDPOINT,
    env.GREMLIN_PORT ?? '8182',
    { ...credentials, region: env.AWS_REGION },
    '/gremlin',
    env.GREMLIN_PROTOCOL ?? 'wss',
  );
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};
const loadFacade = async () => {
  // Existing Git helpers log provider errors. This process serves only the
  // private facade: silence those loggers BEFORE dynamically importing them.
  // AWS_LAMBDA_LOG_LEVEL takes precedence over POWERTOOLS_LOG_LEVEL in the
  // installed logger. Sampling must not re-enable DEBUG. Do not replace global
  // console methods or log/rethrow an event/exception on this secret path.
  process.env.AWS_LAMBDA_LOG_LEVEL = 'SILENT';
  process.env.POWERTOOLS_LOG_LEVEL = 'SILENT';
  process.env.POWERTOOLS_LOGGER_SAMPLE_RATE = '0';
  const { createNativeExecutionCredentials } = await import('./execution-credentials.js');
  return createNativeExecutionCredentials;
};

export const createNativeExecutionCredentialsLambda =
  ({
    ddb,
    ssm,
    secrets,
    env = process.env,
    openConnection = openNeptune,
    membershipSnapshot = fetchWorkflowSourceMembership,
    preparationFactory = createNativeRuntimeStore,
    executionFactory = createNativeExecutionStore,
    facadeFactory = loadFacade,
  } = {}) =>
  async (payload) => {
    let connection;
    let graph;
    let result;
    try {
      const createFacade = await facadeFactory();
      const documentClient = ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
      const preparationStore = preparationFactory({
        ddb: documentClient,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        deployment: {
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          region: env.AWS_REGION,
          partition: env.AWS_PARTITION || 'aws',
          fileSystemId: env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
        },
      });
      const executionStore = executionFactory({
        ddb: documentClient,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        preparationStore,
      });
      const getMembershipSnapshot = async (projectId, actorId) => {
        graph ??= Promise.resolve()
          .then(() => openConnection(env))
          .then((opened) => {
            connection = opened;
            return traversal().withRemote(connection);
          });
        return membershipSnapshot(await graph, projectId, actorId);
      };
      result = await createFacade({
        executionStore,
        preparationStore,
        ddb: documentClient,
        ssm: ssm ?? new SSMClient({}),
        secrets: secrets ?? new SecretsManagerClient({}),
        env,
        getMembershipSnapshot,
      })(payload);
    } catch {
      result = unavailable();
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {
          // A failed cleanup also suppresses a successfully resolved credential.
          result = unavailable();
        }
      }
    }
    return result;
  };

export const handler = (payload) => createNativeExecutionCredentialsLambda()(payload);
