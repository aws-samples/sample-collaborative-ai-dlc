// The runtime side of engine-data: a process store whose methods run in the
// engine-data Lambda instead of against DynamoDB.
//
// It has the same shape as the local store for every method engine-data
// allows, and nothing else, so feature detection (`typeof store.x`,
// `store.x?.()`, `{ ...store }`) sees exactly what the Lambda will accept. The
// grant is read on every call from the invocation that is running, so a
// method called outside a granted invocation fails instead of acting with no
// scope. Store errors come back with their name, so `ConditionalCheckFailed`
// and transaction-conflict handling in the engine behave as with the local
// store.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ENGINE_DATA_STORE_METHODS, engineDataOp } from '../shared/engine-data-ops.js';

export class EngineDataError extends Error {
  constructor(message, { name = 'EngineDataError', code = null } = {}) {
    super(message);
    this.name = name;
    if (code) this.code = code;
  }
}

const rehydrate = ({ name, code, message, conflict }) => {
  const error = new EngineDataError(message ?? 'Engine data call failed', { name, code });
  // isTransactionConflict reads these reasons on a cancelled transaction.
  if (conflict && name === 'TransactionCanceledException') {
    error.CancellationReasons = [{ Code: 'TransactionConflict' }];
  }
  return error;
};

let lambdaClient;
const defaultInvoke = async (event, env = process.env) => {
  lambdaClient ??= new LambdaClient({});
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: env.ENGINE_DATA_FUNCTION,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
  let body;
  try {
    body = JSON.parse(Buffer.from(response.Payload ?? []).toString('utf8') || 'null');
  } catch {
    throw new EngineDataError('Engine data returned an unreadable response', {
      code: 'ENGINE_DATA_BAD_RESPONSE',
    });
  }
  if (response.FunctionError) {
    throw new EngineDataError(body?.errorMessage ?? 'Engine data function failed', {
      code: 'ENGINE_DATA_FUNCTION_ERROR',
    });
  }
  return body;
};

export const createRemoteProcessStore = ({ invoke = defaultInvoke, grant }) => {
  if (typeof grant !== 'function')
    throw new Error('createRemoteProcessStore requires a grant source');
  const call =
    (method) =>
    async (...args) => {
      const token = grant();
      if (!token) {
        throw new EngineDataError('No engine data grant for this invocation', {
          code: 'ENGINE_DATA_GRANT_MISSING',
        });
      }
      const body = await invoke({ op: engineDataOp(method), args, grant: token });
      if (!body || typeof body !== 'object' || !(body.ok === true || body.error)) {
        throw new EngineDataError('Engine data returned an unreadable response', {
          code: 'ENGINE_DATA_BAD_RESPONSE',
        });
      }
      if (body.error) throw rehydrate(body.error);
      return body.result;
    };
  return Object.fromEntries(ENGINE_DATA_STORE_METHODS.map((method) => [method, call(method)]));
};

// A deployment that routes the store to engine-data but still runs the
// built-in MCP locally would keep the MCP's own direct table access, so it is
// refused rather than half-applied.
export const misconfiguredProcessStore = (reason) => {
  const fail = async () => {
    throw new EngineDataError(reason, { code: 'ENGINE_DATA_MISCONFIGURED' });
  };
  return Object.fromEntries(ENGINE_DATA_STORE_METHODS.map((method) => [method, fail]));
};
