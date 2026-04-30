const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, SendTaskSuccessCommand } = require('@aws-sdk/client-sfn');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});

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
  const { questionId, structuredAnswer, answeredBy } = JSON.parse(event.body || event);

  const question = await ddb.send(new GetCommand({
    TableName: process.env.QUESTIONS_TABLE,
    Key: { questionId }
  }));

  if (!question.Item || question.Item.status !== 'pending') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Question not found or already answered' }) };
  }

  const structuredAnswerJson = typeof structuredAnswer === 'string' ? structuredAnswer : JSON.stringify(structuredAnswer);

  await ddb.send(new UpdateCommand({
    TableName: process.env.QUESTIONS_TABLE,
    Key: { questionId },
    UpdateExpression: 'SET #status = :status, structuredAnswer = :structuredAnswer, answeredBy = :answeredBy, answeredAt = :answeredAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'answered',
      ':structuredAnswer': structuredAnswerJson,
      ':answeredBy': answeredBy,
      ':answeredAt': Date.now()
    }
  }));

  // Update Sprint status back to running
  if (question.Item.sprintId) {
    try {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        await g.V().has('Sprint', 'id', question.Item.sprintId)
          .property(cardinality.single, 'current_agent_status', 'running')
          .next();
      });
    } catch (e) {
      console.error('Failed to update Sprint status:', e.message);
    }
  }

  if (question.Item.taskToken) {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken: question.Item.taskToken,
      output: JSON.stringify({ questionId, structuredAnswer: structuredAnswerJson })
    }));
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
