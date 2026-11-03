import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const client = new LambdaClient({});
export const invokeNativeAuthority = async (
  caller,
  input,
  { lambda = client, functionName = process.env.NATIVE_AUTHORITY_FUNCTION } = {},
) => {
  if (!functionName) throw new Error('Native authority is not configured');
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: `${functionName}:${caller}`,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(input)),
    }),
  );
  if (result.FunctionError || !result.Payload)
    throw Object.assign(new Error('Native authority unavailable'), {
      code: 'NATIVE_EXECUTION_UNAVAILABLE',
    });
  const reply = JSON.parse(Buffer.from(result.Payload).toString('utf8'));
  if (!reply.ok) throw Object.assign(new Error(reply.code), { code: reply.code });
  return reply.value;
};

export const nativeAuthorityPort = (caller, aggregate, methods, options) =>
  Object.freeze(
    Object.fromEntries(
      methods.map((operation) => [
        operation,
        (...args) => invokeNativeAuthority(caller, { aggregate, operation, args }, options),
      ]),
    ),
  );

export const executionObservationPort = (options) =>
  nativeAuthorityPort(
    'execution',
    'execution',
    [
      'get',
      'response',
      'claim',
      'advance',
      'release',
      'dispatchAttempted',
      'dispatched',
      'recoveryStopped',
      'recovered',
      'recoveryRequired',
      'publish',
      'observeRevocation',
    ],
    options,
  );
export const preparationObservationPort = (options) =>
  nativeAuthorityPort(
    'preparation',
    'preparation',
    ['get', 'claim', 'advance', 'release', 'fail', 'ready'],
    options,
  );
