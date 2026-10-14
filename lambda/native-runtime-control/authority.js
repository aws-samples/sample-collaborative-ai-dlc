import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createNativeRuntimeLambda } from './command-service.js';
import { createNativeRuntimeStore } from './store.js';
import { createNativeExecutionStore } from './execution-store.js';
import { createNativeActivityStore } from './activity-store.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import { createNativeProjectionStore } from './projection-store.js';
import { createNativeResultStore } from './result-store.js';
import { broadcastToNativeIntentChannel } from '../shared/ws-fanout.js';

// Lambda's invoked ARN is supplied by AWS. IAM grants each adapter only its
// alias ARN, never the unqualified function or a wildcard qualifier.
export const NATIVE_AUTHORITY_OPERATIONS = Object.freeze({
  results: { execution: ['get'], results: ['claim', 'finish'] },
  preparation: { preparation: ['get', 'claim', 'advance', 'release', 'fail', 'ready'] },
  execution: {
    preparation: ['get'],
    execution: [
      'get',
      'response',
      'claim',
      'advance',
      'release',
      'dispatchAttempted',
      'dispatched',
      'beginRecovery',
      'recoveryStopped',
      'recovered',
      'recoveryRequired',
      'publish',
      'observeRevocation',
    ],
    activity: ['cursor', 'ingest'],
  },
  projection: {
    preparation: ['get'],
    execution: ['get'],
    projection: ['claim', 'acknowledge', 'release'],
  },
});

const denied = () => {
  throw Object.assign(new Error('Native authority caller or operation denied'), {
    code: 'NATIVE_AUTHORITY_FORBIDDEN',
  });
};

export const authenticatedCommandEvent = async (event, verify) => {
  const headers = Object.entries(event?.headers ?? {}).filter(
    ([key]) => key.toLowerCase() === 'authorization',
  );
  if (headers.length !== 1 || typeof headers[0][1] !== 'string') denied();
  const token = headers[0][1].replace(/^Bearer /i, '');
  const claims = await verify(token);
  if (!claims?.sub) denied();
  // Never trust claims, actor IDs or caller class forwarded by the adapter.
  return {
    ...event,
    requestContext: { ...event.requestContext, authorizer: { claims } },
  };
};

export const createNativeAuthority =
  ({ stores, commands, verify, functionName }) =>
  async (event, context) => {
    try {
      const arn = context?.invokedFunctionArn;
      const caller =
        typeof arn === 'string' && arn.startsWith(`${functionName}:`)
          ? arn.slice(functionName.length + 1)
          : null;
      if (caller === 'commands') {
        const authenticated = await authenticatedCommandEvent(event, verify);
        return { ok: true, value: await commands(authenticated) };
      }
      const { aggregate, operation, args } = event ?? {};
      if (
        Object.keys(event ?? {})
          .toSorted()
          .join(',') !== 'aggregate,args,operation' ||
        !Array.isArray(args) ||
        !Object.hasOwn(NATIVE_AUTHORITY_OPERATIONS, caller ?? '') ||
        !Object.hasOwn(NATIVE_AUTHORITY_OPERATIONS[caller], aggregate ?? '') ||
        !NATIVE_AUTHORITY_OPERATIONS[caller][aggregate].includes(operation)
      )
        denied();
      return { ok: true, value: await stores[aggregate][operation](...args) };
    } catch (error) {
      const code = /^NATIVE_[A-Z_]{1,80}$/.test(error?.code ?? '')
        ? error.code
        : 'NATIVE_AUTHORITY_UNAVAILABLE';
      return { ok: false, code };
    }
  };

let authority;
export const handler = (event, context) => {
  if (!authority) {
    const env = process.env;
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const preparation = createNativeRuntimeStore({
      ddb,
      tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
      deployment: {
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        region: env.AWS_REGION,
        partition: env.AWS_PARTITION,
        fileSystemId: env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
      },
    });
    const execution = createNativeExecutionStore({
      ddb,
      tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
      preparationStore: preparation,
      leaseMs: 180000,
    });
    const verifier = CognitoJwtVerifier.create({
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_CLIENT_ID,
      tokenUse: 'id',
    });
    authority = createNativeAuthority({
      stores: {
        results: createNativeResultStore({ ddb, tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE }),
        preparation,
        execution: {
          ...execution,
          async observeRevocation(scope) {
            const row = await execution.get(scope);
            if (
              !row ||
              !(await createNativeRuntimeImagePolicy({
                ddb,
                tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
                env,
              }).revocation(row.configuration.image.digest))
            )
              return row;
            return execution.cancel({ ...scope, bindingId: row.bindingId });
          },
        },
        activity: createNativeActivityStore({
          ddb,
          tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          broadcast: broadcastToNativeIntentChannel,
        }),
        projection: createNativeProjectionStore({
          ddb,
          tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          execution,
          preparation,
        }),
      },
      commands: createNativeRuntimeLambda({ ddb }),
      verify: (token) => verifier.verify(token),
      functionName: env.NATIVE_AUTHORITY_FUNCTION,
    });
  }
  return authority(event, context);
};
