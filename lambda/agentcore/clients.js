// Shared AWS + Neptune clients for the AgentCore container, constructed once.
//
// Test seam mirrors the discussions lambda: GREMLIN_PROTOCOL=ws (plain, no IAM)
// for a local gremlin-server; wss + SigV4 in production Neptune. The DDB/S3/WS
// clients use the default credential chain (the ECS/AgentCore task role).

import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import {
  LambdaClient,
  InvokeCommand,
  SendDurableExecutionCallbackSuccessCommand,
  SendDurableExecutionCallbackHeartbeatCommand,
} from '@aws-sdk/client-lambda';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { parseLambdaPayload } from '../shared/lambda-payload.js';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

const dynamoEndpoint = process.env.DYNAMODB_LOCAL_ENDPOINT || undefined;
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
);
export const s3 = new S3Client({});
const lambda = new LambdaClient({});

// AgentCore's only credential entry point. The broker is not API-facing and
// its IAM policy allows invocation solely from the AgentCore runtime role.
export const invokeCredentialBroker = async (request) => {
  const functionName = process.env.CREDENTIAL_BROKER_FUNCTION;
  if (!functionName) {
    throw Object.assign(new Error('Credential broker is not configured'), {
      code: 'CREDENTIAL_BROKER_NOT_CONFIGURED',
    });
  }
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );
  if (response.FunctionError) {
    throw Object.assign(new Error('Credential broker invocation failed'), {
      code: 'CREDENTIAL_BROKER_FAILED',
    });
  }
  const result = parseLambdaPayload(response.Payload);
  if (!result?.ok) {
    throw Object.assign(new Error('Credential broker denied the request'), {
      code: result?.code || 'CREDENTIAL_BROKER_FAILED',
    });
  }
  return result;
};

export const invokeSourceControlOperation = async ({
  projectId,
  provider,
  repo,
  operation,
  args = {},
}) => {
  const functionName = process.env.SOURCE_CONTROL_FUNCTION;
  if (!functionName) {
    throw Object.assign(new Error('Source-control service is not configured'), {
      code: 'SOURCE_CONTROL_NOT_CONFIGURED',
    });
  }
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(
        JSON.stringify({
          action: 'operate',
          projectId,
          provider,
          repo,
          operation,
          args,
        }),
      ),
    }),
  );
  if (response.FunctionError) throw new Error('Source-control service invocation failed');
  const result = parseLambdaPayload(response.Payload);
  if (!result?.ok) {
    throw Object.assign(new Error('Source-control operation failed'), {
      code: result?.code || 'SOURCE_CONTROL_OPERATION_FAILED',
    });
  }
  return result.result;
};

// Complete the durable callback the orchestrator suspended on for an async
// stage (docs/v2-parallel.md WP1). The result object is the run-stage return
// contract, JSON-serialized to match the SDK's default (JSON) serdes. Retries
// with backoff: this send is the ONLY thing that un-suspends the orchestrator,
// so a transient Lambda-API failure must not orphan the run (the orchestrator's
// callback heartbeatTimeout is the final backstop if we truly cannot deliver).
export const sendStageCallbackSuccess = async (
  callbackId,
  result,
  { attempts = 5, baseDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await lambda.send(
        new SendDurableExecutionCallbackSuccessCommand({
          CallbackId: callbackId,
          Result: Buffer.from(JSON.stringify(result ?? null)),
        }),
      );
      return { delivered: true };
    } catch (err) {
      lastErr = err;
      console.error(
        `[agentcore] stage callback send failed (attempt ${i + 1}/${attempts}):`,
        err.message,
      );
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  return { delivered: false, error: lastErr?.message };
};

// Heartbeat the stage callback while the background job runs. Retry transient
// Lambda API failures: this is also called synchronously before a stage is
// accepted, so returning delivered:false must mean the callback is genuinely
// unreachable rather than one request happened to fail.
export const sendStageCallbackHeartbeat = async (
  callbackId,
  { attempts = 3, baseDelayMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await lambda.send(
        new SendDurableExecutionCallbackHeartbeatCommand({ CallbackId: callbackId }),
      );
      return { delivered: true };
    } catch (err) {
      lastErr = err;
      console.error(
        `[agentcore] stage callback heartbeat failed (attempt ${i + 1}/${attempts}):`,
        err.message,
      );
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  return { delivered: false, error: lastErr?.message };
};

// Open a Neptune (or local gremlin-server) traversal source. wss+SigV4 in prod;
// plain ws for the test container.
//
// Each call returns an INDEPENDENT connection the caller OWNS and MUST close
// (via closeGraphSource in mcp/graph-writer.js). There is deliberately no module
// singleton: the container's session process is long-lived and runs many
// sequential stages, each opening the graph 2–3 times — a shared/overwritten
// singleton silently orphaned every prior WebSocket (one socket fd apiece) until
// the process hit EMFILE ("too many open files") and the next stage crashed.
// Ownership + closeGraphSource is the fix.
export const openGraph = async () => {
  const endpoint = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  let conn;
  if (protocol === 'ws') {
    conn = new DriverRemoteConnection(`ws://${endpoint}:${port}/gremlin`);
  } else {
    const region = process.env.AWS_REGION || 'us-east-1';
    const creds = await fromNodeProviderChain()();
    const signerCreds = {
      ...creds,
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      region,
    };
    const info = getUrlAndHeaders(endpoint, port, signerCreds, '/gremlin', 'wss');
    conn = new DriverRemoteConnection(info.url, { headers: info.headers });
  }
  return traversal().withRemote(conn);
};

// One API Gateway management client per endpoint, reused across broadcasts. The
// session process is long-lived and broadcasts on every note/output/metric; a
// fresh client per call would leak a socket pool each time (a sibling of the
// graph-connection EMFILE leak). Keyed by endpoint (only ever one in practice).
const _apiClients = new Map();
const apiClientFor = (endpoint) => {
  let api = _apiClients.get(endpoint);
  if (!api) {
    api = new ApiGatewayManagementApiClient({ endpoint });
    _apiClients.set(endpoint, api);
  }
  return api;
};

// Broadcast a payload to every live connection on the intent's realtime channel.
// Best-effort; never throws. Mirrors the v1 sprint-channel fanout but keyed on
// `intent:<intentId>` (the v2 realtime channel). The connection query drains
// LastEvaluatedKey — a Query page caps at 1MB and truncation would silently
// stop broadcasting to the connections past the first page.
export const broadcastToIntent = async (intentId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint || !intentId) return;
  try {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: connectionsTable,
          IndexName: 'DocumentIdIndex',
          KeyConditionExpression: 'documentId = :doc',
          ExpressionAttributeValues: { ':doc': `intent:${intentId}` },
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const api = apiClientFor(websocketEndpoint);
    const data = JSON.stringify(payload);
    await Promise.all(
      items.map((item) =>
        api
          .send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
          .catch(() => {}),
      ),
    );
  } catch (err) {
    console.error('[agentcore] intent broadcast failed:', err.message);
  }
};
