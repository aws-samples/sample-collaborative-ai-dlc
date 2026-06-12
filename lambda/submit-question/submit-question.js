const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';
  const credentials = await fromNodeProviderChain()();
  credentials.region = region;
  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

async function withNeptune(fn) {
  const conn = await getConnection();
  try {
    const g = traversal().withRemote(conn);
    return await fn(g);
  } finally {
    await conn.close();
  }
}

exports.handler = async (event) => {
  const { questionId, agentTaskId, taskToken, questions, projectId, sprintId } = JSON.parse(
    event.body || event,
  );

  await ddb.send(
    new PutCommand({
      TableName: process.env.QUESTIONS_TABLE,
      Item: {
        questionId,
        agentTaskId,
        taskToken,
        questions,
        projectId,
        sprintId: sprintId || null,
        status: 'pending',
        createdAt: Date.now(),
      },
    }),
  );

  // Update Sprint status + create timeline event in Neptune (single connection)
  if (sprintId) {
    try {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        // Mark sprint as waiting for user input
        await g
          .V()
          .has('Sprint', 'id', sprintId)
          .property(cardinality.single, 'current_agent_status', 'waiting')
          .next();
        // Create timeline event (once, server-side — avoids per-client duplicates)
        const teId = `te-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();
        await g
          .V()
          .has('Sprint', 'id', sprintId)
          .as('s')
          .addV('TimelineEvent')
          .property('id', teId)
          .property('type', 'question_asked')
          .property('title', 'Agent asked a question')
          .property('detail', '')
          .property('user_id', '')
          .property('user_name', '')
          .property('timestamp', timestamp)
          .property('sprint_id', sprintId)
          .property('question_id', questionId)
          .as('e')
          .addE('HAS_TIMELINE_EVENT')
          .from_('s')
          .to('e')
          .next();
      });
    } catch (e) {
      console.error('Failed to update Neptune:', e.message);
    }
  }

  // Broadcast to connected users — include structured questions for immediate UI rendering
  const wsClient = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });
  const connections = await getSprintConnections(sprintId);

  // Parse questions for broadcast (stored as JSON string from MCP tool)
  const parsedQuestions = typeof questions === 'string' ? JSON.parse(questions) : questions;

  await Promise.all(
    connections.map((connId) =>
      wsClient
        .send(
          new PostToConnectionCommand({
            ConnectionId: connId,
            Data: JSON.stringify({
              type: 'agent.question',
              questionId,
              questions: parsedQuestions,
              agentTaskId,
              sprintId,
            }),
          }),
        )
        .catch(() => {}),
    ),
  );

  return { statusCode: 200, body: JSON.stringify({ questionId }) };
};

async function getSprintConnections(sprintId) {
  // Query connections by documentId (sprint:sprintId) using GSI
  const result = await ddb.send(
    new QueryCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      IndexName: 'DocumentIdIndex',
      KeyConditionExpression: 'documentId = :docId',
      ExpressionAttributeValues: { ':docId': `sprint:${sprintId}` },
    }),
  );
  // Never target connections whose scope token has expired (plan §4a).
  // Inline copy of shared/realtime-token.js#isTokenLive — this lambda is
  // zip-packaged without bundling, so it cannot import lambda/shared.
  // Rows without tokenExp are pre-enforcement legacy rows (TTL ≤1h) — allow.
  const nowMs = Date.now();
  return (result.Items || [])
    .filter((item) => {
      const exp = Number(item.tokenExp);
      return !item.tokenExp || !Number.isFinite(exp) || exp * 1000 > nowMs;
    })
    .map((item) => item.connectionId);
}
